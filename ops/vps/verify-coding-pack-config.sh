#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

config_path="${1:-${OPENCLAW_CONFIG_PATH:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/openclaw.json}}"
env_path="${OPENCLAW_ENV_PATH:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/.env}"

if [[ -f "$env_path" ]]; then
  # shellcheck disable=SC1090
  set -a && source "$env_path" && set +a
fi

if [[ ! -f "$config_path" ]]; then
  echo "[vps-verify] ERROR: config file not found: $config_path" >&2
  exit 1
fi

node --input-type=module - "$config_path" <<'EOF'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";

const configPath = process.argv[2];
const raw = fs.readFileSync(configPath, "utf8");
const cfg = JSON5.parse(raw);
const failures = [];
const approvalsPath = path.join(path.dirname(configPath), "exec-approvals.json");
const expectedMainModel = process.env.OPENCLAW_VERIFY_EXPECTED_MAIN_MODEL?.trim() || "";
const homedir = os.homedir();
const expectedAgents = {
  main: {
    agentDir: "~/.openclaw/agents/main/agent",
    primary: expectedMainModel || "openai-codex/gpt-5.3-codex",
    fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
  },
  coder: {
    agentDir: "~/.openclaw/agents/coder/agent",
    primary: "openai-codex/gpt-5.3-codex",
    fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
  },
  power: {
    agentDir: "~/.openclaw/agents/power/agent",
    primary: "openai-codex/gpt-5.3-codex",
    fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
  },
  devops: {
    agentDir: "~/.openclaw/agents/devops/agent",
    primary: "openai-codex/gpt-5.3-codex",
    fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
  },
};

const resolveUserPath = (value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value === "~") {
    return homedir;
  }
  if (value.startsWith("~/")) {
    return path.join(homedir, value.slice(2));
  }
  return value;
};

const readJson = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const gatewayBind = cfg?.gateway?.bind;
if (gatewayBind !== "loopback") {
  failures.push(`gateway.bind must be "loopback" (got ${JSON.stringify(gatewayBind)})`);
}

const telegram = cfg?.channels?.telegram ?? {};
if (telegram.enabled !== true) {
  failures.push("channels.telegram.enabled must be true");
}
if (telegram.dmPolicy !== "allowlist") {
  failures.push(`channels.telegram.dmPolicy must be "allowlist" (got ${JSON.stringify(telegram.dmPolicy)})`);
}
if (telegram.groupPolicy !== "allowlist") {
  failures.push(`channels.telegram.groupPolicy must be "allowlist" (got ${JSON.stringify(telegram.groupPolicy)})`);
}
const telegramAllowFrom = Array.isArray(telegram.allowFrom)
  ? telegram.allowFrom.map((value) => String(value).trim()).filter(Boolean)
  : [];
if (telegramAllowFrom.length === 0) {
  failures.push("channels.telegram.allowFrom must include at least one entry");
}
const telegramGroupAllowFrom = Array.isArray(telegram.groupAllowFrom)
  ? telegram.groupAllowFrom.map((value) => String(value).trim()).filter(Boolean)
  : [];
if (telegramGroupAllowFrom.length === 0) {
  failures.push("channels.telegram.groupAllowFrom must include at least one entry");
}
const inlineButtons = telegram?.capabilities?.inlineButtons;
if (inlineButtons !== "allowlist") {
  failures.push(
    `channels.telegram.capabilities.inlineButtons must be "allowlist" (got ${JSON.stringify(inlineButtons)})`,
  );
}
if (telegram.streamMode !== "off") {
  failures.push(`channels.telegram.streamMode must be "off" (got ${JSON.stringify(telegram.streamMode)})`);
}

const workPluginEnabled = cfg?.plugins?.entries?.work?.enabled;
if (workPluginEnabled !== true) {
  failures.push("plugins.entries.work.enabled must be true");
}

const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
const mainAgent = agents.find((entry) => entry?.id === "main");
if (!mainAgent) {
  failures.push('agents.list must include id="main"');
}
const resolveModelConfig = (agent) => {
  if (typeof agent?.model === "string") {
    return {
      primary: agent.model,
      fallbacks: [],
    };
  }
  if (agent?.model && typeof agent.model === "object") {
    return {
      primary: typeof agent.model.primary === "string" ? agent.model.primary : undefined,
      fallbacks: Array.isArray(agent.model.fallbacks) ? agent.model.fallbacks : [],
    };
  }
  return {
    primary: undefined,
    fallbacks: [],
  };
};

