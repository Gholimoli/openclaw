---
title: "VPS Coding Automation"
summary: "Security-first VPS setup: loopback Gateway, Telegram allowlist DMs, Tailscale Serve, and deterministic /work coding workflows."
read_when:
  - You want an always-on Gateway on a VPS without public exposure
  - You want Telegram as the primary interface with strict approvals
  - You want coding automation driven by CLI tools (git, gh, codex, gemini, coderabbit)
---

# VPS coding automation (secure by default)

This guide describes a hardened VPS setup that keeps the Gateway private and runs coding automation through a sandboxed agent session.

This setup is designed for a common pattern:

- You talk to OpenClaw over Telegram.
- OpenClaw orchestrates approvals and routing.
- Actual coding work is executed by CLI tools (for example Codex CLI, Gemini CLI, CodeRabbit CLI) inside a sandbox.
- The Gateway stays private (loopback bind) and is accessed remotely via Tailscale, not a public reverse proxy.

High-level goals:

- No public Gateway exposure (bind loopback).
- Private remote access via Tailscale.
- Telegram bot DMs locked down (owner allowlist by default) and no groups by default.
- Deterministic workflows with explicit approvals (commit, push, merge).

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
- Telegram is the primary interface (DM owner allowlist, groups disabled).
- Coding tool execution happens in a Docker sandbox (a dedicated `coder` agent).
- Multi-step automation uses Lobster workflows with resumable approval tokens.
- Risky steps are approval-gated: commits, pushes, PR creation, merges (and any custom "side effect" step you add later).

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

GH_TOKEN="..."
CODERABBIT_API_KEY="..."

GIT_AUTHOR_NAME="Your Name"
GIT_AUTHOR_EMAIL="you@example.com"
```

Notes:

- `OPENCLAW_GATEWAY_TOKEN` is required if you use `/tools/invoke` from automation (for example via the Work plugin).
- `TELEGRAM_OWNER_ID` is your numeric Telegram user id. If you don't know it yet, message the bot once and check:
  the bot's onboarding reply (it prints your user id). Then set `TELEGRAM_OWNER_ID` and restart the gateway.
- For Codex CLI and Gemini CLI, you can often rely on their own auth flows (subscription/OAuth credentials on disk) instead of API keys. If you do use API keys, treat them as coding-environment secrets and keep them out of repos.
- If you run coding CLIs inside a sandbox, those credentials must be available inside the sandbox (typically via env vars or read-only mounts).

## Configure the Gateway

The VPS pack config template lives at `ops/vps/openclaw.vps-coding.json5`.

Copy it to your config path (default):

```bash
cp ops/vps/openclaw.vps-coding.json5 ~/.openclaw/openclaw.json
```

Key decisions in that config:

- `gateway.bind: "loopback"` and token auth
- Telegram DM owner allowlist, groups disabled, `configWrites: false`, and `streamMode: "off"`
- `main` agent denies shell and write tools
- `coder` agent runs tools in a Docker sandbox
- `work` plugin enabled and wired to the `coder` session key

## Build a coder sandbox image

The recommended execution model is:

- The `coder` agent is sandboxed (Docker).
- All CLI calls (`git`, `gh`, `codex`, `gemini`, `coderabbit`) run inside that sandbox.

This repo includes a reference Dockerfile you can build on the VPS:

```bash
sudo docker build -t openclaw-sandbox-coder:bookworm -f ops/vps/Dockerfile.openclaw-sandbox-coder .
```

If you maintain your own image:

- install the coding CLIs in the image
- ensure they are on `PATH` for the sandbox user
- pass API keys into the sandbox via `agents.list[].sandbox.docker.env`

Security notes:

- Keep the chat-facing `main` agent tool policy minimal and route all execution to the `coder` agent. This limits the blast radius of prompt injection in chat.
- Keep `tools.elevated.enabled=false` unless you have a specific operational need. See [Elevated mode](/tools/elevated).

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

When a workflow needs approval, it returns a resume token.
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
- Route “power tool” work to a dedicated agent (for example `power`) with a tighter allowlist and explicit approvals.
- Prefer sandboxed execution where possible. See [Sandboxing](/gateway/sandboxing).

Operational pattern:

- Your Telegram DM talks to the default agent (`main`).
- When you ask for “power tool” work (browser, host exec), `main` should spawn a separate run under the `power` agent.
- Exec approvals are forwarded back to your Telegram DM (so you can approve without opening the Control UI).

### Telegram voice notes (TTS)

OpenClaw can send Telegram-compatible Opus voice notes (the “round bubble” UX). See:

- [Text-to-speech (TTS)](/tts)

Operational pattern:

- Set TTS to `tagged` so audio is only generated when you explicitly request it, or when the model emits a `[[tts:...]]` directive.
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
- configure `tools.media.audio.models` to use `whisper-cli` (and optionally add a provider fallback)

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
