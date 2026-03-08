import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { telegramOutbound } from "./telegram.js";

describe("telegramOutbound.sendPayload", () => {
  it("sends text payload with buttons", async () => {
    const sendTelegram = vi.fn(async () => ({ messageId: "m1", chatId: "c1" }));

    const result = await telegramOutbound.sendPayload?.({
      cfg: {} as OpenClawConfig,
      to: "telegram:123",
      text: "ignored",
      payload: {
        text: "Hello",
        channelData: {
          telegram: {
            buttons: [[{ text: "Option", callback_data: "/option" }]],
          },
        },
      },
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      "telegram:123",
      "Hello",
      expect.objectContaining({
        buttons: [[{ text: "Option", callback_data: "/option" }]],
        textMode: "html",
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "m1", chatId: "c1" });
  });

  it("sends media payloads and attaches buttons only to first", async () => {
    const sendTelegram = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m1", chatId: "c1" })
      .mockResolvedValueOnce({ messageId: "m2", chatId: "c1" });

    const result = await telegramOutbound.sendPayload?.({
      cfg: {} as OpenClawConfig,
      to: "telegram:123",
      text: "ignored",
      payload: {
        text: "Caption",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        channelData: {
          telegram: {
            buttons: [[{ text: "Go", callback_data: "/go" }]],
          },
        },
      },
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(2);
    expect(sendTelegram).toHaveBeenNthCalledWith(
      1,
      "telegram:123",
      "Caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
        buttons: [[{ text: "Go", callback_data: "/go" }]],
      }),
    );
    const secondOpts = sendTelegram.mock.calls[1]?.[2] as { buttons?: unknown } | undefined;
    expect(sendTelegram).toHaveBeenNthCalledWith(
      2,
      "telegram:123",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/b.png",
      }),
    );
    expect(secondOpts?.buttons).toBeUndefined();
    expect(result).toEqual({ channel: "telegram", messageId: "m2", chatId: "c1" });
  });

  it("auto-converts a trailing simple Options line into Telegram buttons", async () => {
    const sendTelegram = vi.fn(async () => ({ messageId: "m1", chatId: "c1" }));

    await telegramOutbound.sendPayload?.({
      cfg: {} as OpenClawConfig,
      to: "telegram:123",
      text: "ignored",
      payload: {
        text: "Choose a mode.\nOptions: on, off.",
      },
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "telegram:123",
      "Choose a mode.",
      expect.objectContaining({
        buttons: [
          [
            { text: "on", callback_data: "xcm1:on" },
            { text: "off", callback_data: "xcm1:off" },
          ],
        ],
      }),
    );
  });

  it("does not overwrite explicit Telegram buttons with auto-generated ones", async () => {
    const sendTelegram = vi.fn(async () => ({ messageId: "m1", chatId: "c1" }));

    await telegramOutbound.sendPayload?.({
      cfg: {} as OpenClawConfig,
      to: "telegram:123",
      text: "ignored",
      payload: {
        text: "Choose a mode.\nOptions: on, off.",
        channelData: {
          telegram: {
            buttons: [[{ text: "Keep", callback_data: "keep" }]],
          },
        },
      },
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "telegram:123",
      "Choose a mode.\nOptions: on, off.",
      expect.objectContaining({
        buttons: [[{ text: "Keep", callback_data: "keep" }]],
      }),
    );
  });
});
