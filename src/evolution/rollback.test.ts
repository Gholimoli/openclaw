import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rollbackEvolutionCommit } from "./rollback.js";

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

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) {
      continue;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("evolution rollback helper", () => {
  it("reverts an applied commit and returns changed paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-evolution-rollback-"));
    tempRoots.push(root);

    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "a.md"), "# Before\n", "utf-8");
    runOrThrow(["git", "init"], root);
    runOrThrow(["git", "config", "user.email", "evolution@test.local"], root);
    runOrThrow(["git", "config", "user.name", "Evolution Test"], root);
    runOrThrow(["git", "add", "."], root);
    runOrThrow(["git", "commit", "-m", "init"], root);

    await fs.writeFile(path.join(root, "docs", "a.md"), "# After\n", "utf-8");
    runOrThrow(["git", "add", "."], root);
    runOrThrow(["git", "commit", "-m", "Evolution: proposal-1 docs update"], root);
    const evolutionCommit = runOrThrow(["git", "rev-parse", "HEAD"], root);

    const result = await rollbackEvolutionCommit({
      repoDir: root,
      commitSha: evolutionCommit,
    });

    expect(result.ok).toBe(true);
    expect(result.revertedCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.changedPaths).toContain("docs/a.md");

    const current = await fs.readFile(path.join(root, "docs", "a.md"), "utf-8");
    expect(current).toContain("Before");
  });
});
