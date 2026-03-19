#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

config_path="${1:-${OPENCLAW_CONFIG_PATH:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/openclaw.json}}"
provider_id="${OPENCLAW_SYNC_AUTH_PROVIDER:-openai-codex}"
source_agent_id="${OPENCLAW_SYNC_AUTH_SOURCE_AGENT:-main}"

if [[ ! -f "$config_path" ]]; then
  echo "[vps-auth-sync] ERROR: config file not found: $config_path" >&2
  exit 1
fi

node --input-type=module - "$config_path" "$provider_id" "$source_agent_id" <<'EOF'
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import JSON5 from "json5";

const configPath = process.argv[2];
const providerId = String(process.argv[3] ?? "").trim() || "openai-codex";
const sourceAgentId = String(process.argv[4] ?? "").trim() || "main";
const home = os.homedir();

const resolveUserPath = (value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/")) {
    return path.join(home, value.slice(2));
  }
  return value;
};

const cfg = JSON5.parse(fs.readFileSync(configPath, "utf8"));
const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
const sourceAgent = agents.find((entry) => entry?.id === sourceAgentId);
if (!sourceAgent) {
  throw new Error(`Source agent not found: ${sourceAgentId}`);
}

const sourceAgentDir = resolveUserPath(sourceAgent?.agentDir);
if (!sourceAgentDir) {
  throw new Error(`Source agent ${sourceAgentId} does not define agentDir`);
}
const sourceAuthPath = path.join(sourceAgentDir, "auth-profiles.json");
if (!fs.existsSync(sourceAuthPath)) {
  throw new Error(`Source auth store missing: ${sourceAuthPath}`);
}

const sourceStore = JSON.parse(fs.readFileSync(sourceAuthPath, "utf8"));
const sourceProfiles = Object.entries(sourceStore?.profiles ?? {}).filter(
  ([, profile]) => profile && typeof profile === "object" && profile.provider === providerId,
);
if (sourceProfiles.length === 0) {
  throw new Error(`Source agent ${sourceAgentId} has no ${providerId} profiles to copy`);
}

const sourceProfileIds = sourceProfiles.map(([profileId]) => profileId);
const changed = [];
const skipped = [];

for (const agent of agents) {
  const agentId = String(agent?.id ?? "");
  if (!agentId || agentId === sourceAgentId) {
    continue;
  }
  const model = agent?.model;
  const primary =
    typeof model === "string"
      ? model
      : model && typeof model === "object" && typeof model.primary === "string"
        ? model.primary
        : undefined;
  const fallbacks =
    model && typeof model === "object" && Array.isArray(model.fallbacks) ? model.fallbacks : [];
  const usesProvider = [primary, ...fallbacks].some(
    (value) => typeof value === "string" && value.startsWith(`${providerId}/`),
  );
  if (!usesProvider) {
    continue;
  }

  const agentDir = resolveUserPath(agent?.agentDir);
  if (!agentDir) {
    throw new Error(`Target agent ${agentId} does not define agentDir`);
  }
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const authPath = path.join(agentDir, "auth-profiles.json");
  const targetStore = fs.existsSync(authPath)
    ? JSON.parse(fs.readFileSync(authPath, "utf8"))
    : { version: 1, profiles: {} };
  targetStore.version = typeof targetStore.version === "number" ? targetStore.version : 1;
  targetStore.profiles = targetStore.profiles && typeof targetStore.profiles === "object" ? targetStore.profiles : {};
  targetStore.usageStats =
    targetStore.usageStats && typeof targetStore.usageStats === "object" ? targetStore.usageStats : {};
  targetStore.lastGood =
    targetStore.lastGood && typeof targetStore.lastGood === "object" ? targetStore.lastGood : {};

  const hasProviderProfiles = Object.values(targetStore.profiles).some(
    (profile) => profile && typeof profile === "object" && profile.provider === providerId,
  );
  if (hasProviderProfiles) {
    skipped.push(`${agentId}:already-configured`);
    continue;
  }

  for (const [profileId, profile] of sourceProfiles) {
    const existing = targetStore.profiles[profileId];
    if (existing && existing.provider !== providerId) {
      throw new Error(
        `Target agent ${agentId} has conflicting profile id ${profileId} for provider ${existing.provider}`,
      );
    }
    targetStore.profiles[profileId] = structuredClone(profile);
    if (sourceStore?.usageStats?.[profileId] && !targetStore.usageStats[profileId]) {
      targetStore.usageStats[profileId] = structuredClone(sourceStore.usageStats[profileId]);
    }
  }

  const sourceLastGood = sourceStore?.lastGood?.[providerId];
  if (typeof sourceLastGood === "string" && sourceProfileIds.includes(sourceLastGood)) {
    targetStore.lastGood[providerId] = sourceLastGood;
  }

  fs.writeFileSync(authPath, `${JSON.stringify(targetStore, null, 2)}\n`);
  changed.push(agentId);
}

if (changed.length === 0) {
  console.log(`[vps-auth-sync] OK: no changes needed for provider=${providerId}`);
  if (skipped.length > 0) {
    console.log(`[vps-auth-sync] skipped=${skipped.join(",")}`);
  }
  process.exit(0);
}

console.log(`[vps-auth-sync] OK: synced provider=${providerId} from ${sourceAgentId}`);
console.log(`[vps-auth-sync] changed=${changed.join(",")}`);
if (skipped.length > 0) {
  console.log(`[vps-auth-sync] skipped=${skipped.join(",")}`);
}
EOF
