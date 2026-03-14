import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createExecApprovalForwarder } from "./exec-approval-forwarder.js";

const baseRequest = {
  id: "req-1",
  request: {
    command: "echo hello",
    agentId: "main",
    sessionKey: "agent:main:main",
  },
  createdAtMs: 1000,
  expiresAtMs: 6000,
};

afterEach(() => {
  vi.useRealTimers();
});

function getFirstDeliveryText(deliver: ReturnType<typeof vi.fn>): string {
  const firstCall = deliver.mock.calls[0]?.[0] as
    | { payloads?: Array<{ text?: string }> }
    | undefined;
  return firstCall?.payloads?.[0]?.text ?? "";
}

function getFirstDeliveryPayload(deliver: ReturnType<typeof vi.fn>) {
  const firstCall = deliver.mock.calls[0]?.[0] as
    | {
        payloads?: Array<{
          text?: string;
          channelData?: Record<string, unknown>;
        }>;
      }
    | undefined;
  return firstCall?.payloads?.[0];
}

function getFirstTelegramSendText(sendTelegramMessage: ReturnType<typeof vi.fn>): string {
  return (sendTelegramMessage.mock.calls[0]?.[1] as string | undefined) ?? "";
}

function getFirstTelegramSendOpts(sendTelegramMessage: ReturnType<typeof vi.fn>) {
  return sendTelegramMessage.mock.calls[0]?.[2] as
    | {
        buttons?: Array<Array<{ text: string }>>;
      }
    | undefined;
}

