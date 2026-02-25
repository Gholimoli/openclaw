import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";
import { handleGatewayRequest } from "../server-methods.js";

function createContext() {
  const evolution = {
    status: vi.fn(async () => ({
      enabled: true,
      running: true,
      paused: false,
      objective: "reliability_quality" as const,
      scoutEveryMs: 3_600_000,
      synthEveryMs: 86_400_000,
      nextScoutAtMs: null,
      nextSynthAtMs: null,
      lastScoutAtMs: null,
      lastSynthAtMs: null,
      counts: { sources: 0, insights: 0, proposals: 0, pending: 0, autoMergeCandidates: 0 },
    })),
    listSources: vi.fn(async () => []),
    upsertSource: vi.fn(async (source: unknown) => source),
    listInsights: vi.fn(async () => []),
    listProposals: vi.fn(async () => []),
    actProposal: vi.fn(async () => ({ ok: true, message: "ok" })),
    runScoutNow: vi.fn(async () => ({ added: 0, skipped: 0 })),
    runSynthesizeNow: vi.fn(async () => ({ added: 0, executed: 0, failed: 0 })),
    executeProposal: vi.fn(async () => ({ ok: true, message: "ok" })),
    officeSnapshot: vi.fn(async () => ({
      agents: [],
      layout: { version: 1, tileSize: 16, width: 10, height: 10, placements: {} },
      activity: [],
    })),
    officeLayoutGet: vi.fn(async () => ({
      version: 1 as const,
      tileSize: 16,
      width: 10,
      height: 10,
      placements: {},
    })),
    officeLayoutSet: vi.fn(async (layout: unknown) => layout),
    onAgentEvent: vi.fn(async () => {}),
    onExecApprovalRequested: vi.fn(async () => {}),
    onExecApprovalResolved: vi.fn(async () => {}),
    onCronEvent: vi.fn(async () => {}),
  };

  return {
    evolution,
  } as unknown as GatewayRequestContext;
}

function buildReq(method: string, params: Record<string, unknown>) {
  return {
    type: "req" as const,
    id: "req-1",
    method,
    params,
  };
}

describe("gateway evolution methods", () => {
  it("allows operator.read to call evolution.status", async () => {
    const respond = vi.fn();
    const context = createContext();

    await handleGatewayRequest({
      req: buildReq("evolution.status", {}),
      respond,
      client: { connect: { role: "operator", scopes: ["operator.read"] } },
      isWebchatConnect: () => false,
      context,
    });

    expect(context.evolution?.status).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ enabled: true }),
      undefined,
    );
  });

  it("rejects invalid evolution.insights.list params", async () => {
    const respond = vi.fn();

    await handleGatewayRequest({
      req: buildReq("evolution.insights.list", { limit: 0 }),
      respond,
      client: { connect: { role: "operator", scopes: ["operator.read"] } },
      isWebchatConnect: () => false,
      context: createContext(),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
      }),
    );
  });

  it("requires admin for office.layout.set", async () => {
    const respond = vi.fn();

    await handleGatewayRequest({
      req: buildReq("office.layout.set", {
        layout: { version: 1, tileSize: 16, width: 10, height: 10, placements: {} },
      }),
      respond,
      client: { connect: { role: "operator", scopes: ["operator.read"] } },
      isWebchatConnect: () => false,
      context: createContext(),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "missing scope: operator.admin",
      }),
    );
  });
});
