#!/usr/bin/env bash
set -euo pipefail

# Optional "power tools" for a VPS gateway:
# - Google Chrome (for the Browser tool on Linux)
# - Local STT (Whisper.cpp via whisper-cli + a ggml model)
#
# This script is designed to be run on Ubuntu 24.04 as root (sudo).
# It tries to be idempotent-ish and safe to rerun.

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

OPENCLAW_MODELS_DIR="${OPENCLAW_MODELS_DIR:-/opt/openclaw/models}"
WHISPER_MODEL_NAME="${WHISPER_MODEL_NAME:-base.en}"

echo "[1/4] System packages (media + build)"
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git \
  ffmpeg \
  build-essential cmake pkg-config

echo "[2/4] Google Chrome (recommended for Browser tool on Linux)"
if ! command -v google-chrome >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/google-chrome.gpg ]]; then
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
    chmod a+r /etc/apt/keyrings/google-chrome.gpg
  fi
  if [[ ! -f /etc/apt/sources.list.d/google-chrome.list ]]; then
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list
  fi
  apt-get update
  apt-get install -y --no-install-recommends google-chrome-stable
fi

echo "[3/4] Whisper.cpp (local STT)"
if ! command -v whisper-cli >/dev/null 2>&1; then
  if [[ ! -d /opt/whisper.cpp/.git ]]; then
    git clone https://github.com/ggerganov/whisper.cpp /opt/whisper.cpp
  fi
  cd /opt/whisper.cpp
  cmake -S . -B build
  cmake --build build -j"$(nproc)"

  # Prefer whisper-cli (newer builds); fall back to main (older builds).
  built=""
  if [[ -x build/bin/whisper-cli ]]; then
    built="build/bin/whisper-cli"
  elif [[ -x build/bin/main ]]; then
    built="build/bin/main"
  else
    built="$(find build -maxdepth 4 -type f \\( -name whisper-cli -o -name main \\) -perm -111 2>/dev/null | head -n 1 || true)"
  fi
  if [[ -z "${built:-}" ]]; then
    echo "Could not find built whisper-cli binary under /opt/whisper.cpp/build" >&2
    exit 1
  fi
  install -m 0755 "$built" /usr/local/bin/whisper-cli
fi

mkdir -p "${OPENCLAW_MODELS_DIR}/whisper-cpp"

modelPath="${OPENCLAW_MODELS_DIR}/whisper-cpp/ggml-${WHISPER_MODEL_NAME}.bin"
if [[ ! -f "$modelPath" ]]; then
  if [[ -x /opt/whisper.cpp/models/download-ggml-model.sh ]]; then
    /opt/whisper.cpp/models/download-ggml-model.sh "$WHISPER_MODEL_NAME"
    # whisper.cpp script writes to /opt/whisper.cpp/models/ggml-<name>.bin
    src="/opt/whisper.cpp/models/ggml-${WHISPER_MODEL_NAME}.bin"
    if [[ ! -f "$src" ]]; then
      echo "Whisper.cpp model download did not produce expected file: $src" >&2
      exit 1
    fi
    cp -f "$src" "$modelPath"
  else
    echo "Missing whisper.cpp model downloader at /opt/whisper.cpp/models/download-ggml-model.sh" >&2
    exit 1
  fi
fi

echo "[4/4] Output"
cat <<EOF
Installed:
- google-chrome-stable (Browser tool on Linux)
- whisper-cli + model (local STT)

Set this env var in ~/.openclaw/.env on the gateway host:

  WHISPER_CPP_MODEL="$modelPath"

Then restart the gateway:

  openclaw gateway restart
EOF

