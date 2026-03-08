import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import type { WorkAction, WorkEnvelope } from "./work-types.js";
import {
  resumeWorkLobster,
  resolveWorkctlPath,
  resolveWorkflowsDir,
  runWorkLobster,
} from "./run-lobster.js";
import { runWorkctlJson } from "./run-workctl.js";

function defaultNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function repoBasename(repo: string): string {
  const trimmed = repo.trim();
  const parts = trimmed.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? trimmed) : trimmed;
}

function repoRelativePath(repo: string): string {
  const trimmed = repo.trim();
  const httpsMatch =
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (httpsMatch?.[1] && httpsMatch?.[2]) {
    return path.join(httpsMatch[1], httpsMatch[2]);
  }
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return path.join(parts[0] ?? "", parts[1] ?? "");
  }
  return repoBasename(repo);
}

function resolveConfigString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const t = value.trim();
  return t ? t : undefined;
}

function resolveWorkRoot(api: OpenClawPluginApi): string {
  const cfg = resolveConfigString(api.pluginConfig?.workRoot);
  return api.resolvePath(cfg ?? "~/work/repos");
}

function resolveDefaultBase(api: OpenClawPluginApi): string {
  return resolveConfigString(api.pluginConfig?.defaultBase) ?? "main";
}

function resolveCoderSessionKey(api: OpenClawPluginApi): string {
  return resolveConfigString(api.pluginConfig?.coderSessionKey) ?? "agent:coder:main";
}

