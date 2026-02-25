import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { EvolutionInsight } from "./types.js";
import { createEvolutionService } from "./service.js";
import { createEvolutionStore, resolveEvolutionPaths } from "./store.js";

const tempRoots: string[] = [];

function runOrThrow(args: string[], cwd: string) {
  const result = spawnSync(args[0] ?? "", args.slice(1), {
    cwd,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      `command failed: ${args.join(" ")}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

async function setupRepo(root: string) {
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "a.md"), "# Before\n", "utf-8");
  await fs.writeFile(
    path.join(root, "scripts", "committer"),
    '#!/usr/bin/env bash\nset -euo pipefail\nmsg="$1"\nshift\ngit add "$@"\ngit commit -m "$msg" >/dev/null\n',
    "utf-8",
  );
  await fs.chmod(path.join(root, "scripts", "committer"), 0o755);

  runOrThrow(["git", "init"], root);
  runOrThrow(["git", "config", "user.email", "evolution@test.local"], root);
  runOrThrow(["git", "config", "user.name", "Evolution Test"], root);
  runOrThrow(["git", "add", "."], root);
  runOrThrow(["git", "commit", "-m", "init"], root);
}

function buildConfig(sourceId: string): OpenClawConfig {
  return {
    evolution: {
      enabled: true,
      objective: "reliability_quality",
      autonomy: {
        mode: "merge-low-risk",
        mergeScope: ["docs", "prompts", "dashboard"],
      },
      sources: {
        allowlist: [
          {
            id: sourceId,
            kind: "manual_url",
            url: "https://example.com/source",
            reliabilityTier: "high",
          },
        ],
      },
    },
  };
}

function buildInsight(params: {
  id: string;
  sourceId: string;
  evidenceText: string;
  confidence?: number;
}): EvolutionInsight {
  return {
    id: params.id,
    sourceId: params.sourceId,
    fetchedAt: new Date().toISOString(),
    url: "https://example.com/insight",
    publishedAt: "2026-02-24T00:00:00.000Z",
    contentHash: `hash-${params.id}`,
    evidenceText: params.evidenceText,
    confidence: params.confidence ?? 0.95,
    tags: ["reliability", "docs", "gateway"],
  };
}

function buildEvidenceWithProposal(payload: object) {
  const keywords =
    "reliability stability bug incident outage regression error quality tests docs maintain coverage lint gateway control ui agent cron prompt dashboard";
  return `${keywords}\nopenclaw-evolution: ${JSON.stringify(payload)}`;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) {
      continue;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("evolution service e2e scenarios", () => {
  it("executes low-risk docs proposal and publishes report", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-evolution-e2e-"));
    tempRoots.push(root);
    const repoRoot = path.join(root, "repo");
    const stateDir = path.join(root, "state");
    await fs.mkdir(repoRoot, { recursive: true });
    await setupRepo(repoRoot);

    const store = createEvolutionStore(resolveEvolutionPaths(stateDir));
    await store.appendInsight(
      buildInsight({
        id: "insight-1",
        sourceId: "source-1",
        evidenceText: buildEvidenceWithProposal({
          title: "Docs reliability fix",
          summary: "Apply a low-risk docs patch.",
          candidatePaths: ["docs/a.md"],
          patchOps: [
            {
              type: "replace_text",
              path: "docs/a.md",
              find: "Before",
              replace: "After",
            },
          ],
        }),
      }),
    );

    const events: Array<{ event: string; payload: unknown }> = [];
    const service = createEvolutionService({
      getConfig: () => buildConfig("source-1"),
      repoRoot,
      stateDir,
      executorOverrides: {
        gateCommands: [["node", "-e", ""]],
        committerScript: "scripts/committer",
      },
      broadcast: (event, payload) => {
        events.push({ event, payload });
      },
    });

    const result = await service.runSynthesizeNow();
    expect(result.executed).toBe(1);

    const latestSubject = runOrThrow(["git", "log", "--pretty=%s", "-1"], repoRoot);
    expect(latestSubject).toContain("Evolution:");
    expect(events.some((entry) => entry.event === "evolution")).toBe(true);
    expect(
      events.some(
        (entry) =>
          entry.event === "evolution" &&
          typeof entry.payload === "object" &&
          entry.payload !== null &&
          (entry.payload as { kind?: string }).kind === "report.published",
      ),
    ).toBe(true);
  });

  it("keeps out-of-scope proposals in review queue without merge", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-evolution-e2e-"));
    tempRoots.push(root);
    const repoRoot = path.join(root, "repo");
    const stateDir = path.join(root, "state");
    await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
    await setupRepo(repoRoot);
    await fs.writeFile(path.join(repoRoot, "src", "runtime.ts"), "export const x = 1;\n", "utf-8");
    runOrThrow(["git", "add", "."], repoRoot);
    runOrThrow(["git", "commit", "-m", "add runtime file"], repoRoot);

    const store = createEvolutionStore(resolveEvolutionPaths(stateDir));
    await store.appendInsight(
      buildInsight({
        id: "insight-2",
        sourceId: "source-2",
        evidenceText: buildEvidenceWithProposal({
          title: "Runtime rewrite idea",
          summary: "Out-of-scope runtime patch.",
          candidatePaths: ["src/runtime.ts"],
          patchOps: [
            {
              type: "write_file",
              path: "src/runtime.ts",
              content: "export const x = 2;\n",
            },
          ],
        }),
      }),
    );

    const service = createEvolutionService({
      getConfig: () => buildConfig("source-2"),
      repoRoot,
      stateDir,
      executorOverrides: {
        gateCommands: [["node", "-e", ""]],
        committerScript: "scripts/committer",
      },
    });

    const result = await service.runSynthesizeNow();
    expect(result.added).toBe(1);
    expect(result.executed).toBe(0);

    const proposals = await service.listProposals({ limit: 10 });
    expect(proposals[0]?.class).toBe("needs_review");
    const subjects = runOrThrow(["git", "log", "--pretty=%s"], repoRoot).split("\n");
    expect(subjects.some((line) => line.includes("Evolution:"))).toBe(false);
  });

  it("projects approval-blocked office state within one event cycle", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-evolution-e2e-"));
    tempRoots.push(root);
    const repoRoot = path.join(root, "repo");
    const stateDir = path.join(root, "state");
    await fs.mkdir(repoRoot, { recursive: true });
    await setupRepo(repoRoot);

    const service = createEvolutionService({
      getConfig: () => buildConfig("source-3"),
      repoRoot,
      stateDir,
    });

    await service.onExecApprovalRequested({
      request: { agentId: "main", command: "pnpm test" },
    });
    const snapshot = await service.officeSnapshot();
    expect(snapshot.agents[0]?.state).toBe("approval-blocked");
  });

  it("recovers after restart without duplicate proposal execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-evolution-e2e-"));
    tempRoots.push(root);
    const repoRoot = path.join(root, "repo");
    const stateDir = path.join(root, "state");
    await fs.mkdir(repoRoot, { recursive: true });
    await setupRepo(repoRoot);

    const store = createEvolutionStore(resolveEvolutionPaths(stateDir));
    await store.appendInsight(
      buildInsight({
        id: "insight-3",
        sourceId: "source-4",
        evidenceText: buildEvidenceWithProposal({
          title: "Single execution change",
          summary: "Should run exactly once.",
          candidatePaths: ["docs/a.md"],
          patchOps: [
            {
              type: "replace_text",
              path: "docs/a.md",
              find: "Before",
              replace: "After",
            },
          ],
        }),
      }),
    );

    const config = buildConfig("source-4");
    const serviceA = createEvolutionService({
      getConfig: () => config,
      repoRoot,
      stateDir,
      executorOverrides: {
        gateCommands: [["node", "-e", ""]],
        committerScript: "scripts/committer",
      },
    });
    const first = await serviceA.runSynthesizeNow();
    expect(first.executed).toBe(1);
    await serviceA.stop();

    const serviceB = createEvolutionService({
      getConfig: () => config,
      repoRoot,
      stateDir,
      executorOverrides: {
        gateCommands: [["node", "-e", ""]],
        committerScript: "scripts/committer",
      },
    });
    const second = await serviceB.runSynthesizeNow();
    expect(second.added).toBe(0);
    expect(second.executed).toBe(0);

    const subjects = runOrThrow(["git", "log", "--pretty=%s"], repoRoot).split("\n");
    const evolutionCommits = subjects.filter((line) => line.includes("Evolution:"));
    expect(evolutionCommits).toHaveLength(1);
  });
});
