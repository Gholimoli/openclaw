#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

config_path="${1:-${OPENCLAW_CONFIG_PATH:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/openclaw.json}}"
template_path="${2:-${OPENCLAW_VPS_CODING_PACK_TEMPLATE:-$SCRIPT_DIR/openclaw.vps-coding.json5}}"

if [[ ! -f "$config_path" ]]; then
  echo "[vps-sync] ERROR: config file not found: $config_path" >&2
  exit 1
fi

if [[ ! -f "$template_path" ]]; then
  echo "[vps-sync] ERROR: template file not found: $template_path" >&2
  exit 1
fi

node --input-type=module - "$config_path" "$template_path" <<'EOF'
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";

const configPath = process.argv[2];
const templatePath = process.argv[3];
const approvalsPath = path.join(path.dirname(configPath), "exec-approvals.json");

const readJson5 = (filePath) => JSON5.parse(fs.readFileSync(filePath, "utf8"));
const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const isNonEmptyArray = (value) => Array.isArray(value) && value.length > 0;
const isNonEmptyObject = (value) => isObject(value) && Object.keys(value).length > 0;
const normalizeArray = (value) =>
  Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : [];

const getPath = (obj, pathParts) => {
  let current = obj;
  for (const part of pathParts) {
    if (!isObject(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = current?.[part];
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
};

const ensureParent = (obj, pathParts) => {
  let current = obj;
  for (const part of pathParts) {
    if (!isObject(current[part])) {
      current[part] = {};
    }
    current = current[part];
  }
  return current;
};

const setPath = (obj, pathParts, value) => {
  const parent = ensureParent(obj, pathParts.slice(0, -1));
  parent[pathParts.at(-1)] = clone(value);
};

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ENV_REF_PATTERN = /\$\{([A-Z0-9_]+)\}/g;
const PLACEHOLDER_TELEGRAM_GROUP_IDS = new Set([
  "-1001111111111",
  "-1002222222222",
  "-1003333333333",
]);

const hasMissingEnvRef = (value) => {
  if (typeof value !== "string") {
    return false;
  }
  let match;
  while ((match = ENV_REF_PATTERN.exec(value)) !== null) {
    if (!Object.prototype.hasOwnProperty.call(process.env, match[1])) {
      ENV_REF_PATTERN.lastIndex = 0;
      return true;
    }
  }
  ENV_REF_PATTERN.lastIndex = 0;
  return false;
};

const deepMerge = (currentValue, templateValue) => {
  if (!isObject(currentValue) || !isObject(templateValue)) {
    return clone(templateValue);
  }
  const merged = clone(currentValue) ?? {};
  for (const [key, value] of Object.entries(templateValue)) {
    if (value === undefined) {
      continue;
    }
    if (isObject(value) && isObject(merged[key])) {
      merged[key] = deepMerge(merged[key], value);
      continue;
    }
    merged[key] = clone(value);
  }
  return merged;
};

const sanitizeAgent = (agent) => {
  const nextAgent = clone(agent) ?? {};
  if (
    nextAgent?.id === "main" &&
    Array.isArray(nextAgent?.tools?.alsoAllow) &&
    nextAgent.tools.alsoAllow.length > 0 &&
    Array.isArray(nextAgent?.tools?.allow)
  ) {
    delete nextAgent.tools.allow;
  }
  const dockerConfig = nextAgent?.sandbox?.docker;
  if (!isObject(dockerConfig)) {
    return nextAgent;
  }

  if (hasMissingEnvRef(dockerConfig.user)) {
    delete dockerConfig.user;
  }

  if (isObject(dockerConfig.env)) {
    const filteredEnv = {};
    for (const [key, value] of Object.entries(dockerConfig.env)) {
      if (hasMissingEnvRef(value)) {
        continue;
      }
      filteredEnv[key] = clone(value);
    }
    dockerConfig.env = filteredEnv;
  }

  return nextAgent;
};

const stripPlaceholderTelegramGroups = (groups) => {
  if (!isObject(groups)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(groups).filter(([groupId]) => !PLACEHOLDER_TELEGRAM_GROUP_IDS.has(String(groupId))),
  );
};

const isPlaceholderTelegramBinding = (binding) =>
  binding?.match?.channel === "telegram" &&
  binding?.match?.peer?.kind === "group" &&
  PLACEHOLDER_TELEGRAM_GROUP_IDS.has(String(binding?.match?.peer?.id ?? ""));

const current = readJson5(configPath);
const template = readJson5(templatePath);
const next = clone(current) ?? {};
const readJsonIfPresent = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};
const changes = [];
const extraChanges = [];

const assign = (pathParts, value) => {
  if (value === undefined) {
    return;
  }
  const previous = getPath(next, pathParts);
  if (sameJson(previous, value)) {
    return;
  }
  setPath(next, pathParts, value);
  changes.push(pathParts.join("."));
};

const currentTelegram = current?.channels?.telegram ?? {};
const templateTelegram = template?.channels?.telegram ?? {};
const currentTelegramGroups = stripPlaceholderTelegramGroups(currentTelegram?.groups);
const templateTelegramGroups = stripPlaceholderTelegramGroups(templateTelegram?.groups);
const currentGatewayAuth = current?.gateway?.auth ?? {};
const templateGatewayAuth = template?.gateway?.auth ?? {};
const currentWorkConfig = current?.plugins?.entries?.work?.config ?? {};
const templateWorkConfig = template?.plugins?.entries?.work?.config ?? {};
const currentExecApprovals = current?.approvals?.exec ?? {};
const templateExecApprovals = template?.approvals?.exec ?? {};

assign(["gateway", "mode"], template?.gateway?.mode);
assign(["gateway", "bind"], template?.gateway?.bind);
assign(["gateway", "port"], template?.gateway?.port);
assign(["gateway", "auth"], {
  ...clone(templateGatewayAuth),
  ...(isNonEmptyString(currentGatewayAuth?.token) ? { token: currentGatewayAuth.token } : {}),
});
assign(["gateway", "tools", "deny"], clone(template?.gateway?.tools?.deny ?? []));
assign(["env", "shellEnv"], clone(template?.env?.shellEnv ?? {}));
assign(["session", "dmScope"], template?.session?.dmScope);
assign(["tools"], clone(template?.tools ?? {}));

const allowFrom = normalizeArray(currentTelegram?.allowFrom);
const nextAllowFrom = allowFrom.length > 0 ? allowFrom : normalizeArray(templateTelegram?.allowFrom);
const groupAllowFrom = normalizeArray(currentTelegram?.groupAllowFrom);

assign(["channels", "telegram", "enabled"], templateTelegram?.enabled);
assign(["channels", "telegram", "botToken"], currentTelegram?.botToken ?? templateTelegram?.botToken);
assign(["channels", "telegram", "capabilities"], clone(templateTelegram?.capabilities ?? {}));
assign(["channels", "telegram", "dmPolicy"], templateTelegram?.dmPolicy);
assign(["channels", "telegram", "allowFrom"], nextAllowFrom);
assign(["channels", "telegram", "groupPolicy"], templateTelegram?.groupPolicy);
assign(
  ["channels", "telegram", "groupAllowFrom"],
  groupAllowFrom.length > 0 ? groupAllowFrom : nextAllowFrom,
);
assign(
  ["channels", "telegram", "groups"],
  isNonEmptyObject(currentTelegramGroups) ? currentTelegramGroups : clone(templateTelegramGroups),
);
assign(
  ["channels", "telegram", "clients"],
  isNonEmptyObject(currentTelegram?.clients) ? currentTelegram.clients : templateTelegram?.clients,
);
assign(["channels", "telegram", "configWrites"], templateTelegram?.configWrites);
assign(["channels", "telegram", "streamMode"], templateTelegram?.streamMode);

assign(
  ["plugins", "entries", "google-gemini-cli-auth"],
  clone(template?.plugins?.entries?.["google-gemini-cli-auth"] ?? {}),
);
assign(["plugins", "entries", "work"], {
  ...clone(current?.plugins?.entries?.work ?? {}),
  ...clone(template?.plugins?.entries?.work ?? {}),
  config: {
    ...clone(currentWorkConfig),
    ...clone(templateWorkConfig),
  },
});

const templateAgents = Array.isArray(template?.agents?.list) ? template.agents.list : [];
const managedAgentIds = new Set(templateAgents.map((agent) => String(agent?.id ?? "")).filter(Boolean));
const currentAgents = Array.isArray(current?.agents?.list) ? current.agents.list : [];
const mergedAgents = [];
const seenAgentIds = new Set();
for (const agent of currentAgents) {
  const agentId = String(agent?.id ?? "");
  if (!managedAgentIds.has(agentId)) {
    mergedAgents.push(clone(agent));
    continue;
  }
  const templateAgent = templateAgents.find((entry) => String(entry?.id ?? "") === agentId);
  if (!templateAgent) {
    mergedAgents.push(clone(agent));
    continue;
  }
  const merged = sanitizeAgent(deepMerge(agent, sanitizeAgent(templateAgent)));
  if (isNonEmptyString(agent?.workspace)) {
    merged.workspace = agent.workspace;
  }
  mergedAgents.push(merged);
  seenAgentIds.add(agentId);
}
for (const templateAgent of templateAgents) {
  const agentId = String(templateAgent?.id ?? "");
  if (!agentId || seenAgentIds.has(agentId)) {
    continue;
  }
  mergedAgents.push(sanitizeAgent(templateAgent));
}
assign(["agents", "list"], mergedAgents);

const templateBindings = Array.isArray(template?.bindings) ? template.bindings : [];
const templateBindingIds = new Set(
  templateBindings.map((binding) => String(binding?.agentId ?? "")).filter(Boolean),
);
const currentBindings = Array.isArray(current?.bindings)
  ? current.bindings.filter((binding) => !isPlaceholderTelegramBinding(binding))
  : [];
const mergedBindings = [];
const seenBindings = new Set();
for (const binding of currentBindings) {
  const agentId = String(binding?.agentId ?? "");
  if (!templateBindingIds.has(agentId)) {
    mergedBindings.push(clone(binding));
    continue;
  }
  mergedBindings.push(clone(binding));
  seenBindings.add(agentId);
}
for (const templateBinding of templateBindings) {
  const agentId = String(templateBinding?.agentId ?? "");
  if (!agentId || seenBindings.has(agentId)) {
    continue;
  }
  mergedBindings.push(clone(templateBinding));
}
assign(["bindings"], mergedBindings);

const currentExecTargets = Array.isArray(currentExecApprovals?.targets) ? currentExecApprovals.targets : [];
assign(["approvals", "exec"], {
  ...clone(currentExecApprovals),
  ...clone(templateExecApprovals),
  targets:
    currentExecTargets.length > 0 ? clone(currentExecTargets) : clone(templateExecApprovals?.targets ?? []),
});

const currentApprovals = readJsonIfPresent(approvalsPath);
const nextApprovals = clone(currentApprovals) ?? { version: 1, agents: {} };
nextApprovals.version = 1;
if (!isObject(nextApprovals.socket)) {
  nextApprovals.socket = {};
}
if (!isObject(nextApprovals.defaults)) {
  nextApprovals.defaults = {};
}
nextApprovals.defaults = {
  ...clone(nextApprovals.defaults),
  security: "allowlist",
  ask: "always",
  askFallback: "deny",
  autoAllowSkills: false,
};
if (!isObject(nextApprovals.agents)) {
  nextApprovals.agents = {};
}
const syncAgentApprovals = (agentId, policy) => {
  const currentAgent = isObject(nextApprovals.agents[agentId]) ? nextApprovals.agents[agentId] : {};
  nextApprovals.agents[agentId] = {
    ...clone(currentAgent),
    ...policy,
    allowlist: Array.isArray(currentAgent.allowlist) ? clone(currentAgent.allowlist) : [],
  };
};
syncAgentApprovals("main", {
  security: "allowlist",
  ask: "always",
  askFallback: "deny",
  autoAllowSkills: false,
});
syncAgentApprovals("power", {
  security: "full",
  ask: "off",
  askFallback: "deny",
  autoAllowSkills: false,
});
if (!sameJson(currentApprovals, nextApprovals)) {
  extraChanges.push("exec-approvals");
}

if (changes.length === 0 && extraChanges.length === 0) {
  console.log(`[vps-sync] OK: ${configPath} (already aligned)`);
  process.exit(0);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `${configPath}.bak-${timestamp}-pre-vps-sync`;
fs.mkdirSync(path.dirname(configPath), { recursive: true });
if (changes.length > 0) {
  fs.copyFileSync(configPath, backupPath);
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {}
}
if (extraChanges.includes("exec-approvals")) {
  const approvalsBackupPath = `${approvalsPath}.bak-${timestamp}-pre-vps-sync`;
  if (fs.existsSync(approvalsPath)) {
    fs.copyFileSync(approvalsPath, approvalsBackupPath);
  }
  fs.writeFileSync(approvalsPath, `${JSON.stringify(nextApprovals, null, 2)}\n`, "utf8");
  try {
    fs.chmodSync(approvalsPath, 0o600);
  } catch {}
  console.log(`[vps-sync] approvals_backup=${approvalsBackupPath}`);
}
try {
  fs.chmodSync(configPath, 0o600);
} catch {}

console.log(`[vps-sync] OK: ${configPath}`);
console.log(`[vps-sync] backup=${backupPath}`);
console.log(`[vps-sync] template=${templatePath}`);
console.log(`[vps-sync] changed=${[...changes, ...extraChanges].join(",")}`);
EOF
