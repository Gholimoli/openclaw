---
title: "VPS Coding Automation"
summary: "Security-first VPS setup: loopback Gateway, Ted-led /work automation, GitHub App repo access, and Codex-first sandboxed coding workflows with Railway-ready deploy tooling."
read_when:
  - You want an always-on Gateway on a VPS without public exposure
  - You want Telegram as the primary interface with tap-first approvals
  - You want coding automation driven by CLI tools (git, gh, codex, gemini, railway, coderabbit)
---

# VPS coding automation (secure by default)

This guide describes a hardened VPS setup that keeps the Gateway private and runs coding automation through a sandboxed agent session.

This setup is designed for a common pattern:

- You talk to OpenClaw over Telegram or the Control UI.
- The operator-facing `main` agent presents as Ted and handles repo intake, research, specs, approvals, and orchestration.
- Actual coding work is executed by Codex CLI inside a sandboxed `coder` agent session, with generic OpenAI GPT-5.4 then generic Google Gemini API fallback.
- The Gateway stays private (loopback bind) and is accessed remotely via Tailscale, not a public reverse proxy.

High-level goals:

- No public Gateway exposure (bind loopback).
- Private remote access via Tailscale.
- Telegram bot DMs locked down (owner allowlist by default) and no groups by default.
- Deterministic workflows with explicit approvals for Ted and `/work`, plus a separate owner-only `power` lane for full-auto host exec that still consults you before high-risk actions.
- Forwarded Telegram exec approvals are button-first for every approval-gated agent, with `/approve ...` kept as fallback text.

Related:

- VPS hosting hub: [VPS hosting](/vps)
- Remote access: [Remote access](/gateway/remote)
- Telegram: [Telegram](/channels/telegram)
- Sandbox: [Sandboxing](/gateway/sandboxing)
  - Lobster: [Lobster](/tools/lobster)
  - Work plugin: [Work plugin](/plugins/work)

## Architecture

Decisions:

- One Ubuntu 24.04 VPS runs the OpenClaw Gateway.
- The Gateway binds to `127.0.0.1` only (`gateway.bind: "loopback"`).
- The Control UI is reachable only over a private network (Tailscale Serve recommended).
- Telegram is the primary interface (DM owner allowlist, groups disabled by default).
- Ted plans and delegates coding tool execution to a Docker sandbox (a dedicated `coder` agent).
- The owner-only `power` agent keeps full host exec without per-command approvals, but its system prompt requires operator consultation before risky production-affecting actions.
- Multi-step automation uses Lobster workflows with resumable approval tokens.
- Risky steps are approval-gated: host sudo, commits, pushes, PR creation, merges, and deploy-affecting actions.

Rationale (why this shape works well):

- Loopback bind drastically reduces attack surface for the Gateway HTTP endpoints and Control UI. See [Gateway security](/gateway/security).
- A dedicated sandboxed `coder` agent lets you keep the chat-facing agent minimal while still enabling robust automation. See [Sandboxing](/gateway/sandboxing) and [Tool policy mental model](/gateway/sandbox-vs-tool-policy-vs-elevated).
- Lobster keeps orchestration deterministic and token-efficient: a single tool call can execute a whole pipeline with explicit approvals. See [Lobster](/tools/lobster).

## Host requirements

- Ubuntu 24.04 LTS
- 2 vCPU, 4 GB RAM minimum
- 40 GB disk minimum
- Provider firewall enabled
- SSH key auth enabled

## Provision the host

At minimum, ensure:

- Only SSH is exposed publicly (provider firewall).
- UFW is enabled with an allow rule for your SSH port.
- Tailscale is installed (for private access).

Recommended:

- Prefer the hardened installer: [Ansible](/install/ansible).
- Enable provider snapshots (daily) so you can recover quickly.

## Install prerequisites

You need these on the VPS:

- Node 22+
- OpenClaw CLI (daemon + gateway)
- Docker (for sandboxing)
- Lobster CLI (for workflow execution)
- Railway CLI (for downstream app deploys)

Recommended: use [Ansible](/install/ansible) for a production-grade install (firewall-first + Tailscale + systemd hardening).

If you are working from a source checkout, this repo also includes a bootstrap script (useful for experimentation and forks):

```bash
sudo bash ops/vps/bootstrap-ubuntu24.sh
```

Notes:

- The bootstrap script installs Tailscale but does not join your tailnet. Run `tailscale up` manually.
- The script builds a dedicated sandbox image intended for the `coder` agent.

