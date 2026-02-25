import crypto from "node:crypto";
import type { EvolutionReport } from "./types.js";

export function createEvolutionReport(params: {
  insightsAdded: number;
  proposalsAdded: number;
  executed: number;
  failed: number;
}): EvolutionReport {
  const summary = `Scout added ${params.insightsAdded} insights; synthesis added ${params.proposalsAdded} proposals; executed ${params.executed}; failed ${params.failed}.`;
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    summary,
    stats: {
      insightsAdded: params.insightsAdded,
      proposalsAdded: params.proposalsAdded,
      executed: params.executed,
      failed: params.failed,
    },
  };
}
