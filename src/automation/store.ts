import type { DatabaseSync } from "node:sqlite";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AutomationActorType,
  AutomationApprovalEvent,
  AutomationAuditEntry,
  AutomationQuery,
  AutomationRawEvent,
  AutomationRun,
  AutomationStep,
} from "./types.js";
import { resolveStateDir } from "../config/paths.js";
import { appendJsonl, readJsonl } from "../evolution/store.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

export type AutomationPaths = {
  root: string;
  rawEventsPath: string;
  dbPath: string;
};

export function resolveAutomationPaths(stateDir = resolveStateDir()): AutomationPaths {
  const root = path.join(path.resolve(stateDir), "automation");
  return {
    root,
    rawEventsPath: path.join(root, "events.jsonl"),
    dbPath: path.join(root, "index.sqlite"),
  };
}

type AutomationRunRow = Omit<AutomationRun, "specPacket"> & {
  specPacket: string;
};

function decodeRun(row: AutomationRunRow): AutomationRun {
  return {
    ...row,
    specPacket: JSON.parse(row.specPacket),
  } as AutomationRun;
}

function ensureDb(db: DatabaseSync) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      repo_url TEXT,
      repo_dir TEXT,
      base TEXT NOT NULL,
      branch TEXT,
      default_branch TEXT,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      user_request TEXT NOT NULL,
      risk_tier TEXT NOT NULL,
      planner_agent_id TEXT NOT NULL,
      planner_display_name TEXT,
      planner_model TEXT,
      implementation_agent_id TEXT NOT NULL,
      implementation_cli TEXT NOT NULL,
      implementation_fallback_cli TEXT,
      implementation_model TEXT,
      fallback_model TEXT,
      started_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      summary TEXT,
      last_step_label TEXT,
      last_approval_id TEXT,
      spec_packet_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS automation_runs_updated_at_idx
      ON automation_runs(updated_at_ms DESC);
    CREATE TABLE IF NOT EXISTS automation_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      status TEXT NOT NULL,
      label TEXT NOT NULL,
      detail TEXT,
      actor_id TEXT,
      actor_type TEXT,
      actor_label TEXT,
      command TEXT,
      exit_code INTEGER,
      data_json TEXT
    );
    CREATE INDEX IF NOT EXISTS automation_steps_run_ts_idx
      ON automation_steps(run_id, ts DESC);
    CREATE TABLE IF NOT EXISTS automation_audit (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT,
      message TEXT NOT NULL,
      repo TEXT,
      branch TEXT,
      actor_id TEXT,
      actor_type TEXT,
      actor_label TEXT,
      data_json TEXT
    );
    CREATE INDEX IF NOT EXISTS automation_audit_run_ts_idx
      ON automation_audit(run_id, ts DESC);
    CREATE INDEX IF NOT EXISTS automation_audit_repo_ts_idx
      ON automation_audit(repo, ts DESC);
    CREATE TABLE IF NOT EXISTS automation_approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      approval_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      state TEXT NOT NULL,
      decision TEXT,
      resolved_by TEXT,
      agent_id TEXT,
      session_key TEXT,
      command TEXT,
      host TEXT,
      cwd TEXT,
      security TEXT,
      ask TEXT
    );
    CREATE INDEX IF NOT EXISTS automation_approvals_run_ts_idx
      ON automation_approvals(run_id, ts DESC);
  `);
}

function serializeJson(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export type AutomationStore = {
  paths: AutomationPaths;
  appendRawEvent: (event: AutomationRawEvent) => Promise<void>;
  readRawEvents: (opts?: { limit?: number }) => Promise<AutomationRawEvent[]>;
  upsertRun: (run: AutomationRun) => void;
  appendStep: (step: AutomationStep) => void;
  appendAudit: (entry: AutomationAuditEntry) => void;
  appendApproval: (entry: AutomationApprovalEvent) => void;
  listRuns: (opts?: { limit?: number; repo?: string; status?: string }) => AutomationRun[];
  getRun: (runId: string) => AutomationRun | null;
  listSteps: (runId: string, limit?: number) => AutomationStep[];
  queryAudit: (query?: AutomationQuery) => AutomationAuditEntry[];
  close: () => void;
};

export function createAutomationStore(paths: AutomationPaths): AutomationStore {
  fsSync.mkdirSync(paths.root, { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(paths.dbPath);
  ensureDb(db);

  const upsertRunStmt = db.prepare(`
    INSERT INTO automation_runs (
      id, repo, repo_url, repo_dir, base, branch, default_branch, status, title,
      user_request, risk_tier, planner_agent_id, planner_display_name, planner_model,
      implementation_agent_id, implementation_cli, implementation_fallback_cli,
      implementation_model, fallback_model, started_at_ms, updated_at_ms,
      finished_at_ms, summary, last_step_label, last_approval_id, spec_packet_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      repo = excluded.repo,
      repo_url = excluded.repo_url,
      repo_dir = excluded.repo_dir,
      base = excluded.base,
      branch = excluded.branch,
      default_branch = excluded.default_branch,
      status = excluded.status,
      title = excluded.title,
      user_request = excluded.user_request,
      risk_tier = excluded.risk_tier,
      planner_agent_id = excluded.planner_agent_id,
      planner_display_name = excluded.planner_display_name,
      planner_model = excluded.planner_model,
      implementation_agent_id = excluded.implementation_agent_id,
      implementation_cli = excluded.implementation_cli,
      implementation_fallback_cli = excluded.implementation_fallback_cli,
      implementation_model = excluded.implementation_model,
      fallback_model = excluded.fallback_model,
      started_at_ms = excluded.started_at_ms,
      updated_at_ms = excluded.updated_at_ms,
      finished_at_ms = excluded.finished_at_ms,
      summary = excluded.summary,
      last_step_label = excluded.last_step_label,
      last_approval_id = excluded.last_approval_id,
      spec_packet_json = excluded.spec_packet_json
  `);

  const insertStepStmt = db.prepare(`
    INSERT OR REPLACE INTO automation_steps (
      id, run_id, ts, status, label, detail, actor_id, actor_type, actor_label, command, exit_code, data_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAuditStmt = db.prepare(`
    INSERT OR REPLACE INTO automation_audit (
      id, run_id, ts, kind, status, message, repo, branch, actor_id, actor_type, actor_label, data_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertApprovalStmt = db.prepare(`
    INSERT OR REPLACE INTO automation_approvals (
      id, run_id, approval_id, ts, state, decision, resolved_by, agent_id, session_key, command, host, cwd, security, ask
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    paths,
    appendRawEvent: async (event) => {
      await fs.mkdir(paths.root, { recursive: true });
      await appendJsonl(paths.rawEventsPath, event);
    },
    readRawEvents: async (opts) => await readJsonl<AutomationRawEvent>(paths.rawEventsPath, opts),
    upsertRun: (run) => {
      upsertRunStmt.run(
        run.id,
        run.repo,
        run.repoUrl ?? null,
        run.repoDir ?? null,
        run.base,
        run.branch ?? null,
        run.defaultBranch ?? null,
        run.status,
        run.title,
        run.userRequest,
        run.riskTier,
        run.plannerAgentId,
        run.plannerDisplayName ?? null,
        run.plannerModel ?? null,
        run.implementationAgentId,
        run.implementationCli,
        run.implementationFallbackCli ?? null,
        run.implementationModel ?? null,
        run.fallbackModel ?? null,
        run.startedAtMs,
        run.updatedAtMs,
        run.finishedAtMs ?? null,
        run.summary ?? null,
        run.lastStepLabel ?? null,
        run.lastApprovalId ?? null,
        JSON.stringify(run.specPacket),
      );
    },
    appendStep: (step) => {
      insertStepStmt.run(
        step.id,
        step.runId,
        step.ts,
        step.status,
        step.label,
        step.detail ?? null,
        step.actor?.id ?? null,
        step.actor?.type ?? null,
        step.actor?.label ?? null,
        step.command ?? null,
        step.exitCode ?? null,
        serializeJson(step.data),
      );
    },
    appendAudit: (entry) => {
      insertAuditStmt.run(
        entry.id,
        entry.runId ?? null,
        entry.ts,
        entry.kind,
        entry.status ?? null,
        entry.message,
        entry.repo ?? null,
        entry.branch ?? null,
        entry.actor?.id ?? null,
        entry.actor?.type ?? null,
        entry.actor?.label ?? null,
        serializeJson(entry.data),
      );
    },
    appendApproval: (entry) => {
      insertApprovalStmt.run(
        entry.id,
        entry.runId ?? null,
        entry.approvalId,
        entry.ts,
        entry.state,
        entry.decision ?? null,
        entry.resolvedBy ?? null,
        entry.agentId ?? null,
        entry.sessionKey ?? null,
        entry.command ?? null,
        entry.host ?? null,
        entry.cwd ?? null,
        entry.security ?? null,
        entry.ask ?? null,
      );
    },
    listRuns: (opts) => {
      const where: string[] = [];
      const values: Array<string | number> = [];
      if (opts?.repo) {
        where.push("repo = ?");
        values.push(opts.repo);
      }
      if (opts?.status) {
        where.push("status = ?");
        values.push(opts.status);
      }
      const limit = Math.max(1, Math.min(500, Math.floor(opts?.limit ?? 100)));
      values.push(limit);
      const rows = db
        .prepare(
          `
            SELECT
              id,
              repo,
              repo_url as repoUrl,
              repo_dir as repoDir,
              base,
              branch,
              default_branch as defaultBranch,
              status,
              title,
              user_request as userRequest,
              risk_tier as riskTier,
              planner_agent_id as plannerAgentId,
              planner_display_name as plannerDisplayName,
              planner_model as plannerModel,
              implementation_agent_id as implementationAgentId,
              implementation_cli as implementationCli,
              implementation_fallback_cli as implementationFallbackCli,
              implementation_model as implementationModel,
              fallback_model as fallbackModel,
              started_at_ms as startedAtMs,
              updated_at_ms as updatedAtMs,
              finished_at_ms as finishedAtMs,
              summary,
              last_step_label as lastStepLabel,
              last_approval_id as lastApprovalId,
              spec_packet_json as specPacket
            FROM automation_runs
            ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
            ORDER BY updated_at_ms DESC
            LIMIT ?
          `,
        )
        .all(...values) as AutomationRunRow[];
      return rows.map(decodeRun);
    },
    getRun: (runId) => {
      const row = db
        .prepare(
          `
            SELECT
              id,
              repo,
              repo_url as repoUrl,
              repo_dir as repoDir,
              base,
              branch,
              default_branch as defaultBranch,
              status,
              title,
              user_request as userRequest,
              risk_tier as riskTier,
              planner_agent_id as plannerAgentId,
              planner_display_name as plannerDisplayName,
              planner_model as plannerModel,
              implementation_agent_id as implementationAgentId,
              implementation_cli as implementationCli,
              implementation_fallback_cli as implementationFallbackCli,
              implementation_model as implementationModel,
              fallback_model as fallbackModel,
              started_at_ms as startedAtMs,
              updated_at_ms as updatedAtMs,
              finished_at_ms as finishedAtMs,
              summary,
              last_step_label as lastStepLabel,
              last_approval_id as lastApprovalId,
              spec_packet_json as specPacket
            FROM automation_runs
            WHERE id = ?
          `,
        )
        .get(runId) as AutomationRunRow | undefined;
      return row ? decodeRun(row) : null;
    },
    listSteps: (runId, limit = 100) => {
      const rows = db
        .prepare(
          `
            SELECT
              id,
              run_id as runId,
              ts,
              status,
              label,
              detail,
              actor_id as actorId,
              actor_type as actorType,
              actor_label as actorLabel,
              command,
              exit_code as exitCode,
              data_json as dataJson
            FROM automation_steps
            WHERE run_id = ?
            ORDER BY ts DESC
            LIMIT ?
          `,
        )
        .all(runId, Math.max(1, Math.min(500, Math.floor(limit)))) as unknown as Array<{
        id: string;
        runId: string;
        ts: number;
        status: AutomationStep["status"];
        label: string;
        detail?: string;
        actorId?: string;
        actorType?: AutomationActorType;
        actorLabel?: string;
        command?: string;
        exitCode?: number;
        dataJson?: string | null;
      }>;
      return rows.map((row) => ({
        id: row.id,
        runId: row.runId,
        ts: row.ts,
        status: row.status,
        label: row.label,
        detail: row.detail,
        actor:
          row.actorId && row.actorType
            ? { id: row.actorId, type: row.actorType, label: row.actorLabel }
            : undefined,
        command: row.command,
        exitCode: row.exitCode,
        data: row.dataJson
          ? ((JSON.parse(row.dataJson) as Record<string, unknown>) ?? {})
          : undefined,
      }));
    },
    queryAudit: (query) => {
      const where: string[] = [];
      const values: Array<string | number> = [];
      if (query?.runId) {
        where.push("run_id = ?");
        values.push(query.runId);
      }
      if (query?.repo) {
        where.push("repo = ?");
        values.push(query.repo);
      }
      if (query?.branch) {
        where.push("branch = ?");
        values.push(query.branch);
      }
      if (query?.actorId) {
        where.push("actor_id = ?");
        values.push(query.actorId);
      }
      if (query?.kind) {
        where.push("kind = ?");
        values.push(query.kind);
      }
      const limit = Math.max(1, Math.min(1000, Math.floor(query?.limit ?? 100)));
      values.push(limit);
      const rows = db
        .prepare(
          `
            SELECT
              id,
              run_id as runId,
              ts,
              kind,
              status,
              message,
              repo,
              branch,
              actor_id as actorId,
              actor_type as actorType,
              actor_label as actorLabel,
              data_json as dataJson
            FROM automation_audit
            ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
            ORDER BY ts DESC
            LIMIT ?
          `,
        )
        .all(...values) as unknown as Array<{
        id: string;
        runId?: string;
        ts: number;
        kind: string;
        status?: string;
        message: string;
        repo?: string;
        branch?: string;
        actorId?: string;
        actorType?: AutomationActorType;
        actorLabel?: string;
        dataJson?: string | null;
      }>;
      return rows.map((row) => ({
        id: row.id,
        runId: row.runId,
        ts: row.ts,
        kind: row.kind,
        status: row.status,
        message: row.message,
        repo: row.repo,
        branch: row.branch,
        actor:
          row.actorId && row.actorType
            ? { id: row.actorId, type: row.actorType, label: row.actorLabel }
            : undefined,
        data: row.dataJson
          ? ((JSON.parse(row.dataJson) as Record<string, unknown>) ?? {})
          : undefined,
      }));
    },
    close: () => {
      db.close();
    },
  };
}