## Configure secrets

Put secrets in `~/.openclaw/.env` on the VPS (daemon-readable). Keep file permissions tight:

```bash
chmod 600 ~/.openclaw/.env
```

Common env vars for the coding pipeline:

```bash
TELEGRAM_BOT_TOKEN="..."
TELEGRAM_OWNER_ID="123456789"
OPENCLAW_GATEWAY_TOKEN="..."

GITHUB_APP_ID="..."
GITHUB_APP_INSTALLATION_ID="..."
GITHUB_APP_PRIVATE_KEY_FILE="$HOME/.openclaw/github-app.pem"
OPENCLAW_SANDBOX_UID="$(id -u)"
OPENCLAW_SANDBOX_GID="$(id -g)"
CODERABBIT_API_KEY="..."
OPENAI_API_KEY="..."
GEMINI_API_KEY="..."
RAILWAY_API_TOKEN="..."

GIT_AUTHOR_NAME="Your Name"
GIT_AUTHOR_EMAIL="you@example.com"
```

Notes:

- `OPENCLAW_GATEWAY_TOKEN` is required if you use `/tools/invoke` from automation (for example via the Work plugin).
- `TELEGRAM_OWNER_ID` is your numeric Telegram user id. If you don't know it yet, message the bot once and check:
  the bot's onboarding reply (it prints your user id). Then set `TELEGRAM_OWNER_ID` and restart the gateway.
- `/work` prefers GitHub App auth and mints a short-lived installation token per run. Avoid a broad personal PAT for steady-state automation.
- `OPENCLAW_SANDBOX_UID` and `OPENCLAW_SANDBOX_GID` must match the host service user so the coder container can reuse host CLI OAuth state and write mounted repos.
- `OPENAI_API_KEY` and `GEMINI_API_KEY` are required by the pinned fallback policy in the VPS coding pack.
- Keep interactive host logins separate from unattended `/work` runs. The runtime uses OpenClaw OAuth profiles, while the coder sandbox reuses host Codex/Gemini/Railway CLI state through bind mounts.

## Configure the Gateway

The VPS pack config template lives at `ops/vps/openclaw.vps-coding.json5`.

Copy it to your config path (default):

```bash
cp ops/vps/openclaw.vps-coding.json5 ~/.openclaw/openclaw.json
```

Key decisions in that config:

- `gateway.bind: "loopback"` and token auth
- Telegram DM owner allowlist, groups disabled, `configWrites: false`, and `streamMode: "off"`
- `main` keeps its internal id for compatibility but presents as Ted
- `main` owns repo intake, specs, approvals, CI watching, and VPS troubleshooting dispatch
- any Telegram-forwarded exec approval from `main`, `coder`, `devops`, or future approval-gated agents uses the same native inline approval UI with `/approve ...` fallback
- `coder` agent runs tools in a Docker sandbox and prefers OpenAI Codex first, then `openai/gpt-5.4`, then `google/gemini-3-pro-preview`
- `power` agent keeps full host exec with `ask: "off"` and an agent-specific consultation prompt for big-risk changes
- bundled `work` plugin enabled and wired to the `coder` session key with GitHub App token minting
- runtime fallbacks stay on OpenAI Codex OAuth first, then `OPENAI_API_KEY`, then `GEMINI_API_KEY`
- coder sandbox env forwards `RAILWAY_API_TOKEN` and bind-mounts host `~/.railway` for deploy-ready Railway CLI sessions
- X CLI credentials come from `~/.config/x-cli/.env`; `x-cli` does not support browser-style X account login

Production note:

- Keep `work` on the bundled plugin path of the live OpenClaw runtime.
- For the VPS pack, the live runtime is the promoted release under `~/openclaw-current`.
- Prefer `cd ~/openclaw-current && pnpm openclaw ...` for operator checks unless you know the host `openclaw` shim already points there.
- Install the Lobster runtime from `@clawdbot/lobster` on the gateway host, not `@openclaw/lobster` (that package is the OpenClaw plugin wrapper, not the CLI).
- Prefer an absolute `plugins.entries.work.config.lobsterPath` such as `/usr/bin/lobster` on Ubuntu VPS hosts.
- Do not add a repo checkout path under `plugins.load.paths` for `work` on the VPS.
- Remove any older `~/.openclaw/extensions/work` install after you upgrade to a build that bundles the plugin.

## Build a coder sandbox image

The recommended execution model is:

