import { describe, expect, it } from "vitest";
import type { EvolutionInsight } from "./types.js";
import { classifyProposalFromScore, scoreInsight } from "./score.js";

function buildInsight(overrides: Partial<EvolutionInsight> = {}): EvolutionInsight {
  return {
    id: "insight-1",
    sourceId: "source-1",
    fetchedAt: new Date().toISOString(),
    url: "https://example.com/a",
    contentHash: "hash",
    evidenceText: "reliability quality docs gateway update",
    confidence: 0.9,
    tags: ["reliability", "docs"],
    ...overrides,
  };
}

describe("evolution score", () => {
  it("is deterministic for the same input", () => {
    const insight = buildInsight();
    const a = scoreInsight({ insight, hasPatchOps: true, pathRisk: 10 });
    const b = scoreInsight({ insight, hasPatchOps: true, pathRisk: 10 });
    expect(a).toEqual(b);
  });

  it("classifies low-risk high-score proposals as auto-merge", () => {
    const score = scoreInsight({
      insight: buildInsight({
        evidenceText:
          "reliability stability bug incident outage regression error quality tests docs maintain coverage lint gateway control ui agent cron prompt dashboard",
      }),
      hasPatchOps: true,
      pathRisk: 10,
    });
    expect(classifyProposalFromScore(score)).toBe("auto_merge_low_risk");
  });

  it("classifies low-score proposals as reject/archive", () => {
    const score = scoreInsight({
      insight: buildInsight({
        confidence: 0.2,
        evidenceText: "prototype rewrite breaking fork temporary quick fix",
      }),
      hasPatchOps: false,
      pathRisk: 90,
    });
    expect(classifyProposalFromScore(score)).toBe("reject_archive");
  });
});
