import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearTelegramClientRouteStoreCacheForTest } from "../../telegram/client-routing.js";
import { handleTelegramClientCommand } from "./commands-client.js";

function testConfig(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main" }, { id: "coder" }, { id: "power" }],
    },
    channels: {
      telegram: {
        clients: {
          "12345": {
            label: "Acme",
            defaultAgentId: "coder",
            allowedAgents: ["coder", "power"],
          },
        },
      },
    },
  };
}

function baseParams(commandBodyNormalized: string) {
  return {
    ctx: {
      From: "telegram:999",
      AccountId: "default",
    },
    cfg: testConfig(),
    command: {
      surface: "telegram",
      channel: "telegram",
      ownerList: ["999"],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: "999",
      rawBodyNormalized: commandBodyNormalized,
      commandBodyNormalized,
    },
    directives: {},
    elevated: { enabled: false, allowed: false, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention" as const,
    resolvedVerboseLevel: "normal" as const,
    resolvedReasoningLevel: "normal" as const,
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
  } as const;
}

describe("/client command", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    clearTelegramClientRouteStoreCacheForTest();
  });

  it("assigns a Telegram client route to an allowed agent", async () => {
    process.env.OPENCLAW_STATE_DIR = path.join(
      os.tmpdir(),
      `openclaw-client-command-${Date.now()}`,
    );
    clearTelegramClientRouteStoreCacheForTest();
    const result = await handleTelegramClientCommand(
      baseParams("/client assign power 12345"),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Assigned agent: power");
  });

  it("lists configured Telegram client routes", async () => {
    process.env.OPENCLAW_STATE_DIR = path.join(
      os.tmpdir(),
      `openclaw-client-command-${Date.now()}`,
    );
    clearTelegramClientRouteStoreCacheForTest();
    const result = await handleTelegramClientCommand(baseParams("/client list"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Telegram client routes:");
    expect(result?.reply?.text).toContain("Acme");
  });
});
