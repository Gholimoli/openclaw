import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    },
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

let lastHeartbeatAt = Date.now();
let outageAlerted = false;

let child = startOpenClawGateway();
let restarting = false;

async function restartGateway(reason) {
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
  const alive = child.exitCode == null;

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    const ageMs = Date.now() - lastHeartbeatAt;
    return respondJson(res, 200, {
      ok: true,
      gatewayRunning: child.exitCode == null,
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
