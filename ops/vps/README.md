# OpenClaw VPS Coding Automation Pack

This folder is the “implementation bundle” for the secure VPS setup + `/work` coding pipeline:

- OpenClaw config template (`openclaw.vps-coding.json5`)
- A custom coder sandbox image Dockerfile
- Bootstrap script to install prerequisites and wire everything up on Ubuntu 24.04
- Manual CLI login helper for emergency host sessions

## What this gives you

- Gateway binds to **loopback** by default (no public exposure). If you want the Control UI remotely, expose it privately over **Tailscale Serve**.
- Telegram is the primary interface with **owner-allowlisted DMs** and **dedicated allowlisted groups** for `coder`, `power`, and `devops`.
- The operator-facing `main` agent presents as **Ted** and uses `openai-codex/gpt-5.3-codex`, with `openai-codex/gpt-5.2` then `google-gemini-cli/gemini-3-pro-preview` as fallbacks.
- A `coder` agent runs tool execution inside Docker sandbox with network enabled (for `git`, `gh`, `codex`, `gemini`, `cursor-agent`, `gcloud`, `x-cli`, `coderabbit`).
- `coder` defaults to Codex CLI with high reasoning, retries with `gpt-5.4`, then falls back to Gemini CLI.
- OpenClaw approvals stay in place for Ted and host execution; nested coding CLIs inside the coder sandbox are configured for full-access agent runs.
- A `/work` command (plugin `work`) runs **Lobster workflows** with approval gates for commit/push/merge, GitHub App-backed repo access, structured spec-packet handoff to Codex/Gemini, and merge preflight checks.
- Unattended runs use subscription auth where the runtime supports it:
  - GitHub App installation tokens for repo and PR actions
  - OpenClaw `openai-codex` OAuth for Ted and other runtime `openai-codex/*` model calls
  - OpenClaw `google-gemini-cli` OAuth plugin for runtime `google-gemini-cli/*` fallback calls
  - Codex CLI and Gemini CLI OAuth state bind-mounted into the coder sandbox for `/work`
- The default VPS preset avoids OpenAI API-key-dependent voice features: inbound audio uses local Whisper.cpp only, and TTS is disabled until you configure a non-keyless path yourself.
- Manual host use stays separate from `/work` and uses `tmux`-backed one-time login sessions for `codex`, `gh`, optional `gemini`, and `agent`.
- Phase-two Telegram client takeover is available through allowlisted `channels.telegram.clients` routes and the `/client` operator command.
- Telegram client takeover rooms can now use shared-room orchestration so one lead agent stays always-on while quiet peers remain fully room-aware and only speak when mentioned.
- Telegram worker groups can also use top-level `broadcast` fanout with the same bounded shared room log, which is useful for internal delivery rooms where multiple specialists should track the same client thread.
- The VPS coding-pack template now pins explicit per-agent `agentDir` paths so deploy preflight boots can reuse the real auth stores instead of looking inside temporary preflight state.

## Files

- `ops/vps/openclaw.vps-coding.json5`
  - Copy to `$OPENCLAW_STATE_DIR/openclaw.json` (typically `~/.openclaw/openclaw.json`).
- `ops/vps/Dockerfile.openclaw-sandbox-coder`
  - Build as `openclaw-sandbox-coder:bookworm` and set in config.
- `ops/vps/bootstrap-ubuntu24.sh`
  - Idempotent-ish bootstrap to install Docker, Tailscale, OpenClaw, host Codex/Gemini/Cursor/gcloud/x-cli tooling, and build the sandbox image.
- `ops/vps/verify-coding-pack-config.sh`
  - Verifies the live `openclaw.json` still matches the Ted VPS coding-pack guardrails before you trust deploys or approval tests.
- `ops/vps/sync-coding-pack-config.sh`
  - Reconciles the live `openclaw.json` with the release's VPS coding-pack guardrails while preserving operator-specific values such as Telegram ids/targets and existing bindings.
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
- Treat `~/openclaw-current` as the authoritative production runtime for this VPS pack. The deploy flow promotes that symlink and rewrites the host `openclaw` shim to point there.
- `ops/vps/promote-release.sh` auto-detects whether the live host uses a system unit such as `openclaw.service` or a user unit such as `openclaw-gateway.service`.
- `ops/vps/promote-release.sh` syncs the live `~/.openclaw/openclaw.json` from the release template before verification/cutover, then verifies the result so Ted cannot silently run against an older non-coding config or leave `~/openclaw-current` half-promoted.
- The bootstrap script installs Tailscale but does not join your tailnet; run `tailscale up` manually.
- Repo intake defaults to `~/work/repos/<owner>/<repo>`.
- Manual CLI login is for operator sessions only. Keep unattended `/work` runs on GitHub App + service credentials rather than interactive host logins.
- ChatGPT/Codex OAuth only covers the `openai-codex/*` provider path. It does not cover generic `openai/*` or `openrouter/*` billing.
- Gemini CLI OAuth covers `google-gemini-cli/*` provider usage and the Gemini CLI itself after login. It does not replace generic `google/*` API-key features.
