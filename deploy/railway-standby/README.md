# Railway Standby (Active/Standby Telegram Failover)

This directory is a **minimal Railway service** that runs:

- a standby Telegram bot (long polling; no inbound webhooks)
- a tiny HTTP "sentinel" on `$PORT` for Railway health checks plus a `/heartbeat` endpoint
- optionally, a full OpenClaw Gateway bound to **loopback** (not publicly exposed)

The OpenClaw config is generated at runtime from Railway environment variables.

Docs: `/install/railway-standby`

## Environment variables

Required:

- `TELEGRAM_BOT_TOKEN` (backup bot token)
- `OPERATOR_TELEGRAM_CHAT_ID` (operator DM chat id / user id)
- `OPENCLAW_HEARTBEAT_SECRET` (header secret for `/heartbeat`)
- `OPENCLAW_GATEWAY_TOKEN` (gateway token, used only when gateway mode is enabled)

Optional:

- `HEARTBEAT_TTL_MS` (default: 180000)
- `OPENCLAW_STANDBY_ENABLE_GATEWAY=1` to start the full OpenClaw gateway (default: disabled)

Notes:

- Railway free tiers often OOM running the full gateway. Simple mode is the default and is designed to be cheap and robust.
- Telegram long polling cannot be shared across two processes for the same bot token, so this service runs either:
  - simple standby polling (default), or
  - OpenClaw gateway polling (when `OPENCLAW_STANDBY_ENABLE_GATEWAY=1`)
