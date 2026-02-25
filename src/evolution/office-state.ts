import crypto from "node:crypto";
import type {
  OfficeActivityEntry,
  OfficeAgentState,
  OfficeEventPayload,
  OfficeLayout,
  OfficeVisualState,
} from "./types.js";

function inferVisualStateFromAgentEvent(payload: Record<string, unknown>): OfficeVisualState {
  const stream = typeof payload.stream === "string" ? payload.stream : "";
  const data =
    payload.data && typeof payload.data === "object"
      ? (payload.data as Record<string, unknown>)
      : {};
  const phase = typeof data.phase === "string" ? data.phase : "";

  if (stream === "lifecycle") {
    if (phase === "start") {
      return "walking";
    }
    if (phase === "error") {
      return "failed";
    }
    return "idle";
  }
  if (stream === "tool") {
    if (phase === "start" || phase === "update") {
      return "running-command";
    }
    if (phase === "result") {
      const isError = data.isError === true;
      return isError ? "failed" : "typing";
    }
  }
  if (stream === "assistant") {
    return "typing";
  }
  return "reading";
}

function shouldRecordAgentActivity(stream: string, phase: string): boolean {
  if (stream === "assistant") {
    return false;
  }
  if (stream === "tool" && phase === "update") {
    return false;
  }
  return true;
}

function shouldRecordChatActivity(chatState: string): boolean {
  return chatState !== "delta";
}

export type OfficeStateManager = {
  snapshot: () => {
    agents: OfficeAgentState[];
    layout: OfficeLayout;
    activity: OfficeActivityEntry[];
  };
  setLayout: (layout: OfficeLayout) => OfficeEventPayload;
  applyAgentEvent: (payload: Record<string, unknown>) => OfficeEventPayload[];
  applyChatEvent: (payload: Record<string, unknown>) => OfficeEventPayload[];
  applyExecApprovalRequested: (payload: Record<string, unknown>) => OfficeEventPayload[];
  applyExecApprovalResolved: (payload: Record<string, unknown>) => OfficeEventPayload[];
  applyCronEvent: (payload: Record<string, unknown>) => OfficeEventPayload[];
  appendActivity: (entry: Omit<OfficeActivityEntry, "id" | "ts">) => OfficeEventPayload;
};