for (const [agentId, expected] of Object.entries(expectedAgents)) {
  const agent = agents.find((entry) => entry?.id === agentId);
  if (!agent) {
    failures.push(`agents.list must include id=${JSON.stringify(agentId)}`);
    continue;
  }

  const agentDir = typeof agent?.agentDir === "string" ? agent.agentDir : undefined;
  if (agentDir !== expected.agentDir) {
    failures.push(
      `${agentId} agentDir must be ${JSON.stringify(expected.agentDir)} (got ${JSON.stringify(agentDir)})`,
    );
  }

  const model = resolveModelConfig(agent);
  if (!model.primary) {
    failures.push(`${agentId} agent must define a model.primary`);
  } else if (model.primary !== expected.primary) {
    failures.push(
      `${agentId} primary model must be ${JSON.stringify(expected.primary)} (got ${JSON.stringify(model.primary)})`,
    );
  }

  if (JSON.stringify(model.fallbacks) !== JSON.stringify(expected.fallbacks)) {
    failures.push(
      `${agentId} fallbacks must be ${JSON.stringify(expected.fallbacks)} (got ${JSON.stringify(model.fallbacks)})`,
    );
  }

  const modelRefs = [model.primary, ...model.fallbacks].filter((value) => typeof value === "string");
  if (modelRefs.some((value) => String(value).startsWith("openai-codex/"))) {
    const resolvedAgentDir = resolveUserPath(agentDir);
    const authPath = resolvedAgentDir ? path.join(resolvedAgentDir, "auth-profiles.json") : undefined;
    const authStore = authPath ? readJson(authPath) : null;
    const profiles = authStore?.profiles && typeof authStore.profiles === "object" ? authStore.profiles : {};
    const hasOpenAICodexProfile = Object.values(profiles).some(
      (profile) => profile && typeof profile === "object" && profile.provider === "openai-codex",
    );
    if (!hasOpenAICodexProfile) {
      failures.push(
        `${agentId} must have an openai-codex auth profile in ${JSON.stringify(authPath ?? "<unknown>")}`,
      );
    }
  }
}

const allFallbacks = Object.values(expectedAgents).flatMap((agent) => agent.fallbacks);
if (allFallbacks.some((modelRef) => modelRef.startsWith("openai/")) && !process.env.OPENAI_API_KEY?.trim()) {
  failures.push("OPENAI_API_KEY must be set when VPS fallback policy includes openai/* models");
}
if (allFallbacks.some((modelRef) => modelRef.startsWith("google/")) && !process.env.GEMINI_API_KEY?.trim()) {
  failures.push("GEMINI_API_KEY must be set when VPS fallback policy includes google/* models");
}

const mainToolsAlsoAllow = Array.isArray(mainAgent?.tools?.alsoAllow)
  ? mainAgent.tools.alsoAllow.map((value) => String(value).trim())
  : [];
const mainToolsAllow = Array.isArray(mainAgent?.tools?.allow)
  ? mainAgent.tools.allow.map((value) => String(value).trim())
  : [];
const mainToolsDeny = Array.isArray(mainAgent?.tools?.deny)
  ? mainAgent.tools.deny.map((value) => String(value).trim())
  : [];
if (mainToolsAllow.length > 0) {
  failures.push(
    `main agent tools.allow must be unset when tools.alsoAllow is used (got ${JSON.stringify(mainToolsAllow)})`,
  );
}
if (!mainToolsAlsoAllow.includes("exec")) {
  failures.push('main agent tools.alsoAllow must include "exec"');
}
if (!mainToolsAlsoAllow.includes("process")) {
  failures.push('main agent tools.alsoAllow must include "process"');
}
if (!mainToolsAlsoAllow.includes("read")) {
  failures.push('main agent tools.alsoAllow must include "read"');
}
if (mainToolsDeny.includes("exec")) {
  failures.push('main agent tools.deny must not include "exec"');
}

const powerAgent = agents.find((entry) => entry?.id === "power");
const powerSystemPrompt =
  typeof powerAgent?.systemPrompt === "string" ? powerAgent.systemPrompt.trim() : "";
if (!powerSystemPrompt) {
  failures.push("power agent systemPrompt must be set");
} else {
  for (const requiredPhrase of [
    "Consult the operator before",
    "deploys",
    "live-config",
    "destructive file/data operations",
  ]) {
    if (!powerSystemPrompt.includes(requiredPhrase)) {
      failures.push(
        `power agent systemPrompt must mention ${JSON.stringify(requiredPhrase)} (got ${JSON.stringify(powerSystemPrompt)})`,
      );
    }
  }
}
const powerToolsAllow = Array.isArray(powerAgent?.tools?.allow)
  ? powerAgent.tools.allow.map((value) => String(value).trim())
  : [];