- The `coder` agent is sandboxed (Docker).
- All CLI calls (`git`, `gh`, `codex`, `gemini`, `railway`, `coderabbit`) run inside that sandbox.

This repo includes a reference Dockerfile you can build on the VPS:

```bash
sudo docker build -t openclaw-sandbox-coder:bookworm -f ops/vps/Dockerfile.openclaw-sandbox-coder .
```

If you maintain your own image:

- install the coding CLIs in the image
- ensure they are on `PATH` for the sandbox user
- bind host `~/.codex`, `~/.gemini`, and `~/.railway` into the sandbox user home if you want CLI auth state to survive container recreation

Security notes:

- Keep the chat-facing `main` agent tool policy minimal and route all execution to the `coder` agent. This limits the blast radius of prompt injection in chat.
- Keep `tools.elevated.enabled=false` unless you have a specific operational need. See [Elevated mode](/tools/elevated).

## Manual host CLI login

Use interactive CLI logins only for manual host sessions, not for unattended automation.

The VPS pack includes a helper that starts a `tmux` session as the primary service user and launches a real TTY flow:

```bash
sudo bash ops/vps/login-coding-clis.sh codex
sudo bash ops/vps/login-coding-clis.sh gh
sudo bash ops/vps/login-coding-clis.sh railway
sudo bash ops/vps/login-coding-clis.sh gemini
sudo bash ops/vps/login-coding-clis.sh agent
```

Use this when you need to:

- verify Codex CLI device auth on the host
- log `gh` into a manual operator session
- log Railway CLI into the same account used for deploys on your Mac
- do optional first-run Gemini setup
- inspect the host-side agent CLI directly

Use this once for the runtime provider side:

```bash
openclaw models auth login --provider openai-codex
```

Also set `OPENAI_API_KEY` and `GEMINI_API_KEY` in `~/.openclaw/.env` for the generic fallback providers.
Also set `RAILWAY_API_TOKEN` in `~/.openclaw/.env` for unattended Railway deploys.

Use the host CLI login helpers for the sandboxed implementation CLIs:

```bash
sudo bash ops/vps/login-coding-clis.sh codex
sudo bash ops/vps/login-coding-clis.sh railway
sudo bash ops/vps/login-coding-clis.sh gemini
```

ChatGPT/Codex OAuth does not cover `openrouter/*` or generic `openai/*` billing, Gemini CLI OAuth does not replace generic `google/*` API-key features, and `x-cli` still requires X Developer Portal credentials.

The default VPS preset avoids OpenAI API-key-dependent voice features:

- inbound audio transcription uses local Whisper.cpp only
- TTS is disabled until you add a separate configuration

## Join Tailscale (recommended)

Join your tailnet:

```bash
sudo tailscale up
```

Optional:

```bash
sudo tailscale up --ssh
```

See [Tailscale](/gateway/tailscale).

## Start and verify

```bash
openclaw doctor
openclaw gateway restart
openclaw channels status --probe
openclaw security audit --deep
```

## Expose the Control UI privately (optional)

