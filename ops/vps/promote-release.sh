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
  OPENCLAW_CLI_SHIM                       Host CLI shim rewritten to the live release (default: $HOME/.local/share/pnpm/openclaw)
  OPENCLAW_LAST_KNOWN_GOOD_FILE           Last-known-good SHA file (default: $OPENCLAW_DEPLOY_ROOT/last-known-good.sha)
  OPENCLAW_ENV_FILE                       Env file loaded before preflight/probes (default: $HOME/.openclaw/.env)
  OPENCLAW_GATEWAY_SERVICE                systemd unit name to restart (default: auto-detect)
  OPENCLAW_GATEWAY_SERVICE_SCOPE          systemd scope: auto, user, or system (default: auto)
  OPENCLAW_GATEWAY_HEALTH_URL             Health URL (default: http://127.0.0.1:18789/health)
  OPENCLAW_PREFLIGHT_PORT                 Candidate preflight port (default: 29879)
  OPENCLAW_PREFLIGHT_TIMEOUT_SECONDS      Candidate boot timeout (default: 90)
  OPENCLAW_PREFLIGHT_TMP_ROOT             Writable root for preflight state/logs (default: ${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/openclaw-preflight)
  OPENCLAW_HEALTH_TIMEOUT_SECONDS         Post-restart health timeout (default: 90)
  OPENCLAW_STABILITY_SECONDS              Stability window seconds (default: 45)
  OPENCLAW_CHANNELS_PROBE_TIMEOUT_SECONDS channels status probe timeout (default: 90)
  OPENCLAW_RUN_CHANNELS_PROBE             1 to run probe, 0 to skip (default: 1)
  OPENCLAW_SYNC_VPS_CODING_PACK_CONFIG    1 to sync live config from the VPS coding-pack template before verification/cutover, 0 to skip (default: 1)
  OPENCLAW_VERIFY_VPS_CODING_PACK_CONFIG  1 to verify the live config matches the VPS coding pack guardrails, 0 to skip (default: 1)
EOF
}

log() {
  printf '[vps-promote] %s\n' "$*"
}

warn() {
  printf '[vps-promote] WARN: %s\n' "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

append_automation_audit() {
  local status="$1"
  local message="$2"
  if [[ "${automation_audit_recorded:-0}" == "1" ]]; then
    return 0
  fi

  local automation_root="${OPENCLAW_AUTOMATION_ROOT:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/automation}"
  local events_path="${OPENCLAW_AUTOMATION_EVENTS_PATH:-$automation_root/events.jsonl}"
  local actor_id="${OPENCLAW_AUTOMATION_ACTOR_ID:-vps-deploy}"
  local actor_label="${OPENCLAW_AUTOMATION_ACTOR_LABEL:-VPS Deploy}"
  local run_id="${OPENCLAW_AUTOMATION_RUN_ID:-}"
  local repo_ref="${OPENCLAW_AUTOMATION_REPO:-$(basename "$repo_dir")}"
  local branch_ref="${OPENCLAW_AUTOMATION_BRANCH:-main}"

  mkdir -p "$(dirname "$events_path")"
  EVENTS_PATH="$events_path" \
  AUDIT_STATUS="$status" \
  AUDIT_MESSAGE="$message" \
  AUDIT_RUN_ID="$run_id" \
  AUDIT_REPO="$repo_ref" \
  AUDIT_BRANCH="$branch_ref" \
  AUDIT_TARGET_SHA="$target_sha" \
  AUDIT_ACTOR_ID="$actor_id" \
  AUDIT_ACTOR_LABEL="$actor_label" \
  node <<'EOF'
const fs = require("node:fs");

const ts = Date.now();
const runId = (process.env.AUDIT_RUN_ID || "").trim();
const entry = {
  id: `audit-deploy-${process.env.AUDIT_TARGET_SHA}-${ts}`,
  ts,
  kind: "deploy.result",
  status: process.env.AUDIT_STATUS,
  message: process.env.AUDIT_MESSAGE,
  repo: process.env.AUDIT_REPO || undefined,
  branch: process.env.AUDIT_BRANCH || undefined,
  actor: {
    id: process.env.AUDIT_ACTOR_ID || "vps-deploy",
    type: "system",
    label: process.env.AUDIT_ACTOR_LABEL || "VPS Deploy",
  },
  data: {
    commit: process.env.AUDIT_TARGET_SHA,
  },
};
if (runId) {
  entry.runId = runId;
}
const event = { kind: "audit.append", ts, entry };
fs.appendFileSync(process.env.EVENTS_PATH, `${JSON.stringify(event)}\n`);
EOF
  automation_audit_recorded=1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
}

normalize_service_name() {
  local unit="$1"
  unit="${unit#"${unit%%[![:space:]]*}"}"
  unit="${unit%"${unit##*[![:space:]]}"}"
  if [[ -z "$unit" ]]; then
    return 1
  fi
  if [[ "$unit" != *.service ]]; then
    unit="${unit}.service"
  fi
  printf '%s\n' "$unit"
}

ensure_user_systemd_env() {
  if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
    local runtime_dir="/run/user/$(id -u)"
    if [[ -d "$runtime_dir" ]]; then
      export XDG_RUNTIME_DIR="$runtime_dir"
    fi
  fi
  if [[ -n "${XDG_RUNTIME_DIR:-}" && -S "${XDG_RUNTIME_DIR}/bus" && -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  fi
}

run_systemctl() {
  local scope="$1"
  shift
  if [[ "$scope" == "user" ]]; then
    ensure_user_systemd_env
    systemctl --user "$@"
    return
  fi
  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo -n systemctl "$@"
    return
  fi
  systemctl "$@"
}

service_exists() {
  local scope="$1"
  local unit="$2"
  local load_state
  load_state="$(run_systemctl "$scope" show "$unit" -p LoadState --value 2>/dev/null || true)"
  [[ "$load_state" != "not-found" && -n "$load_state" ]]
}

resolve_gateway_service() {
  local requested_scope="${OPENCLAW_GATEWAY_SERVICE_SCOPE:-auto}"
  local requested_service="${OPENCLAW_GATEWAY_SERVICE:-}"
  local default_gateway_service="openclaw-gateway.service"
  local profile="${OPENCLAW_PROFILE:-}"
  local profile_lower=""
  if [[ -n "$profile" ]]; then
    profile_lower="$(printf '%s' "$profile" | tr '[:upper:]' '[:lower:]')"
  fi
  if [[ -n "$profile" && "$profile_lower" != "default" ]]; then
    default_gateway_service="$(normalize_service_name "openclaw-gateway-${profile}")"
  fi

  if [[ -n "$requested_service" ]]; then
    requested_service="$(normalize_service_name "$requested_service")" || fail "OPENCLAW_GATEWAY_SERVICE must not be empty"
  fi

  local -a candidates=()
  case "$requested_scope" in
    auto)
      if [[ -n "$requested_service" ]]; then
        if [[ "$requested_service" == "openclaw.service" ]]; then
          candidates=("system:${requested_service}" "user:${requested_service}")
        else
          candidates=("user:${requested_service}" "system:${requested_service}")
        fi
      else
        candidates=(
          "user:${default_gateway_service}"
          "system:${default_gateway_service}"
          "system:openclaw.service"
          "user:openclaw.service"
        )
      fi
      ;;
    user|system)
      if [[ -z "$requested_service" ]]; then
        if [[ "$requested_scope" == "user" ]]; then
          requested_service="$default_gateway_service"
        else
          requested_service="openclaw.service"
        fi
      fi
      candidates=("${requested_scope}:${requested_service}")
      ;;
    *)
      fail "OPENCLAW_GATEWAY_SERVICE_SCOPE must be one of: auto, user, system (got: $requested_scope)"
      ;;
  esac

  local candidate scope unit
  for candidate in "${candidates[@]}"; do
    scope="${candidate%%:*}"
    unit="${candidate#*:}"
    if service_exists "$scope" "$unit"; then
      gateway_service_scope="$scope"
      gateway_service="$unit"
      log "resolved gateway service: scope=${gateway_service_scope} unit=${gateway_service}"
      return 0
    fi
  done

  if [[ -n "$requested_service" ]]; then
    fail "unable to find requested gateway service (${requested_scope}:${requested_service})"
  fi
  fail "unable to resolve a gateway service; set OPENCLAW_GATEWAY_SERVICE and OPENCLAW_GATEWAY_SERVICE_SCOPE explicitly"
}

load_env_file() {
  if [[ ! -f "$env_file" ]]; then
    warn "env file not found; continuing without it: $env_file"
    return 0
  fi

  set -a
  # shellcheck source=/dev/null
  . "$env_file"
  set +a
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
  run_systemctl "$gateway_service_scope" show "$gateway_service" -p NRestarts --value 2>/dev/null || true
}

set_current_link() {
  local target="$1"
  local tmp_link="${current_link}.next.$$"
  ln -sfn "$target" "$tmp_link"
  rm -f "$current_link"
  mv -f "$tmp_link" "$current_link"
}

sync_openclaw_cli_shim() {
  local release_dir="$1"
  local cli_shim="${OPENCLAW_CLI_SHIM:-$HOME/.local/share/pnpm/openclaw}"
  local entrypoint="${release_dir}/openclaw.mjs"
  local plugins_dir="${release_dir}/extensions"
  local skills_dir="${release_dir}/skills"
  local hooks_dir="${release_dir}/dist/hooks/bundled"

  [[ -f "$entrypoint" ]] || fail "release entrypoint not found: $entrypoint"

  mkdir -p "$(dirname "$cli_shim")"
  local tmp_shim="${cli_shim}.next.$$"
  cat >"$tmp_shim" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export OPENCLAW_BUNDLED_PLUGINS_DIR="$plugins_dir"
export OPENCLAW_BUNDLED_SKILLS_DIR="$skills_dir"
export OPENCLAW_BUNDLED_HOOKS_DIR="$hooks_dir"
exec node "$entrypoint" "\$@"
EOF
  chmod 0755 "$tmp_shim"
  mv -f "$tmp_shim" "$cli_shim"
  log "synced openclaw CLI shim to $(basename "$release_dir")"
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

run_pack_config_verify() {
  if [[ "$verify_vps_coding_pack_config" != "1" ]]; then
    log "VPS coding-pack config verification disabled (OPENCLAW_VERIFY_VPS_CODING_PACK_CONFIG=$verify_vps_coding_pack_config)"
    return 0
  fi

  local verify_script="$1/ops/vps/verify-coding-pack-config.sh"
  [[ -x "$verify_script" ]] || fail "config verify script is missing or not executable: $verify_script"

  log "verifying live VPS coding-pack config"
  if ! "$verify_script" >/tmp/openclaw-vps-config-verify.log 2>&1; then
    cat /tmp/openclaw-vps-config-verify.log >&2 || true
    fail "live VPS coding-pack config verification failed"
  fi
}

run_pack_config_sync() {
  if [[ "$sync_vps_coding_pack_config" != "1" ]]; then
    log "VPS coding-pack config sync disabled (OPENCLAW_SYNC_VPS_CODING_PACK_CONFIG=$sync_vps_coding_pack_config)"
    return 0
  fi

  local sync_script="$1/ops/vps/sync-coding-pack-config.sh"
  [[ -x "$sync_script" ]] || fail "config sync script is missing or not executable: $sync_script"

  log "syncing live VPS coding-pack config"
  if ! "$sync_script" >/tmp/openclaw-vps-config-sync.log 2>&1; then
    cat /tmp/openclaw-vps-config-sync.log >&2 || true
    fail "live VPS coding-pack config sync failed"
  fi
}

notify_deploy_success() {
  if ! command -v openclaw >/dev/null 2>&1; then
    warn "openclaw CLI not found; skipping deploy success notification"
    return 0
  fi

  local ts_utc host short_sha event_text
  ts_utc="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  host="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo unknown-host)"
  short_sha="${target_sha:0:12}"
  event_text="Deployment succeeded: commit=${target_sha} short=${short_sha} utc=${ts_utc} host=${host} service=${gateway_service} scope=${gateway_service_scope}"

  if ! openclaw system event --mode now --text "$event_text" >/tmp/openclaw-deploy-notify.log 2>&1; then
    warn "failed to enqueue deploy success system event; see /tmp/openclaw-deploy-notify.log"
    return 0
  fi

  log "deploy success system event queued"
  return 0
}

run_candidate_preflight() {
  local candidate_dir="$1"
  local preflight_state_dir
  mkdir -p "$preflight_tmp_root"
  preflight_state_dir="$(mktemp -d "${preflight_tmp_root}/state.XXXXXX")"
  local preflight_log="${preflight_tmp_root}/preflight-${target_sha}.log"

  log "boot preflight: candidate=${candidate_dir} port=${preflight_port}"
  (
    cd "$candidate_dir"
    OPENCLAW_STATE_DIR="$preflight_state_dir" \
      node "$candidate_dir/openclaw.mjs" gateway \
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
    if curl -fsS --max-time 2 "http://127.0.0.1:${preflight_port}/health" >/dev/null 2>&1; then
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
  sync_openclaw_cli_shim "$rollback_dir"
  run_systemctl "$gateway_service_scope" restart "$gateway_service"

  if ! wait_for_health "$gateway_health_url" "$health_timeout_seconds"; then
    fail "${reason}; rollback restart did not recover health"
  fi

  if ! run_channels_probe; then
    fail "${reason}; rollback probe failed"
  fi

  append_automation_audit "failed" "${reason}; rolled back to $(basename "$rollback_dir")"
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
env_file="${OPENCLAW_ENV_FILE:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/.env}"
gateway_service="${OPENCLAW_GATEWAY_SERVICE:-}"
gateway_service_scope=""
gateway_health_url="${OPENCLAW_GATEWAY_HEALTH_URL:-http://127.0.0.1:18789/health}"
preflight_port="${OPENCLAW_PREFLIGHT_PORT:-29879}"
preflight_timeout_seconds="${OPENCLAW_PREFLIGHT_TIMEOUT_SECONDS:-90}"
preflight_tmp_root="${OPENCLAW_PREFLIGHT_TMP_ROOT:-${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/openclaw-preflight}"
health_timeout_seconds="${OPENCLAW_HEALTH_TIMEOUT_SECONDS:-90}"
stability_seconds="${OPENCLAW_STABILITY_SECONDS:-45}"
channels_probe_timeout_seconds="${OPENCLAW_CHANNELS_PROBE_TIMEOUT_SECONDS:-90}"
run_channels_probe_enabled="${OPENCLAW_RUN_CHANNELS_PROBE:-1}"
verify_vps_coding_pack_config="${OPENCLAW_VERIFY_VPS_CODING_PACK_CONFIG:-1}"
sync_vps_coding_pack_config="${OPENCLAW_SYNC_VPS_CODING_PACK_CONFIG:-1}"

require_cmd git
require_cmd pnpm
require_cmd curl
require_cmd systemctl
require_cmd timeout

if [[ ! -d "$repo_dir" ]]; then
  fail "repo dir does not exist: $repo_dir"
fi

mkdir -p "$deploy_root" "$releases_dir" "$(dirname "$last_known_good_file")"
load_env_file
resolve_gateway_service

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
    pnpm ui:build
  )
  run_candidate_preflight "$release_dir"
  touch "$release_ready_marker"
else
  log "reusing existing prepared release: $release_dir"
fi

run_pack_config_sync "$release_dir"
run_pack_config_verify "$release_dir"
before_restarts="$(read_restart_count)"
log "promoting release to live symlink: $release_dir"
set_current_link "$release_dir"
sync_openclaw_cli_shim "$release_dir"

if ! run_systemctl "$gateway_service_scope" restart "$gateway_service"; then
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
append_automation_audit "completed" "Deployment succeeded for ${target_sha}"
notify_deploy_success
