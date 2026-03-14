# Ted VPS Smoke Tests

Run these checks on the VPS after a deploy or pipeline change.

## 1. Confirm the live config

```bash
sudo -u openclaw bash -lc 'cd ~/openclaw-current && bash ops/vps/verify-coding-pack-config.sh'
```

Expected:

- the verifier prints `OK`
- Ted still has an approval-capable coding-pack config (`inlineButtons: "allowlist"`, Telegram allowlist, `work` enabled, mirrored exec approvals for `main`, and `power` full-auto host exec with a consultation prompt)

## 2. Confirm the live release

```bash
sudo -u openclaw bash -lc 'readlink -f ~/openclaw-current && git -C ~/openclaw-current rev-parse --short HEAD'
curl -fsS http://127.0.0.1:18789/health
sudo -u openclaw bash -lc 'cd ~/openclaw-current && pnpm openclaw channels status --probe'
```

Expected:

- `openclaw-current` points at the intended release SHA
- `/health` returns `{"ok":true}`
- Telegram shows `running` and `works`

## 3. Confirm only one live gateway process

```bash
ss -ltnp | grep 127.0.0.1:18789
pgrep -af openclaw-gateway
```

Expected:

- one listener on `127.0.0.1:18789`
- one live `openclaw-gateway` process for the production lane

## 4. Ted `/work` smoke test

In Telegram DM with Ted:

```text
/work task owner/repo "Make a docs-only change that adds one sentence to the README and open a PR"
```

Expected:

- Ted resolves the repo and writes a run record
- the run appears in Office automation views
- a structured spec packet is generated before coder execution
- coder uses Codex first and records the selected CLI in the run audit

## 5. Approval flow smoke test

Trigger a host action that requires approval, for example:

```text
/work task owner/repo "Prepare a deploy, but require approval before merge"
```

Expected:

- the originating Telegram chat shows inline Approve and Deny buttons, even when the request started in a dedicated group
- the operator DM also receives the mirrored approval prompt
- the approval text tells you to use the buttons below, with manual `/approve ...` only as fallback
- tapping one resolves the approval and clears the buttons
- non-allowlisted group members cannot resolve the approval buttons
- the message still includes the resume token and manual `/work resume ...` fallback
- the same approval appears in the Office view

## 5b. Choice menu smoke test

Trigger a Ted question that offers simple discrete options, for example a status
toggle or follow-up clarification that ends with `Options: ...`.

Expected:

- Telegram renders the options as inline menu buttons in the active chat
- tapping one clears the buttons
- the selected option is routed back to Ted as user input

## 6. Control UI smoke test

Open the Control UI and verify:

- Office shows the recent automation run list
- selecting a run shows timeline, audit, and current status
- filters by repo and status work
- resume and cancel actions are visible for eligible runs

## 7. Manual CLI login smoke test

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

## 8. Merge gate smoke test

Use a test PR and confirm `/work merge` blocks:

- stale PR head SHA
- failed or pending required checks
- missing human approval

Expected:

- Ted reports the exact blocking condition
- no merge occurs until the gate is satisfied

## 9. Deploy evidence smoke test

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
