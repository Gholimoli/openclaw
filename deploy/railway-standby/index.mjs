import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isTruthyEnvValue(v) {
  if (!v) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function respondJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(buf.length),
  });
  res.end(buf);
}

async function sendTelegramDm({ botToken, chatId, text }) {
  // Best-effort notification; never throw from watchdog paths.
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const body = new URLSearchParams({ chat_id: chatId, text });
    const resp = await fetch(url, { method: "POST", body });
    if (!resp.ok) {
      // Avoid dumping token; include only status.
      console.error(`[sentinel] telegram sendMessage failed status=${resp.status}`);
    }
  } catch (err) {
    console.error(`[sentinel] telegram sendMessage failed: ${String(err)}`);
  }
}

async function telegramGetUpdates({ botToken, offset }) {
  const url = new URL(`https://api.telegram.org/bot${botToken}/getUpdates`);
  // Long polling: keep sentinel cheap and avoid webhooks/inbound exposure.
  url.searchParams.set("timeout", "30");
  url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
  if (offset != null) {
    url.searchParams.set("offset", String(offset));
  }
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`telegram getUpdates failed status=${resp.status}`);
  }
  const data = await resp.json();
  if (!data?.ok) {
    throw new Error(`telegram getUpdates returned ok=false`);
  }
  return Array.isArray(data.result) ? data.result : [];
}

function formatAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem}s`;
}

async function runStandbyTelegramLoop({ botToken, operatorChatId, getStatusText, onHelpText }) {
  // Note: do not run this if OpenClaw is also long-polling the same bot token.
  let offset = 0;
  await sendTelegramDm({
    botToken,
    chatId: operatorChatId,
    text:
      "OpenClaw standby is online (simple mode). " +
      "I will alert you if the primary heartbeat stops. " +
      "Send /help for commands.",
  });

  for (;;) {
    try {
      const updates = await telegramGetUpdates({ botToken, offset });
      for (const u of updates) {
        if (typeof u?.update_id === "number") {
          offset = Math.max(offset, u.update_id + 1);
        }
        const msg = u?.message;
        const chatId = msg?.chat?.id;
        const text = typeof msg?.text === "string" ? msg.text.trim() : "";
        if (!text) {
          continue;
        }

        // Lock down to the operator DM. Ignore everyone else.
        if (String(chatId) !== String(operatorChatId)) {
          continue;
        }

        if (text === "/help" || text === "/start") {
          await sendTelegramDm({ botToken, chatId: operatorChatId, text: onHelpText() });
          continue;
        }

        if (text === "/status") {
          await sendTelegramDm({ botToken, chatId: operatorChatId, text: getStatusText() });
          continue;
        }

        if (text === "/primary") {
          await sendTelegramDm({
            botToken,
            chatId: operatorChatId,
            text:
              "If the primary bot is responsive, use it for normal work. " +
              "If it is unresponsive, you can use this standby for status + alerts while you recover the primary.",
          });
          continue;
        }

        await sendTelegramDm({ botToken, chatId: operatorChatId, text: getStatusText() });
      }
    } catch (err) {
      console.error(`[sentinel] telegram polling error: ${String(err)}`);
      await sleep(3000);
    }
  }
}

function startOpenClawGateway() {
  const bin = path.join(__dirname, "node_modules", ".bin", "openclaw");
  const configPath = path.join(os.tmpdir(), "openclaw-railway-standby.json");

  // Generate a config file at runtime so the Railway environment is the only
  // source of secrets (and so we can template operator allowlists safely).
  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: 18789,
      auth: { mode: "token", token: GATEWAY_TOKEN },
      // Standby is Telegram-only; avoid exposing local UI surfaces.
      controlUi: { enabled: false },
    },
    // Reduce baseline memory: disable optional embedded servers.
    browser: { enabled: false },
    canvasHost: { enabled: false },
    discovery: { mdns: { mode: "off" }, wideArea: { enabled: false } },
    agents: {
      defaults: {
        // Orchestration-only. Keep standby conservative and cheap.
        model: {
          primary: "openrouter/openai/gpt-5.2",
          fallbacks: ["openrouter/google/gemini-3-pro-preview"],
        },
      },
      list: [
        {
          id: "main",
          default: true,
          name: "Standby",
          sandbox: { mode: "off" },
          tools: { profile: "minimal" },
        },
      ],
    },
    tools: { profile: "minimal", elevated: { enabled: false } },
    channels: {
      telegram: {
        enabled: true,
        configWrites: false,
        dmPolicy: "allowlist",
        // Lock the standby bot to the operator only.
        allowFrom: [OPERATOR_CHAT_ID],
        // Keep groups disabled until explicitly configured.
        groups: {},
      },
    },
    plugins: { entries: { telegram: { enabled: true } } },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });

  const child = spawn(bin, ["gateway", "run", "--bind", "loopback", "--port", "18789", "--force"], {
    env: {
      ...process.env,
      // Force the deploy-local config and keep state in the container FS.
      OPENCLAW_CONFIG_PATH: configPath,
      // Keep the standby tiny; these features are not needed on Railway.
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    },
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    console.error(`[sentinel] openclaw exited code=${code ?? "null"} signal=${signal ?? "null"}`);
  });

  return child;
}

const BOT_TOKEN = requiredEnv("TELEGRAM_BOT_TOKEN");
const OPERATOR_CHAT_ID = requiredEnv("OPERATOR_TELEGRAM_CHAT_ID");
const HEARTBEAT_SECRET = requiredEnv("OPENCLAW_HEARTBEAT_SECRET");
const GATEWAY_TOKEN = requiredEnv("OPENCLAW_GATEWAY_TOKEN");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HEARTBEAT_TTL_MS = Number.parseInt(process.env.HEARTBEAT_TTL_MS || "180000", 10); // 3m
const ENABLE_GATEWAY = isTruthyEnvValue(process.env.OPENCLAW_STANDBY_ENABLE_GATEWAY);

let lastHeartbeatAt = Date.now();
let outageAlerted = false;

let child = ENABLE_GATEWAY ? startOpenClawGateway() : null;
let restarting = false;

async function restartGateway(reason) {
  if (!ENABLE_GATEWAY) {
    return;
  }
  if (restarting) {
    return;
  }
  restarting = true;
  console.error(`[sentinel] restarting gateway reason=${reason}`);

  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  await sleep(1500);
  child = startOpenClawGateway();
  restarting = false;

  await sendTelegramDm({
    botToken: BOT_TOKEN,
    chatId: OPERATOR_CHAT_ID,
    text: `OpenClaw standby: restarted (reason: ${reason}).`,
  });
}

setInterval(async () => {
  const age = Date.now() - lastHeartbeatAt;
  const alive = child ? child.exitCode == null : true;

  if (!alive) {
    await restartGateway("process-exited");
    return;
  }

  if (age > HEARTBEAT_TTL_MS) {
    if (!outageAlerted) {
      outageAlerted = true;
      await sendTelegramDm({
        botToken: BOT_TOKEN,
        chatId: OPERATOR_CHAT_ID,
        text:
          "OpenClaw standby: primary heartbeat is missing. " +
          "If the primary bot is unresponsive, use this standby bot now.",
      });
    }
  } else {
    outageAlerted = false;
  }
}, 30_000).unref();

function getStatusText() {
  const ageMs = Date.now() - lastHeartbeatAt;
  const hbOk = ageMs <= HEARTBEAT_TTL_MS;
  const gatewayRunning = child ? child.exitCode == null : false;
  return [
    `Standby mode: ${ENABLE_GATEWAY ? "gateway" : "simple"}`,
    `Primary heartbeat: ${hbOk ? "ok" : "stale"} (age ${formatAge(ageMs)}, ttl ${formatAge(HEARTBEAT_TTL_MS)})`,
    `Standby gateway: ${ENABLE_GATEWAY ? (gatewayRunning ? "running" : "down") : "disabled"}`,
    "",
    "Commands: /status /primary /help",
  ].join("\n");
}

function helpText() {
  return [
    "OpenClaw standby commands:",
    "",
    "/status  Show heartbeat + standby status",
    "/primary Remind how to use primary vs standby",
    "/help    Show this help",
    "",
    "Notes:",
    "- This standby runs in simple mode by default (Railway free tiers often OOM running a full OpenClaw gateway).",
    "- To try a full standby gateway, set OPENCLAW_STANDBY_ENABLE_GATEWAY=1 (and use a plan with enough RAM).",
  ].join("\n");
}

if (!ENABLE_GATEWAY) {
  // Simple standby runs its own long polling loop. Do NOT enable this if
  // OpenClaw is also running with Telegram long polling for the same token.
  void runStandbyTelegramLoop({
    botToken: BOT_TOKEN,
    operatorChatId: OPERATOR_CHAT_ID,
    getStatusText,
    onHelpText: helpText,
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    const ageMs = Date.now() - lastHeartbeatAt;
    return respondJson(res, 200, {
      ok: true,
      standbyMode: ENABLE_GATEWAY ? "gateway" : "simple",
      gatewayRunning: child ? child.exitCode == null : false,
      heartbeatAgeMs: ageMs,
      heartbeatStale: ageMs > HEARTBEAT_TTL_MS,
    });
  }

  if (req.method === "POST" && url.pathname === "/heartbeat") {
    const secret = req.headers["x-openclaw-heartbeat-secret"];
    if (typeof secret !== "string" || secret !== HEARTBEAT_SECRET) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    lastHeartbeatAt = Date.now();
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[sentinel] listening on :${PORT}`);
});
