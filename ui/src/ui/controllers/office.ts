import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  OfficeActivityEntry,
  OfficeAgentState,
  OfficeLayout,
  OfficeSnapshot,
} from "../types.ts";

export type OfficeState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  officeLoading: boolean;
  officeSavingLayout: boolean;
  officeError: string | null;
  officeAgents: OfficeAgentState[];
  officeLayout: OfficeLayout | null;
  officeActivity: OfficeActivityEntry[];
};

export async function loadOfficeSnapshot(state: OfficeState, opts?: { quiet?: boolean }) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.officeLoading) {
    return;
  }
  state.officeLoading = true;
  if (!opts?.quiet) {
    state.officeError = null;
  }
  try {
    const snapshot = await state.client.request<OfficeSnapshot>("office.snapshot", {});
    state.officeAgents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
    state.officeLayout = snapshot.layout ?? null;
    state.officeActivity = Array.isArray(snapshot.activity) ? snapshot.activity : [];
  } catch (err) {
    state.officeError = String(err);
  } finally {
    state.officeLoading = false;
  }
}

export async function saveOfficeLayout(state: OfficeState, layout: OfficeLayout) {
  if (!state.client || !state.connected || state.officeSavingLayout) {
    return;
  }
  state.officeSavingLayout = true;
  state.officeError = null;
  try {
    const res = await state.client.request<{ layout?: OfficeLayout }>("office.layout.set", {
      layout,
    });
    state.officeLayout = res.layout ?? layout;
  } catch (err) {
    state.officeError = String(err);
  } finally {
    state.officeSavingLayout = false;
  }
}
