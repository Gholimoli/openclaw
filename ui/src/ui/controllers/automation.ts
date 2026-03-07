import type { GatewayBrowserClient } from "../gateway.ts";
import type { AutomationAuditEntry, AutomationRun, AutomationStep } from "../types.ts";

export type AutomationState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  automationLoading: boolean;
  automationError: string | null;
  automationRuns: AutomationRun[];
  automationSelectedRunId: string | null;
  automationSelectedRunLoading: boolean;
  automationSelectedRunError: string | null;
  automationSelectedRun: AutomationRun | null;
  automationSelectedSteps: AutomationStep[];
  automationSelectedAudit: AutomationAuditEntry[];
};

function sortRuns(runs: AutomationRun[]) {
  return [...runs].toSorted((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export async function loadAutomationRuns(
  state: AutomationState,
  opts?: { quiet?: boolean; limit?: number },
) {
  if (!state.client || !state.connected || state.automationLoading) {
    return;
  }
  state.automationLoading = true;
  if (!opts?.quiet) {
    state.automationError = null;
  }
  try {
    const result = await state.client.request<{ runs?: AutomationRun[] }>("automation.runs.list", {
      limit: opts?.limit ?? 50,
    });
    state.automationRuns = sortRuns(Array.isArray(result.runs) ? result.runs : []);
    if (
      state.automationSelectedRunId &&
      state.automationRuns.some((entry) => entry.id === state.automationSelectedRunId)
    ) {
      state.automationSelectedRun =
        state.automationRuns.find((entry) => entry.id === state.automationSelectedRunId) ?? null;
    } else if (!state.automationSelectedRunId && state.automationRuns[0]) {
      state.automationSelectedRunId = state.automationRuns[0].id;
      await loadAutomationRunDetail(state, state.automationSelectedRunId, { quiet: true });
    }
  } catch (err) {
    state.automationError = String(err);
  } finally {
    state.automationLoading = false;
  }
}

export async function loadAutomationRunDetail(
  state: AutomationState,
  runId: string,
  opts?: { quiet?: boolean },
) {
  if (!state.client || !state.connected || !runId.trim()) {
    return;
  }
  if (state.automationSelectedRunLoading && state.automationSelectedRunId === runId) {
    return;
  }
  state.automationSelectedRunId = runId;
  state.automationSelectedRunLoading = true;
  if (!opts?.quiet) {
    state.automationSelectedRunError = null;
  }
  try {
    const result = await state.client.request<{
      run?: AutomationRun | null;
      steps?: AutomationStep[];
      audit?: AutomationAuditEntry[];
    }>("automation.runs.get", { runId });
    state.automationSelectedRun = result.run ?? null;
    state.automationSelectedSteps = Array.isArray(result.steps)
      ? [...result.steps].toSorted((a, b) => b.ts - a.ts)
      : [];
    state.automationSelectedAudit = Array.isArray(result.audit)
      ? [...result.audit].toSorted((a, b) => b.ts - a.ts)
      : [];
  } catch (err) {
    state.automationSelectedRunError = String(err);
  } finally {
    state.automationSelectedRunLoading = false;
  }
}

function upsertRun(runs: AutomationRun[], run: AutomationRun) {
  const existing = runs.findIndex((entry) => entry.id === run.id);
  if (existing >= 0) {
    return sortRuns(runs.map((entry, index) => (index === existing ? run : entry)));
  }
  return sortRuns([run, ...runs]).slice(0, 100);
}

export async function resumeAutomationRun(state: AutomationState, runId: string) {
  if (!state.client || !state.connected || !runId.trim()) {
    return;
  }
  state.automationSelectedRunError = null;
  try {
    const result = await state.client.request<{ ok?: boolean; run?: AutomationRun | null }>(
      "automation.runs.resume",
      { runId },
    );
    if (result.run) {
      state.automationRuns = upsertRun(state.automationRuns, result.run);
      state.automationSelectedRun = result.run;
    }
    await loadAutomationRunDetail(state, runId, { quiet: true });
  } catch (err) {
    state.automationSelectedRunError = String(err);
  }
}

export async function cancelAutomationRun(state: AutomationState, runId: string, reason?: string) {
  if (!state.client || !state.connected || !runId.trim()) {
    return;
  }
  state.automationSelectedRunError = null;
  try {
    const result = await state.client.request<{ ok?: boolean; run?: AutomationRun | null }>(
      "automation.runs.cancel",
      { runId, reason },
    );
    if (result.run) {
      state.automationRuns = upsertRun(state.automationRuns, result.run);
      state.automationSelectedRun = result.run;
    }
    await loadAutomationRunDetail(state, runId, { quiet: true });
  } catch (err) {
    state.automationSelectedRunError = String(err);
  }
}
