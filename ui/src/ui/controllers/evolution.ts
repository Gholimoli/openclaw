import type { GatewayBrowserClient } from "../gateway.ts";
import type { EvolutionProposal, EvolutionStatus } from "../types.ts";

export type EvolutionState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  evolutionLoading: boolean;
  evolutionError: string | null;
  evolutionStatus: EvolutionStatus | null;
  evolutionProposals: EvolutionProposal[];
};

export async function loadEvolutionStatus(state: EvolutionState) {
  if (!state.client || !state.connected) {
    return;
  }
  const status = await state.client.request<EvolutionStatus>("evolution.status", {});
  state.evolutionStatus = status;
}

export async function loadEvolutionProposals(state: EvolutionState, limit = 200) {
  if (!state.client || !state.connected) {
    return;
  }
  const res = await state.client.request<{ proposals?: EvolutionProposal[] }>(
    "evolution.proposals.list",
    { limit },
  );
  state.evolutionProposals = Array.isArray(res.proposals) ? res.proposals : [];
}

export async function loadEvolution(state: EvolutionState) {
  if (!state.client || !state.connected || state.evolutionLoading) {
    return;
  }
  state.evolutionLoading = true;
  state.evolutionError = null;
  try {
    await Promise.all([loadEvolutionStatus(state), loadEvolutionProposals(state)]);
  } catch (err) {
    state.evolutionError = String(err);
  } finally {
    state.evolutionLoading = false;
  }
}

export async function actEvolutionProposal(
  state: EvolutionState,
  params: {
    proposalId?: string;
    action: "approve" | "reject" | "execute" | "pause";
    paused?: boolean;
    reason?: string;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  await state.client.request("evolution.proposals.act", params);
  await Promise.all([loadEvolutionStatus(state), loadEvolutionProposals(state)]);
}
