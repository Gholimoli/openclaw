#!/usr/bin/env node
import JSON5 from "json5";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_DOC = path.join(ROOT, "docs", "concepts", "system-architecture.md");
const CHANNEL_REGISTRY = path.join(ROOT, "src", "channels", "registry.ts");
const SERVER_METHODS = path.join(ROOT, "src", "gateway", "server-methods.ts");
const MESSAGE_HANDLER = path.join(
  ROOT,
  "src",
  "gateway",
  "server",
  "ws-connection",
  "message-handler.ts",
);
const SERVER_BROADCAST = path.join(ROOT, "src", "gateway", "server-broadcast.ts");
const VPS_CONFIG = path.join(ROOT, "ops", "vps", "openclaw.vps-coding.json5");
const EXTENSIONS_DIR = path.join(ROOT, "extensions");

const args = new Set(process.argv.slice(2));
const mode = args.has("--update") ? "update" : args.has("--check") ? "check" : null;

if (!mode || (args.has("--update") && args.has("--check"))) {
  console.error("Usage: node scripts/docs-system-atlas-sync.mjs --update|--check");
  process.exit(1);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function parseStringArrayFromLiteral(raw) {
  return Array.from(raw.matchAll(/"([^"]+)"/g), (m) => m[1]);
}

function parseSet(source, name) {
  const match = source.match(
    new RegExp(`const\\s+${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\);`),
  );
  if (!match) {
    throw new Error(`Could not parse set ${name}`);
  }
  return parseStringArrayFromLiteral(match[1]).toSorted((a, b) => a.localeCompare(b));
}

function parseArray(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) {
    throw new Error(`Could not parse array ${name}`);
  }
  return parseStringArrayFromLiteral(match[1]).toSorted((a, b) => a.localeCompare(b));
}

function parseCoreChannels() {
  const source = readText(CHANNEL_REGISTRY);
  const orderMatch = source.match(/export const CHAT_CHANNEL_ORDER = \[([\s\S]*?)\] as const;/);
  if (!orderMatch) {
    throw new Error("Could not parse CHAT_CHANNEL_ORDER");
  }
  const ids = parseStringArrayFromLiteral(orderMatch[1]);
  const rows = [];

  for (const id of ids) {
    const blockMatch = source.match(new RegExp(`${id}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`, "m"));
    if (!blockMatch) {
      throw new Error(`Could not parse metadata block for core channel ${id}`);
    }
    const block = blockMatch[1];
    const label = (block.match(/label:\s*"([^"]+)"/) || [null, id])[1];
    const docsPath = (block.match(/docsPath:\s*"([^"]+)"/) || [null, `/channels/${id}`])[1];
    const blurb = (block.match(/blurb:\s*"([^"]+)"/) || [null, ""])[1].replace(/\s+/g, " ").trim();
    rows.push({ id, label, docsPath, blurb });
  }

  return rows;
}

function parsePluginChannels() {
  const dirs = fs
    .readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const rows = [];
  for (const dir of dirs) {
    const pkgPath = path.join(EXTENSIONS_DIR, dir, "package.json");
    if (!fs.existsSync(pkgPath)) {
      continue;
    }
    const pkg = JSON.parse(readText(pkgPath));
    const channel = pkg?.openclaw?.channel;
    if (!channel?.id || !channel?.label) {
      continue;
    }
    rows.push({
      id: String(channel.id),
      label: String(channel.label),
      docsPath: String(channel.docsPath || `/channels/${channel.id}`),
      npmSpec: String(pkg?.openclaw?.install?.npmSpec || pkg?.name || "-"),
      extensionDir: `extensions/${dir}`,
      order: Number.isFinite(channel.order) ? Number(channel.order) : 999,
    });
  }

  return rows.toSorted((a, b) =>
    a.order === b.order ? a.label.localeCompare(b.label) : a.order - b.order,
  );
}

