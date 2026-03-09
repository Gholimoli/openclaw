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

describe("exec approval forwarder", () => {
  it("defaults to telegram session forwarding when approvals config is unset", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
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
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "telegram", to: "123" }),
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).toHaveBeenCalledTimes(1);
    const payload = getFirstDeliveryPayload(deliver) as
      | { channelData?: { telegram?: { buttons?: Array<Array<{ text: string }>> } } }
      | undefined;
    const labels =
      payload?.channelData?.telegram?.buttons?.flat().map((button) => button.text) ?? [];
    expect(labels).toContain("Approve");
    expect(labels).toContain("Deny");
    expect(labels).toContain("Always allow");
  });

  it("does not auto-forward non-telegram sessions when approvals config is unset", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
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
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "slack", to: "U1" }),
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("respects explicit exec approval forwarding disable", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
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
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "telegram", to: "123" }),
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).not.toHaveBeenCalled();
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
      editTelegramMessage,
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested(baseRequest);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(editTelegramMessage).not.toHaveBeenCalled();
  });

  it("formats single-line commands as inline code", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
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
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested(baseRequest);

    expect(getFirstDeliveryText(deliver)).toContain("Command: `echo hello`");
  });

  it("attaches approval buttons for telegram direct messages", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
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
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested(baseRequest);
    const payload = getFirstDeliveryPayload(deliver) as
      | { channelData?: { telegram?: { buttons?: unknown[] } } }
      | undefined;
    expect(payload?.channelData?.telegram?.buttons).toBeDefined();
  });

  it("attaches approval buttons for telegram groups", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
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
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested(baseRequest);
    const payload = getFirstDeliveryPayload(deliver) as
      | { channelData?: { telegram?: { buttons?: unknown[] } } }
      | undefined;
    expect(payload?.channelData?.telegram?.buttons).toBeDefined();
  });

  it("falls back to text-only when approval id cannot fit telegram callback_data", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
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
      nowMs: () => 1000,
      resolveSessionTarget: () => null,
    });

    await forwarder.handleRequested({
      ...baseRequest,
      id: "x".repeat(120),
    });
    const payload = getFirstDeliveryPayload(deliver) as
      | { channelData?: { telegram?: { buttons?: unknown[] } } }
      | undefined;
    expect(payload?.channelData?.telegram?.buttons).toBeUndefined();
  });

  it("mirrors telegram approvals to the session chat and explicit dm target when mode is both", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
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
      nowMs: () => 1000,
      resolveSessionTarget: () => ({ channel: "telegram", to: "-1001234567890", threadId: "77" }),
    });

    await forwarder.handleRequested(baseRequest);

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.map((call) => call[0]?.to)).toEqual(["-1001234567890", "123"]);
    const payloads = deliver.mock.calls.map(
      (call) =>
        (call[0] as { payloads?: Array<{ channelData?: { telegram?: { buttons?: unknown[] } } }> })
          .payloads?.[0],
    );
    expect(payloads.every((payload) => payload?.channelData?.telegram?.buttons)).toBe(true);
  });

  it("formats complex commands as fenced code blocks", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
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

    expect(getFirstDeliveryText(deliver)).toContain("Command:\n```\necho `uname`\necho done\n```");
  });

  it("uses a longer fence when command already contains triple backticks", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([]);
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

    expect(getFirstDeliveryText(deliver)).toContain("Command:\n````\necho ```danger```\n````");
  });

  it("clears telegram buttons when a direct-message approval resolves elsewhere", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue([{ channel: "telegram", messageId: "42" }]);
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
