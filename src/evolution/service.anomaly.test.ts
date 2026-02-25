import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvolutionService } from "./service.js";

const { mockRunScout } = vi.hoisted(() => ({
  mockRunScout: vi.fn(),
}));

vi.mock("./scout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scout.js")>();
  return {
    ...actual,
    runScout: mockRunScout,
  };
});

const tempRoots: string[] = [];

afterEach(async () => {
  mockRunScout.mockReset();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) {
      continue;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("evolution service anomalies", () => {
  it("auto-pauses on repeated malformed source payload bursts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-evolution-service-"));
    tempRoots.push(root);
    const stateDir = path.join(root, "state");
    const repoRoot = path.join(root, "repo");
    await fs.mkdir(repoRoot, { recursive: true });

    mockRunScout.mockResolvedValueOnce({
      sources: {
        version: 1 as const,
        sources: [
          {
            id: "source-1",
            kind: "github_repo",
            enabled: true,
            githubOwner: "openclaw",
            githubRepo: "openclaw",
            include: ["releases"],
            tags: [],
            reliabilityTier: "high",
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
          },
        ],
        cursors: {
          "source-1": {
            malformedBurstCount: 3,
            lastMalformedCount: 8,
            fetchedAtMs: Date.now(),
          },
        },
      },
      newInsights: [],
      skipped: 0,
      malformedBySource: { "source-1": 8 },
      malformedBurstSources: ["source-1"],
    });

    const service = createEvolutionService({
      getConfig: () => ({
        evolution: {
          enabled: true,
          sources: {
            allowlist: [
              {
                id: "source-1",
                kind: "github_repo",
                githubOwner: "openclaw",
                githubRepo: "openclaw",
              },
            ],
          },
        },
      }),
      repoRoot,
      stateDir,
    });

    await service.runScoutNow();
    const status = await service.status();
    expect(status.paused).toBe(true);
  });

  it("accepts manual evidence text during source upsert", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-evolution-service-"));
    tempRoots.push(root);
    const stateDir = path.join(root, "state");
    const repoRoot = path.join(root, "repo");
    await fs.mkdir(repoRoot, { recursive: true });

    const service = createEvolutionService({
      getConfig: () => ({
        evolution: {
          enabled: true,
        },
      }),
      repoRoot,
      stateDir,
    });

    await service.upsertSource(
      {
        id: "manual-1",
        kind: "manual_url",
        url: "https://example.com",
      },
      {
        manualInsight: {
          evidenceText: "operator supplied evidence",
          tags: ["manual", "seeded"],
        },
      },
    );

    const insights = await service.listInsights({ limit: 10 });
    expect(insights).toHaveLength(1);
    expect(insights[0]?.evidenceText).toContain("operator supplied evidence");
  });
});
