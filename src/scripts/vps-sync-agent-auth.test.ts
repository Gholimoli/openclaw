import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(process.cwd(), "ops/vps/sync-agent-auth.sh");

describe("ops/vps/sync-agent-auth.sh", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("copies openai-codex auth from main to worker agents that are missing it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-vps-auth-sync-"));
    tempRoots.push(root);

    const configPath = path.join(root, "openclaw.json");
    const mainAgentDir = path.join(root, ".openclaw", "agents", "main", "agent");
    const coderAgentDir = path.join(root, ".openclaw", "agents", "coder", "agent");
    const powerAgentDir = path.join(root, ".openclaw", "agents", "power", "agent");
    const devopsAgentDir = path.join(root, ".openclaw", "agents", "devops", "agent");
    await Promise.all([
      mkdir(mainAgentDir, { recursive: true }),
      mkdir(coderAgentDir, { recursive: true }),
      mkdir(powerAgentDir, { recursive: true }),
      mkdir(devopsAgentDir, { recursive: true }),
    ]);

    await writeFile(
      path.join(mainAgentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai-codex:default": {
              type: "oauth",
              provider: "openai-codex",
              access: "access",
              refresh: "refresh",
            },
          },
          usageStats: {
            "openai-codex:default": {
              lastUsed: 123,
            },
          },
          lastGood: {
            "openai-codex": "openai-codex:default",
          },
        },
        null,
        2,
      ) + "\n",
    );

    await writeFile(
      path.join(powerAgentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "custom:api": {
              type: "api_key",
              provider: "custom",
              key: "keep-me",
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    await writeFile(
      path.join(devopsAgentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai-codex:default": {
              type: "oauth",
              provider: "openai-codex",
              access: "existing",
              refresh: "existing",
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    await writeFile(
      configPath,
      JSON.stringify(
        {
          agents: {
            list: [
              {
                id: "main",
                agentDir: "~/.openclaw/agents/main/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                  fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
                },
              },
              {
                id: "coder",
                agentDir: "~/.openclaw/agents/coder/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                },
              },
              {
                id: "power",
                agentDir: "~/.openclaw/agents/power/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                },
              },
              {
                id: "devops",
                agentDir: "~/.openclaw/agents/devops/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                },
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );

    const result = await execFileAsync("bash", [scriptPath, configPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root,
      },
    });

    expect(result.stdout).toContain("changed=coder,power");
    expect(result.stdout).toContain("skipped=devops:already-configured");

    const coderStore = JSON.parse(
      await readFile(path.join(coderAgentDir, "auth-profiles.json"), "utf8"),
    ) as {
      profiles?: Record<string, { provider?: string }>;
      usageStats?: Record<string, { lastUsed?: number }>;
      lastGood?: Record<string, string>;
    };
    expect(coderStore.profiles?.["openai-codex:default"]?.provider).toBe("openai-codex");
    expect(coderStore.usageStats?.["openai-codex:default"]?.lastUsed).toBe(123);
    expect(coderStore.lastGood?.["openai-codex"]).toBe("openai-codex:default");

    const powerStore = JSON.parse(
      await readFile(path.join(powerAgentDir, "auth-profiles.json"), "utf8"),
    ) as {
      profiles?: Record<string, { provider?: string }>;
    };
    expect(powerStore.profiles?.["custom:api"]?.provider).toBe("custom");
    expect(powerStore.profiles?.["openai-codex:default"]?.provider).toBe("openai-codex");

    const devopsStore = JSON.parse(
      await readFile(path.join(devopsAgentDir, "auth-profiles.json"), "utf8"),
    ) as {
      profiles?: Record<string, { access?: string }>;
    };
    expect(devopsStore.profiles?.["openai-codex:default"]?.access).toBe("existing");
  });
});
