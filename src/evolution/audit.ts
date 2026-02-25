import crypto from "node:crypto";
import type { EvolutionAuditEntry } from "./types.js";

export function createAuditEntry(
  params: Omit<EvolutionAuditEntry, "id" | "ts">,
): EvolutionAuditEntry {
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    ...params,
  };
}
