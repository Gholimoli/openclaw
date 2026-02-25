import type { EvolutionConfig, EvolutionSourceSpec } from "../config/types.evolution.js";
import type { EvolutionSource } from "./types.js";

export const DEFAULT_SCOUT_EVERY_MS = 60 * 60 * 1000;
export const DEFAULT_SYNTH_EVERY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_MAX_FAILURES_PER_24H = 5;

export type ResolvedEvolutionConfig = {
  enabled: boolean;
  objective: "reliability_quality" | "speed" | "cost";
  scoutEveryMs: number;
  synthEveryMs: number;
  autonomyMode: "merge-low-risk" | "review-only";
  mergeScope: Array<"docs" | "prompts" | "dashboard">;
  discoveryMode: "curated" | "open" | "fixed";
  nominations: boolean;
  xMode: "api-first-hybrid";
  xBrowserFallback: boolean;
  workTarget: "state-mirror-repo";
  mergePath: "local-squash";
  maxConsecutiveFailures: number;
  maxFailuresPer24h: number;
  allowlist: EvolutionSourceSpec[];
};

function uniqueMergeScope(
  values: Array<"docs" | "prompts" | "dashboard">,
): Array<"docs" | "prompts" | "dashboard"> {
  const deduped = Array.from(new Set(values));
  return deduped.length > 0 ? deduped : ["docs", "prompts", "dashboard"];
}

export function resolveEvolutionConfig(cfg?: EvolutionConfig): ResolvedEvolutionConfig {
  return {
    enabled: cfg?.enabled === true,
    objective: cfg?.objective ?? "reliability_quality",
    scoutEveryMs: DEFAULT_SCOUT_EVERY_MS,
    synthEveryMs: DEFAULT_SYNTH_EVERY_MS,
    autonomyMode: cfg?.autonomy?.mode ?? "merge-low-risk",
    mergeScope: uniqueMergeScope(cfg?.autonomy?.mergeScope ?? ["docs", "prompts", "dashboard"]),
    discoveryMode: cfg?.discovery?.mode ?? "curated",
    nominations: cfg?.discovery?.nominations ?? true,
    xMode: cfg?.x?.mode ?? "api-first-hybrid",
    xBrowserFallback: cfg?.x?.browserFallback ?? false,
    workTarget: cfg?.execution?.workTarget ?? "state-mirror-repo",
    mergePath: cfg?.execution?.mergePath ?? "local-squash",
    maxConsecutiveFailures:
      cfg?.execution?.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
    maxFailuresPer24h: cfg?.execution?.maxFailuresPer24h ?? DEFAULT_MAX_FAILURES_PER_24H,
    allowlist: Array.isArray(cfg?.sources?.allowlist) ? cfg.sources.allowlist : [],
  };
}

export function normalizeSourceSpecs(
  specs: EvolutionSourceSpec[],
  nowMs = Date.now(),
): EvolutionSource[] {
  return specs.map((source) => ({
    id: source.id.trim(),
    kind: source.kind,
    enabled: source.enabled !== false,
    url: source.url?.trim() || undefined,
    githubOwner: source.githubOwner?.trim() || undefined,
    githubRepo: source.githubRepo?.trim() || undefined,
    include: source.include?.length ? source.include : ["releases", "commits", "issues", "prs"],
    tags: Array.from(new Set((source.tags ?? []).map((tag) => tag.trim()).filter(Boolean))),
    reliabilityTier: source.reliabilityTier ?? "medium",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  }));
}
