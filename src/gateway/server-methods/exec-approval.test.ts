import { describe, expect, it, vi } from "vitest";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { validateExecApprovalRequestParams } from "../protocol/index.js";
import { createExecApprovalHandlers } from "./exec-approval.js";

const noop = () => {};

describe("exec approval handlers", () => {
  describe("ExecApprovalRequestParams validation", () => {
    it("accepts request with resolvedPath omitted", () => {
      const params = {
        command: "echo hi",
        cwd: "/tmp",
        host: "node",
      };
      expect(validateExecApprovalRequestParams(params)).toBe(true);
    });

    it("accepts request with resolvedPath as string", () => {
      const params = {
        command: "echo hi",
        cwd: "/tmp",
        host: "node",
        resolvedPath: "/usr/bin/echo",
      };
      expect(validateExecApprovalRequestParams(params)).toBe(true);
    });

    it("accepts request with resolvedPath as undefined", () => {
      const params = {
        command: "echo hi",
        cwd: "/tmp",
        host: "node",
        resolvedPath: undefined,
      };
      expect(validateExecApprovalRequestParams(params)).toBe(true);
    });

    // Fixed: null is now accepted (Type.Union([Type.String(), Type.Null()]))
    // This matches the calling code in bash-tools.exec.ts which passes null.
    it("accepts request with resolvedPath as null", () => {
      const params = {
        command: "echo hi",
        cwd: "/tmp",
        host: "node",
        resolvedPath: null,
      };
      expect(validateExecApprovalRequestParams(params)).toBe(true);
    });
  });

  it("broadcasts request + resolve", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const broadcasts: Array<{ event: string; payload: unknown }> = [];

    const respond = vi.fn();
    const context = {
      broadcast: (event: string, payload: unknown) => {
        broadcasts.push({ event, payload });
      },
    };

    const requestPromise = handlers["exec.approval.request"]({
      params: {
        command: "echo ok",
        cwd: "/tmp",
        host: "node",
        timeoutMs: 2000,
        twoPhase: true,
      },
      respond,
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.request"]
      >[0]["context"],
      client: null,
      req: { id: "req-1", type: "req", method: "exec.approval.request" },
      isWebchatConnect: noop,
    });

    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    expect(requested).toBeTruthy();
    const id = (requested?.payload as { id?: string })?.id ?? "";
    expect(id).not.toBe("");

    // First response should be "accepted" (registration confirmation)
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "accepted", id }),
      undefined,
    );

    const resolveRespond = vi.fn();
    await handlers["exec.approval.resolve"]({
      params: { id, decision: "allow-once" },
      respond: resolveRespond,
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.resolve"]
      >[0]["context"],
      client: { connect: { client: { id: "cli", displayName: "CLI" } } },
      req: { id: "req-2", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: noop,
    });

    await requestPromise;

    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    // Second response should contain the decision
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id, decision: "allow-once" }),
      undefined,
    );
    expect(broadcasts.some((entry) => entry.event === "exec.approval.resolved")).toBe(true);
  });

  it("accepts resolve during broadcast", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const respond = vi.fn();
    const resolveRespond = vi.fn();

    const resolveContext = {
      broadcast: () => {},
    };

    const context = {
      broadcast: (event: string, payload: unknown) => {
        if (event !== "exec.approval.requested") {
          return;
        }
        const id = (payload as { id?: string })?.id ?? "";
        void handlers["exec.approval.resolve"]({
          params: { id, decision: "allow-once" },
          respond: resolveRespond,
          context: resolveContext as unknown as Parameters<
            (typeof handlers)["exec.approval.resolve"]
          >[0]["context"],
          client: { connect: { client: { id: "cli", displayName: "CLI" } } },
          req: { id: "req-2", type: "req", method: "exec.approval.resolve" },
          isWebchatConnect: noop,
        });
      },
    };

    await handlers["exec.approval.request"]({
      params: {
        command: "echo ok",
        cwd: "/tmp",
        host: "node",
        timeoutMs: 2000,
      },
      respond,
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.request"]
      >[0]["context"],
      client: null,
      req: { id: "req-1", type: "req", method: "exec.approval.request" },
      isWebchatConnect: noop,
    });

    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ decision: "allow-once" }),
      undefined,
    );
  });

  it("accepts explicit approval ids", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const broadcasts: Array<{ event: string; payload: unknown }> = [];

    const respond = vi.fn();
    const context = {
      broadcast: (event: string, payload: unknown) => {
        broadcasts.push({ event, payload });
      },
    };

    const requestPromise = handlers["exec.approval.request"]({
      params: {
        id: "approval-123",
        command: "echo ok",
        cwd: "/tmp",
        host: "gateway",
        timeoutMs: 2000,
      },
      respond,
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.request"]
      >[0]["context"],
      client: null,
      req: { id: "req-1", type: "req", method: "exec.approval.request" },
      isWebchatConnect: noop,
    });

    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    const id = (requested?.payload as { id?: string })?.id ?? "";
    expect(id).toBe("approval-123");

    const resolveRespond = vi.fn();
    await handlers["exec.approval.resolve"]({
      params: { id, decision: "allow-once" },
      respond: resolveRespond,
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.resolve"]
      >[0]["context"],
      client: { connect: { client: { id: "cli", displayName: "CLI" } } },
      req: { id: "req-2", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: noop,
    });

    await requestPromise;
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "approval-123", decision: "allow-once" }),
      undefined,
    );
  });

  it("rejects duplicate approval ids", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const respondA = vi.fn();
    const respondB = vi.fn();
    const broadcasts: Array<{ event: string; payload: unknown }> = [];
    const context = {
      broadcast: (event: string, payload: unknown) => {
        broadcasts.push({ event, payload });
      },
    };

    const requestPromise = handlers["exec.approval.request"]({
      params: {
        id: "dup-1",
        command: "echo ok",
      },
      respond: respondA,
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.request"]
      >[0]["context"],
      client: null,
      req: { id: "req-1", type: "req", method: "exec.approval.request" },
      isWebchatConnect: noop,
    });

    await handlers["exec.approval.request"]({
      params: {
        id: "dup-1",
        command: "echo again",
      },
      respond: respondB,
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.request"]
      >[0]["context"],
      client: null,
      req: { id: "req-2", type: "req", method: "exec.approval.request" },
      isWebchatConnect: noop,
    });

    expect(respondB).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "approval id already pending" }),
    );

    const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
    const id = (requested?.payload as { id?: string })?.id ?? "";
    const resolveRespond = vi.fn();
    await handlers["exec.approval.resolve"]({
      params: { id, decision: "deny" },
      respond: resolveRespond,
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.resolve"]
      >[0]["context"],
      client: { connect: { client: { id: "cli", displayName: "CLI" } } },
      req: { id: "req-3", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: noop,
    });

    await requestPromise;
  });

  it("lists pending approvals scoped by session", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const context = {
      broadcast: () => {},
    };

    const requestARespond = vi.fn();
    const requestBRespond = vi.fn();
    const requestA = handlers["exec.approval.request"]({
      params: {
        id: "s1",
        command: "echo one",
        sessionKey: "agent:main:session-1",
        timeoutMs: 60_000,
      },
      respond: requestARespond,
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.request"]
      >[0]["context"],
      client: null,
      req: { id: "req-1", type: "req", method: "exec.approval.request" },
      isWebchatConnect: noop,
    });
    const requestB = handlers["exec.approval.request"]({
      params: {
        id: "s2",
        command: "echo two",
        sessionKey: "agent:main:session-2",
        timeoutMs: 60_000,
      },
      respond: requestBRespond,
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.request"]
      >[0]["context"],
      client: null,
      req: { id: "req-2", type: "req", method: "exec.approval.request" },
      isWebchatConnect: noop,
    });

    const listRespond = vi.fn();
    await handlers["exec.approval.list"]({
      params: { sessionKey: "agent:main:session-1", limit: 10 },
      respond: listRespond,
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.list"]
      >[0]["context"],
      client: null,
      req: { id: "req-3", type: "req", method: "exec.approval.list" },
      isWebchatConnect: noop,
    });

    expect(listRespond).toHaveBeenCalledWith(
      true,
      {
        items: [
          {
            id: "s1",
            createdAtMs: expect.any(Number),
            expiresAtMs: expect.any(Number),
            request: {
              command: "echo one",
              cwd: null,
              host: null,
              agentId: null,
              sessionKey: "agent:main:session-1",
            },
          },
        ],
      },
      undefined,
    );

    // Resolve to avoid leaving timers running until timeout.
    await handlers["exec.approval.resolve"]({
      params: { id: "s1", decision: "deny" },
      respond: vi.fn(),
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.resolve"]
      >[0]["context"],
      client: { connect: { client: { id: "cli", displayName: "CLI" } } },
      req: { id: "req-4", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: noop,
    });
    await handlers["exec.approval.resolve"]({
      params: { id: "s2", decision: "deny" },
      respond: vi.fn(),
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.resolve"]
      >[0]["context"],
      client: { connect: { client: { id: "cli", displayName: "CLI" } } },
      req: { id: "req-5", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: noop,
    });

    await requestA;
    await requestB;
  });

  it("enforces list limit and excludes resolved approvals", async () => {
    const manager = new ExecApprovalManager();
    const handlers = createExecApprovalHandlers(manager);
    const context = {
      broadcast: () => {},
    };

    const requestARespond = vi.fn();
    const requestBRespond = vi.fn();
    const requestA = handlers["exec.approval.request"]({
      params: {
        id: "l1",
        command: "echo one",
        timeoutMs: 60_000,
      },
      respond: requestARespond,
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.request"]
      >[0]["context"],
      client: null,
      req: { id: "req-10", type: "req", method: "exec.approval.request" },
      isWebchatConnect: noop,
    });
    const requestB = handlers["exec.approval.request"]({
      params: {
        id: "l2",
        command: "echo two",
        timeoutMs: 60_000,
      },
      respond: requestBRespond,
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.request"]
      >[0]["context"],
      client: null,
      req: { id: "req-11", type: "req", method: "exec.approval.request" },
      isWebchatConnect: noop,
    });

    await handlers["exec.approval.resolve"]({
      params: { id: "l1", decision: "deny" },
      respond: vi.fn(),
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.resolve"]
      >[0]["context"],
      client: { connect: { client: { id: "cli", displayName: "CLI" } } },
      req: { id: "req-12", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: noop,
    });
    await requestA;

    const listRespond = vi.fn();
    await handlers["exec.approval.list"]({
      params: { limit: 1 },
      respond: listRespond,
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.list"]
      >[0]["context"],
      client: null,
      req: { id: "req-13", type: "req", method: "exec.approval.list" },
      isWebchatConnect: noop,
    });

    const payload = listRespond.mock.calls[0]?.[1] as { items?: Array<{ id: string }> } | undefined;
    expect(payload?.items).toHaveLength(1);
    expect(payload?.items?.[0]?.id).toBe("l2");

    await handlers["exec.approval.resolve"]({
      params: { id: "l2", decision: "deny" },
      respond: vi.fn(),
      context: context as unknown as Parameters<
        (typeof handlers)["exec.approval.resolve"]
      >[0]["context"],
      client: { connect: { client: { id: "cli", displayName: "CLI" } } },
      req: { id: "req-14", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: noop,
    });
    await requestB;
  });
});
