import path from "node:path";
import { runCommandWithTimeout, type SpawnResult } from "../process/exec.js";

export type EvolutionRollbackResult = {
  ok: boolean;
  message: string;
  revertedCommitSha?: string;
  changedPaths: string[];
};

async function runCommand(argv: string[], cwd: string, timeoutMs = 120_000): Promise<SpawnResult> {
  return await runCommandWithTimeout(argv, { cwd, timeoutMs });
}

function parseChangedPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("commit "))
    .toSorted();
}

export async function rollbackEvolutionCommit(params: {
  repoDir: string;
  commitSha: string;
}): Promise<EvolutionRollbackResult> {
  const repoDir = path.resolve(params.repoDir);
  const commitSha = params.commitSha.trim();
  if (!commitSha) {
    return { ok: false, message: "commit sha is required", changedPaths: [] };
  }

  const exists = await runCommand(
    ["git", "-C", repoDir, "cat-file", "-e", `${commitSha}^{commit}`],
    repoDir,
  );
  if (exists.code !== 0) {
    return {
      ok: false,
      message: `commit not found: ${commitSha}`,
      changedPaths: [],
    };
  }

  const changed = await runCommand(
    ["git", "-C", repoDir, "show", "--name-only", "--pretty=format:", commitSha],
    repoDir,
  );
  const changedPaths = changed.code === 0 ? parseChangedPaths(changed.stdout) : [];

  const revert = await runCommand(
    ["git", "-C", repoDir, "revert", "--no-edit", commitSha],
    repoDir,
  );
  if (revert.code !== 0) {
    return {
      ok: false,
      message: revert.stderr.trim() || revert.stdout.trim() || `failed to revert ${commitSha}`,
      changedPaths,
    };
  }

  const head = await runCommand(["git", "-C", repoDir, "rev-parse", "HEAD"], repoDir, 30_000);
  const revertedCommitSha = head.code === 0 ? head.stdout.trim() : undefined;

  return {
    ok: true,
    message: `reverted ${commitSha}`,
    revertedCommitSha,
    changedPaths,
  };
}