function resolveModelPrimary(value: unknown): string | undefined {
  if (typeof value === "string") {
    return resolveConfigString(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return resolveConfigString((value as { primary?: unknown }).primary);
}

function resolveModelFallbacks(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const fallbacks = (value as { fallbacks?: unknown }).fallbacks;
  if (!Array.isArray(fallbacks)) {
    return [];
  }
  return fallbacks
    .map((entry) => resolveConfigString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

type ResolvedModelConfig = {
  primary?: string;
  fallbacks: string[];
};

function resolveModelConfig(value: unknown): ResolvedModelConfig {
  return {
    primary: resolveModelPrimary(value),
    fallbacks: resolveModelFallbacks(value),
  };
}

function normalizeCliModelRef(
  value: string | undefined,
  providers: readonly string[],
): string | undefined {
  const raw = resolveConfigString(value);
  if (!raw) {
    return undefined;
  }
  const lower = raw.toLowerCase();
  for (const provider of providers) {
    const prefix = `${provider.toLowerCase()}/`;
    if (lower.startsWith(prefix)) {
      return raw.slice(prefix.length).trim() || undefined;
    }
  }
  return raw;
}

function normalizeCodexCliModelRef(value: string | undefined): string | undefined {
  return normalizeCliModelRef(value, ["openai-codex", "openai"]);
}

function normalizeGeminiCliModelRef(value: string | undefined): string | undefined {
  return normalizeCliModelRef(value, ["google-gemini-cli"]);
}

function isGeminiRuntimeModelRef(value: string): boolean {
  return value.toLowerCase().startsWith("google-gemini-cli/");
}

function normalizePlannerModelRef(value: string | undefined): string | undefined {
  const raw = resolveConfigString(value);
  if (!raw) {
    return undefined;
  }
  return raw;
}

function resolveConfiguredAgentModel(
  config: OpenClawPluginToolContext["config"] | OpenClawPluginApi["config"],
  agentId: string | undefined,
): ResolvedModelConfig {
  if (!config || typeof config !== "object") {
    return { primary: undefined, fallbacks: [] };
  }
  const agents = (config as { agents?: unknown }).agents;
  if (!agents || typeof agents !== "object") {
    return { primary: undefined, fallbacks: [] };
  }

  const list = Array.isArray((agents as { list?: unknown }).list)
    ? ((agents as { list?: unknown[] }).list ?? [])
    : [];
  if (agentId) {
    const match = list.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        resolveConfigString((entry as { id?: unknown }).id) === agentId,
    ) as { model?: unknown } | undefined;
    const override = resolveModelConfig(match?.model);
    if (override.primary || override.fallbacks.length > 0) {
      return {
        primary: normalizePlannerModelRef(override.primary),
        fallbacks: override.fallbacks
          .map((entry) => normalizePlannerModelRef(entry))
          .filter((entry): entry is string => Boolean(entry)),
      };
    }
  }

  const defaults = (agents as { defaults?: unknown }).defaults;
  if (!defaults || typeof defaults !== "object") {
    return { primary: undefined, fallbacks: [] };
  }
  const resolved = resolveModelConfig((defaults as { model?: unknown }).model);
  return {
    primary: normalizePlannerModelRef(resolved.primary),
    fallbacks: resolved.fallbacks
      .map((entry) => normalizePlannerModelRef(entry))
      .filter((entry): entry is string => Boolean(entry)),
  };
}

function resolveConfiguredPlannerModel(
  config: OpenClawPluginToolContext["config"] | OpenClawPluginApi["config"],
  agentId: string | undefined,
): string | undefined {
  return resolveConfiguredAgentModel(config, agentId).primary;
}

function resolvePlannerModel(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
  params: Record<string, unknown>,
): string | undefined {
  const explicit = resolveConfigString(params.plannerModel);
  if (explicit) {
    return explicit;
  }
  const pluginDefault = resolveConfigString(api.pluginConfig?.plannerModel);
  if (pluginDefault) {
    return pluginDefault;
  }
  const cfg = ctx.config ?? api.config;
  if (!cfg) {
    return undefined;
  }
  return resolveConfiguredPlannerModel(cfg, ctx.agentId);
}

function pickFirstModelRef(values: string[], prefixes: string[]): string | undefined {
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (prefixes.some((prefix) => normalized.startsWith(prefix))) {
      return value;
    }
  }
  return undefined;
}

function resolveImplementationModelDefaults(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
): {
  implementationModel?: string;
  implementationFallbackModel?: string;
  fallbackModel?: string;
} {
  const cfg = ctx.config ?? api.config;
  const coderModel = resolveConfiguredAgentModel(cfg, "coder");
  const allRefs = [coderModel.primary, ...coderModel.fallbacks].filter((entry): entry is string =>
    Boolean(entry),
  );
  const implementationModel =
    pickFirstModelRef(allRefs, ["openai-codex/", "openai/"]) ?? coderModel.primary ?? allRefs[0];
  const implementationFallbackModel = coderModel.fallbacks.find(
    (entry) => entry !== implementationModel && !isGeminiRuntimeModelRef(entry),
  );
  const fallbackModel = pickFirstModelRef(
    coderModel.fallbacks.filter((entry) => entry !== implementationFallbackModel),
    ["google-gemini-cli/"],
  );
  return {
    implementationModel: normalizeCodexCliModelRef(implementationModel),
    implementationFallbackModel: normalizeCodexCliModelRef(implementationFallbackModel),
    fallbackModel: normalizeGeminiCliModelRef(fallbackModel),
  };
}

function resolveMaxFixLoops(api: OpenClawPluginApi): number {
  const n = defaultNumber(api.pluginConfig?.maxFixLoops, 3);
  return Math.min(Math.max(1, n), 10);
}

function resolveTimeoutMs(api: OpenClawPluginApi): number {
  const n = defaultNumber(api.pluginConfig?.timeoutMs, 30 * 60_000);
  return Math.min(Math.max(10_000, n), 2 * 60 * 60_000);
}

function resolveDefaultUpstreamRepo(api: OpenClawPluginApi): string {
  return resolveConfigString(api.pluginConfig?.defaultUpstreamRepo) ?? "openclaw/openclaw";
}

function resolveKeepWorkflowFiles(api: OpenClawPluginApi): boolean {
  const raw = api.pluginConfig?.keepWorkflowFiles;
  return typeof raw === "boolean" ? raw : true;
}

function jsonResult(envelope: WorkEnvelope): AgentToolResult<WorkEnvelope> {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    details: envelope,
  };
}

async function runDirectWorkAction(params: {
  action: "review" | "fix";
  workctlPath: string;
  repo: string;
  repoDir: string;
  workRoot: string;
  base: string;
  coderSessionKey: string;
  maxFixLoops: number;
  implementationModel?: string;
  implementationFallbackModel?: string;
  fallbackModel?: string;
  timeoutMs: number;
  maxStdoutBytes: number;
}): Promise<WorkEnvelope> {
  const cwd = process.cwd();
  await runWorkctlJson({
    workctlPath: params.workctlPath,
    subcommand: "ensure-repo",
    args: {
      repo: params.repo,
      "work-root": params.workRoot,
      base: params.base,
      "session-key": params.coderSessionKey,
    },
    cwd,
    timeoutMs: params.timeoutMs,
    maxStdoutBytes: params.maxStdoutBytes,
  });

  const result = await runWorkctlJson({
    workctlPath: params.workctlPath,
    subcommand: params.action,
    args: {
      "repo-dir": params.repoDir,
      base: params.base,
      ...(params.action === "fix"
        ? {
            "max-fix-loops": params.maxFixLoops,
            "implementation-model": params.implementationModel,
            "implementation-fallback-model": params.implementationFallbackModel,
            "fallback-model": params.fallbackModel,
          }
        : {}),
      "session-key": params.coderSessionKey,
    },
    cwd,
    timeoutMs: params.timeoutMs,
    maxStdoutBytes: params.maxStdoutBytes,
  });

  return {
    ok: true,
    status: "ok",
    output: [result],
    requiresApproval: null,
  };
}

export function createWorkTool(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext) {
  return {
    name: "work",
    label: "Work",
    description:
      "Run deterministic coding workflows (new/task/review/fix/ship/merge/upstream) via Lobster with resumable approvals.",
    parameters: Type.Object({
      action: Type.Unsafe<WorkAction>({
        type: "string",
        enum: ["new", "task", "review", "fix", "ship", "merge", "upstream", "resume"],
      }),
      repo: Type.Optional(Type.String({ description: "Repo name or owner/name." })),
      name: Type.Optional(Type.String({ description: "New repo name (for action=new)." })),
      message: Type.Optional(Type.String({ description: "Task description (for action=task)." })),
      base: Type.Optional(Type.String({ description: "Base branch (default: main)." })),
      pr: Type.Optional(Type.Number({ description: "PR number (for action=merge)." })),
      upstream: Type.Optional(
        Type.String({ description: "Upstream repo owner/name (for action=upstream)." }),
      ),
      syncBranch: Type.Optional(
        Type.String({ description: "Sync branch name (for action=upstream)." }),
      ),
      token: Type.Optional(Type.String({ description: "Resume token (for action=resume)." })),
      approve: Type.Optional(Type.Boolean({ description: "Approve resume? (for action=resume)." })),
      plannerModel: Type.Optional(
        Type.String({ description: "Planner/orchestrator model override." }),
      ),
      implementationModel: Type.Optional(
        Type.String({ description: "Primary implementation model override for Codex CLI." }),
      ),
      implementationFallbackModel: Type.Optional(
        Type.String({ description: "Secondary Codex model override before Gemini fallback." }),
      ),
      fallbackModel: Type.Optional(
        Type.String({ description: "Fallback implementation model override for Gemini CLI." }),
      ),
      timeoutMs: Type.Optional(Type.Number()),
      maxStdoutBytes: Type.Optional(Type.Number()),
    }),
    async execute(
      _id: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<WorkEnvelope>> {
      const action = typeof params.action === "string" ? (params.action.trim() as WorkAction) : "";
      if (!action) {
        throw new Error("action required");
      }

      const timeoutMs =
        typeof params.timeoutMs === "number" ? params.timeoutMs : resolveTimeoutMs(api);
      const maxStdoutBytes =
        typeof params.maxStdoutBytes === "number" ? params.maxStdoutBytes : 512_000;

      if (action === "resume") {
        const token = typeof params.token === "string" ? params.token.trim() : "";
        if (!token) {
          throw new Error("token required");
        }
        if (typeof params.approve !== "boolean") {
          throw new Error("approve required");
        }
        const envelope = await resumeWorkLobster(api, {
          token,
          approve: params.approve,
          timeoutMs,
          maxStdoutBytes,
        });
        return jsonResult(envelope);
      }

      const workflowsDir = resolveWorkflowsDir();
      const workflowPath = path.join(workflowsDir, `work-${action}.lobster.yml`);
      const workctlPath = resolveWorkctlPath();

      const workRoot = resolveWorkRoot(api);
      const base =
        typeof params.base === "string" && params.base.trim()
          ? params.base.trim()
          : resolveDefaultBase(api);
      const maxFixLoops = resolveMaxFixLoops(api);
      const coderSessionKey = resolveCoderSessionKey(api);
      const plannerModel = resolvePlannerModel(api, ctx, params);
      const implementationDefaults = resolveImplementationModelDefaults(api, ctx);
      const implementationModel =
        typeof params.implementationModel === "string" && params.implementationModel.trim()
          ? normalizeCodexCliModelRef(params.implementationModel)
          : implementationDefaults.implementationModel;
      const implementationFallbackModel =
        typeof params.implementationFallbackModel === "string" &&
        params.implementationFallbackModel.trim()
          ? normalizeCodexCliModelRef(params.implementationFallbackModel)
          : implementationDefaults.implementationFallbackModel;
      const fallbackModel =
        typeof params.fallbackModel === "string" && params.fallbackModel.trim()
          ? normalizeGeminiCliModelRef(params.fallbackModel)
          : implementationDefaults.fallbackModel;

      const args: Record<string, unknown> = {
        workRoot,
        base,
        maxFixLoops,
        agentId: ctx.agentId,
        workspaceDir: ctx.workspaceDir,
        workctlPath,
        coderSessionKey,
      };

      if (action === "new") {
        const name = typeof params.name === "string" ? params.name.trim() : "";
        if (!name) {
          throw new Error("name required");
        }
        args.name = name;
      } else {
        const repo = typeof params.repo === "string" ? params.repo.trim() : "";
        if (!repo) {
          throw new Error("repo required");
        }
        args.repo = repo;
        args.repoDir = path.join(workRoot, repoRelativePath(repo));
      }

      if (action === "review" || action === "fix") {
        const repo = typeof args.repo === "string" ? args.repo : "";
        const repoDir = typeof args.repoDir === "string" ? args.repoDir : "";
        if (!repo || !repoDir) {
          throw new Error("repo required");
        }
        const envelope = await runDirectWorkAction({
          action,
          workctlPath,
          repo,
          repoDir,
          workRoot,
          base,
          coderSessionKey,
          maxFixLoops,
          implementationModel,
          implementationFallbackModel,
          fallbackModel,
          timeoutMs,
          maxStdoutBytes,
        });
        return jsonResult(envelope);
      }

      if (action === "task") {
        const message = typeof params.message === "string" ? params.message.trim() : "";
        if (!message) {
          throw new Error("message required");
        }
        args.message = message;
      }

      if (plannerModel) {
        args.plannerModel = plannerModel;
      }
      if (implementationModel) {
        args.implementationModel = implementationModel;
      }
      if (implementationFallbackModel) {
        args.implementationFallbackModel = implementationFallbackModel;
      }
      if (fallbackModel) {
        args.fallbackModel = fallbackModel;
      }

      if (action === "merge") {
        const pr = typeof params.pr === "number" ? params.pr : NaN;
        if (!Number.isFinite(pr) || pr <= 0) {
          throw new Error("pr required");
        }
        args.pr = pr;
      }

      if (action === "upstream") {
        const upstream =
          typeof params.upstream === "string" && params.upstream.trim()
            ? params.upstream.trim()
            : resolveDefaultUpstreamRepo(api);
        const syncBranch =
          typeof params.syncBranch === "string" && params.syncBranch.trim()
            ? params.syncBranch.trim()
            : `chore/sync-upstream-${base}`;
        args.upstreamRepo = upstream;
        args.syncBranch = syncBranch;
        args.keepWorkflowFiles = resolveKeepWorkflowFiles(api);
      }

      const argsJson = JSON.stringify(args);
      const envelope = await runWorkLobster(api, {
        workflowPath,
        argsJson,
        timeoutMs,
        maxStdoutBytes,
      });
      return jsonResult(envelope);
    },
  };
}
