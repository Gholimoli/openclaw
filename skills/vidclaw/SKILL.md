---
name: vidclaw
description: Query a local VidClaw dashboard (tasks, usage, agents) and produce a tight status report for chat.
metadata: { "openclaw": { "emoji": "📊", "requires": { "bins": ["curl"] } } }
---

# VidClaw (dashboard reporting)

Use this skill to query a **local** VidClaw instance (recommended: loopback-only) and produce a safe, compact status report.

## Security rules (mandatory)

- Only call VidClaw on loopback: `http://127.0.0.1:3333`
- Do not include secrets in any report (tokens, API keys, raw environment variables).
- Prefer summaries over raw logs.
- If VidClaw is unreachable, report that and stop (do not try to expose it publicly).

## Quick checks

List agents:

```bash
curl -fsSL http://127.0.0.1:3333/api/agents
```

Usage for an agent:

```bash
curl -fsSL "http://127.0.0.1:3333/api/usage?agentId=main"
```

Task board:

```bash
curl -fsSL http://127.0.0.1:3333/api/tasks
```

Queue (what would run next):

```bash
curl -fsSL http://127.0.0.1:3333/api/tasks/queue
```

## Suggested report format (send to Telegram)

Include:

- `agentId`: the selected agent
- heartbeat status (if you use it): `GET /api/heartbeat`
- queue size and top task title
- in-progress tasks with age (if visible)
- usage tiers (today/week/month) in human-friendly form

Keep it short enough to fit a single message.

## Troubleshooting

- If `/api/agents` returns an empty list, VidClaw can still work. It means it did not discover agent state under `~/.openclaw/agents/` on that machine.
- If usage is always zero, verify your OpenClaw session JSONL logs exist under:
  - `~/.openclaw/agents/<agentId>/sessions/*.jsonl`