describe("exec approval forwarder", () => {
  it("defaults to telegram session forwarding when approvals config is unset", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const sendTelegramMessage = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "123" });
    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-token",
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      sendTelegramMessage,
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "telegram", to: "123" }),
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    const labels =
      getFirstTelegramSendOpts(sendTelegramMessage)
        ?.buttons?.flat()
        .map((button) => button.text) ?? [];
    expect(labels).toContain("Approve");
    expect(labels).toContain("Deny");
    expect(labels).toContain("Always allow");
  });

  it("does not auto-forward non-telegram sessions when approvals config is unset", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const sendTelegramMessage = vi.fn();
    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-token",
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      sendTelegramMessage,
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("respects explicit exec approval forwarding disable", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const sendTelegramMessage = vi.fn();
    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-token",
        },
      },
      approvals: {
        exec: {
          enabled: false,
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      sendTelegramMessage,
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "telegram", to: "123" }),
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("forwards to session target and resolves", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const cfg = {
      approvals: { exec: { enabled: true, mode: "session" } },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).toHaveBeenCalledTimes(1);

    await forwarder.handleResolved({
      id: baseRequest.id,
      decision: "allow-once",
      resolvedBy: "slack:U1",
      ts: 2000,
    });
    expect(deliver).toHaveBeenCalledTimes(2);

    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("forwards to explicit targets and expires", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const sendTelegramMessage = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m1", chatId: "123" })
      .mockResolvedValueOnce({ messageId: "m2", chatId: "123" });
    const editTelegramMessage = vi
      .fn()
      .mockResolvedValue({ ok: true, messageId: "m1", chatId: "123" });
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      sendTelegramMessage,
      editTelegramMessage,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested(baseRequest);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(2);
    expect(editTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("formats single-line commands as inline code", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const sendTelegramMessage = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "123" });
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      sendTelegramMessage,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested(baseRequest);

    expect(getFirstTelegramSendText(sendTelegramMessage)).toContain("Command: `echo hello`");
  });

  it("attaches approval buttons for telegram direct messages", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const sendTelegramMessage = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "123" });
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      sendTelegramMessage,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested(baseRequest);
    expect(getFirstTelegramSendOpts(sendTelegramMessage)?.buttons).toBeDefined();
    expect(getFirstTelegramSendText(sendTelegramMessage)).toContain(
      "Use the buttons below to approve or deny.",
    );
    expect(getFirstTelegramSendText(sendTelegramMessage)).toContain(
      "Fallback: /approve <id> allow-once|allow-always|deny",
    );
  });

  it("attaches approval buttons for telegram groups", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const sendTelegramMessage = vi
      .fn()
      .mockResolvedValue({ messageId: "m1", chatId: "-1001234567890" });
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "-1001234567890" }],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      sendTelegramMessage,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested(baseRequest);
    expect(getFirstTelegramSendOpts(sendTelegramMessage)?.buttons).toBeDefined();
  });

  it("falls back to text-only when approval id cannot fit telegram callback_data", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const sendTelegramMessage = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "123" });
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      sendTelegramMessage,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested({
      ...baseRequest,
      id: "x".repeat(120),
    });
    expect(getFirstTelegramSendOpts(sendTelegramMessage)?.buttons).toBeUndefined();
    expect(getFirstTelegramSendText(sendTelegramMessage)).toContain(
      "Reply with: /approve <id> allow-once|allow-always|deny",
    );
  });

  it("mirrors telegram approvals to the session chat and explicit dm target when mode is both", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const sendTelegramMessage = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m1", chatId: "-1001234567890" })
      .mockResolvedValueOnce({ messageId: "m2", chatId: "123" });
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "both",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      sendTelegramMessage,
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "telegram", to: "-1001234567890", threadId: "77" }),
    });

    await forwarder.handleRequested(baseRequest);

    expect(sendTelegramMessage).toHaveBeenCalledTimes(2);
    expect(sendTelegramMessage.mock.calls.map((call) => call[0])).toEqual([
      "-1001234567890",
      "123",
    ]);
    expect(
      sendTelegramMessage.mock.calls.every(
        (call) => Array.isArray(call[2]?.buttons) && call[2].buttons.length > 0,
      ),
    ).toBe(true);
  });

  it("formats complex commands as fenced code blocks", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const sendTelegramMessage = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "123" });
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      sendTelegramMessage,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested({
      ...baseRequest,
      request: {
        ...baseRequest.request,
        command: "echo `uname`\necho done",
      },
    });

    expect(getFirstTelegramSendText(sendTelegramMessage)).toContain(
      "Command:\n```\necho `uname`\necho done\n```",
    );
  });

  it("keeps manual approval copy for non-telegram targets", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "U123" }],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested(baseRequest);

    expect(getFirstDeliveryText(deliver)).toContain(
      "Reply with: /approve <id> allow-once|allow-always|deny",
    );
    expect(getFirstDeliveryText(deliver)).not.toContain(
      "Use the buttons below to approve or deny.",
    );
  });

  it("uses a longer fence when command already contains triple backticks", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
    const sendTelegramMessage = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "123" });
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      sendTelegramMessage,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested({
      ...baseRequest,
      request: {
        ...baseRequest.request,
        command: "echo ```danger```",
      },
    });

    expect(getFirstTelegramSendText(sendTelegramMessage)).toContain(
      "Command:\n````\necho ```danger```\n````",
    );
  });

  it("clears telegram buttons when a direct-message approval resolves elsewhere", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([{ channel: "telegram", messageId: "42" }]);
    const sendTelegramMessage = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "42", chatId: "123" })
      .mockResolvedValueOnce({ messageId: "44", chatId: "123" });
    const editTelegramMessage = vi
      .fn()
      .mockResolvedValue({ ok: true, messageId: "42", chatId: "123" });
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      sendTelegramMessage,
      editTelegramMessage,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested(baseRequest);
    await forwarder.handleResolved({
      id: baseRequest.id,
      decision: "deny",
      resolvedBy: "operator",
      ts: 2000,
    });

    expect(editTelegramMessage).toHaveBeenCalledTimes(1);
    expect(editTelegramMessage).toHaveBeenCalledWith(
      "123",
      "42",
      expect.stringContaining("Exec approval required"),
      expect.objectContaining({ buttons: [] }),
    );
  });

  it("clears telegram buttons when a direct-message approval expires", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([{ channel: "telegram", messageId: "43" }]);
    const sendTelegramMessage = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "43", chatId: "123" })
      .mockResolvedValueOnce({ messageId: "45", chatId: "123" });
    const editTelegramMessage = vi
      .fn()
      .mockResolvedValue({ ok: true, messageId: "43", chatId: "123" });
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "123" }],
        },
      },
    } as OpenClawConfig;

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      sendTelegramMessage,
      editTelegramMessage,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested(baseRequest);
    await vi.runAllTimersAsync();

    expect(editTelegramMessage).toHaveBeenCalledTimes(1);
    expect(editTelegramMessage).toHaveBeenCalledWith(
      "123",
      "43",
      expect.stringContaining("Exec approval required"),
      expect.objectContaining({ buttons: [] }),
    );
  });
});
