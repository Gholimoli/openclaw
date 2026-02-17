---
title: "VidClaw (Control Center)"
summary: "Run a self-hosted dashboard alongside your Gateway to manage tasks, inspect usage, and edit workspace files."
read_when:
  - You want a private “control center” UI for your Gateway and workspace
  - You run multiple agents and want to switch between them in the dashboard
---

# VidClaw (control center)

VidClaw is a self-hosted dashboard designed to run next to an OpenClaw gateway. It typically runs on `127.0.0.1:3333` and is accessed over a private tunnel (Tailscale Serve or SSH port-forward).

## Security model (recommended)

- Bind VidClaw to loopback only (default).
- Do not expose VidClaw to the public internet.
- Access it only over:
  - SSH port-forward, or
  - a private network like Tailscale (recommended)

Treat it as an admin UI: it can read and write workspace files and can run `openclaw` CLI commands.

## Multi-agent support

If your gateway runs multiple agents, prefer a VidClaw build that supports an agent selector:

- usage metrics should read from `~/.openclaw/agents/<agentId>/sessions/*.jsonl`
- workspace browsing should use the agent's configured `agents.list[].workspace` when available

This lets you inspect and operate on `main` vs `coder` vs `power` workspaces without manually changing paths.

### API patterns (recommended)

If you fork VidClaw, add an explicit `agentId` query parameter to agent-scoped endpoints, for example:

- `GET /api/agents`
- `GET /api/usage?agentId=<id>`
- `GET /api/files?agentId=<id>&path=/`
- `GET /api/workspace-file?agentId=<id>&path=/context/PROJECT.md`

If `agentId` is omitted, the dashboard should use a safe default (for example the OpenClaw default agent id).

## Install (Linux VPS)

Example install location:

```bash
cd ~/.openclaw/workspace
git clone <your-vidclaw-fork> dashboard
cd dashboard
npm install
npm run build
node server.js
```

Notes:

- VidClaw expects to find your OpenClaw state under `~/.openclaw` by default. If your state lives elsewhere, set `OPENCLAW_DIR` for VidClaw.
- If your gateway binds to loopback (recommended), VidClaw should use `OPENCLAW_API=http://127.0.0.1:18789` (default).

## Reporting to Telegram (secure pattern)

If you want an agent to send you periodic “control center” updates:

1. Keep the reporting agent separate (for example an approval-gated `power` agent).
2. Query VidClaw locally (loopback) and summarize:
   - `GET /api/agents`
   - `GET /api/usage?agentId=<id>`
   - `GET /api/tasks`
3. Send only the minimal status text to Telegram (avoid including raw logs or secrets).

This keeps the UI private while still giving you visibility in chat.

## OpenClaw skill (optional)

If you want an agent to produce “control center” status reports without exposing the dashboard, install a simple skill that calls VidClaw on loopback:

- list agents: `curl -fsSL http://127.0.0.1:3333/api/agents`
- usage for an agent: `curl -fsSL "http://127.0.0.1:3333/api/usage?agentId=main"`
- task board: `curl -fsSL http://127.0.0.1:3333/api/tasks`

Security rules for the skill:

- only call `http://127.0.0.1:3333`
- never paste secrets into chat (tokens, API keys, raw env vars)
