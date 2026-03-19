# Ted VPS Coding Toolchain

Ted orchestrates coding work through `/work` and keeps the outer OpenClaw
approval boundary intact for host execution, sudo, deploys, pushes, merges, and
other non-coding-agent actions.

Inside the dedicated coding CLI environment, the nested coding agents are
trusted and run with full access:

- Codex CLI: use `codex exec --full-auto ...`
- Gemini CLI: use `gemini --approval-mode yolo ...` or `gemini-yolo ...`
- Railway CLI: use `railway` for deploy, logs, link, and service operations
- Cursor Agent CLI: use `agent --force ...` or `cursor-agent --force ...`
- Google Cloud CLI: `gcloud`
- X CLI: `x-cli` (requires X Developer Portal credentials in `~/.config/x-cli/.env`; no browser login flow)

Persistence:

- Codex CLI state: `~/.codex`
- Railway CLI state: `~/.railway` plus `RAILWAY_API_TOKEN`
- X CLI credentials: `~/.config/x-cli/.env`

Expected boundary:

- Ted running host commands through OpenClaw: approval-gated
- When Ted or any other approval-gated OpenClaw agent needs approval, it should trigger the real tool/workflow and let OpenClaw send the native Telegram approval UI. Do not simulate approval prompts in plain chat text.
- `power` running host commands through OpenClaw: full-auto for exec, but it must consult the operator before deploys, service control, git push/merge/rebase/reset/force ops, release/publish steps, secret or live-config changes, destructive file/data operations, or other external side effects
- Codex/Gemini/Cursor agents running inside the coder sandbox: no per-command
  approvals inside that nested CLI

Default implementation policy:

1. Use Codex first for repo implementation.
2. Run Codex with high reasoning and retry with OpenAI GPT-5.4 when the primary Codex pass fails.
3. Fall back to the generic Google Gemini API path when Codex and OpenAI fallback both fail.
4. Use Cursor Agent only when explicitly requested or when a task benefits from
   its agent loop.
5. Use `gcloud`, `railway`, and `x-cli` as supporting CLIs, not as the primary code editor.
