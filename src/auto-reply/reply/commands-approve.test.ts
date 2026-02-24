import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { handleCommands } from "./commands.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

describe("/approve command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists pending approvals when called without args", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const mockCallGateway = vi.mocked(callGateway);
    mockCallGateway.mockResolvedValueOnce({
      items: [
        {
          id: "abc",
          createdAtMs: 1700000000000,
          expiresAtMs: Date.now() + 60_000,
          request: {
            command: "openclaw gateway status",
            sessionKey: "agent:main:main",
          },
        },
      ],
    });

    const params = buildCommandTestParams("/approve", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Pending exec approvals for this session");
    expect(result.reply?.text).toContain("/approve abc allow-once");
    expect(result.reply?.text).toContain("/approve abc allow-always");
    expect(result.reply?.text).toContain("/approve abc deny");
    expect(mockCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.list",
        params: { limit: 5, sessionKey: "agent:main:main" },
      }),
    );
  });

  it("shows empty-state help when no pending approvals are found", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const mockCallGateway = vi.mocked(callGateway);
    mockCallGateway.mockResolvedValueOnce({ items: [] });

    const params = buildCommandTestParams("/approve", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("No pending exec approvals for this session");
    expect(result.reply?.text).toContain("Usage: /approve");
  });

  it("rejects invalid usage", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/approve abc", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Usage: /approve");
  });

  it("submits approval", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/approve abc allow-once", cfg, { SenderId: "123" });

    const mockCallGateway = vi.mocked(callGateway);
    mockCallGateway.mockResolvedValueOnce({ ok: true });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Exec approval allow-once submitted");
    expect(mockCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "abc", decision: "allow-once" },
      }),
    );
  });

  it("rejects gateway clients without approvals scope", async () => {
    const cfg = {
      commands: { text: true },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/approve abc allow-once", cfg, {
      Provider: "webchat",
      Surface: "webchat",
      GatewayClientScopes: ["operator.write"],
    });

    const mockCallGateway = vi.mocked(callGateway);
    mockCallGateway.mockResolvedValueOnce({ ok: true });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("requires operator.approvals");
    expect(mockCallGateway).not.toHaveBeenCalled();
  });

  it("allows gateway clients with approvals scope", async () => {
    const cfg = {
      commands: { text: true },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/approve abc allow-once", cfg, {
      Provider: "webchat",
      Surface: "webchat",
      GatewayClientScopes: ["operator.approvals"],
    });

    const mockCallGateway = vi.mocked(callGateway);
    mockCallGateway.mockResolvedValueOnce({ ok: true });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Exec approval allow-once submitted");
    expect(mockCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "abc", decision: "allow-once" },
      }),
    );
  });

  it("allows gateway clients with admin scope", async () => {
    const cfg = {
      commands: { text: true },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/approve abc allow-once", cfg, {
      Provider: "webchat",
      Surface: "webchat",
      GatewayClientScopes: ["operator.admin"],
    });

    const mockCallGateway = vi.mocked(callGateway);
    mockCallGateway.mockResolvedValueOnce({ ok: true });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Exec approval allow-once submitted");
    expect(mockCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "abc", decision: "allow-once" },
      }),
    );
  });
});
