#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

PRIMARY_USER="${SUDO_USER:-root}"
PRIMARY_HOME="$(getent passwd "$PRIMARY_USER" | cut -d: -f6)"
if [[ -z "${PRIMARY_HOME:-}" ]]; then
  echo "Could not resolve home directory for $PRIMARY_USER." >&2
  exit 1
fi

run_as_primary_user() {
  local cmd="$1"
  if [[ "$PRIMARY_USER" == "root" ]]; then
    bash -lc "$cmd"
  else
    sudo -H -u "$PRIMARY_USER" bash -lc "$cmd"
  fi
}

link_user_local_bin() {
  local bin_name="$1"
  local source_path="$PRIMARY_HOME/.local/bin/$bin_name"
  if [[ -e "$source_path" ]]; then
    ln -sf "$source_path" "/usr/local/bin/$bin_name"
  fi
}

write_if_missing() {
  local target_path="$1"
  local source_path="$2"
  if [[ -e "$target_path" ]]; then
    return
  fi
  install -d -m 0755 "$(dirname "$target_path")"
  install -m 0644 "$source_path" "$target_path"
  chown "$PRIMARY_USER":"$PRIMARY_USER" "$target_path"
}

if [[ -f "$PRIMARY_HOME/.openclaw/.env" ]]; then
  # shellcheck disable=SC1090
  set -a && source "$PRIMARY_HOME/.openclaw/.env" && set +a
fi

echo "[1/5] Seed Ted workspace guidance"
install -d -m 0755 -o "$PRIMARY_USER" -g "$PRIMARY_USER" "$PRIMARY_HOME/work/repos"
write_if_missing "$PRIMARY_HOME/work/repos/AGENTS.md" "$REPO_ROOT/ops/vps/TED_AGENTS.md"

echo "[2/5] Configure Codex defaults"
install -d -m 0755 -o "$PRIMARY_USER" -g "$PRIMARY_USER" "$PRIMARY_HOME/.codex"
cat > "$PRIMARY_HOME/.codex/config.toml" <<'EOF'
approval_policy = "never"
sandbox_mode = "danger-full-access"
reasoning_effort = "high"
EOF
chown "$PRIMARY_USER":"$PRIMARY_USER" "$PRIMARY_HOME/.codex/config.toml"

echo "[3/5] Configure Gemini defaults"
install -d -m 0755 -o "$PRIMARY_USER" -g "$PRIMARY_USER" "$PRIMARY_HOME/.gemini/policies"
cat > "$PRIMARY_HOME/.gemini/policies/openclaw-yolo.toml" <<'EOF'
[[rule]]
toolName = "*"
decision = "allow"
priority = 1000
EOF
chown "$PRIMARY_USER":"$PRIMARY_USER" "$PRIMARY_HOME/.gemini/policies/openclaw-yolo.toml"

echo "[4/5] Install helper wrappers"
cat > /usr/local/bin/gemini-yolo <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec gemini --approval-mode yolo "$@"
EOF
cat > /usr/local/bin/agent-full <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec agent --force "$@"
EOF
chmod +x /usr/local/bin/gemini-yolo /usr/local/bin/agent-full
ln -sf /usr/local/bin/agent-full /usr/local/bin/cursor-agent-full

echo "[5/5] Configure optional X/Google auth"
if [[ -n "${X_API_KEY:-}" && -n "${X_API_SECRET:-}" && -n "${X_BEARER_TOKEN:-}" && -n "${X_ACCESS_TOKEN:-}" && -n "${X_ACCESS_TOKEN_SECRET:-}" ]]; then
  install -d -m 0700 -o "$PRIMARY_USER" -g "$PRIMARY_USER" "$PRIMARY_HOME/.config/x-cli"
  cat > "$PRIMARY_HOME/.config/x-cli/.env" <<EOF
X_API_KEY=${X_API_KEY}
X_API_SECRET=${X_API_SECRET}
X_BEARER_TOKEN=${X_BEARER_TOKEN}
X_ACCESS_TOKEN=${X_ACCESS_TOKEN}
X_ACCESS_TOKEN_SECRET=${X_ACCESS_TOKEN_SECRET}
EOF
  chown "$PRIMARY_USER":"$PRIMARY_USER" "$PRIMARY_HOME/.config/x-cli/.env"
  chmod 600 "$PRIMARY_HOME/.config/x-cli/.env"
fi

if command -v gcloud >/dev/null 2>&1; then
  key_file="${GCLOUD_SERVICE_ACCOUNT_KEY_FILE:-${GOOGLE_APPLICATION_CREDENTIALS:-}}"
  if [[ -n "${key_file:-}" && -f "$key_file" ]]; then
    gcloud auth activate-service-account --key-file="$key_file" >/dev/null
  fi
  if [[ -n "${GCLOUD_PROJECT:-}" ]]; then
    gcloud config set project "$GCLOUD_PROJECT" >/dev/null
  fi
fi

run_as_primary_user 'export PATH="$HOME/.local/bin:$PATH"; command -v agent >/dev/null 2>&1 && agent --version >/dev/null 2>&1 || true'
link_user_local_bin agent
link_user_local_bin cursor-agent
link_user_local_bin uv
link_user_local_bin x-cli

echo "Configured coding CLI defaults for $PRIMARY_USER."
