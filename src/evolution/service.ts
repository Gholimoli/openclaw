import crypto from "node:crypto";
import type { EvolutionSourceSpec } from "../config/types.evolution.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  EvolutionEventPayload,
  EvolutionInsight,
  EvolutionPauseState,
  EvolutionProposal,
  EvolutionProposalAction,
  EvolutionReport,
  EvolutionRun,
  EvolutionSource,
  EvolutionStatus,
  OfficeEventPayload,
  OfficeLayout,
} from "./types.js";
import { createAuditEntry } from "./audit.js";
import { resolveEvolutionConfig, type ResolvedEvolutionConfig } from "./defaults.js";
import { createEvolutionExecutor, type EvolutionExecuteResult } from "./executor.js";
import { createOfficeStateManager, type OfficeStateManager } from "./office-state.js";
import { createEvolutionReport } from "./report.js";
import { createEvolutionScheduler, type EvolutionScheduler } from "./scheduler.js";
import { runScout } from "./scout.js";
import { createEvolutionStore, resolveEvolutionPaths, type EvolutionStore } from "./store.js";
import { synthesizeProposals } from "./synthesize.js";

function dayAgo(nowMs: number) {
  return nowMs - 24 * 60 * 60 * 1000;
}

function makeRun(stage: EvolutionRun["stage"]): EvolutionRun {
  return {
    id: crypto.randomUUID(),
    stage,
    startedAtMs: Date.now(),
  };
}

export type EvolutionService = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  status: () => Promise<EvolutionStatus>;
  listSources: () => Promise<EvolutionSource[]>;
  upsertSource: (spec: EvolutionSourceSpec) => Promise<EvolutionSource>;
  listInsights: (opts?: { limit?: number }) => Promise<EvolutionInsight[]>;
  listProposals: (opts?: { limit?: number }) => Promise<EvolutionProposal[]>;
  actProposal: (params: {
    proposalId?: string;
    action: EvolutionProposalAction;
    paused?: boolean;
    reason?: string;
  }) => Promise<{ ok: boolean; message: string }>;
  runScoutNow: () => Promise<{ added: number; skipped: number }>;
  runSynthesizeNow: () => Promise<{ added: number; executed: number; failed: number }>;
  executeProposal: (proposalId: string) => Promise<{ ok: boolean; message: string }>;
  officeSnapshot: () => Promise<{
    agents: ReturnType<OfficeStateManager["snapshot"]>["agents"];
    layout: OfficeLayout;
    activity: ReturnType<OfficeStateManager["snapshot"]>["activity"];
  }>;
  officeLayoutGet: () => Promise<OfficeLayout>;
  officeLayoutSet: (layout: OfficeLayout) => Promise<OfficeLayout>;
  onAgentEvent: (payload: Record<string, unknown>) => Promise<void>;
  onExecApprovalRequested: (payload: Record<string, unknown>) => Promise<void>;
  onExecApprovalResolved: (payload: Record<string, unknown>) => Promise<void>;
  onCronEvent: (payload: Record<string, unknown>) => Promise<void>;
};

