import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(process.cwd(), "ops/vps/verify-coding-pack-config.sh");

describe("ops/vps/verify-coding-pack-config.sh", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("accepts the pinned VPS coding-pack agent model policy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-vps-verify-"));
    tempRoots.push(root);

    const configPath = path.join(root, "openclaw.json");
    const approvalsPath = path.join(root, "exec-approvals.json");
    for (const agentId of ["main", "coder", "power", "devops"]) {
      const agentDir = path.join(root, ".openclaw", "agents", agentId, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        path.join(agentDir, "auth-profiles.json"),
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
          },
          null,
          2,
        ) + "\n",
      );
    }
    await writeFile(
      approvalsPath,
      JSON.stringify(
        {
          version: 1,
          defaults: { security: "allowlist", ask: "always", askFallback: "deny" },
          agents: {
            main: { security: "allowlist", ask: "always", askFallback: "deny", allowlist: [] },
            power: { security: "full", ask: "off", askFallback: "deny", allowlist: [] },
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
          gateway: { bind: "loopback" },
          channels: {
            telegram: {
              enabled: true,
              dmPolicy: "allowlist",
              groupPolicy: "allowlist",
              allowFrom: ["7652107499"],
              groupAllowFrom: ["7652107499"],
              capabilities: { inlineButtons: "allowlist" },
              streamMode: "off",
            },
          },
          plugins: { entries: { work: { enabled: true } } },
          approvals: {
            exec: {
              enabled: true,
              mode: "both",
              agentFilter: ["main"],
              targets: [{ channel: "telegram", to: "7652107499" }],
            },
          },
          agents: {
            list: [
              {
                id: "main",
                agentDir: "~/.openclaw/agents/main/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                  fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
                },
                tools: { alsoAllow: ["read", "exec", "process"], deny: ["browser"] },
              },
              {
                id: "coder",
                agentDir: "~/.openclaw/agents/coder/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                  fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
                },
              },
              {
                id: "power",
                agentDir: "~/.openclaw/agents/power/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                  fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
                },
                systemPrompt:
                  "Consult the operator before deploys, restarts, service control, git push/merge/rebase/reset/branch deletion/tagging/force operations, publish/release steps, secret/token/env/live-config changes, destructive file/data operations, or other external side effects that could break production or leak data.",
                tools: {
                  allow: ["browser", "exec", "process", "read", "write", "edit", "apply_patch"],
                  deny: ["canvas", "nodes", "cron", "gateway", "sessions_spawn", "sessions_send"],
                  exec: {
                    host: "gateway",
                    security: "full",
                    ask: "off",
                    applyPatch: { enabled: true, workspaceOnly: false },
                  },
                  fs: { workspaceOnly: false },
                },
              },
              {
                id: "devops",
                agentDir: "~/.openclaw/agents/devops/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                  fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
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
        OPENAI_API_KEY: "test-openai",
        GEMINI_API_KEY: "test-gemini",
      },
    });

    expect(result.stdout).toContain("[vps-verify] OK:");
  });

  it("rejects drift in agentDir and fallback policy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-vps-verify-fail-"));
    tempRoots.push(root);

    const configPath = path.join(root, "openclaw.json");
    const approvalsPath = path.join(root, "exec-approvals.json");
    await writeFile(
      approvalsPath,
      JSON.stringify(
        {
          version: 1,
          defaults: { security: "allowlist", ask: "always", askFallback: "deny" },
          agents: {
            main: { security: "allowlist", ask: "always", askFallback: "deny", allowlist: [] },
            power: { security: "full", ask: "off", askFallback: "deny", allowlist: [] },
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
          gateway: { bind: "loopback" },
          channels: {
            telegram: {
              enabled: true,
              dmPolicy: "allowlist",
              groupPolicy: "allowlist",
              allowFrom: ["7652107499"],
              groupAllowFrom: ["7652107499"],
              capabilities: { inlineButtons: "allowlist" },
              streamMode: "off",
            },
          },
          plugins: { entries: { work: { enabled: true } } },
          approvals: {
            exec: {
              enabled: true,
              mode: "both",
              agentFilter: ["main"],
              targets: [{ channel: "telegram", to: "7652107499" }],
            },
          },
          agents: {
            list: [
              {
                id: "main",
                agentDir: "~/.openclaw/agents/main/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                  fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
                },
                tools: { alsoAllow: ["read", "exec", "process"], deny: ["browser"] },
              },
              {
                id: "coder",
                agentDir: "~/.openclaw/agents/coder/custom",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                  fallbacks: ["openai/gpt-5.4"],
                },
              },
              {
                id: "power",
                agentDir: "~/.openclaw/agents/power/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                  fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
                },
                systemPrompt:
                  "Consult the operator before deploys, restarts, service control, git push/merge/rebase/reset/branch deletion/tagging/force operations, publish/release steps, secret/token/env/live-config changes, destructive file/data operations, or other external side effects that could break production or leak data.",
                tools: {
                  allow: ["browser", "exec", "process", "read", "write", "edit", "apply_patch"],
                  deny: ["canvas", "nodes", "cron", "gateway", "sessions_spawn", "sessions_send"],
                  exec: {
                    host: "gateway",
                    security: "full",
                    ask: "off",
                    applyPatch: { enabled: true, workspaceOnly: false },
                  },
                  fs: { workspaceOnly: false },
                },
              },
              {
                id: "devops",
                agentDir: "~/.openclaw/agents/devops/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                  fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
                },
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );

    await expect(
      execFileAsync("bash", [scriptPath, configPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: root,
          OPENAI_API_KEY: "test-openai",
          GEMINI_API_KEY: "test-gemini",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('coder agentDir must be "~/.openclaw/agents/coder/agent"'),
    });
  });

  it("rejects missing worker oauth profiles and fallback env vars", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-vps-verify-auth-"));
    tempRoots.push(root);

    const configPath = path.join(root, "openclaw.json");
    const approvalsPath = path.join(root, "exec-approvals.json");
    const mainAgentDir = path.join(root, ".openclaw", "agents", "main", "agent");
    await mkdir(mainAgentDir, { recursive: true });
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
        },
        null,
        2,
      ) + "\n",
    );

    await writeFile(
      approvalsPath,
      JSON.stringify(
        {
          version: 1,
          defaults: { security: "allowlist", ask: "always", askFallback: "deny" },
          agents: {
            main: { security: "allowlist", ask: "always", askFallback: "deny", allowlist: [] },
            power: { security: "full", ask: "off", askFallback: "deny", allowlist: [] },
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
          gateway: { bind: "loopback" },
          channels: {
            telegram: {
              enabled: true,
              dmPolicy: "allowlist",
              groupPolicy: "allowlist",
              allowFrom: ["7652107499"],
              groupAllowFrom: ["7652107499"],
              capabilities: { inlineButtons: "allowlist" },
              streamMode: "off",
            },
          },
          plugins: { entries: { work: { enabled: true } } },
          approvals: {
            exec: {
              enabled: true,
              mode: "both",
              agentFilter: ["main"],
              targets: [{ channel: "telegram", to: "7652107499" }],
            },
          },
          agents: {
            list: [
              {
                id: "main",
                agentDir: "~/.openclaw/agents/main/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                  fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
                },
                tools: { alsoAllow: ["read", "exec", "process"], deny: ["browser"] },
              },
              {
                id: "coder",
                agentDir: "~/.openclaw/agents/coder/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                  fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
                },
              },
              {
                id: "power",
                agentDir: "~/.openclaw/agents/power/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                  fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
                },
                tools: {
                  allow: ["browser", "exec", "process", "read", "write", "edit", "apply_patch"],
                  deny: ["canvas", "nodes", "cron", "gateway", "sessions_spawn", "sessions_send"],
                  exec: {
                    host: "gateway",
                    security: "full",
                    ask: "off",
                    applyPatch: { enabled: true, workspaceOnly: false },
                  },
                  fs: { workspaceOnly: false },
                },
              },
              {
                id: "devops",
                agentDir: "~/.openclaw/agents/devops/agent",
                model: {
                  primary: "openai-codex/gpt-5.3-codex",
                  fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
                },
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );

    await expect(
      execFileAsync("bash", [scriptPath, configPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: root,
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("coder must have an openai-codex auth profile"),
    });
  });
});
