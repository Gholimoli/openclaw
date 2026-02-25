import crypto from "node:crypto";
import type { EvolutionSourceSpec } from "../config/types.evolution.js";
import type { EvolutionInsight, EvolutionSourceStore } from "./types.js";
import { fetchGithubInsights } from "./connectors/github.js";
import { fetchManualInsight } from "./connectors/manual.js";
import { normalizeSourceSpecs } from "./defaults.js";

export type ScoutResult = {
  sources: EvolutionSourceStore;
  newInsights: EvolutionInsight[];
  skipped: number;
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
    cursors: existing.cursors,
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
  const seen = new Set(params.existingInsights.map((entry) => dedupeKey(entry)));
  let skipped = 0;

  for (const source of mergedSources.sources) {
    if (!source.enabled) {
      continue;
    }
    if (source.kind === "github_repo") {
      const result = await fetchGithubInsights({
        source,
        cursor: mergedSources.cursors[source.id],
        authToken: params.githubToken,
      });
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
    if (!insight) {
      continue;
    }
    const key = dedupeKey(insight);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    insights.push(insight);
  }

  return {
    sources: mergedSources,
    newInsights: insights,
    skipped,
  };
}
