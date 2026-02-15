import type { OpenClawPluginApi, PluginCommandContext } from "../../../src/plugins/types.js";
import { createWorkTool } from "./work-tool.js";

function parseApprove(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === "yes" || v === "y" || v === "true" || v === "1" || v === "allow") {
    return true;
  }
  if (v === "no" || v === "n" || v === "false" || v === "0" || v === "deny") {
    return false;
  }
  return null;
}

function parseFlags(argv: string[]): { flags: Record<string, string | boolean>; rest: string[] } {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (!tok.startsWith("--")) {
      rest.push(tok);
      continue;
    }
    const key = tok.slice(2).trim();
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { flags, rest };
}

function usage() {
  return [
    "Usage:",
    "/work new <repo-name>",
    "/work task <repo|owner/name> <description> [--base main]",
    "/work review <repo|owner/name> [--base main]",
    "/work fix <repo|owner/name> [--base main]",
    "/work ship <repo|owner/name> [--base main]",
    "/work merge <repo|owner/name>#<prNumber>",
    "/work resume <resumeToken> --approve yes|no",
  ].join("\n");
}

export function registerWorkCommand(api: OpenClawPluginApi) {
  api.registerCommand({
    name: "work",
    description: "Run deterministic coding workflows (new/task/review/fix/ship/merge) via Lobster.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: PluginCommandContext) => {
      if (!ctx.isAuthorizedSender) {
        return { text: "Not authorized." };
      }

      const raw = (ctx.args ?? "").trim();
      if (!raw) {
        return { text: usage() };
      }

      const argv = raw.split(/\s+/g).filter(Boolean);
      const sub = (argv.shift() ?? "").trim().toLowerCase();
      const { flags, rest } = parseFlags(argv);

      const baseFlag = typeof flags.base === "string" ? String(flags.base) : undefined;

      // Create a tool instance with the current agent workspace context so it can compute paths.
      const tool = createWorkTool(api, {
        config: ctx.config,
        agentId: "main",
        workspaceDir: undefined,
        sandboxed: false,
      });

      try {
        const formatEnvelope = (env: any) => {
          if (!env || typeof env !== "object") {
            return String(env);
          }
          if (env.ok !== true) {
            const msg = env?.error?.message
              ? String(env.error.message)
              : JSON.stringify(env, null, 2);
            return `work failed:\n${msg}`;
          }
          if (env.status === "needs_approval") {
            const prompt = env?.requiresApproval?.prompt
              ? String(env.requiresApproval.prompt)
              : "Approval required.";
            const token = env?.requiresApproval?.resumeToken
              ? String(env.requiresApproval.resumeToken)
              : "";
            const tokenLine = token
              ? `\n\nresumeToken:\n${token}\n\nResume:\n/work resume ${token} --approve yes\n/work resume ${token} --approve no`
              : "";
            return `${prompt}${tokenLine}`;
          }
          return JSON.stringify(env, null, 2);
        };

        if (sub === "resume") {
          const token = rest[0] ?? "";
          const approveRaw = typeof flags.approve === "string" ? String(flags.approve) : "";
          const approve = parseApprove(approveRaw);
          if (!token || approve === null) {
            return { text: usage() };
          }
          const result = await tool.execute("work", { action: "resume", token, approve });
          return { text: formatEnvelope(result.details) };
        }

        if (sub === "new") {
          const name = rest[0] ?? "";
          if (!name) {
            return { text: usage() };
          }
          const result = await tool.execute("work", { action: "new", name });
          return { text: formatEnvelope(result.details) };
        }

        if (sub === "merge") {
          const ref = rest[0] ?? "";
          const m = ref.match(/^(?<repo>[^#]+)#(?<pr>[0-9]+)$/);
          const repo = m?.groups?.repo?.trim() ?? "";
          const pr = m?.groups?.pr ? Number.parseInt(m.groups.pr, 10) : NaN;
          if (!repo || !Number.isFinite(pr) || pr <= 0) {
            return { text: usage() };
          }
          const result = await tool.execute("work", { action: "merge", repo, pr, base: baseFlag });
          return { text: formatEnvelope(result.details) };
        }

        if (sub === "task") {
          const repo = rest[0] ?? "";
          const message = rest.slice(1).join(" ").trim();
          if (!repo || !message) {
            return { text: usage() };
          }
          const result = await tool.execute("work", {
            action: "task",
            repo,
            message,
            base: baseFlag,
          });
          return { text: formatEnvelope(result.details) };
        }

        if (sub === "review" || sub === "fix" || sub === "ship") {
          const repo = rest[0] ?? "";
          if (!repo) {
            return { text: usage() };
          }
          const result = await tool.execute("work", { action: sub, repo, base: baseFlag });
          return { text: formatEnvelope(result.details) };
        }

        return { text: usage() };
      } catch (err) {
        return { text: `work failed: ${String(err)}` };
      }
    },
  });
}
