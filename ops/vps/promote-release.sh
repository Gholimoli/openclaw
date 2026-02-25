#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: promote-release.sh <commit-sha>

Environment overrides:
  OPENCLAW_REPO_DIR                       Source checkout (default: $HOME/openclaw)
  OPENCLAW_DEPLOY_ROOT                    Deploy state root (default: $HOME/deploy/openclaw)
  OPENCLAW_RELEASES_DIR                   Releases directory (default: $OPENCLAW_DEPLOY_ROOT/releases)
  OPENCLAW_CURRENT_LINK                   Live release symlink (default: $HOME/openclaw-current)
  OPENCLAW_LAST_KNOWN_GOOD_FILE           Last-known-good SHA file (default: $OPENCLAW_DEPLOY_ROOT/last-known-good.sha)
  OPENCLAW_GATEWAY_SERVICE                systemd user service (default: openclaw-gateway.service)
  OPENCLAW_GATEWAY_HEALTH_URL             Health URL (default: http://127.0.0.1:18789/api/v1/check)
  OPENCLAW_PREFLIGHT_PORT                 Candidate preflight port (default: 29879)
  OPENCLAW_PREFLIGHT_TIMEOUT_SECONDS      Candidate boot timeout (default: 35)
  OPENCLAW_HEALTH_TIMEOUT_SECONDS         Post-restart health timeout (default: 90)
  OPENCLAW_STABILITY_SECONDS              Stability window seconds (default: 45)
  OPENCLAW_CHANNELS_PROBE_TIMEOUT_SECONDS channels status probe timeout (default: 90)
  OPENCLAW_RUN_CHANNELS_PROBE             1 to run probe, 0 to skip (default: 1)
EOF
}

log() {
  printf '[vps-promote] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
}

is_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

