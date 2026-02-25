import { describe, expect, it } from "vitest";
import { createOfficeStateManager } from "./office-state.js";

const BASE_LAYOUT = {
  version: 1 as const,
  tileSize: 16,
  width: 32,
  height: 20,
  placements: {},
};

describe("office state projector", () => {
  it("maps lifecycle/tool agent events to visual states", () => {
    const state = createOfficeStateManager({ initialLayout: BASE_LAYOUT });
    const lifecycle = state.applyAgentEvent({
      stream: "lifecycle",
      sessionKey: "agent:main:main",
      data: { phase: "start" },
    });
    expect(lifecycle.some((entry) => entry.kind === "agent.delta")).toBe(true);
    const afterLifecycle = state.snapshot().agents[0];
    expect(afterLifecycle?.state).toBe("walking");

    state.applyAgentEvent({
      stream: "tool",
      sessionKey: "agent:main:main",
      data: { phase: "start" },
    });
    const afterTool = state.snapshot().agents[0];
    expect(afterTool?.state).toBe("running-command");
  });

  it("projects approval requested/resolved into blocked and idle states", () => {
    const state = createOfficeStateManager({ initialLayout: BASE_LAYOUT });
    const requested = state.applyExecApprovalRequested({
      request: { agentId: "main", command: "pnpm test" },
    });
    expect(requested.some((entry) => entry.kind === "alert.pin")).toBe(true);
    expect(state.snapshot().agents[0]?.state).toBe("approval-blocked");

    state.applyExecApprovalResolved({ decision: "allow-once" });
    expect(state.snapshot().agents[0]?.state).toBe("idle");
  });
});
