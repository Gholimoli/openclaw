---
title: "ClawForge"
summary: "A machine readable contract for risk tiering, preflight gating, review agent discipline, and UI evidence in CI and /work."
read_when:
  - You are changing CI, workflows, or merge policy
  - You want risk aware checks and machine verifiable evidence for UI flows
  - You are operating the /work coding pipeline
---

# ClawForge

ClawForge is OpenClaw's coding harness: a single contract that makes CI and agent driven coding loops deterministic and auditable.

The goal is one loop:

- a coding agent writes code
- the repo enforces risk aware checks before merge
- a review agent signal is tied to the current PR head SHA
- evidence (tests and UI flows) is machine verifiable
- regressions become harness gaps, not one off fixes

## Contract

ClawForge lives in one machine readable file:

- `.clawforge/contract.json`

It defines:

- risk tiers by changed paths
- which CI scopes can be forced on by tier
- docs drift rules (control plane changes must update docs)
- evidence rules (when UI evidence is required)
- review agent policy (CodeRabbit) for high risk tiers

### Risk tiers

The contract contains ordered `riskTierRules`. First match wins.

Practical guidance:

- `high` should include control plane surfaces such as `.github`, critical Gateway code, routing, and channel plumbing.
- `medium` covers most regular code changes.
- `docs` covers documentation only changes.
- `low` is the default fallback.

## CI preflight gate

CI runs a preflight gate as an early job:

- `clawforge-preflight` (in the `CI` workflow)

It:

1. Computes the changed file set for the event.
2. Classifies a `risk_tier` using `.clawforge/contract.json`.
3. Enforces docs drift rules.
4. For high risk tiers, enforces current head SHA discipline for the review agent:
   - waits for CodeRabbit check runs on the current PR head SHA
   - fails fast if the PR head SHA changes while waiting
5. Emits outputs used by downstream scope detection:
   - `force_run_node`
   - `force_run_macos`
   - `force_run_android`
   - `require_ui_evidence`

This keeps expensive CI fanout jobs from starting when the PR is already blocked by policy or stale evidence.

## CodeRabbit rerun requester

ClawForge uses one canonical rerun comment writer:

- `.github/workflows/clawforge-coderabbit-rerun.yml`

It posts at most one rerun request per PR head SHA using a marker plus `sha:<headSha>` dedupe.

## UI evidence

When UI evidence is required by the contract, CI runs:

- `ui-evidence`

It runs browser backed Control UI tests and uploads a machine verifiable manifest:

- `ui-evidence.json`

## Harness gaps

When a regression slips through, file a ClawForge harness gap issue so it becomes a repeatable check:

- `.github/ISSUE_TEMPLATE/clawforge-harness-gap.yml`

The intent is to preserve incident memory:

production regression -> harness gap issue -> deterministic case added -> tracked until closed

## /work integration

If a repo contains `.clawforge/contract.json`, the `/work` pipeline uses it to choose checks:

- low risk: prefer fast local checks
- medium risk: full unit checks
- high risk: build, protocol checks, and stricter verification
- UI evidence rules: run `pnpm test:ui` when required

Related:

- [Coding automation pipeline](/automation/coding-pipeline)
- [Work plugin](/plugins/work)
- [CI](/ci)
