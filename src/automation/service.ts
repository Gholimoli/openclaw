import fs from "node:fs/promises";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  AutomationApprovalEvent,
  AutomationAuditEntry,
  AutomationEventPayload,
  AutomationQuery,
  AutomationRawEvent,
  AutomationRun,
  AutomationStep,
} from "./types.js";
import { createAutomationStore, resolveAutomationPaths, type AutomationStore } from "./store.js";

export type AutomationService = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  listRuns: (opts?: { limit?: number; repo?: string; status?: string }) => Promise<AutomationRun[]>;
  getRun: (runId: string) => Promise<{
    run: AutomationRun | null;
    steps: AutomationStep[];
    audit: AutomationAuditEntry[];
  }>;
  queryAudit: (query?: AutomationQuery) => Promise<AutomationAuditEntry[]>;
  resumeRun: (runId: string) => Promise<{ ok: boolean; run: AutomationRun | null }>;
  cancelRun: (
    runId: string,
    reason?: string,
  ) => Promise<{ ok: boolean; run: AutomationRun | null }>;
  onExecApprovalRequested: (payload: Record<string, unknown>) => Promise<void>;
  onExecApprovalResolved: (payload: Record<string, unknown>) => Promise<void>;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseApprovalRequested(payload: Record<string, unknown>): AutomationApprovalEvent | null {
  const request = (payload.request ?? {}) as {
    id?: unknown;
    request?: {
      agentId?: unknown;
      sessionKey?: unknown;
      command?: unknown;
      host?: unknown;
      cwd?: unknown;
      security?: unknown;
      ask?: unknown;
    };
  };
  const inner = request.request ?? {};
  const approvalId = readString(request.id);
  if (!approvalId) {
    return null;
  }
  return {
    id: `approval-${approvalId}-requested`,
    ts: Date.now(),
    approvalId,
    state: "requested",
    agentId: readString(inner.agentId),
    sessionKey: readString(inner.sessionKey),
    command: readString(inner.command),
    host: readString(inner.host),
    cwd: readString(inner.cwd),
    security: readString(inner.security),
    ask: readString(inner.ask),
  };
}

function parseApprovalResolved(payload: Record<string, unknown>): AutomationApprovalEvent | null {
  const approvalId = readString(payload.id);
  if (!approvalId) {
    return null;
  }
  const decision = readString(payload.decision) as AutomationApprovalEvent["decision"] | undefined;
  return {
    id: `approval-${approvalId}-resolved-${Date.now()}`,
    ts: Date.now(),
    approvalId,
    state: "resolved",
    decision,
    resolvedBy: readString(payload.resolvedBy),
  };
}

