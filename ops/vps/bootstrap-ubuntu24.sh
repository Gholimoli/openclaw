#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

PRIMARY_USER="${SUDO_USER:-root}"
PRIMARY_HOME="$(getent passwd "$PRIMARY_USER" | cut -d: -f6)"
if [[ -z "${PRIMARY_HOME:-}" ]]; then
  PRIMARY_HOME="/root"
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

echo "[1/12] Base packages"
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg lsb-release jq git ufw python3 python3-venv pipx tmux

echo "[2/12] UFW (lock down public exposure)"
if command -v ufw >/dev/null 2>&1; then
  ssh_port="22"
  if command -v sshd >/dev/null 2>&1; then
    detected="$(sshd -T 2>/dev/null | awk '$1 == \"port\" { print $2; exit }' || true)"
    if [[ -n "${detected:-}" ]]; then
      ssh_port="$detected"
    fi
  fi
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow "${ssh_port}/tcp"
  ufw --force enable
fi

echo "[3/12] Tailscale (private access)"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

echo "[4/12] Docker (for OpenClaw sandbox)"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

echo "[5/12] Node 22 (for OpenClaw CLI)"
node_major=""
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
fi
if [[ -z "${node_major:-}" || "${node_major}" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash
  apt-get install -y --no-install-recommends nodejs
fi

echo "[6/12] Install OpenClaw CLI"
if ! command -v openclaw >/dev/null 2>&1; then
  npm install -g openclaw@latest
fi

echo "[7/12] Install Lobster CLI"
if ! command -v lobster >/dev/null 2>&1; then
  npm install -g @clawdbot/lobster@latest
fi
if ! command -v lobster >/dev/null 2>&1; then
  echo "lobster CLI not found after install; expected @clawdbot/lobster to provide it" >&2
  exit 1
fi

echo "[8/12] Install OpenAI and Gemini CLIs"
if ! command -v codex >/dev/null 2>&1 || ! command -v gemini >/dev/null 2>&1; then
  npm install -g @openai/codex @google/gemini-cli
fi

echo "[9/12] Install Cursor Agent and x-cli"
run_as_primary_user 'mkdir -p "$HOME/.local/bin"'
if ! run_as_primary_user 'export PATH="$HOME/.local/bin:$PATH"; command -v agent >/dev/null 2>&1'; then
  run_as_primary_user 'curl -fsSL https://cursor.com/install | bash'
fi
if ! run_as_primary_user 'export PATH="$HOME/.local/bin:$PATH"; command -v uv >/dev/null 2>&1'; then
  run_as_primary_user 'curl -LsSf https://astral.sh/uv/install.sh | sh'
fi
if ! run_as_primary_user 'export PATH="$HOME/.local/bin:$PATH"; command -v x-cli >/dev/null 2>&1'; then
  run_as_primary_user 'export PATH="$HOME/.local/bin:$PATH"; uv tool install --force git+https://github.com/INFATOSHI/x-cli.git'
fi
link_user_local_bin agent
link_user_local_bin cursor-agent
link_user_local_bin uv
link_user_local_bin x-cli

echo "[10/12] Install Google Cloud CLI"
if ! command -v gcloud >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | gpg --dearmor -o /etc/apt/keyrings/google-cloud-cli.gpg
  chmod a+r /etc/apt/keyrings/google-cloud-cli.gpg
  echo "deb [signed-by=/etc/apt/keyrings/google-cloud-cli.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-cli.list
  apt-get update
  apt-get install -y --no-install-recommends google-cloud-cli
fi

echo "[11/12] Build coder sandbox image"
if ! docker image inspect openclaw-sandbox:bookworm-slim >/dev/null 2>&1; then
  echo "Building openclaw-sandbox:bookworm-slim"
  docker build -t openclaw-sandbox:bookworm-slim -f Dockerfile.sandbox .
fi
if ! docker image inspect openclaw-sandbox-common:bookworm-slim >/dev/null 2>&1; then
  echo "Building openclaw-sandbox-common:bookworm-slim"
  docker build -t openclaw-sandbox-common:bookworm-slim -f Dockerfile.sandbox-common .
fi
docker build -t openclaw-sandbox-coder:bookworm -f ops/vps/Dockerfile.openclaw-sandbox-coder .

echo "[12/12] Host coding CLI health check"
for cli in codex gemini agent cursor-agent gcloud x-cli; do
  if command -v "$cli" >/dev/null 2>&1; then
    echo "  $cli: ok"
  else
    echo "  $cli: missing" >&2
  fi
done

echo "Next steps (manual)"
cat <<'EOF'
Optional power tools:

   sudo bash ops/vps/install-power-tools-ubuntu24.sh

0) Connect Tailscale (pick one):
   tailscale up
   tailscale up --ssh

1) Create ~/.openclaw/.env with required secrets:
   TELEGRAM_OWNER_ID=
   TELEGRAM_BOT_TOKEN=
   OPENCLAW_GATEWAY_TOKEN=
   GITHUB_APP_ID=
   GITHUB_APP_INSTALLATION_ID=
   GITHUB_APP_PRIVATE_KEY_FILE=
   OPENCLAW_SANDBOX_UID=
   OPENCLAW_SANDBOX_GID=
   CODERABBIT_API_KEY=
   GCLOUD_SERVICE_ACCOUNT_KEY_FILE=
   GCLOUD_PROJECT=
   X_API_KEY=
   X_API_SECRET=
   X_BEARER_TOKEN=
   X_ACCESS_TOKEN=
   X_ACCESS_TOKEN_SECRET=
   WHISPER_CPP_MODEL=
   GIT_AUTHOR_NAME=
   GIT_AUTHOR_EMAIL=

2) Write config:
   cp ops/vps/openclaw.vps-coding.json5 ~/.openclaw/openclaw.json

2b) Configure coding CLI defaults and seed Ted workspace guidance:
   sudo bash ops/vps/configure-coding-clis.sh

2c) Open an operator login shell for manual CLI auth when needed:
   sudo bash ops/vps/login-coding-clis.sh codex
   sudo bash ops/vps/login-coding-clis.sh gh
   sudo bash ops/vps/login-coding-clis.sh gemini
   sudo bash ops/vps/login-coding-clis.sh agent

2d) Configure runtime model auth:
   openclaw models auth login --provider openai-codex
   openclaw plugins enable google-gemini-cli-auth
   openclaw models auth login --provider google-gemini-cli

3) Run onboarding or restart:
   openclaw doctor
   openclaw gateway restart

4) Expose the Control UI privately over Tailscale (best UX with gateway.bind=loopback):
   tailscale serve --bg --https=443 http://127.0.0.1:18789

5) In Telegram DM with your bot:
   /work new demo-repo
EOF
