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

  it("maps chat final to waiting-input and chat error to failed", () => {
    const state = createOfficeStateManager({ initialLayout: BASE_LAYOUT });

    state.applyChatEvent({
      sessionKey: "agent:main:main",
      runId: "run-1",
      state: "final",
    });
    expect(state.snapshot().agents[0]?.state).toBe("waiting-input");

    state.applyChatEvent({
      sessionKey: "agent:main:main",
      runId: "run-2",
      state: "error",
      errorMessage: "boom",
    });
    expect(state.snapshot().agents[0]?.state).toBe("failed");
  });

  it("does not append office activity for transient assistant/chat deltas", () => {
    const state = createOfficeStateManager({ initialLayout: BASE_LAYOUT });

    const assistantEvents = state.applyAgentEvent({
      stream: "assistant",
      sessionKey: "agent:main:main",
      data: { text: "partial" },
    });
    expect(assistantEvents).toHaveLength(1);
    expect(assistantEvents[0]?.kind).toBe("agent.delta");

    const assistantRepeat = state.applyAgentEvent({
      stream: "assistant",
      sessionKey: "agent:main:main",
      data: { text: "partial-2" },
    });
    expect(assistantRepeat).toHaveLength(0);

    const chatEvents = state.applyChatEvent({
      sessionKey: "agent:main:main",
      runId: "run-3",
      state: "delta",
    });
    expect(chatEvents).toHaveLength(1);
    expect(chatEvents[0]?.kind).toBe("agent.delta");

    const chatRepeat = state.applyChatEvent({
      sessionKey: "agent:main:main",
      runId: "run-3",
      state: "delta",
    });
    expect(chatRepeat).toHaveLength(0);
    expect(state.snapshot().activity).toHaveLength(0);
  });
});
