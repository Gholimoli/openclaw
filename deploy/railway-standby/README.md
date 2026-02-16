# Railway Standby (Active/Standby Telegram Failover)

This directory is a **minimal Railway service** that runs:

- an OpenClaw Gateway bound to **loopback** (not publicly exposed)
- a tiny HTTP "sentinel" on `$PORT` for Railway health checks plus a `/heartbeat` endpoint

The OpenClaw config is generated at runtime from Railway environment variables.

Docs: `/install/railway-standby`
