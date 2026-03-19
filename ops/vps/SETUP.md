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
- Host `codex`, `gemini`, `railway`, `agent` / `cursor-agent`, `gcloud`, and `x-cli`
  for emergency/manual use on the VPS
- Tailscale (installed, but not joined)
- `openclaw-sandbox-coder:bookworm` Docker image used by the `coder` agent
- `tmux`, which the manual CLI login helper uses for real TTY auth sessions

Current package mapping:

- `openclaw` CLI comes from the `openclaw` npm package
- `lobster` CLI comes from `@clawdbot/lobster`

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
OPENCLAW_SANDBOX_UID="$(id -u)"
OPENCLAW_SANDBOX_GID="$(id -g)"
CODERABBIT_API_KEY="..."
OPENAI_API_KEY="..."
GEMINI_API_KEY="..."
RAILWAY_API_TOKEN="..."
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
- `OPENCLAW_SANDBOX_UID` and `OPENCLAW_SANDBOX_GID` must match the host service user so the coder container can write mounted repos and reuse host CLI OAuth state.
- `OPENAI_API_KEY` and `GEMINI_API_KEY` are required by the pinned VPS fallback policy and should be present before you run `ops/vps/verify-coding-pack-config.sh`.
- `/work` prefers GitHub App auth and mints a short-lived installation token for each coding run. A fallback `GH_TOKEN` or `GITHUB_TOKEN` still works, but it should not be your steady-state setup.
- `TELEGRAM_OWNER_ID` is your numeric Telegram user id. If you don't know it yet, message the bot once and check:
  the bot's onboarding reply (it prints your user id). Then set `TELEGRAM_OWNER_ID` and restart the gateway.

OpenClaw reference: `docs/gateway/tools-invoke-http-api.md`.

## 5. Configure OpenClaw (VPS Pack)

Copy the config template:

```bash
mkdir -p ~/.openclaw
cp ops/vps/openclaw.vps-coding.json5 ~/.openclaw/openclaw.json
bash ops/vps/verify-coding-pack-config.sh
```

Key decisions in this config:

- `gateway.bind: "loopback"` (private by default)
- Telegram DMs use an owner allowlist; dedicated worker groups are optional and should only be added once you have real group IDs; channel-initiated config writes disabled; no partial streaming
- `main` agent presents as `Ted`; it uses `openai-codex/gpt-5.3-codex` with `openai/gpt-5.4` then `google/gemini-3-pro-preview` as fallbacks
- `coder` agent: all tool execution runs inside Docker sandbox (network enabled)
- `coder` uses OpenAI Codex first with high reasoning, then `openai/gpt-5.4`, then `google/gemini-3-pro-preview`, with GitHub tokens injected at runtime
- Nested coding CLIs inside the `coder` sandbox run with their own full-access
  modes enabled; Ted remains approval-gated for host-level OpenClaw exec
- `power` agent: browser + direct host exec plus repo file mutation tools (`write`, `edit`, `apply_patch`) for VPS and codebase tasks, with no per-command exec approvals
- `power.systemPrompt` forces operator consultation before deploys, restarts, service control, push/merge/rebase/reset/force operations, release steps, secret or live-config changes, destructive file/data work, and other risky external side effects
- `devops` agent: maintenance profile with constrained tools and isolated session context
- `work` plugin enabled with `coderSessionKey: "agent:coder:main"` and `workRoot: "~/work/repos"`
- runtime model fallbacks stay on OpenAI Codex OAuth first, then `OPENAI_API_KEY`, then `GEMINI_API_KEY`
- set `plugins.entries.work.config.lobsterPath` to the absolute Lobster binary in production when possible (for this Ubuntu bootstrap path, `/usr/bin/lobster`)
- Telegram client takeover stays disabled until you add explicit `channels.telegram.clients.<peerId>` entries; operators then use `/client assign` and `/client clear` to hand a client chat to an allowlisted agent
- Telegram client takeover rooms can enable `orchestration` so the lead agent is always on, peer agents stay room-aware through a bounded shared room log, and peers only speak on mention by default
- Top-level `broadcast` can now target Telegram groups and forum topics too; each targeted agent gets the same shared room snapshot for that inbound event while keeping its own private session state
- The VPS coding-pack template pins each agent's `agentDir` under `~/.openclaw/agents/<id>/agent`, which keeps provider auth stable during deploy preflight runs that use a temporary `OPENCLAW_STATE_DIR`

### Configure coding CLI defaults

After the `.env` file is in place, run:

```bash
sudo bash ops/vps/configure-coding-clis.sh
```

This does four things:

- seeds `~/work/repos/AGENTS.md` from `ops/vps/TED_AGENTS.md` so Ted sees the
  coding toolchain in workspace context
