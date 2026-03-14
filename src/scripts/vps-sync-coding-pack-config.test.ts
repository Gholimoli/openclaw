import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(process.cwd(), "ops/vps/sync-coding-pack-config.sh");

describe("ops/vps/sync-coding-pack-config.sh", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("reconciles pack guardrails while preserving operator-specific telegram targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-vps-sync-"));
    tempRoots.push(root);

    const configPath = path.join(root, "openclaw.json");
    const approvalsPath = path.join(root, "exec-approvals.json");
    const templatePath = path.join(root, "openclaw.vps-coding.json5");

    await writeFile(
      configPath,
      JSON.stringify(
        {
          gateway: { bind: "0.0.0.0", auth: { token: "literal-token" } },
          channels: {
            telegram: {
              enabled: true,
              botToken: "literal-bot-token",
              dmPolicy: "allowlist",
              groupPolicy: "disabled",
              allowFrom: ["7652107499"],
              groupAllowFrom: ["7652107499"],
              groups: {
                "-1001111111111": { requireMention: false },
                "-100999": { requireMention: true },
              },
              capabilities: { inlineButtons: "off" },
              streamMode: "typing",
            },
          },
          plugins: {
            entries: {
              work: {
                enabled: false,
                config: {
                  lobsterPath: "/usr/bin/lobster",
                },
              },
            },
          },
          agents: {
            list: [
              {
                id: "main",
                workspace: "/srv/custom-main",
                model: { primary: "old-model" },
                tools: { allow: ["read"], deny: ["exec"] },
              },
            ],
          },
          bindings: [
            {
              agentId: "power",
              match: { channel: "telegram", peer: { kind: "group", id: "-1002222222222" } },
            },
            {
              agentId: "coder",
              match: { channel: "telegram", peer: { kind: "group", id: "-100999" } },
            },
          ],
          approvals: {
            exec: {
              enabled: true,
              mode: "targets",
              targets: [{ channel: "telegram", to: "7652107499" }],
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
            power: {
              allowlist: [{ id: "a", pattern: "/usr/bin/echo", lastUsedAt: 1 }],
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    await writeFile(
      templatePath,
      `{
        gateway: {
          mode: "local",
          bind: "loopback",
          port: 18789,
          auth: { mode: "token", token: "\${OPENCLAW_GATEWAY_TOKEN}" },
          tools: { deny: ["gateway"] },
        },
        env: { shellEnv: { enabled: false } },
        channels: {
          telegram: {
            enabled: true,
            botToken: "\${TELEGRAM_BOT_TOKEN}",
            capabilities: { inlineButtons: "allowlist" },
            dmPolicy: "allowlist",
            allowFrom: ["\${TELEGRAM_OWNER_ID}"],
            groupPolicy: "allowlist",
            groupAllowFrom: ["\${TELEGRAM_OWNER_ID}"],
            configWrites: false,
            streamMode: "off",
          },
        },
        session: { dmScope: "per-channel-peer" },
        plugins: {
          entries: {
            "google-gemini-cli-auth": { enabled: true },
            work: {
              enabled: true,
              config: {
                workRoot: "~/work/repos",
                defaultBase: "main",
                coderSessionKey: "agent:coder:main",
                maxFixLoops: 3,
                timeoutMs: 1800000,
              },
            },
          },
        },
        tools: {
          profile: "minimal",
          elevated: { enabled: false },
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
              workspace: "~/work/repos",
              tools: { alsoAllow: ["read", "exec", "process"], deny: ["browser"] },
            },
            {
              id: "coder",
              agentDir: "~/.openclaw/agents/coder/agent",
              model: {
                primary: "openai-codex/gpt-5.3-codex",
                fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
              },
              workspace: "~/work/repos",
              tools: { allow: ["exec"], deny: ["browser"] },
            },
            {
              id: "power",
              agentDir: "~/.openclaw/agents/power/agent",
              model: {
                primary: "openai-codex/gpt-5.3-codex",
                fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
              },
              workspace: "~/.openclaw/workspace/power",
              systemPrompt:
                "Consult the operator before deploys, restarts, service control, git push/merge/rebase/reset/branch deletion/tagging/force operations, publish/release steps, secret/token/env/live-config changes, destructive file/data operations, or other external side effects that could break production or leak data.",
            },
            {
              id: "devops",
              agentDir: "~/.openclaw/agents/devops/agent",
              model: {
                primary: "openai-codex/gpt-5.3-codex",
                fallbacks: ["openai/gpt-5.4", "google/gemini-3-pro-preview"],
              },
              workspace: "~/.openclaw/workspace/devops",
            },
          ],
        },
        bindings: [],
        approvals: {
          exec: {
            enabled: true,
            mode: "both",
            agentFilter: ["main"],
            targets: [{ channel: "telegram", to: "\${TELEGRAM_OWNER_ID}" }],
          },
        },
      }\n`,
    );

    await execFileAsync("bash", [scriptPath, configPath, templatePath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root,
      },
    });

    const synced = JSON.parse(await readFile(configPath, "utf8")) as {
      agents?: {
        list?: Array<{
          id?: string;
          agentDir?: string;
          workspace?: string;
          systemPrompt?: string;
          model?: { primary?: string; fallbacks?: string[] };
        }>;
      };
      approvals?: { exec?: { agentFilter?: string[]; mode?: string; targets?: unknown[] } };
      bindings?: Array<{ agentId?: string; match?: { peer?: { id?: string } } }>;
      channels?: {
        telegram?: {
          allowFrom?: string[];
          botToken?: string;
          capabilities?: { inlineButtons?: string };
          groupAllowFrom?: string[];
          groupPolicy?: string;
          groups?: Record<string, unknown>;
          streamMode?: string;
        };
      };
      gateway?: { auth?: { token?: string }; bind?: string };
      plugins?: { entries?: { work?: { enabled?: boolean; config?: { lobsterPath?: string } } } };
    };
    const syncedApprovals = JSON.parse(await readFile(approvalsPath, "utf8")) as {
      defaults?: { security?: string; ask?: string; askFallback?: string };
      agents?: Record<
        string,
        { security?: string; ask?: string; askFallback?: string; allowlist?: unknown[] }
      >;
    };

    const mainAgent = synced.agents?.list?.find((agent) => agent.id === "main");
    const coderAgent = synced.agents?.list?.find((agent) => agent.id === "coder");
    const powerAgent = synced.agents?.list?.find((agent) => agent.id === "power");
    const devopsAgent = synced.agents?.list?.find((agent) => agent.id === "devops");
    expect(synced.gateway?.bind).toBe("loopback");
    expect(synced.gateway?.auth?.token).toBe("literal-token");
    expect(synced.channels?.telegram?.botToken).toBe("literal-bot-token");
    expect(synced.channels?.telegram?.capabilities?.inlineButtons).toBe("allowlist");
    expect(synced.channels?.telegram?.groupPolicy).toBe("allowlist");
    expect(synced.channels?.telegram?.allowFrom).toEqual(["7652107499"]);
    expect(synced.channels?.telegram?.groupAllowFrom).toEqual(["7652107499"]);
    expect(Object.keys(synced.channels?.telegram?.groups ?? {})).toEqual(["-100999"]);
    expect(synced.channels?.telegram?.streamMode).toBe("off");
    expect(synced.plugins?.entries?.work?.enabled).toBe(true);
    expect(synced.plugins?.entries?.work?.config?.lobsterPath).toBe("/usr/bin/lobster");
    expect(mainAgent?.workspace).toBe("/srv/custom-main");
    expect(mainAgent?.agentDir).toBe("~/.openclaw/agents/main/agent");
    expect(mainAgent?.model?.primary).toBe("openai-codex/gpt-5.3-codex");
    expect(mainAgent?.model?.fallbacks).toEqual(["openai/gpt-5.4", "google/gemini-3-pro-preview"]);
    expect(mainAgent?.tools).toMatchObject({
      alsoAllow: ["read", "exec", "process"],
    });
    expect(mainAgent?.tools?.allow).toBeUndefined();
    expect(coderAgent?.agentDir).toBe("~/.openclaw/agents/coder/agent");
    expect(coderAgent?.model?.fallbacks).toEqual(["openai/gpt-5.4", "google/gemini-3-pro-preview"]);
    expect(powerAgent?.agentDir).toBe("~/.openclaw/agents/power/agent");
    expect(powerAgent?.model?.primary).toBe("openai-codex/gpt-5.3-codex");
    expect(powerAgent?.systemPrompt).toContain("Consult the operator before deploys");
    expect(devopsAgent?.agentDir).toBe("~/.openclaw/agents/devops/agent");
    expect(devopsAgent?.model?.fallbacks).toEqual([
      "openai/gpt-5.4",
      "google/gemini-3-pro-preview",
    ]);
    expect(synced.bindings).toEqual([
      {
        agentId: "coder",
        match: { channel: "telegram", peer: { kind: "group", id: "-100999" } },
      },
    ]);
    expect(synced.approvals?.exec?.mode).toBe("both");
    expect(synced.approvals?.exec?.agentFilter).toEqual(["main"]);
    expect(synced.approvals?.exec?.targets).toEqual([{ channel: "telegram", to: "7652107499" }]);
    expect(syncedApprovals.defaults).toMatchObject({
      security: "allowlist",
      ask: "always",
      askFallback: "deny",
    });
    expect(syncedApprovals.agents?.main).toMatchObject({
      security: "allowlist",
      ask: "always",
      askFallback: "deny",
    });
    expect(syncedApprovals.agents?.power).toMatchObject({
      security: "full",
      ask: "off",
      askFallback: "deny",
    });
    expect(syncedApprovals.agents?.power?.allowlist).toEqual([
      { id: "a", pattern: "/usr/bin/echo", lastUsedAt: 1 },
    ]);
  });

  it("preserves the current sandbox user and drops unresolved sandbox env refs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-vps-sync-sandbox-"));
    tempRoots.push(root);

    const configPath = path.join(root, "openclaw.json");
    const templatePath = path.join(root, "openclaw.vps-coding.json5");

    await writeFile(
      configPath,
      JSON.stringify(
        {
          agents: {
            list: [
              {
                id: "coder",
                sandbox: {
                  docker: {
                    user: "999:988",
                    env: {
                      EXISTING_ONLY: "keep-me",
                      STALE_MISSING: "${STALE_MISSING}",
                    },
                  },
                },
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );

    await writeFile(
      templatePath,
      `{
        agents: {
          list: [
            {
              id: "coder",
              sandbox: {
                docker: {
                  image: "openclaw-sandbox-coder:bookworm",
                  user: "\${OPENCLAW_SANDBOX_UID}:\${OPENCLAW_SANDBOX_GID}",
                  env: {
                    LANG: "C.UTF-8",
                    KEEP_IF_DEFINED: "\${KEEP_IF_DEFINED}",
                    DROP_IF_MISSING: "\${DROP_IF_MISSING}",
                  },
                },
              },
            },
          ],
        },
      }\n`,
    );

    await execFileAsync("bash", [scriptPath, configPath, templatePath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root,
        KEEP_IF_DEFINED: "present",
      },
    });

    const synced = JSON.parse(await readFile(configPath, "utf8")) as {
      agents?: {
        list?: Array<{
          id?: string;
          sandbox?: {
            docker?: {
              env?: Record<string, string>;
              image?: string;
              user?: string;
            };
          };
        }>;
      };
    };

    const coderAgent = synced.agents?.list?.find((agent) => agent.id === "coder");
    expect(coderAgent?.sandbox?.docker?.image).toBe("openclaw-sandbox-coder:bookworm");
    expect(coderAgent?.sandbox?.docker?.user).toBe("999:988");
    expect(coderAgent?.sandbox?.docker?.env).toEqual({
      EXISTING_ONLY: "keep-me",
      LANG: "C.UTF-8",
      KEEP_IF_DEFINED: "${KEEP_IF_DEFINED}",
    });
  });
});
