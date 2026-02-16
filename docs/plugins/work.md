---
title: "Work Plugin"
summary: "Deterministic, approval-gated coding workflows using Lobster plus a sandboxed coder agent session."
read_when:
  - You want a CLI-first coding pipeline from chat with explicit approvals
  - You want to run Codex CLI, Gemini CLI, and CodeRabbit CLI inside a sandbox
  - You want a bounded review loop with predictable stop conditions
---

# Work (plugin)

The Work plugin adds a `/work` command that runs deterministic coding workflows through **Lobster**, with explicit approval gates for side effects.

Use it to drive a CLI-first pipeline from chat:

- Create a repo scaffold and push it only after approval.
- Implement a task on a `work/*` branch.
- Run local checks and a CodeRabbit review pass.
- Commit, push, open a PR, and merge only after approvals.
- Sync your fork from upstream with approval-gated push and PR publication.

If you want a security-first VPS setup for this, see [VPS coding automation](/install/vps-coding).

If you want the end-to-end pipeline design (bounded review loop, CI gates, context hygiene), see [Coding automation pipeline](/automation/coding-pipeline).

## How it works

The plugin runs as part of the Gateway process and follows this pattern:

1. `/work ...` bypasses the LLM and routes to the plugin command handler (deterministic).
2. The command runs a Lobster workflow file (`work-*.lobster.yml`).
3. Workflow steps call a small helper script (`workctl`) that:
   - calls the Gateway HTTP endpoint `POST /tools/invoke`
   - targets a specific session key (usually a sandboxed `coder` agent session)
4. Lobster approvals pause the workflow and return a resume token.
5. You resume from chat with `/work resume <token> --approve yes|no`.

This keeps the orchestration thin and pushes repeatable logic into workflows and scripts.

Related:

- Lobster tool and approvals: [Lobster](/tools/lobster)
- Tools Invoke API: [Tools Invoke API](/gateway/tools-invoke-http-api)
- Sandboxing: [Sandboxing](/gateway/sandboxing)
- Exec approvals: [Exec approvals](/tools/exec-approvals)

## Safety model

`/work` is designed to be "safe by default" for a single operator:

- The command is deterministic and does not rely on the LLM for orchestration.
- Side effects (commit, push, PR creation, merge) are approval-gated.
- You are expected to route execution through a sandboxed `coder` agent session key.
- You can keep the chat-facing agent minimal (deny shell and write tools) so prompt injection in chat has limited blast radius.

For the full mental model of why something is blocked, see [Sandbox vs tool policy vs elevated](/gateway/sandbox-vs-tool-policy-vs-elevated).

## Requirements

- The `lobster` CLI available on the Gateway host.
- Gateway auth enabled (`gateway.auth.token` or `gateway.auth.password`).
- A sandboxed execution session (recommended): a `coder` agent that can run `exec` in Docker.
- Coding CLIs available in that execution environment:
  - `git`
  - `gh`
  - `codex`
  - `gemini`
  - `coderabbit`

## Install

This plugin lives at `extensions/work` in this repo.

Install it as a local plugin:

```bash
openclaw plugins install ./extensions/work
```

Restart the Gateway afterwards so it loads the plugin.

## Enable and configure

Enable and configure under `plugins.entries.work`:

```json5
{
  plugins: {
    entries: {
      work: {
        enabled: true,
        config: {
          // Prefer an absolute path in production to reduce PATH hijack risk.
          // lobsterPath: "/usr/local/bin/lobster",

          workRoot: "~/work",
          defaultBase: "main",

          // Session key used by workctl to run tools via POST /tools/invoke.
          // Recommended: a sandboxed coder agent session.
          coderSessionKey: "agent:coder:main",

          maxFixLoops: 3,
          timeoutMs: 1800000, // 30m
          defaultUpstreamRepo: "openclaw/openclaw",
          keepWorkflowFiles: true,
        },
      },
    },
  },
}
```

Config keys:

- `lobsterPath` (optional): absolute path to `lobster`. Default: `lobster` from `$PATH`.
- `workRoot` (optional): directory containing repos (default `~/work`).
- `defaultBase` (optional): base branch name (default `main`).
- `coderSessionKey` (optional): session key for tool execution (default `agent:coder:main`).
- `maxFixLoops` (optional): bounded remediation loops for check failures (default 3).
- `timeoutMs` (optional): Lobster execution timeout (default 30 minutes).
- `defaultUpstreamRepo` (optional): default owner/name for `/work upstream` (default `openclaw/openclaw`).
- `keepWorkflowFiles` (optional): keep local `.github/workflows` authoritative during upstream sync (default `true`).