- configures Codex for `approval_policy = "never"` and
  `sandbox_mode = "danger-full-access"` plus `reasoning_effort = "high"` in `~/.codex/config.toml`
- configures Gemini with an allow-all policy in
  `~/.gemini/policies/openclaw-yolo.toml`
- writes `RAILWAY_API_TOKEN` into `~/.railway/config.json` when the env var is present, so host exec and sandboxed coder runs can reuse the same Railway auth state
- installs helper wrappers:
  - `gemini-yolo`
  - `agent-full`
  - `cursor-agent-full`

The unattended `/work` path should use:

- `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY_FILE`
- OpenClaw `openai-codex` OAuth for runtime `openai-codex/*`
- `OPENAI_API_KEY` for runtime `openai/*`
- `GEMINI_API_KEY` for runtime `google/*`
- `RAILWAY_API_TOKEN` plus Railway CLI state in `~/.railway`
- Codex CLI, Gemini CLI, and Railway CLI state from the host home bind-mounted into the sandbox

This keeps repo access short-lived for automation runs and removes the normal Ted/coder dependency on OpenAI and Gemini API keys.

Notes:

- The Cursor Agent install is official, but Cursor auth still depends on your
  Cursor account session. If you need an interactive login on the VPS, run
  `agent` once as the service user and complete its auth flow.
- `gcloud` auth is activated automatically only when
  `GCLOUD_SERVICE_ACCOUNT_KEY_FILE` or `GOOGLE_APPLICATION_CREDENTIALS` points
  at a readable service-account key.
- `x-cli` auth is written automatically when all five `X_*` variables are
  present in `~/.openclaw/.env`. `x-cli` uses X Developer Portal credentials, not a browser login flow for x.com.

### Manual VPS CLI login sessions

If you want to use the CLIs directly on the VPS for emergency/manual work, keep that separate from `/work`.

Start a real TTY login session with:

```bash
sudo bash ops/vps/login-coding-clis.sh codex
sudo bash ops/vps/login-coding-clis.sh gh
sudo bash ops/vps/login-coding-clis.sh railway
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
- `railway`: one-time `railway login --browserless` for `~/.railway/config.json`
- `gemini`: optional first-run interactive setup
- `agent`: verify the host-side agent CLI is installed and usable

Do not rely on these interactive host logins for unattended automation. `/work` should continue using GitHub App and service credentials.

### Configure runtime OAuth for Ted

Run this once as the service user:

```bash
openclaw models auth login --provider openai-codex
```

This covers the OAuth-primary runtime path for Ted and the other agents. Generic `openai/*` and `google/*` fallbacks still require `OPENAI_API_KEY` and `GEMINI_API_KEY`.

### Configure CLI OAuth for the coder sandbox

The coder sandbox bind-mounts `~/.codex`, `~/.gemini`, and `~/.railway` from the host into `/home/sandbox`, so do one-time host logins for the CLIs too:

```bash
sudo bash ops/vps/login-coding-clis.sh codex
sudo bash ops/vps/login-coding-clis.sh railway
sudo bash ops/vps/login-coding-clis.sh gemini
```

ChatGPT/Codex OAuth in OpenClaw does not cover `openrouter/*` or generic `openai/*` billing, generic `google/*` runtime calls still require `GEMINI_API_KEY`, and unattended Railway deploys should prefer `RAILWAY_API_TOKEN` even when `~/.railway/config.json` is present.

The default VPS preset avoids OpenAI API-key-dependent voice features:

- inbound audio transcription uses local Whisper.cpp only
- TTS is disabled until you opt into a separate configuration

### Configure dedicated Telegram worker groups (optional)

Create three private Telegram supergroups (or private group chats), add your bot,
and use one per worker agent:

- `coder` group
- `power` group
- `devops` group

Then add the real group IDs to `~/.openclaw/openclaw.json`. The VPS preset no longer ships placeholder IDs.

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
- Telegram inline approvals render tap-first `Approve` / `Deny` buttons for all forwarded exec approval requests and `/work` Lobster checkpoints, mirror exec prompts to the operator DM, keep manual `/approve ...` and `/work resume ...` fallbacks available, and clear those buttons once the request resolves or times out.
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
- Confirm `bash ops/vps/verify-coding-pack-config.sh` passes on the host after the deploy.
- Confirm Telegram receives one success notification including UTC time, commit hash, host, and service details.
- Confirm failed deploys do not emit a false success message.
- Confirm `ops/vps/promote-release.sh` appends the deploy outcome to the automation audit store, auto-detects the live systemd unit (`openclaw.service` vs `openclaw-gateway.service`), syncs the live config from the release's VPS coding-pack template, and fails before cutover if the reconciled config still drifts away from the Ted VPS coding-pack guardrails.

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