export function createOfficeStateManager(params: {
  initialLayout: OfficeLayout;
  initialActivity?: OfficeActivityEntry[];
}): OfficeStateManager {
  const agents = new Map<string, OfficeAgentState>();
  let layout = params.initialLayout;
  const activity = [...(params.initialActivity ?? [])].slice(-500);

  const resolvePlacement = (agentId: string) => {
    const existing = layout.placements[agentId];
    if (existing) {
      return existing;
    }
    const index = agents.size;
    return {
      x: 2 + ((index * 7) % Math.max(8, layout.width - 4)),
      y: 2 + (Math.floor(index / 8) % Math.max(4, layout.height - 4)),
    };
  };

  const hasMeaningfulAgentChange = (
    previous: OfficeAgentState | undefined,
    next: OfficeAgentState,
  ) => {
    if (!previous) {
      return true;
    }
    return (
      previous.label !== next.label ||
      previous.state !== next.state ||
      previous.runId !== next.runId ||
      previous.details !== next.details ||
      previous.blocked !== next.blocked ||
      previous.failed !== next.failed ||
      previous.x !== next.x ||
      previous.y !== next.y
    );
  };

  const upsertAgent = (
    agentId: string,
    patch: Partial<OfficeAgentState>,
  ): { agent: OfficeAgentState; changed: boolean } => {
    const current = agents.get(agentId);
    const placement = resolvePlacement(agentId);
    const next: OfficeAgentState = {
      id: agentId,
      label: patch.label ?? current?.label ?? agentId,
      state: patch.state ?? current?.state ?? "idle",
      lastUpdateMs: patch.lastUpdateMs ?? Date.now(),
      runId: patch.runId ?? current?.runId,
      details: patch.details ?? current?.details,
      blocked: patch.blocked ?? current?.blocked ?? false,
      failed: patch.failed ?? current?.failed ?? false,
      x: patch.x ?? current?.x ?? placement.x,
      y: patch.y ?? current?.y ?? placement.y,
    };
    agents.set(agentId, next);
    return { agent: next, changed: hasMeaningfulAgentChange(current, next) };
  };

  const appendActivity = (entry: Omit<OfficeActivityEntry, "id" | "ts">): OfficeActivityEntry => {
    const next: OfficeActivityEntry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      ...entry,
    };
    activity.push(next);
    if (activity.length > 500) {
      activity.splice(0, activity.length - 500);
    }
    return next;
  };

  const resolveAgentIdFromSessionKey = (sessionKey: unknown): string => {
    const raw = typeof sessionKey === "string" ? sessionKey : "";
    if (!raw.startsWith("agent:")) {
      return "main";
    }
    return raw.split(":")[1] || "main";
  };

  return {
    snapshot: () => ({
      agents: Array.from(agents.values()).toSorted((a, b) => a.id.localeCompare(b.id)),
      layout,
      activity: [...activity].slice(-200),
    }),
    setLayout: (nextLayout) => {
      layout = nextLayout;
      return {
        kind: "layout.updated",
        layout,
      };
    },
    applyAgentEvent: (payload) => {
      const runId = typeof payload.runId === "string" ? payload.runId : undefined;
      const stream = typeof payload.stream === "string" ? payload.stream : "agent";
      const sessionKey =
        typeof payload.sessionKey === "string" ? payload.sessionKey : "agent:main:main";
      const data =
        payload.data && typeof payload.data === "object"
          ? (payload.data as Record<string, unknown>)
          : {};
      const state = inferVisualStateFromAgentEvent({ stream, data });
      const phase = typeof data.phase === "string" ? data.phase : stream;
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const nextAgent = upsertAgent(agentId, {
        state,
        runId,
        details: phase,
        blocked: false,
        failed: state === "failed",
        lastUpdateMs: Date.now(),
      });
      const events: OfficeEventPayload[] = nextAgent.changed
        ? [{ kind: "agent.delta", agent: nextAgent.agent }]
        : [];

      if (shouldRecordAgentActivity(stream, phase)) {
        const activityEntry = appendActivity({
          kind: `agent.${stream}`,
          label: `${agentId}: ${phase}`,
          details: typeof data.text === "string" ? data.text.slice(0, 120) : undefined,
          agentId,
          runId,
        });
        events.push({ kind: "activity.append", entry: activityEntry });
      }

      return events;
    },
    applyChatEvent: (payload) => {
      const agentId = resolveAgentIdFromSessionKey(payload.sessionKey);
      const runId = typeof payload.runId === "string" ? payload.runId : undefined;
      const chatState = typeof payload.state === "string" ? payload.state : "delta";

      const nextState: OfficeVisualState =
        chatState === "error"
          ? "failed"
          : chatState === "final" || chatState === "aborted"
            ? "waiting-input"
            : "typing";

      const details =
        chatState === "error"
          ? typeof payload.errorMessage === "string"
            ? payload.errorMessage.slice(0, 120)
            : "chat error"
          : `chat ${chatState}`;

      const agent = upsertAgent(agentId, {
        state: nextState,
        runId,
        details,
        blocked: false,
        failed: nextState === "failed",
        lastUpdateMs: Date.now(),
      });

      const events: OfficeEventPayload[] = agent.changed
        ? [{ kind: "agent.delta", agent: agent.agent }]
        : [];
      if (shouldRecordChatActivity(chatState)) {
        const entry = appendActivity({
          kind: `chat.${chatState}`,
          label: `${agentId}: chat ${chatState}`,
          details,
          agentId,
          runId,
        });
        events.push({ kind: "activity.append", entry });
      }

      return events;
    },
    applyExecApprovalRequested: (payload) => {
      const request =
        payload.request && typeof payload.request === "object"
          ? (payload.request as Record<string, unknown>)
          : {};
      const agentId =
        typeof request.agentId === "string" && request.agentId.trim() ? request.agentId : "main";
      const command = typeof request.command === "string" ? request.command : "approval requested";
      const agent = upsertAgent(agentId, {
        state: "approval-blocked",
        blocked: true,
        details: "approval requested",
        lastUpdateMs: Date.now(),
      });
      const activityEntry = appendActivity({
        kind: "approval.requested",
        label: `Approval required: ${agentId}`,
        details: command.slice(0, 120),
        agentId,
      });
      const updates: OfficeEventPayload[] = [];
      if (agent.changed) {
        updates.push({ kind: "agent.delta", agent: agent.agent });
      }
      updates.push({
        kind: "alert.pin",
        message: `Approval required for ${agentId}`,
        severity: "warn",
        agentId,
      });
      updates.push({ kind: "activity.append", entry: activityEntry });
      return [...updates];
    },
    applyExecApprovalResolved: (payload) => {
      const decision = typeof payload.decision === "string" ? payload.decision : "resolved";
      const updates: OfficeEventPayload[] = [];
      for (const [agentId, state] of agents.entries()) {
        if (state.state !== "approval-blocked") {
          continue;
        }
        const next = upsertAgent(agentId, {
          state: "idle",
          blocked: false,
          details: `approval ${decision}`,
          lastUpdateMs: Date.now(),
        });
        if (next.changed) {
          updates.push({ kind: "agent.delta", agent: next.agent });
        }
      }
      const entry = appendActivity({
        kind: "approval.resolved",
        label: `Approval ${decision}`,
        details: undefined,
      });
      updates.push({ kind: "activity.append", entry });
      return updates;
    },
    applyCronEvent: (payload) => {
      const action = typeof payload.action === "string" ? payload.action : "cron";
      const entry = appendActivity({
        kind: `cron.${action}`,
        label: `Cron: ${action}`,
        details: typeof payload.summary === "string" ? payload.summary : undefined,
      });
      return [{ kind: "activity.append", entry }];
    },
    appendActivity: (entry) => ({
      kind: "activity.append",
      entry: appendActivity(entry),
    }),
  };
}
