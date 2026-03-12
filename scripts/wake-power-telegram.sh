#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "TELEGRAM_BOT_TOKEN is required."
  echo "Example: TELEGRAM_BOT_TOKEN=... TELEGRAM_TARGET=@your_username $0"
  exit 1
fi

OPENCLAW_CMD=${OPENCLAW_CMD:-"pnpm openclaw"}
POWER_WORKSPACE=${POWER_WORKSPACE:-"$HOME/.openclaw/workspace-power"}
GATEWAY_PORT=${GATEWAY_PORT:-18789}

# Configure Telegram channel.
$OPENCLAW_CMD config set channels.telegram.botToken "$TELEGRAM_BOT_TOKEN" >/dev/null
$OPENCLAW_CMD config set channels.telegram.allowFrom '["*"]' --json >/dev/null
$OPENCLAW_CMD config set channels.telegram.dmPolicy open >/dev/null

# Ensure local mode so CLI/gateway can run in a simple local setup.
$OPENCLAW_CMD config set gateway.mode local >/dev/null

# Ensure state directories exist for fresh environments.
mkdir -p "$HOME/.openclaw/agents/main/sessions" "$HOME/.openclaw/credentials"

# Create power agent if it does not exist.
if ! $OPENCLAW_CMD agents list | rg -q '^- power\b'; then
  $OPENCLAW_CMD agents add power --workspace "$POWER_WORKSPACE" --non-interactive >/dev/null
fi

# Route all Telegram traffic to power.
$OPENCLAW_CMD config set bindings '[{"agentId":"power","match":{"channel":"telegram"}}]' --json >/dev/null

# Start gateway in background.
nohup $OPENCLAW_CMD gateway run --bind loopback --port "$GATEWAY_PORT" --force > /tmp/openclaw-gateway.log 2>&1 &
sleep 3

if [[ -n "${TELEGRAM_TARGET:-}" ]]; then
  echo "Sending wake ping to ${TELEGRAM_TARGET}..."
  $OPENCLAW_CMD message send --channel telegram --target "$TELEGRAM_TARGET" --message "⚡ power agent is awake and assigned to Telegram." || {
    echo "Failed to send Telegram ping."
    exit 1
  }
else
  echo "Power agent is configured and gateway start was requested."
  echo "Set TELEGRAM_TARGET (chat id or username) to send a wake ping immediately."
fi