function parseGatewayScopeData() {
  const source = readText(SERVER_METHODS);

  const nodeRoleMethods = parseSet(source, "NODE_ROLE_METHODS");
  const approvalsMethods = parseSet(source, "APPROVAL_METHODS");
  const pairingMethods = parseSet(source, "PAIRING_METHODS");
  const readMethods = parseSet(source, "READ_METHODS");
  const writeMethods = parseSet(source, "WRITE_METHODS");
  const adminPrefixes = parseArray(source, "ADMIN_METHOD_PREFIXES");

  const adminConditionalMatch = source.match(
    /if \(\s*method\.startsWith\("config\."\)([\s\S]*?)\) \{\s*return errorShape\(ErrorCodes\.INVALID_REQUEST, "missing scope: operator\.admin"\);/,
  );
  const adminConditional = adminConditionalMatch ? adminConditionalMatch[0] : "";
  const adminStartsWith = Array.from(
    adminConditional.matchAll(/method\.startsWith\("([^"]+)"\)/g),
    (m) => m[1],
  ).toSorted((a, b) => a.localeCompare(b));
  const adminExact = Array.from(
    adminConditional.matchAll(/method === "([^"]+)"/g),
    (m) => m[1],
  ).toSorted((a, b) => a.localeCompare(b));

  return {
    nodeRoleMethods,
    approvalsMethods,
    pairingMethods,
    readMethods,
    writeMethods,
    adminPrefixes,
    adminStartsWith,
    adminExact,
  };
}

function parseConnectGuards() {
  const source = readText(MESSAGE_HANDLER);
  const roleMatch = source.match(
    /const role = roleRaw === "([^"]+)" \|\| roleRaw === "([^"]+)" \? roleRaw : null;/,
  );
  const roles = roleMatch ? [roleMatch[1], roleMatch[2]] : [];

  return {
    roles,
    defaultDenyScopes: source.includes("Default-deny: scopes must be explicit"),
    clearsScopesWithoutDevice: source.includes(
      "if (scopes.length > 0) {\n            scopes = [];",
    ),
    secureContextRequired: source.includes(
      "control ui requires HTTPS or localhost (secure context)",
    ),
    allowInsecureControlUiToggle: source.includes("allowInsecureAuth === true"),
    disableDeviceAuthToggle: source.includes("dangerouslyDisableDeviceAuth === true"),
  };
}

