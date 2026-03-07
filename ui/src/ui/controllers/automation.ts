import type { GatewayBrowserClient } from "../gateway.ts";
import type { AutomationRun } from "../types.ts";

export type AutomationState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  automationLoading: boolean;
  automationError: string | null;
  automationRuns: AutomationRun[];
};

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
    state.automationRuns = Array.isArray(result.runs) ? result.runs : [];
  } catch (err) {
    state.automationError = String(err);
  } finally {
    state.automationLoading = false;
  }
}