wait_for_health() {
  local url="$1"
  local timeout_seconds="$2"
  local deadline=$((SECONDS + timeout_seconds))
  while ((SECONDS < deadline)); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

read_restart_count() {
  systemctl --user show "$gateway_service" -p NRestarts --value 2>/dev/null || true
}

set_current_link() {
  local target="$1"
  local tmp_link="${current_link}.next.$$"
  ln -sfn "$target" "$tmp_link"
  mv -fT "$tmp_link" "$current_link"
}

remove_release_dir() {
  local dir="$1"
  if [[ ! -e "$dir" && ! -L "$dir" ]]; then
    return
  fi

  if git -C "$repo_dir" worktree list --porcelain | awk '/^worktree / { print $2 }' | grep -Fxq "$dir"; then
    git -C "$repo_dir" worktree remove --force "$dir" || true
  fi
  rm -rf "$dir"
}

run_channels_probe() {
  if [[ "$run_channels_probe_enabled" != "1" ]]; then
    log "channels probe disabled (OPENCLAW_RUN_CHANNELS_PROBE=$run_channels_probe_enabled)"
    return 0
  fi

  require_cmd openclaw
  log "running channels status probe"
  timeout "${channels_probe_timeout_seconds}s" openclaw channels status --probe >/tmp/openclaw-channels-probe.log 2>&1
}

run_candidate_preflight() {
  local candidate_dir="$1"
  local preflight_state_dir
  preflight_state_dir="$(mktemp -d "${deploy_root}/preflight-state.XXXXXX")"
  local preflight_log="${deploy_root}/preflight-${target_sha}.log"

  log "boot preflight: candidate=${candidate_dir} port=${preflight_port}"
  (
    cd "$candidate_dir"
    OPENCLAW_STATE_DIR="$preflight_state_dir" \
      pnpm openclaw gateway \
        --allow-unconfigured \
        --bind loopback \
        --port "$preflight_port" \
        --token "preflight-${target_sha:0:12}" \
        --force \
        >"$preflight_log" 2>&1
  ) &
  local gateway_pid=$!

  local ok=0
  local deadline=$((SECONDS + preflight_timeout_seconds))
  while ((SECONDS < deadline)); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${preflight_port}/api/v1/check" >/dev/null 2>&1; then
      ok=1
      break
    fi
    if ! kill -0 "$gateway_pid" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if kill -0 "$gateway_pid" >/dev/null 2>&1; then
    kill "$gateway_pid" >/dev/null 2>&1 || true
    wait "$gateway_pid" >/dev/null 2>&1 || true
  else
    wait "$gateway_pid" >/dev/null 2>&1 || true
  fi

  rm -rf "$preflight_state_dir"

  if [[ "$ok" != "1" ]]; then
    fail "candidate preflight failed (see $preflight_log)"
  fi
}

rollback_and_fail() {
  local reason="$1"
  local rollback_dir=""

  if [[ -f "$last_known_good_file" ]]; then
    local lkg_sha
    lkg_sha="$(head -n 1 "$last_known_good_file" | tr -d '[:space:]')"
    if [[ -n "$lkg_sha" && -d "${releases_dir}/${lkg_sha}" ]]; then
      rollback_dir="${releases_dir}/${lkg_sha}"
      log "rollback target selected from last-known-good: $lkg_sha"
    fi
  fi

  if [[ -z "$rollback_dir" && -n "$previous_release_dir" && -d "$previous_release_dir" ]]; then
    rollback_dir="$previous_release_dir"
    log "rollback target selected from previous live release"
  fi

  if [[ -z "$rollback_dir" ]]; then
    fail "${reason}; rollback unavailable"
  fi

  log "rolling back to $rollback_dir"
  set_current_link "$rollback_dir"
  systemctl --user restart "$gateway_service"

  if ! wait_for_health "$gateway_health_url" "$health_timeout_seconds"; then
    fail "${reason}; rollback restart did not recover health"
  fi

  if ! run_channels_probe; then
    fail "${reason}; rollback probe failed"
  fi

  fail "${reason}; rolled back to $(basename "$rollback_dir")"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

target_sha="${1:-}"
if [[ -z "$target_sha" ]]; then
  usage >&2
  exit 2
fi
if [[ ! "$target_sha" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  fail "commit sha must be 7-40 hex chars (got: $target_sha)"
fi

repo_dir="${OPENCLAW_REPO_DIR:-$HOME/openclaw}"
deploy_root="${OPENCLAW_DEPLOY_ROOT:-$HOME/deploy/openclaw}"
releases_dir="${OPENCLAW_RELEASES_DIR:-$deploy_root/releases}"
current_link="${OPENCLAW_CURRENT_LINK:-$HOME/openclaw-current}"
last_known_good_file="${OPENCLAW_LAST_KNOWN_GOOD_FILE:-$deploy_root/last-known-good.sha}"
gateway_service="${OPENCLAW_GATEWAY_SERVICE:-openclaw-gateway.service}"
gateway_health_url="${OPENCLAW_GATEWAY_HEALTH_URL:-http://127.0.0.1:18789/api/v1/check}"
preflight_port="${OPENCLAW_PREFLIGHT_PORT:-29879}"
preflight_timeout_seconds="${OPENCLAW_PREFLIGHT_TIMEOUT_SECONDS:-35}"
health_timeout_seconds="${OPENCLAW_HEALTH_TIMEOUT_SECONDS:-90}"
stability_seconds="${OPENCLAW_STABILITY_SECONDS:-45}"
channels_probe_timeout_seconds="${OPENCLAW_CHANNELS_PROBE_TIMEOUT_SECONDS:-90}"
run_channels_probe_enabled="${OPENCLAW_RUN_CHANNELS_PROBE:-1}"

require_cmd git
require_cmd pnpm
require_cmd curl
require_cmd systemctl
require_cmd timeout

if [[ ! -d "$repo_dir" ]]; then
  fail "repo dir does not exist: $repo_dir"
fi

mkdir -p "$deploy_root" "$releases_dir" "$(dirname "$last_known_good_file")"

git -C "$repo_dir" fetch origin main --prune
git -C "$repo_dir" cat-file -e "${target_sha}^{commit}" 2>/dev/null || fail "unknown commit: $target_sha"

release_dir="${releases_dir}/${target_sha}"
release_ready_marker="${release_dir}/.release-ready"
previous_release_dir="$(readlink -f "$current_link" 2>/dev/null || true)"

if [[ ! -f "$release_ready_marker" ]]; then
  log "building candidate release: $target_sha"
  remove_release_dir "$release_dir"
  git -C "$repo_dir" worktree add --detach "$release_dir" "$target_sha"
  (
    cd "$release_dir"
    pnpm install --frozen-lockfile
    pnpm build
  )
  run_candidate_preflight "$release_dir"
  touch "$release_ready_marker"
else
  log "reusing existing prepared release: $release_dir"
fi

before_restarts="$(read_restart_count)"
log "promoting release to live symlink: $release_dir"
set_current_link "$release_dir"

if ! systemctl --user restart "$gateway_service"; then
  rollback_and_fail "gateway restart failed after promotion"
fi

if ! wait_for_health "$gateway_health_url" "$health_timeout_seconds"; then
  rollback_and_fail "gateway health check failed after promotion"
fi

if ! run_channels_probe; then
  rollback_and_fail "channels probe failed after promotion"
fi

if ! is_integer "$stability_seconds"; then
  fail "OPENCLAW_STABILITY_SECONDS must be an integer (got: $stability_seconds)"
fi
if ((stability_seconds > 0)); then
  log "waiting stability window: ${stability_seconds}s"
  sleep "$stability_seconds"
fi

after_restarts="$(read_restart_count)"
if is_integer "$before_restarts" && is_integer "$after_restarts"; then
  if ((after_restarts > before_restarts)); then
    rollback_and_fail "service restart count increased during stability window (${before_restarts} -> ${after_restarts})"
  fi
else
  log "restart-count check skipped (before='${before_restarts}', after='${after_restarts}')"
fi

printf '%s\n' "$target_sha" > "$last_known_good_file"
log "promotion succeeded: $target_sha"