for (const required of ["browser", "exec", "process", "read", "write", "edit", "apply_patch"]) {
  if (!powerToolsAllow.includes(required)) {
    failures.push(`power agent tools.allow must include ${JSON.stringify(required)}`);
  }
}
const powerToolsDeny = Array.isArray(powerAgent?.tools?.deny)
  ? powerAgent.tools.deny.map((value) => String(value).trim())
  : [];
for (const forbidden of ["write", "edit", "apply_patch", "exec"]) {
  if (powerToolsDeny.includes(forbidden)) {
    failures.push(`power agent tools.deny must not include ${JSON.stringify(forbidden)}`);
  }
}
const powerExec = powerAgent?.tools?.exec ?? {};
if (powerExec.host !== "gateway") {
  failures.push(`power agent tools.exec.host must be "gateway" (got ${JSON.stringify(powerExec.host)})`);
}
if (powerExec.security !== "full") {
  failures.push(
    `power agent tools.exec.security must be "full" (got ${JSON.stringify(powerExec.security)})`,
  );
}
if (powerExec.ask !== "off") {
  failures.push(`power agent tools.exec.ask must be "off" (got ${JSON.stringify(powerExec.ask)})`);
}
if (powerExec?.applyPatch?.enabled !== true) {
  failures.push("power agent tools.exec.applyPatch.enabled must be true");
}
if (powerExec?.applyPatch?.workspaceOnly !== false) {
  failures.push(
    `power agent tools.exec.applyPatch.workspaceOnly must be false (got ${JSON.stringify(powerExec?.applyPatch?.workspaceOnly)})`,
  );
}
if (powerAgent?.tools?.fs?.workspaceOnly !== false) {
  failures.push(
    `power agent tools.fs.workspaceOnly must be false (got ${JSON.stringify(powerAgent?.tools?.fs?.workspaceOnly)})`,
  );
}

const execApprovals = cfg?.approvals?.exec ?? {};
if (execApprovals.enabled !== true) {
  failures.push("approvals.exec.enabled must be true");
}
if (execApprovals.mode !== "both") {
  failures.push(`approvals.exec.mode must be "both" (got ${JSON.stringify(execApprovals.mode)})`);
}
const execTargets = Array.isArray(execApprovals.targets) ? execApprovals.targets : [];
if (execTargets.length === 0) {
  failures.push("approvals.exec.targets must include at least one Telegram DM target");
}
const execAgentFilter = Array.isArray(execApprovals.agentFilter)
  ? execApprovals.agentFilter.map((value) => String(value).trim()).filter(Boolean)
  : [];
if (JSON.stringify(execAgentFilter) !== JSON.stringify(["main"])) {
  failures.push(
    `approvals.exec.agentFilter must be [\"main\"] (got ${JSON.stringify(execAgentFilter)})`,
  );
}

const execApprovalsFile = readJson(approvalsPath);
if (!execApprovalsFile) {
  failures.push(`exec approvals file missing or invalid at ${JSON.stringify(approvalsPath)}`);
} else {
  const execDefaults = execApprovalsFile.defaults ?? {};
  if (execDefaults.security !== "allowlist") {
    failures.push(
      `exec approvals defaults.security must be "allowlist" (got ${JSON.stringify(execDefaults.security)})`,
    );
  }
  if (execDefaults.ask !== "always") {
    failures.push(
      `exec approvals defaults.ask must be "always" (got ${JSON.stringify(execDefaults.ask)})`,
    );
  }
  const mainApprovals = execApprovalsFile.agents?.main ?? {};
  if (mainApprovals.security !== "allowlist") {
    failures.push(
      `exec approvals main.security must be "allowlist" (got ${JSON.stringify(mainApprovals.security)})`,
    );
  }
  if (mainApprovals.ask !== "always") {
    failures.push(`exec approvals main.ask must be "always" (got ${JSON.stringify(mainApprovals.ask)})`);
  }
  const powerApprovals = execApprovalsFile.agents?.power ?? {};
  if (powerApprovals.security !== "full") {
    failures.push(
      `exec approvals power.security must be "full" (got ${JSON.stringify(powerApprovals.security)})`,
    );
  }
  if (powerApprovals.ask !== "off") {
    failures.push(`exec approvals power.ask must be "off" (got ${JSON.stringify(powerApprovals.ask)})`);
  }
  if (powerApprovals.askFallback !== "deny") {
    failures.push(
      `exec approvals power.askFallback must be "deny" (got ${JSON.stringify(powerApprovals.askFallback)})`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[vps-verify] ERROR: ${failure}`);
  }
  process.exit(1);
}

console.log(`[vps-verify] OK: ${configPath}`);
const mainModel = resolveModelConfig(mainAgent).primary;
console.log(`[vps-verify] main=${mainModel} telegram_allow_from=${telegramAllowFrom.join(",")}`);
EOF
