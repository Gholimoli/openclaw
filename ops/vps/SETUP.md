# Secure, Stable OpenClaw VPS Setup + Coding Automation Pipeline (CLI-First)

This is the setup guide for the `ops/vps` “coding automation pack” and the bundled `/work` workflows (`extensions/work`).

It assumes:

- Ubuntu 24.04 VPS
- Telegram is the primary interface
- Gateway is private (loopback bind) and any remote Control UI access is via Tailscale Serve
- Coding work runs via a sandboxed `coder` agent session using `POST /tools/invoke` (so tool policy + sandboxing apply)

## 1. Provision VPS

Minimum host shape:

- 2 vCPU / 4 GB RAM
- 40 GB disk
- Provider firewall enabled

Security baseline:

- SSH key auth only
- No public inbound ports besides SSH (provider firewall)

OpenClaw reference: `docs/gateway/security/index.md`.

## 2. Bootstrap Host

On the VPS, from this repo root:

```bash
sudo bash ops/vps/bootstrap-ubuntu24.sh
```

This installs:

- Docker (for OpenClaw sandboxing)
- Node 22 (for OpenClaw + Lobster CLIs)
- `openclaw` CLI + `lobster` CLI
- Tailscale (installed, but not joined)
- `openclaw-sandbox-coder:bookworm` Docker image used by the `coder` agent

## 3. Join Tailscale

Pick one:

```bash
sudo tailscale up
sudo tailscale up --ssh
```

OpenClaw reference: `docs/gateway/tailscale.md`.

## 4. Configure Secrets

Create `~/.openclaw/.env` with:

```bash
TELEGRAM_BOT_TOKEN="..."
OPENCLAW_GATEWAY_TOKEN="..."

GH_TOKEN="..."
OPENAI_API_KEY="..."
GEMINI_API_KEY="..."
CODERABBIT_API_KEY="..."

GIT_AUTHOR_NAME="Your Name"
GIT_AUTHOR_EMAIL="you@example.com"
```

Notes:

- Keep file permissions tight: `chmod 600 ~/.openclaw/.env`
- `OPENCLAW_GATEWAY_TOKEN` is required because `workctl` uses the Gateway HTTP API (`POST /tools/invoke`).

OpenClaw reference: `docs/gateway/tools-invoke-http-api.md`.

## 5. Configure OpenClaw (VPS Pack)

Copy the config template:

```bash
mkdir -p ~/.openclaw
cp ops/vps/openclaw.vps-coding.json5 ~/.openclaw/openclaw.json
```

Key decisions in this config:

- `gateway.bind: "loopback"` (private by default)
- Telegram DMs use pairing; groups disabled; channel-initiated config writes disabled
- `main` agent: no shell/tooling access
- `coder` agent: all tool execution runs inside Docker sandbox (network enabled)
- `work` plugin enabled with `coderSessionKey: "agent:coder:main"`

OpenClaw reference:

- `docs/channels/telegram.md`
- `docs/gateway/sandboxing.md`
- `docs/tools/lobster.md`

## 6. Start/Restart Gateway

```bash
openclaw doctor
openclaw gateway restart
openclaw channels status --probe
```

## 7. Expose Control UI Privately (Optional)

Because the pack binds the gateway to loopback, use Tailscale Serve for remote access:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:18789
```

OpenClaw reference: `docs/gateway/remote.md`.

## 8. Run the Coding Pipeline from Telegram

In a Telegram DM with the bot:

```text
/work new demo-repo
/work task demo-repo "add endpoint X"
```

Approvals:

- Lobster will ask for approvals for commit/push/merge steps and provide a resume token.
- Resume from Telegram:

```text
/work resume <token> --approve yes
/work resume <token> --approve no
```

## 9. Acceptance Checks

Security:

- From the public internet, only SSH is reachable on the VPS IP (provider firewall).
- Gateway is not public (`gateway.bind=loopback`).
- `openclaw security audit --deep` has no critical findings.

Workflow:

- `/work new demo-repo` scaffolds a repo and (after approval) creates/pushes it.
- `/work task ...` creates a `work/*` branch, runs coding CLIs, runs checks, runs CodeRabbit CLI, and (after approvals) commits + opens a PR.

## 10. “Idea -> source” traceability (external)

- Harness-first, deterministic orchestration: https://openai.com/index/harness-engineering/
- Context repositories pattern: https://www.letta.com/blog/context-repositories
- Summary compression tooling inspiration: https://github.com/steipete/summarize/releases/tag/v0.11.1
- Google Workspace automation potential: https://github.com/steipete/gogcli/releases
- X automation potential: https://github.com/Infatoshi/x-cli
- “Integrations marketplace” option: https://github.com/ComposioHQ/open-claude-cowork/
- Extra sandboxing inspiration: https://github.com/tomascupr/sandstorm
- Browser/MCP future option: https://developer.chrome.com/blog/webmcp-epp
- Shell ergonomics for robust pipelines: https://developers.openai.com/blog/skills-shell-tips