## Recommended policy and sandbox setup

Keep the chat-facing agent (`main`) minimal and deny shell and filesystem mutation tools. Route all execution through a dedicated sandboxed agent (`coder`).

Example `coder` agent shape:

```json5
{
  agents: {
    list: [
      {
        id: "coder",
        workspace: "~/work",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "rw",
          docker: {
            image: "openclaw-sandbox-coder:bookworm",
            network: "bridge",
          },
        },
        tools: {
          profile: "minimal",
          allow: ["exec", "process", "read", "write", "edit", "apply_patch"],
          deny: ["browser", "nodes", "gateway", "sessions_spawn", "sessions_send"],
        },
      },
    ],
  },
}
```

See [Sandboxing](/gateway/sandboxing) and [Tool policy](/gateway/sandbox-vs-tool-policy-vs-elevated).

## Commands

```text
/work new <repo-name>
/work task <repo|owner/name> <description> [--base main]
/work review <repo|owner/name> [--base main]
/work fix <repo|owner/name> [--base main]
/work ship <repo|owner/name> [--base main]
/work merge <repo|owner/name>#<prNumber>
/work upstream <repo|owner/name> [--base main] [--upstream owner/name] [--sync-branch branch]
/work resume <resumeToken> --approve yes|no
```

Behavior notes:

- All actions require an authorized sender (pairing or allowlist).
- Risky steps are approval-gated by Lobster:
  - pushing to remote
  - opening a PR
  - merging a PR
- Work branches use the prefix `work/` and commits are refused outside those branches.

### upstream sync workflow

`/work upstream` is the agent-operated maintenance path for keeping a fork current without auto-merging to your base branch:

1. Ensure local clone exists and fetch `origin/<base>` and `upstream/<base>`.
2. Prepare sync commit on a dedicated sync branch (default `chore/sync-upstream-<base>`).
3. Keep local `.github/workflows` authoritative by default.
4. Pause for approval.
5. After approval, push sync branch and create or update a PR into `<base>`.

Stop conditions:

- If already in sync: returns `already_synced`.
- If conflicts exist: returns `conflicts` with a file list.
- If delta is empty after keep rules: returns `no_delta_after_keep_rules`.

## Workflow behavior

### task and fix loop

For `task` and `fix`:

1. Ensure a clean worktree.
2. Check out `base` and create a `work/*` branch.
3. Run a coding agent CLI (`codex` with a best-effort fallback to `gemini`).
4. Run deterministic checks based on the repo lockfile.
5. Run a CodeRabbit review pass.
6. Stop after `maxFixLoops` if checks remain failing, and return a report.

Practical tips:

- Treat the loop as bounded automation, not an infinite agent. If it fails repeatedly, stop and ask for a human decision.
- Keep the coding agent prompt template strict (no secrets exfiltration, stop on unclear requirements, ask before risky changes).
- Keep checks deterministic and fast. Prefer format, lint, typecheck, unit tests. Avoid flaky e2e tests in the loop.

### approvals and resume

If a workflow pauses, you get:

- a prompt
- a `resumeToken`

Resume from chat:

```text
/work resume <token> --approve yes
/work resume <token> --approve no
```

## CI and merge policy

Recommended approach:

- Local `/work` loop makes the change clean before pushing.
- GitHub Actions remains the merge gate (format, lint, typecheck, tests, build, security checks).
- CodeRabbit is best treated as a PR signal (comments) and as a local loop input. Avoid making it a hard merge blocker if its output is nondeterministic for your repos.

See [CI](/ci) and [Coding automation pipeline](/automation/coding-pipeline) for a reference gate template.

## Troubleshooting

### Tools Invoke returns 404

`POST /tools/invoke` returns 404 when the tool is not available under policy.

Common fixes:

- Ensure the target `coderSessionKey` resolves to a session whose agent allows `exec`.
- Ensure `gateway.tools.deny` is not blocking the tool over HTTP.

See [Tools Invoke API](/gateway/tools-invoke-http-api).

### Missing Gateway auth

`workctl` calls `POST /tools/invoke` and requires auth.

- Set `OPENCLAW_GATEWAY_TOKEN` (or `OPENCLAW_GATEWAY_PASSWORD`) in the daemon env.
- Ensure `gateway.auth` is configured.

### Coding CLIs not found

If `codex`, `gemini`, `coderabbit`, or `gh` are missing:

- Install them in the environment where `exec` runs (recommended: inside the `coder` sandbox image).
- Confirm `exec` is running with the expected session key.
