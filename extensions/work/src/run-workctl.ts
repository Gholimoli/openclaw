import { spawn } from "node:child_process";

function parseJsonObject(stdout: string): Record<string, unknown> {
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("workctl returned invalid JSON");
  }
  return parsed as Record<string, unknown>;
}

type WorkctlError = Error & {
  payload?: Record<string, unknown>;
};

function formatStructuredWorkctlFailure(payload: Record<string, unknown>): string {
  const title = typeof payload.error === "string" ? payload.error.trim() : "";
  const details = [
    typeof payload.cause === "string" ? payload.cause.trim() : "",
    typeof payload.tail === "string" ? payload.tail.trim() : "",
  ].filter(Boolean);
  return [title || "workctl failed", ...details].join("\n\n");
}

function pushArg(argv: string[], key: string, value: unknown) {
  if (value === undefined || value === null || value === false) {
    return;
  }
  argv.push(`--${key}`);
  if (value !== true) {
    argv.push(String(value));
  }
}

async function runOnce(params: {
  workctlPath: string;
  subcommand: string;
  args?: Record<string, unknown>;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
}) {
  const timeoutMs = Math.max(200, params.timeoutMs);
  const maxStdoutBytes = Math.max(1024, params.maxStdoutBytes);
  const env = { ...process.env } as Record<string, string | undefined>;

  const nodeOptions = env.NODE_OPTIONS ?? "";
  if (nodeOptions.includes("--inspect")) {
    delete env.NODE_OPTIONS;
  }

  const argv = [params.workctlPath, params.subcommand];
  for (const [key, value] of Object.entries(params.args ?? {})) {
    pushArg(argv, key, value);
  }
  argv.push("--json");

  return await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
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
          reject(new Error("workctl output exceeded maxStdoutBytes"));
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
        reject(new Error("workctl subprocess timed out"));
      }
    }, timeoutMs);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stdoutTrimmed = stdout.trim();
        if (stdoutTrimmed) {
          try {
            const payload = parseJsonObject(stdoutTrimmed);
            const error: WorkctlError = new Error(formatStructuredWorkctlFailure(payload));
            error.payload = payload;
            reject(error);
            return;
          } catch {
            // Fall back to the raw stderr/stdout message below.
          }
        }
        reject(new Error(`workctl failed (${code ?? "?"}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ stdout });
    });
  });
}

export async function runWorkctlJson(params: {
  workctlPath: string;
  subcommand: string;
  args?: Record<string, unknown>;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
}): Promise<Record<string, unknown>> {
  const { stdout } = await runOnce(params);
  return parseJsonObject(stdout);
}
