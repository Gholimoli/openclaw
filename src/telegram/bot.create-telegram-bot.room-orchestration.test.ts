import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getLoadConfigMock,
  getOnHandler,
  makeTelegramMessageCtx,
  onSpy,
  replySpy,
  sendMessageSpy,
} from "./bot.create-telegram-bot.test-harness.js";
import { createTelegramBot } from "./bot.js";

const loadConfig = getLoadConfigMock();

function makeClientRoomConfig() {
  return {
    agents: {
      list: [
        { id: "main", identity: { name: "Main" } },
        { id: "power", identity: { name: "Power" } },
      ],
    },
    channels: {
      telegram: {
        groupPolicy: "open",
        groups: {
          "*": { requireMention: true },
        },
        clients: {
          "-10077": {
            label: "Client Room",
            defaultAgentId: "main",
            orchestration: {
              enabled: true,
              peerAgents: ["power"],
              peerReplyPolicy: "mention",
              historyLimit: 8,
            },
          },
        },
      },
    },
  };
}

const previousStateDir = process.env.OPENCLAW_STATE_DIR;

describe("createTelegramBot room orchestration", () => {
  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("lets the lead agent reply in an orchestrated client room without an explicit mention", async () => {
    process.env.OPENCLAW_STATE_DIR = path.join(os.tmpdir(), `openclaw-tg-room-${Date.now()}`);
    onSpy.mockReset();
    replySpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockResolvedValue({ text: "lead response" });
    loadConfig.mockReturnValue(makeClientRoomConfig());

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message");

    await handler(
      makeTelegramMessageCtx({
        chat: { id: -10077, type: "supergroup", title: "Client Room" },
        from: { id: 9, username: "ada" },
        text: "please continue the build",
        messageId: 1,
      }),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0]?.[0];
    expect(payload.SessionKey).toBe("agent:main:telegram:group:-10077");
    expect(payload.WasMentioned).toBe(true);
    expect(payload.UntrustedContext).toBeUndefined();
    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-10077",
      "[Main] lead response",
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("routes peer mentions to the peer only and includes shared room context", async () => {
    process.env.OPENCLAW_STATE_DIR = path.join(os.tmpdir(), `openclaw-tg-room-${Date.now()}`);
    onSpy.mockReset();
    replySpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockImplementation(async (ctx) => ({
      text: String((ctx as { SessionKey?: string }).SessionKey).includes("agent:power:")
        ? "peer response"
        : "lead response",
    }));
    loadConfig.mockReturnValue(makeClientRoomConfig());

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message");

    await handler(
      makeTelegramMessageCtx({
        chat: { id: -10077, type: "supergroup", title: "Client Room" },
        from: { id: 9, username: "ada" },
        text: "kickoff project",
        messageId: 1,
      }),
    );
    await handler(
      makeTelegramMessageCtx({
        chat: { id: -10077, type: "supergroup", title: "Client Room" },
        from: { id: 9, username: "ada" },
        text: "@power review the kickoff",
        messageId: 2,
      }),
    );

    expect(replySpy).toHaveBeenCalledTimes(2);
    const firstPayload = replySpy.mock.calls[0]?.[0];
    const secondPayload = replySpy.mock.calls[1]?.[0];
    expect(firstPayload.SessionKey).toBe("agent:main:telegram:group:-10077");
    expect(secondPayload.SessionKey).toBe("agent:power:telegram:group:-10077");
    expect(secondPayload.UntrustedContext?.[0]).toContain("ada (@ada) id:9: kickoff project");
    expect(secondPayload.UntrustedContext?.[0]).toContain("Main: [Main] lead response");
    expect(sendMessageSpy).toHaveBeenLastCalledWith(
      "-10077",
      "[Power] peer response",
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("fans out Telegram broadcast peers with the same shared room snapshot", async () => {
    process.env.OPENCLAW_STATE_DIR = path.join(os.tmpdir(), `openclaw-tg-room-${Date.now()}`);
    onSpy.mockReset();
    replySpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockImplementation(async (ctx) => ({
      text: String((ctx as { SessionKey?: string }).SessionKey).includes("agent:power:")
        ? "power response"
        : "main response",
    }));
    loadConfig.mockReturnValue({
      agents: {
        list: [
          { id: "main", identity: { name: "Main" } },
          { id: "power", identity: { name: "Power" } },
        ],
      },
      broadcast: {
        strategy: "sequential",
        "-10088": ["main", "power"],
      },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "*": { requireMention: true },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message");

    await handler(
      makeTelegramMessageCtx({
        chat: { id: -10088, type: "supergroup", title: "Ops Room" },
        from: { id: 9, username: "ada" },
        text: "@openclaw_bot kickoff",
        messageId: 1,
      }),
    );
    await handler(
      makeTelegramMessageCtx({
        chat: { id: -10088, type: "supergroup", title: "Ops Room" },
        from: { id: 9, username: "ada" },
        text: "@openclaw_bot next step",
        messageId: 2,
      }),
    );

    expect(replySpy).toHaveBeenCalledTimes(4);
    const secondRoundMain = replySpy.mock.calls[2]?.[0];
    const secondRoundPower = replySpy.mock.calls[3]?.[0];
    expect(secondRoundMain.SessionKey).toBe("agent:main:telegram:group:-10088");
    expect(secondRoundPower.SessionKey).toBe("agent:power:telegram:group:-10088");
    expect(secondRoundMain.UntrustedContext).toEqual(secondRoundPower.UntrustedContext);
    expect(secondRoundMain.UntrustedContext?.[0]).toContain(
      "ada (@ada) id:9: @openclaw_bot kickoff",
    );
    expect(secondRoundMain.UntrustedContext?.[0]).toContain("Main: [Main] main response");
    expect(secondRoundMain.UntrustedContext?.[0]).toContain("Power: [Power] power response");
  });
});
