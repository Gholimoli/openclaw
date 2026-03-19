import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramResolvedClientRoute } from "./client-routing.js";
import {
  detectMentionedTelegramAgents,
  resolveTelegramRoomPlan,
  resolveTelegramRoomSpeakerLabel,
} from "./orchestration.js";

function buildConfig(): OpenClawConfig {
  return {
    agents: {
      list: [
        { id: "main", identity: { name: "Lead" } },
        { id: "power", identity: { name: "Power" } },
        { id: "review", identity: { name: "Review" } },
      ],
    },
    channels: {
      telegram: {
        historyLimit: 18,
      },
    },
    broadcast: {
      strategy: "sequential",
      "group:ops": ["main", "power"],
    },
  };
}

function buildResolvedClientRoute(
  overrides?: Partial<TelegramResolvedClientRoute>,
): TelegramResolvedClientRoute {
  return {
    peerId: "group:client",
    route: {
      agentId: "main",
      channel: "telegram",
      accountId: "default",
      sessionKey: "agent:main:telegram:group:group:client",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    },
    overrideApplied: true,
    clientConfig: {
      defaultAgentId: "main",
      orchestration: {
        enabled: true,
        peerAgents: ["power", "review"],
        peerReplyPolicy: "addressed",
        historyLimit: 12,
        strategy: "sequential",
      },
    },
    ...overrides,
  };
}

describe("telegram room orchestration", () => {
  it("detects explicitly mentioned peer agents", () => {
    const cfg = buildConfig();
    expect(
      detectMentionedTelegramAgents({
        cfg,
        text: "@power please review this with @review",
        agentIds: ["main", "power", "review"],
      }),
    ).toEqual(["power", "review"]);
  });

  it("routes client rooms to the lead agent when peers are not mentioned", () => {
    const cfg = buildConfig();
    const plan = resolveTelegramRoomPlan({
      cfg,
      telegramCfg: cfg.channels?.telegram,
      peerId: "group:client",
      accountId: "default",
      message: {
        chat: { id: -1001, type: "supergroup" },
        text: "please continue",
        message_id: 1,
      },
      resolvedClientRoute: buildResolvedClientRoute(),
    });
    expect(plan.kind).toBe("client-orchestration");
    if (plan.kind !== "client-orchestration") {
      throw new Error("unexpected plan kind");
    }
    expect(plan.targets).toEqual([{ agentId: "main", allowWithoutMention: true }]);
    expect(plan.roomState.historyLimit).toBe(12);
  });

  it("suppresses the lead and routes only mentioned peers by default", () => {
    const cfg = buildConfig();
    const plan = resolveTelegramRoomPlan({
      cfg,
      telegramCfg: cfg.channels?.telegram,
      peerId: "group:client",
      accountId: "default",
      message: {
        chat: { id: -1001, type: "supergroup" },
        text: "@power please take this one",
        entities: [{ type: "mention", offset: 0, length: 6 }],
        message_id: 2,
      },
      resolvedClientRoute: buildResolvedClientRoute(),
    });
    expect(plan.kind).toBe("client-orchestration");
    if (plan.kind !== "client-orchestration") {
      throw new Error("unexpected plan kind");
    }
    expect(plan.targets).toEqual([{ agentId: "power" }]);
  });

  it("routes ordinary group replies to the addressed peer when replying to its prior message", () => {
    const cfg = buildConfig();
    const plan = resolveTelegramRoomPlan({
      cfg,
      telegramCfg: cfg.channels?.telegram,
      peerId: "group:client",
      accountId: "default",
      message: {
        chat: { id: -1001, type: "supergroup" },
        text: "can you take this one?",
        reply_to_message: {
          message_id: 77,
          from: { id: 100, is_bot: true, first_name: "OpenClaw" },
          chat: { id: -1001, type: "supergroup" },
          date: 1,
        },
        message_id: 5,
      },
      roomEntries: [
        {
          kind: "agent",
          actorLabel: "Power",
          body: "[Power] On it.",
          timestamp: 4,
          agentId: "power",
          outboundMessageIds: ["77"],
        },
      ],
      resolvedClientRoute: {
        peerId: "group:client",
        route: {
          agentId: "main",
          channel: "telegram",
          accountId: "default",
          sessionKey: "agent:main:telegram:group:group:client",
          mainSessionKey: "agent:main:main",
          matchedBy: "default",
        },
        overrideApplied: false,
      },
    });
    expect(plan.kind).toBe("addressed-group");
    if (plan.kind !== "addressed-group") {
      throw new Error("unexpected plan kind");
    }
    expect(plan.targets).toEqual([{ agentId: "power" }]);
    expect(plan.roomState.multiSpeakerRoom).toBe(true);
  });

  it("includes the lead when the lead and peers are both mentioned", () => {
    const cfg = buildConfig();
    const plan = resolveTelegramRoomPlan({
      cfg,
      telegramCfg: cfg.channels?.telegram,
      peerId: "group:client",
      accountId: "default",
      message: {
        chat: { id: -1001, type: "supergroup" },
        text: "@lead coordinate with @review",
        entities: [
          { type: "mention", offset: 0, length: 5 },
          { type: "mention", offset: 22, length: 7 },
        ],
        message_id: 3,
      },
      resolvedClientRoute: buildResolvedClientRoute(),
    });
    expect(plan.kind).toBe("client-orchestration");
    if (plan.kind !== "client-orchestration") {
      throw new Error("unexpected plan kind");
    }
    expect(plan.targets).toEqual([
      { agentId: "main", allowWithoutMention: true },
      { agentId: "review" },
    ]);
  });

  it("builds broadcast plans with shared room state", () => {
    const cfg = buildConfig();
    const plan = resolveTelegramRoomPlan({
      cfg,
      telegramCfg: cfg.channels?.telegram,
      peerId: "group:ops",
      accountId: "default",
      message: {
        chat: { id: -1002, type: "supergroup" },
        text: "@openclaw_bot status",
        entities: [{ type: "mention", offset: 0, length: 13 }],
        message_id: 4,
      },
      resolvedClientRoute: {
        peerId: "group:ops",
        route: {
          agentId: "main",
          channel: "telegram",
          accountId: "default",
          sessionKey: "agent:main:telegram:group:group:ops",
          mainSessionKey: "agent:main:main",
          matchedBy: "default",
        },
        overrideApplied: false,
      },
    });
    expect(plan.kind).toBe("broadcast");
    if (plan.kind !== "broadcast") {
      throw new Error("unexpected plan kind");
    }
    expect(plan.targets).toEqual([
      { agentId: "main", allowWithoutMention: true },
      { agentId: "power", allowWithoutMention: true },
    ]);
    expect(plan.strategy).toBe("sequential");
    expect(plan.roomState.multiSpeakerRoom).toBe(true);
  });

  it("resolves room speaker labels from agent identity names", () => {
    expect(resolveTelegramRoomSpeakerLabel({ cfg: buildConfig(), agentId: "power" })).toBe("Power");
  });
});
