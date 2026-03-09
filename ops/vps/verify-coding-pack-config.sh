#!/usr/bin/env bash
set -euo pipefail

config_path="${1:-${OPENCLAW_CONFIG_PATH:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/openclaw.json}}"

if [[ ! -f "$config_path" ]]; then
  echo "[vps-verify] ERROR: config file not found: $config_path" >&2
  exit 1
fi

node --input-type=module - "$config_path" <<'EOF'
import fs from "node:fs";
import JSON5 from "json5";

const configPath = process.argv[2];
const raw = fs.readFileSync(configPath, "utf8");
const cfg = JSON5.parse(raw);
const failures = [];
const expectedMainModel = process.env.OPENCLAW_VERIFY_EXPECTED_MAIN_MODEL?.trim() || "";

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
const telegramAllowFrom = Array.isArray(telegram.allowFrom)
  ? telegram.allowFrom.map((value) => String(value).trim()).filter(Boolean)
  : [];
if (telegramAllowFrom.length === 0) {
  failures.push("channels.telegram.allowFrom must include at least one entry");
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

const mainModel =
  typeof mainAgent?.model === "string"
    ? mainAgent.model
    : typeof mainAgent?.model?.primary === "string"
      ? mainAgent.model.primary
      : undefined;
if (!mainModel) {
  failures.push("main agent must define a model");
} else if (expectedMainModel && mainModel !== expectedMainModel) {
  failures.push(
    `main agent primary model must be ${JSON.stringify(expectedMainModel)} (got ${JSON.stringify(mainModel)})`,
  );
}

const mainToolsAllow = Array.isArray(mainAgent?.tools?.allow)
  ? mainAgent.tools.allow.map((value) => String(value).trim())
  : [];
const mainToolsDeny = Array.isArray(mainAgent?.tools?.deny)
  ? mainAgent.tools.deny.map((value) => String(value).trim())
  : [];
if (!mainToolsAllow.includes("exec")) {
  failures.push('main agent tools.allow must include "exec"');
}
if (!mainToolsAllow.includes("process")) {
  failures.push('main agent tools.allow must include "process"');
}
if (mainToolsDeny.includes("exec")) {
  failures.push('main agent tools.deny must not include "exec"');
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

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[vps-verify] ERROR: ${failure}`);
  }
  process.exit(1);
}

console.log(`[vps-verify] OK: ${configPath}`);
console.log(`[vps-verify] main=${mainModel} telegram_allow_from=${telegramAllowFrom.join(",")}`);
EOF