export function createAutomationService(params: {
  getConfig: () => OpenClawConfig;
  stateDir?: string;
  broadcast?: (event: "automation", payload: AutomationEventPayload) => void;
  log?: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
}): AutomationService {
  const store: AutomationStore = createAutomationStore(resolveAutomationPaths(params.stateDir));
  const log = params.log ?? { info: () => {}, warn: () => {}, error: () => {} };

  let pollTimer: NodeJS.Timeout | null = null;
  let lastSize = 0;
  let buffer = "";

  const emit = (payload: AutomationEventPayload) => {
    params.broadcast?.("automation", payload);
  };

  const ingestRawEvent = (event: AutomationRawEvent) => {
    if (event.kind === "run.upsert") {
      store.upsertRun(event.run);
      emit({ kind: "run.updated", run: event.run });
      return;
    }
    if (event.kind === "step.append") {
      store.appendStep(event.step);
      emit({ kind: "step.updated", step: event.step });
      return;
    }
    if (event.kind === "audit.append") {
      store.appendAudit(event.entry);
      return;
    }
    if (event.kind === "approval.event") {
      store.appendApproval(event.approval);
      emit({
        kind: event.approval.state === "requested" ? "approval.requested" : "approval.resolved",
        approval: event.approval,
      });
    }
  };

  const syncRawEvents = async () => {
    const stat = await fs.stat(store.paths.rawEventsPath).catch(() => null);
    if (!stat) {
      lastSize = 0;
      buffer = "";
      return;
    }
    if (stat.size < lastSize) {
      lastSize = 0;
      buffer = "";
    }
    if (stat.size === lastSize) {
      return;
    }
    const handle = await fs.open(store.paths.rawEventsPath, "r");
    try {
      const chunkSize = stat.size - lastSize;
      const text = await handle.readFile({ encoding: "utf8" });
      const slice = text.slice(lastSize);
      lastSize = stat.size;
      const joined = `${buffer}${slice}`;
      const lines = joined.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          ingestRawEvent(JSON.parse(trimmed) as AutomationRawEvent);
        } catch (err) {
          log.warn(`automation: failed to parse raw event: ${String(err)}`);
        }
      }
      if (chunkSize > 0 && !slice.endsWith("\n")) {
        buffer = joined;
      }
    } finally {
      await handle.close().catch(() => {});
    }
  };

  const appendAndIngest = async (event: AutomationRawEvent) => {
    await store.appendRawEvent(event);
    const stat = await fs.stat(store.paths.rawEventsPath).catch(() => null);
    if (stat) {
      lastSize = stat.size;
    }
    buffer = "";
    ingestRawEvent(event);
  };

  const updateRunState = async (
    runId: string,
    mutate: (run: AutomationRun) => AutomationRun,
  ): Promise<AutomationRun | null> => {
    const current = store.getRun(runId);
    if (!current) {
      return null;
    }
    const next = mutate(current);
    await appendAndIngest({
      kind: "run.upsert",
      ts: Date.now(),
      run: next,
    });
    return next;
  };

  return {
    start: async () => {
      params.getConfig();
      await fs.mkdir(store.paths.root, { recursive: true });
      await syncRawEvents().catch((err) => {
        log.warn(`automation: initial sync failed: ${String(err)}`);
      });
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      pollTimer = setInterval(() => {
        void syncRawEvents().catch((err) => {
          log.warn(`automation: sync failed: ${String(err)}`);
        });
      }, 1000);
      pollTimer.unref?.();
      log.info("automation: service started");
    },
    stop: async () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      store.close();
    },
    listRuns: async (opts) => store.listRuns(opts),
    getRun: async (runId) => ({
      run: store.getRun(runId),
      steps: store.listSteps(runId),
      audit: store.queryAudit({ runId, limit: 200 }),
    }),
    queryAudit: async (query) => store.queryAudit(query),
    resumeRun: async (runId) => {
      const run = await updateRunState(runId, (current) => ({
        ...current,
        status: "running",
        updatedAtMs: Date.now(),
        summary: "Run resumed by operator.",
      }));
      return { ok: Boolean(run), run };
    },
    cancelRun: async (runId, reason) => {
      const now = Date.now();
      const run = await updateRunState(runId, (current) => ({
        ...current,
        status: "cancelled",
        updatedAtMs: now,
        finishedAtMs: current.finishedAtMs ?? now,
        summary: reason?.trim() || "Run cancelled by operator.",
      }));
      if (run) {
        const entry: AutomationAuditEntry = {
          id: `audit-${runId}-cancel-${now}`,
          runId,
          ts: now,
          kind: "run.cancelled",
          status: "cancelled",
          message: run.summary ?? "Run cancelled by operator.",
          repo: run.repo,
          branch: run.branch,
          actor: { id: "operator", type: "human", label: "Operator" },
        };
        await appendAndIngest({ kind: "audit.append", ts: now, entry });
      }
      return { ok: Boolean(run), run };
    },
    onExecApprovalRequested: async (payload) => {
      const approval = parseApprovalRequested(payload);
      if (!approval) {
        return;
      }
      await appendAndIngest({ kind: "approval.event", ts: approval.ts, approval });
    },
    onExecApprovalResolved: async (payload) => {
      const approval = parseApprovalResolved(payload);
      if (!approval) {
        return;
      }
      await appendAndIngest({ kind: "approval.event", ts: approval.ts, approval });
    },
  };
}
