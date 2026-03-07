# Ted VPS Smoke Tests

Run these checks on the VPS after a deploy or pipeline change.

## 1. Confirm the live release

```bash
sudo -u openclaw bash -lc 'readlink -f ~/openclaw-current && git -C ~/openclaw-current rev-parse --short HEAD'
curl -fsS http://127.0.0.1:18789/health
sudo -u openclaw bash -lc 'cd ~/openclaw-current && pnpm openclaw channels status --probe'
```

Expected:

- `openclaw-current` points at the intended release SHA
- `/health` returns `{"ok":true}`
- Telegram shows `running` and `works`

## 2. Confirm only one live gateway process

```bash
ss -ltnp | grep 127.0.0.1:18789
pgrep -af openclaw-gateway
```

Expected:

- one listener on `127.0.0.1:18789`
- one live `openclaw-gateway` process for the production lane

## 3. Ted `/work` smoke test

In Telegram DM with Ted:

```text
/work task owner/repo "Make a docs-only change that adds one sentence to the README and open a PR"
```

Expected:

- Ted resolves the repo and writes a run record
- the run appears in Office automation views
- a structured spec packet is generated before coder execution
- coder uses Codex first and records the selected CLI in the run audit

## 4. Approval flow smoke test

Trigger a host action that requires approval, for example:

```text
/work task owner/repo "Prepare a deploy, but require approval before merge"
```

Expected:

- Telegram DM shows inline Approve and Deny buttons
- tapping one resolves the approval and clears the buttons
- the same approval appears in the Office view

## 5. Control UI smoke test

Open the Control UI and verify:

- Office shows the recent automation run list
- selecting a run shows timeline, audit, and current status
- filters by repo and status work
- resume and cancel actions are visible for eligible runs

## 6. Manual CLI login smoke test

These are interactive host-only flows. They are separate from unattended `/work` runs.

```bash
sudo bash ops/vps/login-coding-clis.sh codex
sudo bash ops/vps/login-coding-clis.sh gh
sudo bash ops/vps/login-coding-clis.sh gemini
sudo bash ops/vps/login-coding-clis.sh agent
```

Expected:

- each command opens or reuses a `tmux` session
- you can attach and complete the login in a real TTY
- Codex, GitHub CLI, Gemini CLI, and agent stay usable after login

## 7. Merge gate smoke test

Use a test PR and confirm `/work merge` blocks:

- stale PR head SHA
- failed or pending required checks
- missing human approval

Expected:

- Ted reports the exact blocking condition
- no merge occurs until the gate is satisfied

## 8. Deploy evidence smoke test

After a real merge-to-main deploy:

- deployment success or failure appears in Telegram
- the run audit includes deploy evidence
- Office shows the same deploy result under the run timeline

## Credentials still needed

To complete the interactive login portion, provide the credentials or auth method for:

- Codex
- GitHub CLI
- Gemini CLI
- agent
