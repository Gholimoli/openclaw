---
title: "Coding Automation Pipeline"
summary: "CLI-first, approval-gated coding workflows (Codex CLI, Gemini CLI, CodeRabbit) orchestrated by Lobster and /work."
read_when:
  - You want a deterministic, bounded coding automation loop
  - You want explicit approvals for commits, pushes, PRs, and merges
  - You want to minimize token burn by keeping orchestration thin
---

# Coding automation pipeline (CLI first)

This guide describes a secure, stable way to automate coding work with OpenClaw while keeping the LLM "thin":

- Chat (Telegram, web) is the control plane.
- Tool execution happens in a dedicated sandboxed `coder` agent session.
- Multi-step orchestration is deterministic via Lobster.
- Risky steps are approval-gated and resumable.

If you want the full VPS setup for this, start at [VPS coding automation](/install/vps-coding). If you want the concrete implementation, see the [Work plugin](/plugins/work).

## Design principles

- Deterministic harness first: workflows live in code or a DSL, not in the LLM conversation.
- One call instead of many: collapse multi-step loops into a single workflow invocation (token efficiency and auditability).
- Explicit approvals for side effects: commits, pushes, PR creation, merges, and anything that can exfiltrate or mutate state.
- Least privilege by default: keep chat-facing agents minimal, route execution to a sandboxed agent.
- Bounded loops: stop after a small number of remediation iterations and return a structured report.

## Components

- OpenClaw Gateway: routing, policy enforcement, approvals, and channels.
- Telegram DM (recommended): operator interface with pairing and group disable by default.
- Tailscale: private access to the Control UI and debugging surfaces.
- Docker sandbox: tool execution boundary for the `coder` agent.
- Coding CLIs: `git`, `gh`, `codex`, `gemini`, `coderabbit`.
- Lobster: workflow runtime with resumable approvals.

## Workflow surface

The recommended user-facing interface is `/work` (a deterministic plugin command):

- `/work new <name>`: scaffold a repo and (after approval) create/push it on GitHub.
- `/work task <repo> <description>`: implement a change on a `work/*` branch, run checks, run a review pass.
- `/work review <repo>`: run checks and CodeRabbit review and return a fix list.
- `/work fix <repo>`: apply a bounded remediation loop to resolve failures.
- `/work ship <repo>`: (after approval) push branch and open a PR.
- `/work merge <repo>#<prNumber>`: (after approval) merge only if CI is green.
- `/work upstream <repo>`: prepare upstream sync on a dedicated branch, then (after approval) push and open/update a sync PR.

See [Work plugin](/plugins/work) for the exact command syntax.

## Agent operator loop (proactive but bounded)

If you want one agent to operate your pipeline proactively, use this split:

- `main` agent: chat, intent routing, and approvals only.
- `coder` agent: sandboxed tool execution only.
- `ops` agent: disabled by default; enabled only for maintenance windows.

Recommended proactive loop:

1. Trigger daily or every few days (cron or heartbeat).
2. Run `/work upstream <repo>` for fork maintenance.
3. Run `/work review <repo>` against active feature branches.
4. If checks or review fail, run `/work fix <repo>` up to bounded limits.
5. Send structured status back to chat with:
   - what changed
   - what failed
   - whether approval is required

Self-healing boundaries:

- Allowed automatically:
  - retry transient network failures with capped attempts
  - rerun deterministic local checks
  - open/update non-merge PRs
- Never automatic:
  - direct merge to base
  - token/secret changes
  - policy broadening (tool allowlists, sandbox disable, elevated enable)

This gives adaptive behavior without losing operator control.

## The bounded review loop

Recommended bounded loop for `task` and `fix`:

1. Create branch `work/<date>-<slug>` off your base branch.
2. Implementation pass using a coding CLI:
   - Prefer `codex` as primary, `gemini` as fallback.
3. Deterministic local checks:
   - format and lint
   - typecheck (when applicable)
   - unit tests
4. CodeRabbit review pass (CLI) to produce a fix list.
5. If there are findings or checks failed:
   - summarize into a compact fix list
   - run one remediation pass
   - repeat up to `maxFixLoops` (default 3)
6. Stop condition:
   - if still failing after `maxFixLoops`, halt and return a structured report (commands run, failures, log tail, suggested next action).

Why bounded loops matter:

- They prevent runaway automation loops and uncontrolled cost.
- They keep the pipeline predictable and reviewable.
- They make failure modes actionable.

## Context hygiene (token and time)

Coding automation improves when the agent has stable, versioned project context that does not need to be re-derived from raw logs and long diffs every run.

Recommended: keep a small `context/` folder in each repo (or a separate "context repo") with durable, human-curated facts and constraints.

Details: [Context repositories](/automation/context-repositories).

## Security posture (recommended)

The key idea is to separate the chat surface from the execution surface.

1. Keep the Gateway private:
   - `gateway.bind="loopback"` (recommended)
   - remote access via Tailscale Serve or SSH tunnel
2. Keep chat authorization strict:
   - Telegram `dmPolicy="pairing"`
   - groups disabled by default
3. Keep the main agent minimal:
   - deny `exec`, `process`, and filesystem mutation tools on `main`
4. Run execution in a dedicated sandboxed `coder` agent:
   - Docker sandbox enabled for the agent session key
   - tool policy allow only what the workflows require
5. Use approvals for side effects:
   - Lobster approvals for commit, push, PR, merge
   - optional: forward exec approvals to chat with `/approve` (see [Exec approvals](/tools/exec-approvals))

Related reading:

- [Gateway security](/gateway/security)
- [Sandboxing](/gateway/sandboxing)
- [Sandbox vs tool policy vs elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- [Tools Invoke API](/gateway/tools-invoke-http-api)

## CI gates (merge blocking)

Treat GitHub Actions as the merge gate. Your local `/work` loop should make PRs clean before push, but CI is the final lock.

Recommended merge blocking checks:

- format and lint checks
- typecheck (if applicable)
- unit tests
- build (if applicable)
- secret scanning
- dependency scanning (Dependabot alerts; optionally SBOM)

Recommended CodeRabbit usage:

- Run CodeRabbit in the local `/work` loop as an input to the fix list.
- Keep CodeRabbit in CI as informational at first if its output can be nondeterministic for your repos.

## Runbooks (stability)

- Routine:
  - run `openclaw security audit --deep` after config changes
  - run `openclaw doctor` after upgrades
- Backups:
  - provider snapshots (daily) for the VPS
  - periodic encrypted archive of state and workspace (see [Migrating](/install/migrating))
- Incident response:
  - stop the Gateway
  - rotate provider keys and tokens
  - audit recent sessions and logs
  - restore only after rotation

## References and inspiration (external)

These are not required dependencies. They are useful reading or optional integrations that influenced the CLI-first pipeline design:

- Deterministic orchestration and harness-first design: https://openai.com/index/harness-engineering/
- Shell ergonomics for robust pipelines: https://developers.openai.com/blog/skills-shell-tips
- Context repositories pattern: https://www.letta.com/blog/context-repositories
- Compact summaries of large artifacts: https://github.com/steipete/summarize/releases/tag/v0.11.1
- Google Workspace automation (optional): https://github.com/steipete/gogcli/releases
- X automation (optional): https://github.com/Infatoshi/x-cli
- Broad integrations marketplace option (optional): https://github.com/ComposioHQ/open-claude-cowork/
- Extra sandboxing inspiration: https://github.com/tomascupr/sandstorm
- Browser and MCP future option (not CLI-first): https://developer.chrome.com/blog/webmcp-epp
