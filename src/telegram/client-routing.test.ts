import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearTelegramClientRouteStoreCacheForTest,
  resolveTelegramClientRoute,
  setTelegramClientRouteAssignment,
} from "./client-routing.js";

function testConfig(): OpenClawConfig {
  return {
    session: { dmScope: "per-channel-peer" },
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

describe("telegram client routing", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    clearTelegramClientRouteStoreCacheForTest();
  });

  it("routes configured client chats to the default agent", () => {
    process.env.OPENCLAW_STATE_DIR = path.join(os.tmpdir(), `openclaw-client-route-${Date.now()}`);
    clearTelegramClientRouteStoreCacheForTest();
    const resolved = resolveTelegramClientRoute({
      cfg: testConfig(),
      accountId: "default",
      peer: { kind: "direct", id: "12345" },
    });
    expect(resolved.route.agentId).toBe("coder");
    expect(resolved.route.sessionKey).toBe("agent:coder:telegram:direct:12345");
    expect(resolved.overrideApplied).toBe(true);
  });

  it("applies runtime takeover assignments for configured clients", async () => {
    process.env.OPENCLAW_STATE_DIR = path.join(os.tmpdir(), `openclaw-client-route-${Date.now()}`);
    clearTelegramClientRouteStoreCacheForTest();
    const cfg = testConfig();
    await setTelegramClientRouteAssignment({
      cfg,
      accountId: "default",
      peerId: "12345",
      agentId: "power",
      updatedBy: "owner",
    });
    const resolved = resolveTelegramClientRoute({
      cfg,
      accountId: "default",
      peer: { kind: "direct", id: "12345" },
    });
    expect(resolved.route.agentId).toBe("power");
    expect(resolved.assignedAgentId).toBe("power");
    expect(resolved.routeState?.updatedBy).toBe("owner");
  });
});
