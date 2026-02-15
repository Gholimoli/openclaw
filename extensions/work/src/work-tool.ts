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

function defaultNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function repoBasename(repo: string): string {
  const trimmed = repo.trim();
  const parts = trimmed.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? trimmed) : trimmed;
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
  return api.resolvePath(cfg ?? "~/work");
}

function resolveDefaultBase(api: OpenClawPluginApi): string {
  return resolveConfigString(api.pluginConfig?.defaultBase) ?? "main";
}

function resolveCoderSessionKey(api: OpenClawPluginApi): string {
  return resolveConfigString(api.pluginConfig?.coderSessionKey) ?? "agent:coder:main";
}

function resolveMaxFixLoops(api: OpenClawPluginApi): number {
  const n = defaultNumber(api.pluginConfig?.maxFixLoops, 3);
  return Math.min(Math.max(1, n), 10);
}

function resolveTimeoutMs(api: OpenClawPluginApi): number {
  const n = defaultNumber(api.pluginConfig?.timeoutMs, 30 * 60_000);
  return Math.min(Math.max(10_000, n), 2 * 60 * 60_000);
}

function jsonResult(envelope: WorkEnvelope): AgentToolResult<WorkEnvelope> {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    details: envelope,
  };
}

export function createWorkTool(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext) {
  return {
    name: "work",
    label: "Work",
    description:
      "Run deterministic coding workflows (new/task/review/fix/ship/merge) via Lobster with resumable approvals.",
    parameters: Type.Object({
      action: Type.Unsafe<WorkAction>({
        type: "string",
        enum: ["new", "task", "review", "fix", "ship", "merge", "resume"],
      }),
      repo: Type.Optional(Type.String({ description: "Repo name or owner/name." })),
      name: Type.Optional(Type.String({ description: "New repo name (for action=new)." })),
      message: Type.Optional(Type.String({ description: "Task description (for action=task)." })),
      base: Type.Optional(Type.String({ description: "Base branch (default: main)." })),
      pr: Type.Optional(Type.Number({ description: "PR number (for action=merge)." })),
      token: Type.Optional(Type.String({ description: "Resume token (for action=resume)." })),
      approve: Type.Optional(Type.Boolean({ description: "Approve resume? (for action=resume)." })),
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

      const workRoot = resolveWorkRoot(api);
      const base =
        typeof params.base === "string" && params.base.trim()
          ? params.base.trim()
          : resolveDefaultBase(api);

      const args: Record<string, unknown> = {
        workRoot,
        base,
        maxFixLoops: resolveMaxFixLoops(api),
        agentId: ctx.agentId,
        workspaceDir: ctx.workspaceDir,
        workctlPath: resolveWorkctlPath(),
        coderSessionKey: resolveCoderSessionKey(api),
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
        args.repoDir = path.join(workRoot, repoBasename(repo));
      }

      if (action === "task") {
        const message = typeof params.message === "string" ? params.message.trim() : "";
        if (!message) {
          throw new Error("message required");
        }
        args.message = message;
      }

      if (action === "merge") {
        const pr = typeof params.pr === "number" ? params.pr : NaN;
        if (!Number.isFinite(pr) || pr <= 0) {
          throw new Error("pr required");
        }
        args.pr = pr;
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
