---
summary: "RPC adapters for external CLIs plus gateway RPC methods used by automation and control surfaces"
read_when:
  - Adding or changing external CLI integrations
  - Debugging RPC adapters (signal-cli, imsg)
title: "RPC Adapters"
---

# RPC adapters

OpenClaw integrates external CLIs via JSON-RPC. Two patterns are used today.

## Pattern A: HTTP daemon (signal-cli)

- `signal-cli` runs as a daemon with JSON-RPC over HTTP.
- Event stream is SSE (`/api/v1/events`).
- Health probe: `/api/v1/check`.
- OpenClaw owns lifecycle when `channels.signal.autoStart=true`.

See [Signal](/channels/signal) for setup and endpoints.

## Pattern B: stdio child process (legacy: imsg)

> **Note:** For new iMessage setups, use [BlueBubbles](/channels/bluebubbles) instead.

- OpenClaw spawns `imsg rpc` as a child process (legacy iMessage integration).
- JSON-RPC is line-delimited over stdin/stdout (one JSON object per line).
- No TCP port, no daemon required.

Core methods used:

- `watch.subscribe` → notifications (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (probe/diagnostics)

See [iMessage](/channels/imessage) for legacy setup and addressing (`chat_id` preferred).

## Adapter guidelines

- Gateway owns the process (start/stop tied to provider lifecycle).
- Keep RPC clients resilient: timeouts, restart on exit.
- Prefer stable IDs (e.g., `chat_id`) over display strings.

## Gateway automation RPC

OpenClaw also exposes gateway RPC methods for automation runs and audit surfaces. These power the Control UI Office tab and other operator views.

Core methods:

- `automation.runs.list`
  - list recent runs
  - optional filters: `limit`, `repo`, `status`
- `automation.runs.get`
  - fetch one run plus its `steps` and `audit`
- `automation.runs.resume`
  - move a paused or blocked run back to `running`
- `automation.runs.cancel`
  - cancel a run and append an audit entry
- `automation.audit.query`
  - query audit entries by `runId`, `repo`, `branch`, `actorId`, `kind`, and `limit`

Gateway events:

- `automation`
  - `run.updated`
  - `step.updated`
  - `approval.requested`
  - `approval.resolved`
- `exec.approval.requested`
- `exec.approval.resolved`

Typical UI pattern:

1. Call `automation.runs.list` to load recent runs.
2. Call `automation.runs.get` for the selected run.
3. Subscribe to gateway events and update the selected run when `automation` events arrive.
4. Use `automation.runs.resume` or `automation.runs.cancel` for operator controls.
