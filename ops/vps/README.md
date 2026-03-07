# OpenClaw VPS Coding Automation Pack

This folder is the “implementation bundle” for the secure VPS setup + `/work` coding pipeline:

- OpenClaw config template (`openclaw.vps-coding.json5`)
- A custom coder sandbox image Dockerfile
- Bootstrap script to install prerequisites and wire everything up on Ubuntu 24.04
- Manual CLI login helper for emergency host sessions

## What this gives you

- Gateway binds to **loopback** by default (no public exposure). If you want the Control UI remotely, expose it privately over **Tailscale Serve**.
- Telegram is the primary interface with **owner-allowlisted DMs** and **dedicated allowlisted groups** for `coder`, `power`, and `devops`.
- The operator-facing `main` agent presents as **Ted** and runs `gpt-5.4` for research, specs, approvals, and orchestration.
- A `coder` agent runs tool execution inside Docker sandbox with network enabled (for `git`, `gh`, `codex`, `gemini`, `cursor-agent`, `gcloud`, `x-cli`, `coderabbit`).
- OpenClaw approvals stay in place for Ted and host execution; nested coding CLIs inside the coder sandbox are configured for full-access agent runs.
- A `/work` command (plugin `work`) runs **Lobster workflows** with approval gates for commit/push/merge, GitHub App-backed repo access, structured spec-packet handoff to Codex/Gemini, and merge preflight checks.
- Unattended runs use a hybrid auth model:
  - GitHub App installation tokens for repo and PR actions
  - `OPENAI_API_KEY` for Codex CLI
  - `GEMINI_API_KEY` for Gemini CLI
- Manual host use stays separate from `/work` and uses `tmux`-backed one-time login sessions for `codex`, `gh`, optional `gemini`, and `agent`.
- Phase-two Telegram client takeover is available through allowlisted `channels.telegram.clients` routes and the `/client` operator command.

## Files

- `ops/vps/openclaw.vps-coding.json5`
  - Copy to `$OPENCLAW_STATE_DIR/openclaw.json` (typically `~/.openclaw/openclaw.json`).
- `ops/vps/Dockerfile.openclaw-sandbox-coder`
  - Build as `openclaw-sandbox-coder:bookworm` and set in config.
- `ops/vps/bootstrap-ubuntu24.sh`
  - Idempotent-ish bootstrap to install Docker, Tailscale, OpenClaw, host Codex/Gemini/Cursor/gcloud/x-cli tooling, and build the sandbox image.
- `ops/vps/configure-coding-clis.sh`
  - Seeds Ted workspace guidance, Codex/Gemini full-access defaults, helper wrappers, and optional X/gcloud auth.
- `ops/vps/login-coding-clis.sh`
  - Starts an interactive `tmux` session as the primary service user and launches `codex login`, `gh auth login`, optional `gemini`, or `agent`.
- `ops/vps/TED_AGENTS.md`
  - Workspace `AGENTS.md` seed that tells Ted which CLIs are installed and where the approval boundary lives.
- `ops/vps/wake-agents.sh`
  - Wakes `coder`, `power`, and `devops` and posts one online ping to each dedicated Telegram group.
- `ops/vps/SETUP.md`
  - End-to-end setup guide + acceptance checks.

## Notes

- This pack assumes you run the Gateway on the VPS (single-host mode) and decommission Railway after cutover.
- The `/work` plugin is bundled under `extensions/work` but **disabled by default**; config enables it.
- The bootstrap script installs Tailscale but does not join your tailnet; run `tailscale up` manually.
- Repo intake defaults to `~/work/repos/<owner>/<repo>`.
- Manual CLI login is for operator sessions only. Keep unattended `/work` runs on GitHub App + service credentials rather than interactive host logins.