Because the Gateway binds to loopback, a convenient remote access pattern is Tailscale Serve:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:18789
```

See [Remote access](/gateway/remote).

## Run the coding workflows from Telegram

After your Telegram DM is allowed (see [Telegram](/channels/telegram)), use:

```text
/work new demo-repo
/work task demo-repo add endpoint X
/work upstream Gholimoli/openclaw --upstream openclaw/openclaw
```

Repo intake accepts:

- local repo names already synced under `~/work/repos`
- `owner/repo`
- full GitHub HTTPS URLs

Each `/work task` or `/work fix` run now:

- syncs the repo into `~/work/repos/<owner>/<repo>`
- generates a structured spec packet
- sends that packet directly to Codex CLI (with Gemini fallback)
- records the selected CLI, available CLIs, auth mode, checks, approvals, and final outcome in the automation audit trail

When a workflow needs approval, it returns a resume token.
In Telegram DMs, `/work` shows tap-first inline **Approve** / **Deny** buttons
and keeps the resume token plus manual `/work resume ...` commands in the
message as fallback.
Resume from Telegram:

```text
/work resume <token> --approve yes
/work resume <token> --approve no
```

Details: [Work plugin](/plugins/work).

## Power tools (voice notes and browser automation)

OpenClaw can be configured to send Telegram voice notes and to automate a real browser, but you should treat these as **high-risk capabilities**:

- Voice generation can leak sensitive content if enabled indiscriminately.
- Browsers can be abused for credential phishing and prompt injection.

Recommendations:

- Keep your chat-facing `main` agent minimal.
- Route “power tool” work to a dedicated agent (for example `power`) with a tighter allowlist, full-auto host exec, and explicit consultation rules for risky actions.
- Prefer sandboxed execution where possible. See [Sandboxing](/gateway/sandboxing).

Operational pattern:

- Your Telegram DM talks to the default agent (`main`).
- When you ask for “power tool” work (browser, host exec), `main` should spawn a separate run under the `power` agent.
- `power` should consult you before big-risk actions instead of waiting on per-command exec approvals.
- Exec approvals from Ted and other approval-gated agents are forwarded back to your Telegram DM with inline buttons, so you can approve without opening the Control UI.

### Telegram voice notes (TTS)

OpenClaw can send Telegram-compatible Opus voice notes (the “round bubble” UX). See:

- [Text-to-speech (TTS)](/tts)

Operational pattern:

- The stock VPS preset leaves TTS disabled. If you enable it later, prefer `tagged` so audio is only generated when you explicitly request it, or when the model emits a `[[tts:...]]` directive.
- For Telegram, use the `[[audio_as_voice]]` tag (or the channel action’s `asVoice: true`) to send a voice note rather than an audio file. See [Telegram audio notes](/channels/telegram#audio-video-and-stickers).

### Browser automation (Playwright-style)

If you want the agent to browse the web, use the built-in browser tool and keep it isolated:

- [Browser tool](/tools/browser)
- [Browser Linux troubleshooting](/tools/browser-linux-troubleshooting)

Security notes:

- Use a dedicated browser profile for OpenClaw, not your personal profile.
- Treat any page content as untrusted input. Prefer deterministic scrapers and allowlisted domains for automation.

## VidClaw (optional control center UI)

If you run VidClaw next to your gateway (recommended bind: `127.0.0.1:3333`), access it privately:

```bash
ssh -N -L 3333:127.0.0.1:3333 user@gateway-host
```

Then open:

- `http://127.0.0.1:3333/`

VidClaw is an admin UI. Keep it private (loopback + tunnel). See [VidClaw](/tools/vidclaw).

### Make VidClaw discoverable to the agent

If you want your chat-facing agent to reliably remember that VidClaw exists and how to access it, inject an `AGENTS.md` file into the system prompt using the bundled hook `bootstrap-extra-files`.

Docs: [Hooks](/automation/hooks).

### Speech-to-text (STT) for inbound voice notes

OpenClaw can transcribe inbound audio attachments (for example Telegram voice notes) using either:

- a provider model (cloud), or
- a local CLI (offline)

Configuration lives under `tools.media.audio`.

If you want offline STT on Linux, the most reliable path is to install Whisper.cpp and provide a model:

- install `whisper-cli`
- set `WHISPER_CPP_MODEL=/path/to/ggml-*.bin` in the gateway environment
- configure `tools.media.audio.models` to use `whisper-cli`

## Active/standby failover (optional)

If you want a cheap backup Telegram bot, deploy a Railway standby and have your VPS send periodic heartbeats:

- [Railway Standby](/install/railway-standby)
- [Gateway heartbeat](/gateway/heartbeat)

## Railway to VPS cutover

If you are migrating from Railway (or another PaaS):

1. Export your state and workspace (if you have meaningful state).
   - Railway export endpoint: `https://<your-domain>/setup/export` (see [Railway](/install/railway)).
2. Bring up the VPS Gateway first and verify Telegram works.
3. Restore state if needed. See [Migrating](/install/migrating).
4. Decommission the PaaS service after the VPS is stable.

If your deployment is a fresh fork with minimal state, starting clean on the VPS is usually simpler.

## Acceptance checks

Security:

- From the public internet, only SSH is reachable on the VPS IP.
- Gateway is loopback-only (`gateway.bind=loopback`).
- `openclaw security audit --deep` shows no critical findings.

Workflow:

- `/work new demo-repo` scaffolds a repo and (after approval) pushes to GitHub.
- `/work task ...` creates a `work/*` branch, runs coding CLIs, runs checks, runs CodeRabbit review, then (after approval) commits and opens a PR.
- `/work upstream ...` prepares a sync branch from upstream and, after approval, pushes and opens/updates a sync PR.

## Further reading

- Threat model and hardening checklist: [Gateway security](/gateway/security)
- Deterministic orchestration with approvals: [Lobster](/tools/lobster)
- CLI-first coding automation contract: [Work plugin](/plugins/work)
