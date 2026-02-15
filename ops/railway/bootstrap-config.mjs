#!/usr/bin/env node
import JSON5 from "json5";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function resolveStateDir() {
  const explicit = String(process.env.OPENCLAW_STATE_DIR || "").trim();
  if (explicit) {
    return explicit;
  }
  // Uses HOME if set (Railway templates commonly set HOME=/data).
  return path.join(os.homedir(), ".openclaw");
}

function resolveWorkspaceDir() {
  const explicit = String(process.env.OPENCLAW_WORKSPACE_DIR || "").trim();
  if (explicit) {
    return explicit;
  }
  return path.join(resolveStateDir(), "workspace");
}

function resolveConfigPath() {
  const explicit = String(process.env.OPENCLAW_CONFIG_PATH || "").trim();
  if (explicit) {
    return explicit;
  }
  return path.join(resolveStateDir(), "openclaw.json");
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return { exists: false, config: {} };
  }
  const raw = fs.readFileSync(configPath, "utf8");
  try {
    const parsed = JSON5.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { exists: true, config: {} };
    }
    return { exists: true, config: parsed };
  } catch {
    const bak = `${configPath}.invalid.${nowStamp()}.bak`;
    try {
      fs.copyFileSync(configPath, bak);
    } catch {
      // ignore
    }
    return { exists: true, config: {} };
  }
}

function writeConfig(configPath, config) {
  ensureDir(path.dirname(configPath));
  const out = JSON.stringify(config, null, 2);
  fs.writeFileSync(configPath, out + "\n", "utf8");
}

function stringOrEmpty(v) {
  return typeof v === "string" ? v.trim() : "";
}

function parseCsv(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniqStrings(items) {
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const v = stringOrEmpty(it);
    if (!v) {
      continue;
    }
    const k = v.toLowerCase();
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(v);
  }
  return out;
}

function main() {
  const stateDir = resolveStateDir();
  const workspaceDir = resolveWorkspaceDir();
  const configPath = resolveConfigPath();

  ensureDir(stateDir);
  ensureDir(workspaceDir);

  const { config: base } = readConfig(configPath);
  const cfg = { ...base };

  const bind =
    stringOrEmpty(process.env.OPENCLAW_GATEWAY_BIND) || stringOrEmpty(cfg.gateway?.bind) || "lan";

  const gateway = {
    ...cfg.gateway,
    mode: "local",
    bind,
    // Keep auth configured, but reference the secret from env (do not write raw token).
    auth: {
      ...cfg.gateway?.auth,
      mode: "token",
      token: cfg.gateway?.auth?.token ?? "${OPENCLAW_GATEWAY_TOKEN}",
    },
    tools: {
      ...cfg.gateway?.tools,
      // Tighten HTTP tool surface: keep the default deny list and add more.
      deny: uniqStrings([
        ...(cfg.gateway?.tools?.deny || []),
        "gateway",
        "sessions_send",
        "sessions_spawn",
        "whatsapp_login",
        "browser",
      ]),
    },
  };

  const modelPrimary =
    stringOrEmpty(process.env.OPENCLAW_BOOTSTRAP_MODEL_PRIMARY) || "openrouter/openai/gpt-5.2";
  const modelFallbacksRaw =
    stringOrEmpty(process.env.OPENCLAW_BOOTSTRAP_MODEL_FALLBACKS) ||
    "openrouter/google/gemini-3-pro-preview";
  const modelFallbacks = parseCsv(modelFallbacksRaw);

  const agents = {
    ...cfg.agents,
    defaults: {
      ...cfg.agents?.defaults,
      workspace: cfg.agents?.defaults?.workspace ?? workspaceDir,
      model: {
        ...cfg.agents?.defaults?.model,
        primary: modelPrimary,
        fallbacks: modelFallbacks,
      },
    },
  };

  const tools = {
    ...cfg.tools,
    profile: "minimal",
    elevated: { ...cfg.tools?.elevated, enabled: false },
  };

  const channels = { ...cfg.channels };
  const telegramToken = stringOrEmpty(process.env.TELEGRAM_BOT_TOKEN);
  if (telegramToken) {
    channels.telegram = {
      ...channels.telegram,
      enabled: true,
      botToken: channels.telegram?.botToken ?? "${TELEGRAM_BOT_TOKEN}",
      dmPolicy: channels.telegram?.dmPolicy ?? "pairing",
      groupPolicy: channels.telegram?.groupPolicy ?? "disabled",
      configWrites: channels.telegram?.configWrites ?? false,
    };
  }

  const session = {
    ...cfg.session,
    dmScope: cfg.session?.dmScope ?? "per-channel-peer",
  };

  cfg.gateway = gateway;
  cfg.agents = agents;
  cfg.tools = tools;
  cfg.channels = channels;
  cfg.session = session;

  writeConfig(configPath, cfg);

  // Log paths only (no secrets).
  process.stdout.write(
    `openclaw bootstrap: wrote config=${configPath} stateDir=${stateDir} workspaceDir=${workspaceDir}\n`,
  );
}

main();
