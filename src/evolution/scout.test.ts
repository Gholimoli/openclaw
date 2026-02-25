import { describe, expect, it, vi } from "vitest";
import type { EvolutionInsight } from "./types.js";
import { runScout } from "./scout.js";

const { mockFetchGithubInsights, mockFetchManualInsight } = vi.hoisted(() => ({
  mockFetchGithubInsights: vi.fn(),
  mockFetchManualInsight: vi.fn(),
}));

vi.mock("./connectors/github.js", () => ({
  fetchGithubInsights: mockFetchGithubInsights,
}));

vi.mock("./connectors/manual.js", () => ({
  fetchManualInsight: mockFetchManualInsight,
}));

function buildInsight(id: string): EvolutionInsight {
  return {
    id,
    sourceId: "s1",
    fetchedAt: new Date().toISOString(),
    url: "https://example.com/x",
    publishedAt: "2026-02-24T00:00:00.000Z",
    contentHash: "same",
    evidenceText: "same evidence",
    confidence: 0.9,
    tags: [],
  };
}

describe("evolution scout", () => {
  it("dedupes repeated insights across existing and new entries", async () => {
    const duplicate = buildInsight("insight-dup");
    mockFetchGithubInsights.mockResolvedValueOnce({
      insights: [duplicate, { ...duplicate, id: "insight-dup-2" }],
      cursor: {},
    });
    mockFetchManualInsight.mockResolvedValueOnce({ ...duplicate, id: "manual-dup" });

    const result = await runScout({
      existingSources: { version: 1, sources: [], cursors: {} },
      sourceSpecs: [
        { id: "s1", kind: "github_repo", githubOwner: "openclaw", githubRepo: "openclaw" },
        { id: "s2", kind: "manual_url", url: "https://example.com/manual" },
      ],
      existingInsights: [duplicate],
      githubToken: undefined,
    });

    expect(result.newInsights).toHaveLength(0);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
  });
});
