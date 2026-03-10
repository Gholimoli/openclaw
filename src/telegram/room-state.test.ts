import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTelegramRoomStateEntry,
  appendTelegramRoomStateVisibleReply,
  buildTelegramRoomStateContext,
  readTelegramRoomStateEntries,
} from "./room-state.js";

describe("telegram room state", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("trims room state entries to the configured history limit", async () => {
    process.env.OPENCLAW_STATE_DIR = path.join(os.tmpdir(), `openclaw-room-state-${Date.now()}`);
    await appendTelegramRoomStateEntry({
      accountId: "default",
      peerId: "room-1",
      historyLimit: 2,
      entry: {
        kind: "human",
        actorLabel: "Ada",
        body: "first",
        timestamp: 1,
      },
    });
    await appendTelegramRoomStateEntry({
      accountId: "default",
      peerId: "room-1",
      historyLimit: 2,
      entry: {
        kind: "agent",
        actorLabel: "Lead",
        body: "second",
        timestamp: 2,
      },
    });
    await appendTelegramRoomStateEntry({
      accountId: "default",
      peerId: "room-1",
      historyLimit: 2,
      entry: {
        kind: "human",
        actorLabel: "Ada",
        body: "third",
        timestamp: 3,
      },
    });

    expect(
      await readTelegramRoomStateEntries({
        accountId: "default",
        peerId: "room-1",
      }),
    ).toEqual([
      {
        kind: "agent",
        actorLabel: "Lead",
        body: "second",
        timestamp: 2,
      },
      {
        kind: "human",
        actorLabel: "Ada",
        body: "third",
        timestamp: 3,
      },
    ]);
  });

  it("builds untrusted room context from visible human and agent messages", async () => {
    process.env.OPENCLAW_STATE_DIR = path.join(os.tmpdir(), `openclaw-room-state-${Date.now()}`);
    await appendTelegramRoomStateEntry({
      accountId: "default",
      peerId: "room-2",
      historyLimit: 4,
      entry: {
        kind: "human",
        actorLabel: "Client",
        body: "Need a deploy pipeline",
        timestamp: 1,
        messageId: "m1",
      },
    });
    await appendTelegramRoomStateVisibleReply({
      accountId: "default",
      peerId: "room-2",
      historyLimit: 4,
      actorLabel: "Coder",
      agentId: "coder",
      text: "[Coder] I will set it up.",
    });

    const context = buildTelegramRoomStateContext({
      entries: await readTelegramRoomStateEntries({
        accountId: "default",
        peerId: "room-2",
      }),
      excludeMessageId: "m1",
    });
    expect(context).toContain("Shared room log");
    expect(context).toContain("Coder: [Coder] I will set it up.");
    expect(context).not.toContain("Client: Need a deploy pipeline");
  });
});
