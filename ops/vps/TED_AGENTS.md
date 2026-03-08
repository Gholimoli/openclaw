# Ted VPS Coding Toolchain

Ted orchestrates coding work through `/work` and keeps the outer OpenClaw
approval boundary intact for host execution, sudo, deploys, pushes, merges, and
other non-coding-agent actions.

Inside the dedicated coding CLI environment, the nested coding agents are
trusted and run with full access:

- Codex CLI: use `codex exec --full-auto ...`
- Gemini CLI: use `gemini --approval-mode yolo ...` or `gemini-yolo ...`
- Cursor Agent CLI: use `agent --force ...` or `cursor-agent --force ...`
- Google Cloud CLI: `gcloud`
- X CLI: `x-cli`

Expected boundary:

- Ted or `power` running host commands through OpenClaw: approval-gated
- Codex/Gemini/Cursor agents running inside the coder sandbox: no per-command
  approvals inside that nested CLI

Default implementation policy:

1. Use Codex first for repo implementation.
2. Run Codex with high reasoning and retry with GPT-5.4 when the primary Codex pass fails.
3. Fall back to Gemini when Codex fails or is unavailable.
4. Use Cursor Agent only when explicitly requested or when a task benefits from
   its agent loop.
5. Use `gcloud` and `x-cli` as supporting CLIs, not as the primary code editor.
