import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvolutionProposal } from "./types.js";
import { createEvolutionExecutor } from "./executor.js";

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

describe("evolution executor mirror flow", () => {
  it("applies mirror patch and creates a local squash commit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-evolution-exec-"));
    tempRoots.push(root);
    const targetRepoDir = path.join(root, "target");
    const mirrorDir = path.join(root, "mirror", "openclaw");
    await fs.mkdir(path.join(targetRepoDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(targetRepoDir, "scripts"), { recursive: true });

    await fs.writeFile(
      path.join(targetRepoDir, "package.json"),
      JSON.stringify(
        {
          name: "tmp-evolution-repo",
          version: "1.0.0",
          private: true,
          scripts: {
            "format:check": 'node -e ""',
            tsgo: 'node -e ""',
            lint: 'node -e ""',
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(path.join(targetRepoDir, "docs", "a.md"), "# Before\n", "utf-8");
    await fs.writeFile(
      path.join(targetRepoDir, "scripts", "committer"),
      '#!/usr/bin/env bash\nset -euo pipefail\nmsg="$1"\nshift\ngit add "$@"\ngit commit -m "$msg" >/dev/null\n',
      "utf-8",
    );
    await fs.chmod(path.join(targetRepoDir, "scripts", "committer"), 0o755);

    runOrThrow(["git", "init"], targetRepoDir);
    runOrThrow(["git", "config", "user.email", "evolution@test.local"], targetRepoDir);
    runOrThrow(["git", "config", "user.name", "Evolution Test"], targetRepoDir);
    runOrThrow(["git", "add", "."], targetRepoDir);
    runOrThrow(["git", "commit", "-m", "init"], targetRepoDir);

    const executor = createEvolutionExecutor({
      targetRepoDir,
      mirrorDir,
      gateCommands: [["node", "-e", ""]],
      committerScript: "scripts/committer",
    });

    const proposal: EvolutionProposal = {
      id: "proposal-1",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      title: "Docs update",
      summary: "Update doc",
      insightIds: [],
      sourceIds: [],
      candidatePaths: ["docs/a.md"],
      score: {
        reliabilityImpact: 90,
        qualityImpact: 90,
        implementationRisk: 10,
        effort: 10,
        sourceConfidence: 90,
        fitWithOpenClawArchitecture: 90,
        total: 88,
      },
      class: "auto_merge_low_risk",
      status: "pending",
      patchOps: [
        {
          type: "replace_text",
          path: "docs/a.md",
          find: "Before",
          replace: "After",
        },
      ],
    };

    const result = await executor.execute(proposal, {
      mergeScope: ["docs", "prompts", "dashboard"],
    });

    expect(result.ok).toBe(true);
    expect(result.changedPaths).toEqual(["docs/a.md"]);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const updated = await fs.readFile(path.join(targetRepoDir, "docs", "a.md"), "utf-8");
    expect(updated).toContain("After");
  });
});