function parseEventScopeGuards() {
  const source = readText(SERVER_BROADCAST);
  const constantMap = new Map(
    Array.from(source.matchAll(/const\s+(\w+)\s*=\s*"([^"]+)";/g), (m) => [m[1], m[2]]),
  );

  const guardBlock = source.match(/const EVENT_SCOPE_GUARDS:[\s\S]*?=\s*\{([\s\S]*?)\};/);
  if (!guardBlock) {
    throw new Error("Could not parse EVENT_SCOPE_GUARDS");
  }

  const rows = [];
  for (const entry of guardBlock[1].matchAll(/"([^"]+)":\s*\[([^\]]*)\]/g)) {
    const event = entry[1];
    const values = entry[2]
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean)
      .map((token) => constantMap.get(token) || token.replace(/["']/g, ""));
    rows.push({ event, scopes: values.toSorted((a, b) => a.localeCompare(b)) });
  }

  return rows.toSorted((a, b) => a.event.localeCompare(b.event));
}

function parseVpsDefaults() {
  const config = JSON5.parse(readText(VPS_CONFIG));
  const gateway = config.gateway || {};
  const telegram = config.channels?.telegram || {};
  const tools = config.tools || {};
  const workPlugin = config.plugins?.entries?.work || {};
  const workPluginConfig = workPlugin.config || {};
  const agents = Array.isArray(config.agents?.list)
    ? config.agents.list.map((agent) => String(agent.id)).filter(Boolean)
    : [];

  return {
    gatewayBind: gateway.bind || "-",
    gatewayPort: gateway.port || "-",
    gatewayAuthMode: gateway.auth?.mode || "-",
    gatewayToolsDeny: Array.isArray(gateway.tools?.deny) ? gateway.tools.deny.map(String) : [],
    dmPolicy: telegram.dmPolicy || "-",
    groupPolicy: telegram.groupPolicy || "-",
    configWrites: typeof telegram.configWrites === "boolean" ? String(telegram.configWrites) : "-",
    streamMode: telegram.streamMode || "-",
    dmScope: config.session?.dmScope || "-",
    agentIds: agents,
    workEnabled: Boolean(workPlugin.enabled),
    workCoderSessionKey: workPluginConfig.coderSessionKey || "-",
    approvalsExecEnabled: Boolean(config.approvals?.exec?.enabled),
    approvalsExecMode: config.approvals?.exec?.mode || "-",
    approvalsExecAgentFilter: Array.isArray(config.approvals?.exec?.agentFilter)
      ? config.approvals.exec.agentFilter.map(String)
      : [],
    approvalsTargetsCount: Array.isArray(config.approvals?.exec?.targets)
      ? config.approvals.exec.targets.length
      : 0,
    elevatedEnabled: Boolean(tools.elevated?.enabled),
  };
}

function listToInlineCode(values) {
  if (!values.length) {
    return "-";
  }
  return values.map((value) => `\`${value}\``).join(", ");
}

function buildCoreChannelsMarkdown() {
  const rows = parseCoreChannels();
  const lines = ["| Channel id | Label | Docs path | Source note |", "| --- | --- | --- | --- |"];

  for (const row of rows) {
    lines.push(
      `| \`${row.id}\` | ${row.label} | \`${row.docsPath}\` | ${row.blurb || "core built in channel"} |`,
    );
  }
  return lines.join("\n");
}

function buildPluginChannelsMarkdown() {
  const rows = parsePluginChannels();
  const lines = [
    "| Channel id | Label | npm spec | Docs path | Extension directory |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const row of rows) {
    lines.push(
      `| \`${row.id}\` | ${row.label} | \`${row.npmSpec}\` | \`${row.docsPath}\` | \`${row.extensionDir}\` |`,
    );
  }
  return lines.join("\n");
}

function buildGatewayMethodsMarkdown() {
  const data = parseGatewayScopeData();

  return [
    "| Authorization gate | Required role or scope | Methods |",
    "| --- | --- | --- |",
    `| Node role methods | \`role=node\` | ${listToInlineCode(data.nodeRoleMethods)} |`,
    `| Approval methods | \`operator.approvals\` or \`operator.admin\` | ${listToInlineCode(data.approvalsMethods)} |`,
    `| Pairing methods | \`operator.pairing\` or \`operator.admin\` | ${listToInlineCode(data.pairingMethods)} |`,
    `| Read methods | \`operator.read\` or \`operator.write\` or \`operator.admin\` | ${listToInlineCode(data.readMethods)} |`,
    `| Write methods | \`operator.write\` or \`operator.admin\` | ${listToInlineCode(data.writeMethods)} |`,
    `| Admin prefixes | \`operator.admin\` | ${listToInlineCode(data.adminPrefixes.concat(data.adminStartsWith))} |`,
    `| Admin exact methods | \`operator.admin\` | ${listToInlineCode(data.adminExact)} |`,
  ].join("\n");
}

function buildEventGuardsMarkdown() {
  const rows = parseEventScopeGuards();
  const lines = ["| Event | Required scope |", "| --- | --- |"];

  for (const row of rows) {
    lines.push(`| \`${row.event}\` | ${listToInlineCode(row.scopes)} |`);
  }
  return lines.join("\n");
}

function buildConnectGuardsMarkdown() {
  const data = parseConnectGuards();

  return [
    "| Connect guard | Current behavior in source |",
    "| --- | --- |",
    `| Allowed roles | ${data.roles.length ? listToInlineCode(data.roles) : "parse failed"} |`,
    `| Scope model | ${data.defaultDenyScopes ? "Explicit scopes only default deny" : "not detected"} |`,
    `| Scope stripping without device identity | ${data.clearsScopesWithoutDevice ? "enabled" : "not detected"} |`,
    `| Control UI secure context requirement | ${data.secureContextRequired ? "HTTPS or localhost required unless bypass is enabled" : "not detected"} |`,
    `| allowInsecureAuth toggle in handshake | ${data.allowInsecureControlUiToggle ? "present" : "not detected"} |`,
    `| dangerouslyDisableDeviceAuth toggle in handshake | ${data.disableDeviceAuthToggle ? "present" : "not detected"} |`,
  ].join("\n");
}

function buildVpsDefaultsMarkdown() {
  const data = parseVpsDefaults();

  return [
    "| VPS baseline field | Value from `ops/vps/openclaw.vps-coding.json5` |",
    "| --- | --- |",
    `| Gateway bind | \`${data.gatewayBind}\` |`,
    `| Gateway port | \`${String(data.gatewayPort)}\` |`,
    `| Gateway auth mode | \`${data.gatewayAuthMode}\` |`,
    `| Gateway tool deny list | ${listToInlineCode(data.gatewayToolsDeny)} |`,
    `| Telegram dmPolicy | \`${data.dmPolicy}\` |`,
    `| Telegram groupPolicy | \`${data.groupPolicy}\` |`,
    `| Telegram configWrites | \`${data.configWrites}\` |`,
    `| Telegram streamMode | \`${data.streamMode}\` |`,
    `| Session dmScope | \`${data.dmScope}\` |`,
    `| Agent ids | ${listToInlineCode(data.agentIds)} |`,
    `| Work plugin enabled | \`${String(data.workEnabled)}\` |`,
    `| Work plugin coderSessionKey | \`${data.workCoderSessionKey}\` |`,
    `| Exec approvals enabled | \`${String(data.approvalsExecEnabled)}\` |`,
    `| Exec approvals mode | \`${data.approvalsExecMode}\` |`,
    `| Exec approvals agentFilter | ${listToInlineCode(data.approvalsExecAgentFilter)} |`,
    `| Exec approvals targets count | \`${String(data.approvalsTargetsCount)}\` |`,
    `| tools.elevated.enabled | \`${String(data.elevatedEnabled)}\` |`,
  ].join("\n");
}

function replaceBlock(docText, marker, blockContent) {
  const start = `<!-- atlas:auto:${marker}:start -->`;
  const end = `<!-- atlas:auto:${marker}:end -->`;
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  if (!pattern.test(docText)) {
    throw new Error(`Marker block missing: ${marker}`);
  }
  const replacement = `${start}\n${blockContent}\n${end}`;
  return docText.replace(pattern, replacement);
}

function getGeneratedBlocks() {
  return {
    "core-channels": buildCoreChannelsMarkdown(),
    "plugin-channels": buildPluginChannelsMarkdown(),
    "gateway-method-scopes": buildGatewayMethodsMarkdown(),
    "event-scope-guards": buildEventGuardsMarkdown(),
    "connect-guards": buildConnectGuardsMarkdown(),
    "vps-defaults": buildVpsDefaultsMarkdown(),
  };
}

function buildUpdatedDoc(source, blocks) {
  let updated = source;

  for (const [marker, content] of Object.entries(blocks)) {
    updated = replaceBlock(updated, marker, content);
  }

  return updated;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBlockContent(docText, marker) {
  const start = `<!-- atlas:auto:${marker}:start -->`;
  const end = `<!-- atlas:auto:${marker}:end -->`;
  const pattern = new RegExp(`${escapeRegExp(start)}([\\s\\S]*?)${escapeRegExp(end)}`);
  const match = docText.match(pattern);
  if (!match) {
    throw new Error(`Marker block missing: ${marker}`);
  }
  return match[1] ?? "";
}

function normalizeBlock(value) {
  return value
    .split("\n")
    .map((line) => {
      let normalized = line.trim().replace(/\s+/g, " ");
      if (/^\|[|:\-\s]+\|$/.test(normalized)) {
        normalized = normalized.replace(/-+/g, "-").replace(/\s+/g, " ").trim();
      }
      return normalized;
    })
    .filter(Boolean)
    .join("\n");
}

const current = readText(TARGET_DOC);
const blocks = getGeneratedBlocks();
const updated = buildUpdatedDoc(current, blocks);

if (mode === "update") {
  fs.writeFileSync(TARGET_DOC, updated);
  console.log(`Updated atlas generated sections in ${path.relative(ROOT, TARGET_DOC)}`);
  process.exit(0);
}

const outOfDateMarkers = [];
for (const [marker, expected] of Object.entries(blocks)) {
  const currentBlock = extractBlockContent(current, marker);
  if (normalizeBlock(currentBlock) !== normalizeBlock(expected)) {
    outOfDateMarkers.push(marker);
  }
}

if (outOfDateMarkers.length > 0) {
  console.error("System atlas generated sections are out of date.");
  console.error(`Out of date markers: ${outOfDateMarkers.join(", ")}`);
  const marker = outOfDateMarkers[0];
  const currentBlock = normalizeBlock(extractBlockContent(current, marker)).split("\n");
  const expectedBlock = normalizeBlock(blocks[marker] ?? "").split("\n");
  const max = Math.max(currentBlock.length, expectedBlock.length);
  for (let i = 0; i < max; i += 1) {
    const left = currentBlock[i] ?? "<missing>";
    const right = expectedBlock[i] ?? "<missing>";
    if (left !== right) {
      console.error(`First mismatch in marker ${marker} at line ${i + 1}:`);
      console.error(`  current : ${left}`);
      console.error(`  expected: ${right}`);
      break;
    }
  }
  console.error("Run: pnpm docs:atlas:update");
  process.exit(1);
}

console.log("System atlas generated sections are up to date.");
