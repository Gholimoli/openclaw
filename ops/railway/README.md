# Railway Ops (config bootstrap)

This folder contains a small, production-safe bootstrap script used by the
container entrypoint to ensure the Gateway has a valid, secure baseline config
on first boot (and to enforce model defaults when requested).

Why this exists:

- On PaaS platforms like Railway, the Gateway often starts before any interactive
  wizard has run.
- The Gateway normally expects `gateway.mode="local"` to be set in `openclaw.json`
  (unless started with `--allow-unconfigured`).
- We want a deterministic way to set a primary model and fallback models using
  environment variables, without committing secrets.

## What it does

`bootstrap-config.mjs`:

- Locates the config file:
  - `OPENCLAW_CONFIG_PATH` if set, otherwise `$OPENCLAW_STATE_DIR/openclaw.json`
- Creates the state/workspace directories if needed.
- Creates or patches config with:
  - `gateway.mode="local"`
  - `agents.defaults.model.primary` and `agents.defaults.model.fallbacks`
  - Telegram secure defaults (pairing DMs, groups disabled, `configWrites:false`) when `TELEGRAM_BOT_TOKEN` is present
  - tight tool policy defaults (`tools.profile="minimal"`, `tools.elevated.enabled=false`)

## Environment variables

Required for model routing:

- `OPENROUTER_API_KEY` (for `openrouter/*` models)

Optional overrides:

- `OPENCLAW_BOOTSTRAP_MODEL_PRIMARY`
  - Default: `openrouter/openai/gpt-5.2`
- `OPENCLAW_BOOTSTRAP_MODEL_FALLBACKS`
  - Comma-separated list
  - Default: `openrouter/google/gemini-3-pro-preview`

Railway defaults commonly set:

- `OPENCLAW_STATE_DIR=/data/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=/data/workspace`
- `OPENCLAW_GATEWAY_BIND=lan`
- `OPENCLAW_GATEWAY_PORT=8080` (or `CLAWDBOT_GATEWAY_PORT=8080`)
- `OPENCLAW_GATEWAY_TOKEN=...`
