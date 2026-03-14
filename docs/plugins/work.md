---
title: "Work Plugin"
summary: "Deterministic, approval-gated coding workflows using Lobster, GitHub App auth, and a sandboxed Codex-first coder session."
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
   - builds a structured spec packet and sends that packet directly to the implementation CLI
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
- Service auth available to that environment:
  - `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_FILE`
  - OpenClaw `openai-codex` OAuth for runtime `openai-codex/*`
  - `OPENAI_API_KEY` for runtime `openai/*`
  - `GEMINI_API_KEY` for runtime `google/*`
  - Codex CLI and Gemini CLI OAuth state if you run implementation CLIs directly inside the sandbox

## Install

This plugin ships in the main `openclaw` package under `extensions/work`.

Production recommendation:

- Use the bundled plugin from your live OpenClaw runtime.
- On the VPS pack, that means the promoted release under `~/openclaw-current`.
- Install the Lobster runtime separately from `@clawdbot/lobster`. `@openclaw/lobster` is the OpenClaw plugin package and does not provide the `lobster` executable.
- Prefer an absolute `lobsterPath` such as `/usr/bin/lobster` on Linux hosts.
- Do not add `plugins.load.paths` for `work` on a VPS unless you are explicitly testing a source checkout.
- Do not keep a separate `~/.openclaw/extensions/work` copy once you move to the bundled production path.

This repo also includes the source at `extensions/work` for development and local testing.

Install it as a local plugin:

```bash
openclaw plugins install ./extensions/work
```

Restart the Gateway afterwards so it loads the plugin.

If you are developing the plugin from a source checkout, `openclaw plugins install ./extensions/work` remains supported. That path now installs runtime dependencies inside the plugin and ignores repo-local `node_modules` shims.

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

For a subscription-auth VPS pack, pair that with agent models like:

```json5
{
  plugins: {
    entries: {},
  },
  agents: {
    list: [
      {
        id: "main",
        model: {
          primary: "openai-codex/gpt-5.3-codex",
          fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
        },
      },
      {
        id: "coder",
        model: {
          primary: "openai-codex/gpt-5.3-codex",
          fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
        },
        thinkingDefault: "high",
      },
    ],
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

## Repo intake and implementation handoff

`/work` accepts:

- repo names already present under `workRoot`
- `owner/repo`
- full GitHub HTTPS URLs

For task and fix runs, the plugin resolves the repo into `~/work/repos/<owner>/<repo>`, fetches the default branch, detects active PRs, and writes a structured spec packet that includes:

- repo identity and working branch
- goal and non-goals
- acceptance criteria
- risk tier
- required local checks
- approval requirements
- implementation settings such as primary CLI, fallback CLI, available CLIs, access mode, and auth mode

That packet is handed to Codex CLI as serialized input instead of being flattened into a plain ad hoc prompt. The run audit also records:

- selected implementation CLI
- probed toolchain
- GitHub auth mode
- approval and merge state

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
3. Run a coding agent CLI (`codex` with a best-effort fallback to `gemini`) using the serialized spec packet.
4. Run deterministic checks based on the repo lockfile.
   - If the repo contains `.clawforge/contract.json`, `/work` uses it to choose risk-aware checks (for example `test:fast` on low risk changes, `build` and `protocol:check` on high risk changes, and `test:ui` when UI evidence is required).
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

On Telegram, `/work` also renders inline **Approve** / **Deny** buttons for
these Lobster checkpoints. The message still includes the resume token and
manual resume commands as fallback.

Resume from chat:

```text
/work resume <token> --approve yes
/work resume <token> --approve no
```

## CI and merge policy

Recommended approach:

- Local `/work` loop makes the change clean before pushing.
- GitHub Actions remains the merge gate (format, lint, typecheck, tests, build, security checks).
- CodeRabbit is best treated as a PR signal (comments) and as a local loop input. If you make it blocking, keep it limited to high risk changes and enforce current head SHA discipline.

`/work merge` also runs a merge preflight before calling `gh pr merge`. It blocks when:

- the PR head SHA does not match the expected head SHA
- the PR is still a draft
- merge state is not clean enough to proceed
- review decision is `CHANGES_REQUESTED`
- required checks are failed or still pending
- approvals are not fully resolved

See [ClawForge](/automation/clawforge), [CI](/ci), and [Coding automation pipeline](/automation/coding-pipeline) for a reference gate template.

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
