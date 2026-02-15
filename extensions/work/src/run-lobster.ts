import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import type { WorkEnvelope } from "./work-types.js";

function resolveExecutablePath(lobsterPathRaw: string | undefined) {
  const lobsterPath = lobsterPathRaw?.trim() || "lobster";

  // Security: if overridden, must be absolute and point to the lobster binary.
  if (lobsterPath !== "lobster") {
    if (!path.isAbsolute(lobsterPath)) {
      throw new Error("lobsterPath must be an absolute path (or omit to use PATH)");
    }
    const base = path.basename(lobsterPath).toLowerCase();
    const allowed =
      process.platform === "win32" ? ["lobster.exe", "lobster.cmd", "lobster.bat"] : ["lobster"];
    if (!allowed.includes(base)) {
      throw new Error("lobsterPath must point to the lobster executable");
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(lobsterPath);
    } catch {
      throw new Error("lobsterPath must exist");
    }
    if (!stat.isFile()) {
      throw new Error("lobsterPath must point to a file");
    }
    if (process.platform !== "win32") {
      try {
        fs.accessSync(lobsterPath, fs.constants.X_OK);
      } catch {
        throw new Error("lobsterPath must be executable");
      }
    }
  }

  return lobsterPath;
}

function parseEnvelope(stdout: string): WorkEnvelope {
  const trimmed = stdout.trim();
  const tryParse = (input: string) => {
    try {
      return JSON.parse(input) as unknown;
    } catch {
      return undefined;
    }
  };

  let parsed: unknown = tryParse(trimmed);
  if (parsed === undefined) {
    const suffixMatch = trimmed.match(/({[\s\S]*}|\[[\s\S]*])\s*$/);
    if (suffixMatch?.[1]) {
      parsed = tryParse(suffixMatch[1]);
    }
  }
  if (parsed === undefined || !parsed || typeof parsed !== "object") {
    throw new Error("lobster returned invalid JSON envelope");
  }
  const ok = (parsed as { ok?: unknown }).ok;
  if (ok === true || ok === false) {
    return parsed as WorkEnvelope;
  }
  throw new Error("lobster returned invalid JSON envelope");
}

async function runOnce(params: {
  execPath: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
}) {
  const timeoutMs = Math.max(200, params.timeoutMs);
  const maxStdoutBytes = Math.max(1024, params.maxStdoutBytes);
  const env = { ...process.env, LOBSTER_MODE: "tool" } as Record<string, string | undefined>;

  const nodeOptions = env.NODE_OPTIONS ?? "";
  if (nodeOptions.includes("--inspect")) {
    delete env.NODE_OPTIONS;
  }

  return await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(params.execPath, params.argv, {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk) => {
      const str = String(chunk);
      stdoutBytes += Buffer.byteLength(str, "utf8");
      if (stdoutBytes > maxStdoutBytes) {
        try {
          child.kill("SIGKILL");
        } finally {
          reject(new Error("lobster output exceeded maxStdoutBytes"));
        }
        return;
      }
      stdout += str;
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } finally {
        reject(new Error("lobster subprocess timed out"));
      }
    }, timeoutMs);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`lobster failed (${code ?? "?"}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ stdout });
    });
  });
}

export function resolveWorkflowsDir(): string {
  // extensions/work/src/run-lobster.ts -> extensions/work
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "workflows");
}

export function resolveWorkctlPath(): string {
  // extensions/work/src/run-lobster.ts -> extensions/work/scripts/workctl.mjs
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "scripts", "workctl.mjs");
}

export async function runWorkLobster(
  api: OpenClawPluginApi,
  params: {
    workflowPath: string;
    argsJson?: string;
    timeoutMs: number;
    maxStdoutBytes: number;
  },
): Promise<WorkEnvelope> {
  const execPath = resolveExecutablePath(
    typeof api.pluginConfig?.lobsterPath === "string"
      ? String(api.pluginConfig.lobsterPath)
      : undefined,
  );

  const argv = ["run", "--mode", "tool", params.workflowPath];
  if (params.argsJson?.trim()) {
    argv.push("--args-json", params.argsJson.trim());
  }

  const { stdout } = await runOnce({
    execPath,
    argv,
    cwd: process.cwd(),
    timeoutMs: params.timeoutMs,
    maxStdoutBytes: params.maxStdoutBytes,
  });

  return parseEnvelope(stdout);
}

export async function resumeWorkLobster(
  api: OpenClawPluginApi,
  params: {
    token: string;
    approve: boolean;
    timeoutMs: number;
    maxStdoutBytes: number;
  },
): Promise<WorkEnvelope> {
  const execPath = resolveExecutablePath(
    typeof api.pluginConfig?.lobsterPath === "string"
      ? String(api.pluginConfig.lobsterPath)
      : undefined,
  );

  const argv = ["resume", "--token", params.token, "--approve", params.approve ? "yes" : "no"];
  const { stdout } = await runOnce({
    execPath,
    argv,
    cwd: process.cwd(),
    timeoutMs: params.timeoutMs,
    maxStdoutBytes: params.maxStdoutBytes,
  });

  return parseEnvelope(stdout);
}
