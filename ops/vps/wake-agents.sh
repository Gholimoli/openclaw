#!/usr/bin/env bash
set -euo pipefail

readonly REQUIRED_AGENTS=("coder" "power" "devops")

log() {
  printf '[wake-agents] %s\n' "$*"
}

warn() {
  printf '[wake-agents] WARN: %s\n' "$*" >&2
}

fail() {
  printf '[wake-agents] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
}

resolve_group_binding() {
  local agent_id="$1"
  jq -r --arg agent "$agent_id" '
    (
      (. // [])
      | map(
          select(
            .agentId == $agent and
            .match.channel == "telegram" and
            .match.peer.kind == "group" and
            (.match.peer.id | type == "string")
          )
          | .match.peer.id
        )
      | first
    ) // empty
  '
}

normalize_reply_target() {
  local raw="$1"
  local trimmed="${raw#telegram:group:}"
  trimmed="${trimmed#telegram:}"
  printf '%s\n' "$trimmed"
}

main() {
  require_cmd openclaw
  require_cmd jq
  require_cmd date

  local agents_json bindings_json
  if ! agents_json="$(openclaw config get agents.list --json 2>/dev/null)"; then
    fail "failed to read agents.list via openclaw config get"
  fi
  bindings_json="$(openclaw config get bindings --json 2>/dev/null || true)"
  if [[ -z "${bindings_json}" ]]; then
    bindings_json='[]'
  fi
  if ! jq -e 'type == "array"' <<<"$bindings_json" >/dev/null 2>&1; then
    fail "bindings config is not a JSON array"
  fi

  local missing=0
  local agent_id
  for agent_id in "${REQUIRED_AGENTS[@]}"; do
    if ! jq -e --arg id "$agent_id" 'any((. // [])[]; .id == $id)' <<<"$agents_json" >/dev/null; then
      warn "required agent missing from config: $agent_id"
      missing=1
    fi
  done
  ((missing == 0)) || fail "required agents missing; fix config before waking"

  local started_utc
  started_utc="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  local prompt_template
  prompt_template="Wake check run initiated at ${started_utc}. Reply with exactly one line:
AGENT_ONLINE agent=<agent_id> utc=<YYYY-MM-DDTHH:MM:SSZ>
Do not add any extra text."

  local failures=0
  for agent_id in "${REQUIRED_AGENTS[@]}"; do
    local group_id
    group_id="$(resolve_group_binding "$agent_id" <<<"$bindings_json")"
    if [[ -z "$group_id" ]]; then
      warn "missing telegram group binding for agent: $agent_id"
      failures=1
      continue
    fi
    group_id="$(normalize_reply_target "$group_id")"

    log "waking ${agent_id} -> telegram group ${group_id}"
    local prompt="${prompt_template//<agent_id>/${agent_id}}"
    if ! openclaw agent \
      --agent "$agent_id" \
      --message "$prompt" \
      --deliver \
      --reply-channel telegram \
      --reply-to "$group_id" \
      --thinking low \
      --timeout 180; then
      warn "wake command failed for agent: $agent_id"
      failures=1
      continue
    fi
  done

  if ((failures != 0)); then
    fail "one or more agent wake operations failed"
  fi
  log "all requested agents were woken successfully"
}

main "$@"
