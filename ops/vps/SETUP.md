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
- Host `codex`, `gemini`, `agent` / `cursor-agent`, `gcloud`, and `x-cli`
  for emergency/manual use on the VPS
- Tailscale (installed, but not joined)
- `openclaw-sandbox-coder:bookworm` Docker image used by the `coder` agent
- `tmux`, which the manual CLI login helper uses for real TTY auth sessions

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
GCLOUD_SERVICE_ACCOUNT_KEY_FILE="$HOME/.openclaw/gcloud-service-account.json"
GCLOUD_PROJECT="..."

X_API_KEY="..."
X_API_SECRET="..."
X_BEARER_TOKEN="..."
X_ACCESS_TOKEN="..."
X_ACCESS_TOKEN_SECRET="..."

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
- Nested coding CLIs inside the `coder` sandbox run with their own full-access
  modes enabled; Ted and host-level OpenClaw exec remain approval-gated
- `power` agent: browser + shell access (approval-gated), file mutation tools disabled
- `devops` agent: maintenance profile with constrained tools and isolated session context
- `work` plugin enabled with `coderSessionKey: "agent:coder:main"` and `workRoot: "~/work/repos"`
- Telegram client takeover stays disabled until you add explicit `channels.telegram.clients.<peerId>` entries; operators then use `/client assign` and `/client clear` to hand a client chat to an allowlisted agent

### Configure coding CLI defaults

After the `.env` file is in place, run:

```bash
sudo bash ops/vps/configure-coding-clis.sh
```

This does four things:

- seeds `~/work/repos/AGENTS.md` from `ops/vps/TED_AGENTS.md` so Ted sees the
  coding toolchain in workspace context
- configures Codex for `approval_policy = "never"` and
  `sandbox_mode = "danger-full-access"` in `~/.codex/config.toml`
- configures Gemini with an allow-all policy in
  `~/.gemini/policies/openclaw-yolo.toml`
- installs helper wrappers:
  - `gemini-yolo`
  - `agent-full`
  - `cursor-agent-full`

The unattended `/work` path should use:

- `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY_FILE`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`

This keeps repo access and model auth non-interactive and short-lived for automation runs.

Notes:

- The Cursor Agent install is official, but Cursor auth still depends on your
  Cursor account session. If you need an interactive login on the VPS, run
  `agent` once as the service user and complete its auth flow.
- `gcloud` auth is activated automatically only when
  `GCLOUD_SERVICE_ACCOUNT_KEY_FILE` or `GOOGLE_APPLICATION_CREDENTIALS` points
  at a readable service-account key.
- `x-cli` auth is written automatically when all five `X_*` variables are
  present in `~/.openclaw/.env`.

### Manual VPS CLI login sessions

If you want to use the CLIs directly on the VPS for emergency/manual work, keep that separate from `/work`.

Start a real TTY login session with:

```bash
sudo bash ops/vps/login-coding-clis.sh codex
sudo bash ops/vps/login-coding-clis.sh gh
sudo bash ops/vps/login-coding-clis.sh gemini
sudo bash ops/vps/login-coding-clis.sh agent
```

What this does:

- launches or reuses a `tmux` session as the primary service user
- loads `~/.openclaw/.env`
- starts the requested interactive CLI flow
- prints the `tmux attach` command so you can complete the login in a real terminal

Use cases:

- `codex`: one-time `codex login --device-auth` or API-key login verification
- `gh`: one-time `gh auth login --web`
- `gemini`: optional first-run interactive setup
- `agent`: verify the host-side agent CLI is installed and usable

Do not rely on these interactive host logins for unattended automation. `/work` should continue using GitHub App and service credentials.

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

Current behavior:

- Ted plans and emits a structured spec packet with goal, non-goals, acceptance criteria, risk tier, checks, approvals, repo identity, and implementation settings.
- The `coder` sandbox receives that serialized packet directly in Codex CLI, with Gemini CLI fallback only if Codex is unavailable.
- The run record stores the selected implementation CLI, detected toolchain, GitHub auth mode, and the full spec packet.

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
- Toolchain probes now report `codex`, `gemini`, `agent`, `cursor-agent`,
  `gcloud`, and `x-cli` availability to the automation run record.
- `bash ops/vps/wake-agents.sh` sends one startup ping from each worker agent to its dedicated Telegram group.
- Control UI / Office / macOS show the same live automation run state, approval queue, and outcome trail for a given run id.
- `/work merge` blocks stale head SHA, failed or pending required checks, unresolved approvals, drafts, and `CHANGES_REQUESTED` review state before it calls `gh pr merge`.

Deploy notifications:

- Trigger a successful deploy (`.github/workflows/vps-deploy.yml` via push to `main` or manual dispatch).
- Confirm Telegram receives one success notification including UTC time, commit hash, host, and service details.
- Confirm failed deploys do not emit a false success message.
- Confirm `ops/vps/promote-release.sh` appends the deploy outcome to the automation audit store so deploy evidence appears in the same run/audit surfaces.

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
