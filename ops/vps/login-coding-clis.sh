#!/usr/bin/env bash
set -euo pipefail

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

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required. Install it first." >&2
  exit 1
fi

ACTION="${1:-shell}"
SESSION_NAME="openclaw-${ACTION}-login"

load_env='if [[ -f "$HOME/.openclaw/.env" ]]; then set -a; source "$HOME/.openclaw/.env"; set +a; fi'
base_shell='export PATH="$HOME/.local/bin:$PATH:/usr/local/bin:/usr/bin:/bin"; cd "$HOME"'

case "$ACTION" in
  shell)
    BODY='echo "Interactive VPS shell for coding CLIs."; echo "Use codex login, gh auth login, railway login, gemini, or agent as needed."; exec bash -l'
    ;;
  codex)
    BODY='echo "Starting Codex login."; echo "This seeds ~/.codex for the coder sandbox bind mount."; codex login --device-auth || codex login; exec bash -l'
    ;;
  gh)
    BODY='echo "Starting GitHub CLI login."; echo "Preferred unattended mode remains GitHub App tokens inside /work."; gh auth login --web; exec bash -l'
    ;;
  railway)
    BODY='echo "Starting Railway CLI login."; echo "This seeds ~/.railway for host exec and coder sandbox bind mounts."; railway login --browserless; exec bash -l'
    ;;
  gemini)
    BODY='echo "Starting Gemini CLI interactive shell."; echo "This seeds ~/.gemini for the coder sandbox bind mount."; gemini; exec bash -l'
    ;;
  agent|cursor|cursor-agent)
    BODY='echo "Starting Cursor Agent shell."; agent; exec bash -l'
    ;;
  *)
    echo "Usage: sudo bash ops/vps/login-coding-clis.sh [shell|codex|gh|railway|gemini|agent]" >&2
    exit 1
    ;;
esac

RUN_CMD=$(cat <<EOF
bash -lc '$load_env; $base_shell; $BODY'
EOF
)

if sudo -H -u "$PRIMARY_USER" tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "Reusing tmux session $SESSION_NAME for $PRIMARY_USER."
else
  sudo -H -u "$PRIMARY_USER" tmux new-session -d -s "$SESSION_NAME" "$RUN_CMD"
  echo "Created tmux session $SESSION_NAME for $PRIMARY_USER."
fi

echo "Attach with:"
echo "  sudo -H -u $PRIMARY_USER tmux attach -t $SESSION_NAME"
