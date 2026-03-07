# OpenClaw VPS Coding Automation Pack

This folder is the “implementation bundle” for the secure VPS setup + `/work` coding pipeline:

- OpenClaw config template (`openclaw.vps-coding.json5`)
- A custom coder sandbox image Dockerfile
- Bootstrap script to install prerequisites and wire everything up on Ubuntu 24.04

## What this gives you

- Gateway binds to **loopback** by default (no public exposure). If you want the Control UI remotely, expose it privately over **Tailscale Serve**.
- Telegram is the primary interface with **owner-allowlisted DMs** and **dedicated allowlisted groups** for `coder`, `power`, and `devops`.
- The operator-facing `main` agent presents as **Ted** and runs `gpt-5.4` for research, specs, approvals, and orchestration.
- A `coder` agent runs tool execution inside Docker sandbox with network enabled (for `git`, `gh`, `codex`, `gemini`, `coderabbit`).
- A `/work` command (plugin `work`) runs **Lobster workflows** with approval gates for commit/push/merge and GitHub App-backed repo access.
- Phase-two Telegram client takeover is available through allowlisted `channels.telegram.clients` routes and the `/client` operator command.

## Files

- `ops/vps/openclaw.vps-coding.json5`
  - Copy to `$OPENCLAW_STATE_DIR/openclaw.json` (typically `~/.openclaw/openclaw.json`).
- `ops/vps/Dockerfile.openclaw-sandbox-coder`
  - Build as `openclaw-sandbox-coder:bookworm` and set in config.
- `ops/vps/bootstrap-ubuntu24.sh`
  - Idempotent-ish bootstrap to install Docker, Tailscale, OpenClaw, host Codex/Gemini CLIs, and build the sandbox image.
- `ops/vps/wake-agents.sh`
  - Wakes `coder`, `power`, and `devops` and posts one online ping to each dedicated Telegram group.
- `ops/vps/SETUP.md`
  - End-to-end setup guide + acceptance checks.

## Notes

- This pack assumes you run the Gateway on the VPS (single-host mode) and decommission Railway after cutover.
- The `/work` plugin is bundled under `extensions/work` but **disabled by default**; config enables it.
- The bootstrap script installs Tailscale but does not join your tailnet; run `tailscale up` manually.
- Repo intake defaults to `~/work/repos/<owner>/<repo>`.
