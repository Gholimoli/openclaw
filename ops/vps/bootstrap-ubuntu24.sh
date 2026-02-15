#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

echo "[1/8] Base packages"
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg lsb-release jq git ufw

echo "[2/8] UFW (lock down public exposure)"
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

echo "[3/8] Tailscale (private access)"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

echo "[4/8] Docker (for OpenClaw sandbox)"
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

echo "[5/8] Node 22 (for OpenClaw CLI)"
node_major=""
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
fi
if [[ -z "${node_major:-}" || "${node_major}" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash
  apt-get install -y --no-install-recommends nodejs
fi

echo "[6/8] Install OpenClaw CLI"
if ! command -v openclaw >/dev/null 2>&1; then
  npm install -g openclaw@latest
fi

echo "[7/8] Install Lobster CLI"
if ! command -v lobster >/dev/null 2>&1; then
  npm install -g @openclaw/lobster@latest
fi

echo "[8/8] Build coder sandbox image"
if ! docker image inspect openclaw-sandbox:bookworm-slim >/dev/null 2>&1; then
  echo "Building openclaw-sandbox:bookworm-slim"
  docker build -t openclaw-sandbox:bookworm-slim -f Dockerfile.sandbox .
fi
if ! docker image inspect openclaw-sandbox-common:bookworm-slim >/dev/null 2>&1; then
  echo "Building openclaw-sandbox-common:bookworm-slim"
  docker build -t openclaw-sandbox-common:bookworm-slim -f Dockerfile.sandbox-common .
fi
docker build -t openclaw-sandbox-coder:bookworm -f ops/vps/Dockerfile.openclaw-sandbox-coder .

echo "Next steps (manual)"
cat <<'EOF'
0) Connect Tailscale (pick one):
   tailscale up
   tailscale up --ssh

1) Create ~/.openclaw/.env with required secrets:
   TELEGRAM_BOT_TOKEN=
   OPENCLAW_GATEWAY_TOKEN=
   GH_TOKEN=
   OPENAI_API_KEY=
   GEMINI_API_KEY=
   CODERABBIT_API_KEY=
   GIT_AUTHOR_NAME=
   GIT_AUTHOR_EMAIL=

2) Write config:
   cp ops/vps/openclaw.vps-coding.json5 ~/.openclaw/openclaw.json

3) Run onboarding or restart:
   openclaw doctor
   openclaw gateway restart

4) Expose the Control UI privately over Tailscale (best UX with gateway.bind=loopback):
   tailscale serve --bg --https=443 http://127.0.0.1:18789

5) In Telegram DM with your bot:
   /work new demo-repo
EOF
