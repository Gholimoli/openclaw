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
- Host `codex` and `gemini` CLIs for emergency/manual use on the VPS
- Tailscale (installed, but not joined)
- `openclaw-sandbox-coder:bookworm` Docker image used by the `coder` agent

Optional (recommended if you want voice-note UX and browsing):

```bash
sudo bash ops/vps/install-power-tools-ubuntu24.sh
```

This installs:

- Google Chrome stable (recommended for the Browser tool on Linux)
- `whisper-cli` + a Whisper.cpp model (local STT for inbound voice notes)

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
TELEGRAM_OWNER_ID="123456789"
OPENCLAW_GATEWAY_TOKEN="..."

GITHUB_APP_ID="..."
GITHUB_APP_INSTALLATION_ID="..."
GITHUB_APP_PRIVATE_KEY_FILE="$HOME/.openclaw/github-app.pem"
OPENAI_API_KEY="..."
GEMINI_API_KEY="..."
CODERABBIT_API_KEY="..."

WHISPER_CPP_MODEL="/opt/openclaw/models/whisper-cpp/ggml-base.en.bin"

GIT_AUTHOR_NAME="Your Name"
GIT_AUTHOR_EMAIL="you@example.com"
```

Notes:

- Keep file permissions tight: `chmod 600 ~/.openclaw/.env`
- Store the GitHub App private key file with tight permissions too: `chmod 600 ~/.openclaw/github-app.pem`
- `OPENCLAW_GATEWAY_TOKEN` is required because `workctl` uses the Gateway HTTP API (`POST /tools/invoke`).
- `/work` prefers GitHub App auth and mints a short-lived installation token for each coding run. A fallback `GH_TOKEN` or `GITHUB_TOKEN` still works, but it should not be your steady-state setup.
- `TELEGRAM_OWNER_ID` is your numeric Telegram user id. If you don't know it yet, message the bot once and check:
  the bot's onboarding reply (it prints your user id). Then set `TELEGRAM_OWNER_ID` and restart the gateway.

OpenClaw reference: `docs/gateway/tools-invoke-http-api.md`.

## 5. Configure OpenClaw (VPS Pack)

Copy the config template:

```bash
mkdir -p ~/.openclaw
cp ops/vps/openclaw.vps-coding.json5 ~/.openclaw/openclaw.json
```

Key decisions in this config:

- `gateway.bind: "loopback"` (private by default)
- Telegram DMs use an owner allowlist; three dedicated worker groups are allowlisted and routed by bindings; channel-initiated config writes disabled; no partial streaming
- `main` agent presents as `Ted`, runs `openai/gpt-5.4`, and owns repo intake, research, specs, approvals, and orchestration
- `coder` agent: all tool execution runs inside Docker sandbox (network enabled)
- `coder` uses Codex CLI first and Gemini CLI as fallback, with GitHub tokens injected at runtime
- `power` agent: browser + shell access (approval-gated), file mutation tools disabled
- `devops` agent: maintenance profile with constrained tools and isolated session context
- `work` plugin enabled with `coderSessionKey: "agent:coder:main"` and `workRoot: "~/work/repos"`
- Telegram client takeover stays disabled until you add explicit `channels.telegram.clients.<peerId>` entries; operators then use `/client assign` and `/client clear` to hand a client chat to an allowlisted agent

### Configure dedicated Telegram worker groups

Create three private Telegram supergroups (or private group chats), add your bot,
and use one per worker agent:

- `coder` group
- `power` group
- `devops` group

Then replace the placeholder group IDs in `~/.openclaw/openclaw.json`:

- `channels.telegram.groups` keys:
  - `-1001111111111`
  - `-1002222222222`
  - `-1003333333333`
- `bindings[].match.peer.id` values for agents:
  - `coder`
  - `power`
  - `devops`

Reference snippet:

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567001": { requireMention: false },
        "-1001234567002": { requireMention: false },
        "-1001234567003": { requireMention: false },
      },
    },
  },
  bindings: [
    {
      agentId: "coder",
      match: { channel: "telegram", peer: { kind: "group", id: "-1001234567001" } },
    },
    {
      agentId: "power",
      match: { channel: "telegram", peer: { kind: "group", id: "-1001234567002" } },
    },
    {
      agentId: "devops",
      match: { channel: "telegram", peer: { kind: "group", id: "-1001234567003" } },
    },
  ],
}
```

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

## 8. Wake worker agents and verify group routing

Run the wake helper from the repo root:

```bash
bash ops/vps/wake-agents.sh
```

Expected result:

- One wake confirmation message appears in each dedicated Telegram worker group.
- `coder`/`power`/`devops` replies stay isolated to their respective group sessions.

## 9. Run the Coding Pipeline from Telegram

In a Telegram DM with the bot:

```text
/work new demo-repo
/work task demo-repo "add endpoint X"
```

Repo intake also accepts:

```text
/work task openclaw/openclaw "add endpoint X"
/work task https://github.com/openclaw/openclaw "add endpoint X"
```

Approvals:

- Lobster will ask for approvals for commit/push/merge steps and provide a resume token.
- Telegram DM approvals render inline `Approve` / `Deny` buttons for exec approval requests and clear those buttons once the request resolves or times out.
- Resume from Telegram:

```text
/work resume <token> --approve yes
/work resume <token> --approve no
```

## 10. Acceptance Checks

Security:

- From the public internet, only SSH is reachable on the VPS IP (provider firewall).
- Gateway is not public (`gateway.bind=loopback`).
- `openclaw security audit --deep` has no critical findings.

Workflow:

- `/work new demo-repo` scaffolds a repo and (after approval) creates/pushes it.
- `/work task ...` accepts `owner/repo` or a GitHub URL, syncs into `~/work/repos/<owner>/<repo>`, creates a `work/*` branch, produces a structured spec packet, runs coding CLIs, runs checks, runs CodeRabbit CLI, and (after approvals) commits + opens a PR.
- `bash ops/vps/wake-agents.sh` sends one startup ping from each worker agent to its dedicated Telegram group.
- Control UI / Office / macOS show the same live automation run state, approval queue, and outcome trail for a given run id.

Deploy notifications:

- Trigger a successful deploy (`.github/workflows/vps-deploy.yml` via push to `main` or manual dispatch).
- Confirm Telegram receives one success notification including UTC time, commit hash, host, and service details.
- Confirm failed deploys do not emit a false success message.

## 11. “Idea -> source” traceability (external)

- Harness-first, deterministic orchestration: https://openai.com/index/harness-engineering/
- Context repositories pattern: https://www.letta.com/blog/context-repositories
- Summary compression tooling inspiration: https://github.com/steipete/summarize/releases/tag/v0.11.1
- Google Workspace automation potential: https://github.com/steipete/gogcli/releases
- X automation potential: https://github.com/Infatoshi/x-cli
- “Integrations marketplace” option: https://github.com/ComposioHQ/open-claude-cowork/
- Extra sandboxing inspiration: https://github.com/tomascupr/sandstorm
- Browser/MCP future option: https://developer.chrome.com/blog/webmcp-epp
- Shell ergonomics for robust pipelines: https://developers.openai.com/blog/skills-shell-tips
