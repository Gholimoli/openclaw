import crypto from "node:crypto";
import type { EvolutionSourceSpec } from "../config/types.evolution.js";
import type { EvolutionInsight, EvolutionSourceStore } from "./types.js";
import { fetchGithubInsights } from "./connectors/github.js";
import { fetchManualInsight } from "./connectors/manual.js";
import { normalizeSourceSpecs } from "./defaults.js";

export const MALFORMED_ITEMS_BURST_THRESHOLD = 5;
export const MALFORMED_BURST_RUNS_BEFORE_PAUSE = 3;

export type ScoutResult = {
  sources: EvolutionSourceStore;
  newInsights: EvolutionInsight[];
  skipped: number;
  malformedBySource: Record<string, number>;
  malformedBurstSources: string[];
};

function dedupeKey(insight: EvolutionInsight): string {
  const normalizedUrl = insight.url.trim().toLowerCase();
  const normalizedEvidence = insight.evidenceText.replace(/\s+/g, " ").trim().toLowerCase();
  const published = insight.publishedAt?.trim() ?? "";
  return crypto
    .createHash("sha256")
    .update(`${normalizedUrl}\n${normalizedEvidence}\n${published}`)
    .digest("hex");
}

function mergeSources(
  existing: EvolutionSourceStore,
  incomingSpecs: EvolutionSourceSpec[],
): EvolutionSourceStore {
  const now = Date.now();
  const normalizedIncoming = normalizeSourceSpecs(incomingSpecs, now);
  const byId = new Map(existing.sources.map((source) => [source.id, source]));
  for (const source of normalizedIncoming) {
    const prev = byId.get(source.id);
    byId.set(source.id, {
      ...source,
      createdAtMs: prev?.createdAtMs ?? now,
      updatedAtMs: now,
    });
  }
  return {
    version: 1,
    sources: Array.from(byId.values()).toSorted((a, b) => a.id.localeCompare(b.id)),
    cursors: Object.fromEntries(
      Object.entries(existing.cursors).map(([sourceId, cursor]) => [sourceId, { ...cursor }]),
    ),
  };
}

export async function runScout(params: {
  existingSources: EvolutionSourceStore;
  sourceSpecs: EvolutionSourceSpec[];
  existingInsights: EvolutionInsight[];
  githubToken?: string;
}): Promise<ScoutResult> {
  const mergedSources = mergeSources(params.existingSources, params.sourceSpecs);
  const insights: EvolutionInsight[] = [];
  const malformedBySource: Record<string, number> = {};
  const malformedBurstSources: string[] = [];
  const seen = new Set(params.existingInsights.map((entry) => dedupeKey(entry)));
  let skipped = 0;
  const nowMs = Date.now();

  for (const source of mergedSources.sources) {
    if (!source.enabled) {
      continue;
    }
    const prevCursor = mergedSources.cursors[source.id] ?? {};
    let malformedCount = 0;

    if (source.kind === "github_repo") {
      const result = await fetchGithubInsights({
        source,
        cursor: mergedSources.cursors[source.id],
        authToken: params.githubToken,
      });
      malformedCount = result.malformedCount;
      malformedBySource[source.id] = malformedCount;
      mergedSources.cursors[source.id] = result.cursor;
      for (const insight of result.insights) {
        const key = dedupeKey(insight);
        if (seen.has(key)) {
          skipped += 1;
          continue;
        }
        seen.add(key);
        insights.push(insight);
      }
      continue;
    }

    const insight = await fetchManualInsight({ source });
    malformedBySource[source.id] = malformedCount;
    if (!insight) {
      const malformedBurstCount = 0;
      mergedSources.cursors[source.id] = {
        ...prevCursor,
        fetchedAtMs: nowMs,
        lastMalformedCount: 0,
        malformedBurstCount,
      };
      continue;
    }
    const key = dedupeKey(insight);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    insights.push(insight);

    const malformedBurstCount =
      malformedCount >= MALFORMED_ITEMS_BURST_THRESHOLD
        ? (prevCursor.malformedBurstCount ?? 0) + 1
        : 0;
    mergedSources.cursors[source.id] = {
      ...mergedSources.cursors[source.id],
      fetchedAtMs: nowMs,
      lastMalformedCount: malformedCount,
      lastMalformedAtMs: malformedCount > 0 ? nowMs : prevCursor.lastMalformedAtMs,
      malformedBurstCount,
    };
    malformedBySource[source.id] = malformedCount;
    if (malformedBurstCount >= MALFORMED_BURST_RUNS_BEFORE_PAUSE) {
      malformedBurstSources.push(source.id);
    }
    continue;
  }

  // Ensure all source cursors record malformed burst state, including github sources.
  for (const source of mergedSources.sources) {
    const prevCursor = params.existingSources.cursors[source.id] ?? {};
    const currentCursor = mergedSources.cursors[source.id] ?? {};
    if (currentCursor.lastMalformedCount !== undefined) {
      continue;
    }
    const malformedCount = malformedBySource[source.id] ?? 0;
    const malformedBurstCount =
      malformedCount >= MALFORMED_ITEMS_BURST_THRESHOLD
        ? (prevCursor.malformedBurstCount ?? 0) + 1
        : 0;
    mergedSources.cursors[source.id] = {
      ...currentCursor,
      fetchedAtMs: currentCursor.fetchedAtMs ?? nowMs,
      lastMalformedCount: malformedCount,
      lastMalformedAtMs: malformedCount > 0 ? nowMs : prevCursor.lastMalformedAtMs,
      malformedBurstCount,
    };
    if (malformedBurstCount >= MALFORMED_BURST_RUNS_BEFORE_PAUSE) {
      malformedBurstSources.push(source.id);
    }
  }

  return {
    sources: mergedSources,
    newInsights: insights,
    skipped,
    malformedBySource,
    malformedBurstSources: Array.from(new Set(malformedBurstSources)),
  };
}
