# Work (plugin)

Deterministic, approval-gated coding workflows for OpenClaw. Exposes a `/work` command that:

- runs **Lobster** workflows (resumable approvals)
- drives coding CLIs (Codex CLI, Gemini CLI, CodeRabbit CLI) via a local helper (`workctl`)
- keeps the LLM “thin” (command bypasses the LLM entirely)

## Enable

Bundled plugins are disabled by default. Enable this plugin:

```json5
{
  plugins: { entries: { work: { enabled: true } } },
}
```

This plugin requires the `lobster` binary installed on the gateway host.

Optional config:

```json5
{
  plugins: {
    entries: {
      work: {
        enabled: true,
        config: {
          // Prefer absolute path in production to reduce PATH hijack risk.
          // lobsterPath: "/usr/local/bin/lobster",
          workRoot: "~/work",
          defaultBase: "main",
          // Use a sandboxed agent sessionKey so all CLI execution is governed by tool policy + sandboxing.
          // Example: "agent:coder:main"
          coderSessionKey: "agent:coder:main",
          maxFixLoops: 3,
          timeoutMs: 1800000, // 30m
        },
      },
    },
  },
}
```

## Usage

Command syntax (Telegram, Slack, etc.):

```text
/work new <repo-name> [--private]
/work task <repo|owner/name> <description> [--base main]
/work review <repo|owner/name> [--base main]
/work fix <repo|owner/name> [--base main]
/work ship <repo|owner/name> [--base main]
/work merge <repo|owner/name>#<prNumber>
/work resume <resumeToken> --approve yes|no
```

Notes:

- `/work` requires an authorized sender (pairing/allowlist).
- Side effects are gated by Lobster approvals (you’ll get a resume token).
- `workctl` calls the Gateway HTTP API (`POST /tools/invoke`) to run `exec` in the configured session (via `coderSessionKey`).
- `workctl` needs gateway auth in env: `OPENCLAW_GATEWAY_TOKEN` (or `OPENCLAW_GATEWAY_PASSWORD`).
- Coding CLIs must be available in the _execution environment_ for that session key:
  - Recommended: install inside the `coder` Docker sandbox image (`codex`, `gemini`, `coderabbit`, `gh`, `git`).
  - Alternative: run without sandboxing and install them on the gateway host (not the default in the VPS pack).