export function createEvolutionService(params: {
  getConfig: () => OpenClawConfig;
  repoRoot: string;
  stateDir?: string;
  broadcast?: (
    event: "evolution" | "office",
    payload: EvolutionEventPayload | OfficeEventPayload,
  ) => void;
  log?: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
}): EvolutionService {
  const paths = resolveEvolutionPaths(params.stateDir);
  const store: EvolutionStore = createEvolutionStore(paths);
  const executor = createEvolutionExecutor({
    targetRepoDir: params.repoRoot,
    mirrorDir: paths.mirrorDir,
  });

  let scheduler: EvolutionScheduler | null = null;
  let running = false;
  let lastScoutAtMs: number | null = null;
  let lastSynthAtMs: number | null = null;
  let officeState: OfficeStateManager | null = null;
  let resolvedConfig: ResolvedEvolutionConfig = resolveEvolutionConfig(undefined);

  const log = params.log ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const emitEvolution = (payload: EvolutionEventPayload) => {
    params.broadcast?.("evolution", payload);
  };

  const emitOffice = async (payload: OfficeEventPayload) => {
    params.broadcast?.("office", payload);
    if (payload.kind === "activity.append") {
      await store.appendOfficeActivity(payload.entry);
    }
  };

  const ensureOfficeState = async () => {
    if (officeState) {
      return officeState;
    }
    officeState = createOfficeStateManager({
      initialLayout: await store.readOfficeLayout(),
      initialActivity: await store.readOfficeActivity(500),
    });
    return officeState;
  };

  const getResolvedConfig = () => {
    resolvedConfig = resolveEvolutionConfig(params.getConfig().evolution);
    return resolvedConfig;
  };

  const readPauseState = async () => await store.readPauseState();

  const writePauseState = async (state: EvolutionPauseState) => {
    await store.writePauseState(state);
    emitEvolution({
      kind: "paused.changed",
      paused: state.paused,
      reason: state.reason,
    });
  };

  const appendRunStarted = async (run: EvolutionRun) => {
    await store.appendRun(run);
    emitEvolution({ kind: "run.started", run });
  };

  const appendRunFinished = async (
    run: EvolutionRun,
    ok: boolean,
    message?: string,
    meta?: Record<string, unknown>,
  ) => {
    const finished: EvolutionRun = {
      ...run,
      finishedAtMs: Date.now(),
      ok,
      message,
      meta,
    };
    await store.appendRun(finished);
    emitEvolution({ kind: "run.finished", run: finished });
  };

  const mutateProposal = async (
    proposalId: string,
    mutate: (proposal: EvolutionProposal) => EvolutionProposal,
  ): Promise<EvolutionProposal | null> => {
    return await store.withLock(async () => {
      const proposals = await store.readProposals(200_000);
      const index = proposals.findIndex((entry) => entry.id === proposalId);
      if (index < 0) {
        return null;
      }
      proposals[index] = mutate(proposals[index]);
      await store.replaceProposals(proposals);
      return proposals[index];
    });
  };

  const recordExecutionOutcome = async (ok: boolean, reason?: string) => {
    const current = await readPauseState();
    const now = Date.now();
    const recent = current.recentFailureTimestamps.filter((entry) => entry >= dayAgo(now));

    if (ok) {
      const next: EvolutionPauseState = {
        ...current,
        paused: Boolean(current.paused && current.reason?.startsWith("manual")),
        reason: current.paused && current.reason?.startsWith("manual") ? current.reason : undefined,
        updatedAtMs: now,
        consecutiveFailures: 0,
        recentFailureTimestamps: recent,
      };
      await store.writePauseState(next);
      return;
    }

    recent.push(now);
    const consecutiveFailures = current.consecutiveFailures + 1;
    let paused = current.paused;
    let pauseReason = current.reason;
    if (consecutiveFailures >= resolvedConfig.maxConsecutiveFailures) {
      paused = true;
      pauseReason = `auto: exceeded consecutive failure threshold (${consecutiveFailures})`;
    }
    if (recent.length >= resolvedConfig.maxFailuresPer24h) {
      paused = true;
      pauseReason = `auto: exceeded 24h failure threshold (${recent.length})`;
    }

    await writePauseState({
      paused,
      reason: pauseReason ?? reason,
      updatedAtMs: now,
      consecutiveFailures,
      recentFailureTimestamps: recent,
    });
  };

  const executeProposalInternal = async (
    proposal: EvolutionProposal,
  ): Promise<EvolutionExecuteResult> => {
    const staged = await mutateProposal(proposal.id, (entry) => ({
      ...entry,
      status: "executing",
      updatedAtMs: Date.now(),
    }));
    if (!staged) {
      return { ok: false, message: "proposal not found", changedPaths: [], checks: [] };
    }

    emitEvolution({ kind: "proposal.updated", proposal: staged });

    const result = await executor.execute(staged, {
      mergeScope: resolvedConfig.mergeScope,
    });

    const finalized = await mutateProposal(staged.id, (entry) => ({
      ...entry,
      status: result.ok ? "executed" : "failed",
      reason: result.ok ? undefined : result.message,
      updatedAtMs: Date.now(),
      lastExecution: {
        atMs: Date.now(),
        ok: result.ok,
        commitSha: result.commitSha,
        message: result.message,
      },
    }));

    if (finalized) {
      emitEvolution({ kind: "proposal.updated", proposal: finalized });
    }

    await store.appendAudit(
      createAuditEntry({
        proposalId: staged.id,
        action: "execute",
        ok: result.ok,
        message: result.message,
        commitSha: result.commitSha,
        changedPaths: result.changedPaths,
        checks: result.checks,
      }),
    );
    await recordExecutionOutcome(result.ok, result.message);

    return result;
  };

  const runScoutNow = async () => {
    const cfg = getResolvedConfig();
    if (!cfg.enabled) {
      return { added: 0, skipped: 0 };
    }

    const pauseState = await readPauseState();
    if (pauseState.paused) {
      return { added: 0, skipped: 0 };
    }

    const run = makeRun("scout");
    await appendRunStarted(run);

    try {
      const [sourcesStore, insights] = await Promise.all([
        store.readSources(),
        store.readInsights(300_000),
      ]);

      const result = await runScout({
        existingSources: sourcesStore,
        sourceSpecs: cfg.allowlist,
        existingInsights: insights,
        githubToken: process.env.GITHUB_TOKEN,
      });

      await store.withLock(async () => {
        await store.writeSources(result.sources);
        for (const insight of result.newInsights) {
          await store.appendInsight(insight);
        }
      });

      lastScoutAtMs = Date.now();
      await appendRunFinished(run, true, "scout completed", {
        added: result.newInsights.length,
        skipped: result.skipped,
      });

      return {
        added: result.newInsights.length,
        skipped: result.skipped,
      };
    } catch (err) {
      const message = String(err);
      await appendRunFinished(run, false, message);
      log.error(`evolution scout failed: ${message}`);
      await recordExecutionOutcome(false, message);
      return { added: 0, skipped: 0 };
    }
  };

  const runSynthesizeNow = async () => {
    const cfg = getResolvedConfig();
    if (!cfg.enabled) {
      return { added: 0, executed: 0, failed: 0 };
    }

    const pauseState = await readPauseState();
    if (pauseState.paused) {
      return { added: 0, executed: 0, failed: 0 };
    }

    const run = makeRun("synthesize");
    await appendRunStarted(run);

    try {
      const [insights, proposals] = await Promise.all([
        store.readInsights(300_000),
        store.readProposals(300_000),
      ]);

      const created = synthesizeProposals({
        insights,
        existingProposals: proposals,
        mergeScope: cfg.mergeScope,
      });

      for (const proposal of created) {
        await store.appendProposal(proposal);
        emitEvolution({ kind: "proposal.updated", proposal });
      }

      let executed = 0;
      let failed = 0;

      if (cfg.autonomyMode === "merge-low-risk") {
        for (const proposal of created) {
          if (proposal.class !== "auto_merge_low_risk" || proposal.status !== "pending") {
            continue;
          }
          const result = await executeProposalInternal(proposal);
          if (result.ok) {
            executed += 1;
          } else {
            failed += 1;
          }
        }
      }

      lastSynthAtMs = Date.now();

      const report: EvolutionReport = createEvolutionReport({
        insightsAdded: 0,
        proposalsAdded: created.length,
        executed,
        failed,
      });
      emitEvolution({ kind: "report.published", report });

      await appendRunFinished(run, true, "synthesis completed", {
        added: created.length,
        executed,
        failed,
      });

      return { added: created.length, executed, failed };
    } catch (err) {
      const message = String(err);
      await appendRunFinished(run, false, message);
      log.error(`evolution synthesis failed: ${message}`);
      await recordExecutionOutcome(false, message);
      return { added: 0, executed: 0, failed: 0 };
    }
  };

  const executeProposal = async (proposalId: string) => {
    const cfg = getResolvedConfig();
    if (!cfg.enabled) {
      return { ok: false, message: "evolution is disabled" };
    }

    const pauseState = await readPauseState();
    if (pauseState.paused) {
      return { ok: false, message: `evolution is paused: ${pauseState.reason ?? "paused"}` };
    }

    const run = makeRun("execute");
    await appendRunStarted(run);

    const proposals = await store.readProposals(300_000);
    const proposal = proposals.find((entry) => entry.id === proposalId);
    if (!proposal) {
      await appendRunFinished(run, false, "proposal not found", { proposalId });
      return { ok: false, message: "proposal not found" };
    }

    const result = await executeProposalInternal(proposal);
    await appendRunFinished(run, result.ok, result.message, {
      proposalId,
      changedPaths: result.changedPaths,
      commitSha: result.commitSha,
    });
    return { ok: result.ok, message: result.message };
  };

  const actProposal: EvolutionService["actProposal"] = async (paramsAct) => {
    if (paramsAct.action === "pause") {
      const current = await readPauseState();
      const paused = paramsAct.paused ?? !current.paused;
      await writePauseState({
        ...current,
        paused,
        reason: paramsAct.reason ?? (paused ? "manual pause" : undefined),
        updatedAtMs: Date.now(),
      });
      await store.appendAudit(
        createAuditEntry({
          proposalId: paramsAct.proposalId ?? "n/a",
          action: paused ? "pause" : "resume",
          ok: true,
          message: paramsAct.reason,
        }),
      );
      return { ok: true, message: paused ? "evolution paused" : "evolution resumed" };
    }

    if (!paramsAct.proposalId) {
      return { ok: false, message: "proposalId is required" };
    }

    if (paramsAct.action === "execute") {
      return await executeProposal(paramsAct.proposalId);
    }

    if (paramsAct.action === "approve" || paramsAct.action === "reject") {
      const status = paramsAct.action === "approve" ? "approved" : "rejected";
      const proposal = await mutateProposal(paramsAct.proposalId, (entry) => ({
        ...entry,
        status,
        reason: paramsAct.reason,
        updatedAtMs: Date.now(),
      }));
      if (!proposal) {
        return { ok: false, message: "proposal not found" };
      }
      emitEvolution({ kind: "proposal.updated", proposal });
      await store.appendAudit(
        createAuditEntry({
          proposalId: proposal.id,
          action: paramsAct.action,
          ok: true,
          message: paramsAct.reason,
        }),
      );
      return { ok: true, message: `proposal ${status}` };
    }

    return { ok: false, message: "unsupported action" };
  };

  const start = async () => {
    if (running) {
      return;
    }
    running = true;
    await ensureOfficeState();

    const cfg = getResolvedConfig();
    if (!cfg.enabled) {
      return;
    }

    scheduler = createEvolutionScheduler({
      scoutEveryMs: cfg.scoutEveryMs,
      synthEveryMs: cfg.synthEveryMs,
      onScout: async () => {
        await runScoutNow();
      },
      onSynthesize: async () => {
        await runSynthesizeNow();
      },
    });
    scheduler.start();
    log.info("evolution: scheduler started");
  };

  const stop = async () => {
    running = false;
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
    }
    log.info("evolution: scheduler stopped");
  };

  const status = async (): Promise<EvolutionStatus> => {
    const cfg = getResolvedConfig();
    const [pauseState, sources, insights, proposals] = await Promise.all([
      readPauseState(),
      store.readSources(),
      store.readInsights(200_000),
      store.readProposals(200_000),
    ]);

    return {
      enabled: cfg.enabled,
      running,
      paused: pauseState.paused,
      objective: cfg.objective,
      scoutEveryMs: cfg.scoutEveryMs,
      synthEveryMs: cfg.synthEveryMs,
      nextScoutAtMs: scheduler?.getNextScoutAtMs() ?? null,
      nextSynthAtMs: scheduler?.getNextSynthAtMs() ?? null,
      lastScoutAtMs,
      lastSynthAtMs,
      counts: {
        sources: sources.sources.length,
        insights: insights.length,
        proposals: proposals.length,
        pending: proposals.filter((entry) => entry.status === "pending").length,
        autoMergeCandidates: proposals.filter(
          (entry) => entry.class === "auto_merge_low_risk" && entry.status === "pending",
        ).length,
      },
    };
  };

  const listSources = async () => (await store.readSources()).sources;

  const upsertSource = async (spec: EvolutionSourceSpec) => {
    const now = Date.now();
    return await store.withLock(async () => {
      const sources = await store.readSources();
      const normalized: EvolutionSource = {
        id: spec.id.trim(),
        kind: spec.kind,
        enabled: spec.enabled !== false,
        url: spec.url?.trim() || undefined,
        githubOwner: spec.githubOwner?.trim() || undefined,
        githubRepo: spec.githubRepo?.trim() || undefined,
        include: spec.include?.length ? spec.include : ["releases", "commits", "issues", "prs"],
        tags: Array.from(new Set((spec.tags ?? []).map((entry) => entry.trim()).filter(Boolean))),
        reliabilityTier: spec.reliabilityTier ?? "medium",
        createdAtMs: now,
        updatedAtMs: now,
      };
      const index = sources.sources.findIndex((entry) => entry.id === normalized.id);
      if (index >= 0) {
        normalized.createdAtMs = sources.sources[index]?.createdAtMs ?? now;
        sources.sources[index] = normalized;
      } else {
        sources.sources.push(normalized);
      }
      sources.sources = sources.sources.toSorted((a, b) => a.id.localeCompare(b.id));
      await store.writeSources(sources);
      return normalized;
    });
  };

  const officeSnapshot = async () => (await ensureOfficeState()).snapshot();

  const officeLayoutGet = async () => (await ensureOfficeState()).snapshot().layout;

  const officeLayoutSet = async (layout: OfficeLayout) => {
    const state = await ensureOfficeState();
    const event = state.setLayout(layout);
    await store.writeOfficeLayout(layout);
    await emitOffice(event);
    return layout;
  };

  const onAgentEvent = async (payload: Record<string, unknown>) => {
    const state = await ensureOfficeState();
    const events = state.applyAgentEvent(payload);
    for (const event of events) {
      await emitOffice(event);
    }
  };

  const onExecApprovalRequested = async (payload: Record<string, unknown>) => {
    const state = await ensureOfficeState();
    const events = state.applyExecApprovalRequested(payload);
    for (const event of events) {
      await emitOffice(event);
    }
  };

  const onExecApprovalResolved = async (payload: Record<string, unknown>) => {
    const state = await ensureOfficeState();
    const events = state.applyExecApprovalResolved(payload);
    for (const event of events) {
      await emitOffice(event);
    }
  };

  const onCronEvent = async (payload: Record<string, unknown>) => {
    const state = await ensureOfficeState();
    const events = state.applyCronEvent(payload);
    for (const event of events) {
      await emitOffice(event);
    }
  };

  return {
    start,
    stop,
    status,
    listSources,
    upsertSource,
    listInsights: async (opts) => await store.readInsights(opts?.limit ?? 500),
    listProposals: async (opts) => {
      const proposals = await store.readProposals(opts?.limit ?? 5_000);
      return proposals.toSorted((a, b) => b.createdAtMs - a.createdAtMs);
    },
    actProposal,
    runScoutNow,
    runSynthesizeNow,
    executeProposal,
    officeSnapshot,
    officeLayoutGet,
    officeLayoutSet,
    onAgentEvent,
    onExecApprovalRequested,
    onExecApprovalResolved,
    onCronEvent,
  };
}
