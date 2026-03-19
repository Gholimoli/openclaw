#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[vps-fix-host-access] %s\n' "$*"
}

fail() {
  printf '[vps-fix-host-access] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    fail "run as root"
  fi
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
}

require_root
require_cmd systemctl
require_cmd sshd

unit_dropin_dir="/etc/systemd/system/openclaw.service.d"
unit_dropin_path="${unit_dropin_dir}/10-shared-tmp.conf"
sshd_dropin_dir="/etc/ssh/sshd_config.d"
sshd_dropin_path="${sshd_dropin_dir}/99-openclaw-stability.conf"

log "writing openclaw.service drop-in"
mkdir -p "$unit_dropin_dir"
cat >"$unit_dropin_path" <<'EOF'
[Service]
PrivateTmp=false
EOF

log "writing sshd stability drop-in"
mkdir -p "$sshd_dropin_dir"
cat >"$sshd_dropin_path" <<'EOF'
MaxStartups 500:30:1000
LoginGraceTime 15
MaxSessions 100
UseDNS no
EOF

log "validating sshd configuration"
sshd -t

log "reloading systemd and restarting services"
systemctl daemon-reload
systemctl restart ssh
systemctl restart openclaw

log "verifying live settings"
systemctl is-active ssh >/dev/null
systemctl is-active openclaw >/dev/null
systemctl show openclaw -p PrivateTmp --value | grep -qx 'no'

log "done"
