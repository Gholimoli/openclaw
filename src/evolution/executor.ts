import fs from "node:fs/promises";
import path from "node:path";
import type { EvolutionPatchOperation, EvolutionProposal } from "./types.js";
import { runCommandWithTimeout, type SpawnResult } from "../process/exec.js";
import {
  isPathAllowedByScope,
  validatePromptLiteralOnlyEdits,
  PROMPT_ALLOWLIST,
} from "./policy.js";

type CommandCheck = {
  command: string;
  ok: boolean;
  durationMs: number;
  stderrTail?: string;
};

export type EvolutionExecuteResult = {
  ok: boolean;
  message: string;
  changedPaths: string[];
  checks: CommandCheck[];
  commitSha?: string;
};

export type EvolutionExecutor = {
  execute: (
    proposal: EvolutionProposal,
    opts: { mergeScope: Array<"docs" | "prompts" | "dashboard"> },
  ) => Promise<EvolutionExecuteResult>;
};

function sanitizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

async function runCommand(
  argv: string[],
  cwd: string,
  timeoutMs = 20 * 60_000,
): Promise<SpawnResult> {
  return await runCommandWithTimeout(argv, { cwd, timeoutMs });
}

async function ensureMirrorRepo(targetRepoDir: string, mirrorDir: string) {
  const gitDir = path.join(mirrorDir, ".git");
  const hasGit = await fs
    .stat(gitDir)
    .then((stat) => stat.isDirectory())
    .catch(() => false);

  if (!hasGit) {
    await fs.mkdir(path.dirname(mirrorDir), { recursive: true });
    const clone = await runCommand(
      ["git", "clone", "--quiet", "--no-hardlinks", targetRepoDir, mirrorDir],
      targetRepoDir,
    );
    if (clone.code !== 0) {
      throw new Error(`failed to create mirror repo: ${clone.stderr.trim()}`);
    }
    return;
  }

  await runCommand(["git", "-C", mirrorDir, "fetch", "--all", "--prune"], targetRepoDir, 120_000);
  await runCommand(["git", "-C", mirrorDir, "reset", "--hard", "HEAD"], targetRepoDir, 120_000);
}

async function readTextFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function applyPatchOps(params: {
  repoDir: string;
  patchOps: EvolutionPatchOperation[];
  mergeScope: Array<"docs" | "prompts" | "dashboard">;
}): Promise<{ ok: boolean; message?: string; changedPaths: string[] }> {
  const changed = new Set<string>();
  for (const op of params.patchOps) {
    const normalized = sanitizePath(op.path);
    if (!isPathAllowedByScope(normalized, params.mergeScope)) {
      return {
        ok: false,
        message: `path not allowed by merge scope: ${normalized}`,
        changedPaths: [],
      };
    }

    const absPath = path.resolve(params.repoDir, normalized);
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    if (op.type === "replace_text") {
      const before = await readTextFileSafe(absPath);
      if (!before.includes(op.find)) {
        return {
          ok: false,
          message: `replace_text did not match content in ${normalized}`,
          changedPaths: [...changed],
        };
      }
      const after = before.replace(op.find, op.replace);
      if (PROMPT_ALLOWLIST.has(normalized)) {
        const literalOnly = validatePromptLiteralOnlyEdits({
          repoRoot: params.repoDir,
          filePath: absPath,
          before,
          after,
        });
        if (!literalOnly.ok) {
          return {
            ok: false,
            message: literalOnly.reason,
            changedPaths: [...changed],
          };
        }
      }
      await fs.writeFile(absPath, after, "utf-8");
      changed.add(normalized);
      continue;
    }

    if (op.type === "write_file") {
      if (PROMPT_ALLOWLIST.has(normalized)) {
        const before = await readTextFileSafe(absPath);
        const literalOnly = validatePromptLiteralOnlyEdits({
          repoRoot: params.repoDir,
          filePath: absPath,
          before,
          after: op.content,
        });
        if (!literalOnly.ok) {
          return {
            ok: false,
            message: literalOnly.reason,
            changedPaths: [...changed],
          };
        }
      }
      await fs.writeFile(absPath, op.content, "utf-8");
      changed.add(normalized);
    }
  }

  return { ok: true, changedPaths: [...changed].toSorted() };
}

async function collectDirtyPaths(repoDir: string): Promise<Set<string>> {
  const status = await runCommand(
    ["git", "-C", repoDir, "status", "--porcelain"],
    repoDir,
    120_000,
  );
  if (status.code !== 0) {
    return new Set();
  }
  return new Set(
    status.stdout
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .map((entry) => sanitizePath(entry)),
  );
}

async function applyMirrorDiffToTarget(params: {
  mirrorDir: string;
  targetRepoDir: string;
}): Promise<{ ok: boolean; message?: string }> {
  const diff = await runCommand(
    ["git", "-C", params.mirrorDir, "diff", "--binary"],
    params.mirrorDir,
    120_000,
  );
  if (diff.code !== 0) {
    return { ok: false, message: diff.stderr.trim() || "failed to produce mirror diff" };
  }
  if (!diff.stdout.trim()) {
    return { ok: false, message: "mirror diff is empty" };
  }

  const apply = await runCommandWithTimeout(
    ["git", "-C", params.targetRepoDir, "apply", "--whitespace=nowarn", "-"],
    {
      cwd: params.targetRepoDir,
      timeoutMs: 120_000,
      input: diff.stdout,
    },
  );
  if (apply.code !== 0) {
    return { ok: false, message: apply.stderr.trim() || "failed to apply mirror patch" };
  }
  return { ok: true };
}

export function createEvolutionExecutor(params: {
  targetRepoDir: string;
  mirrorDir: string;
  gateCommands?: Array<string[]>;
  committerScript?: string;
}): EvolutionExecutor {
  const targetRepoDir = path.resolve(params.targetRepoDir);
  const mirrorDir = path.resolve(params.mirrorDir);
  const gateCommands =
    params.gateCommands && params.gateCommands.length > 0
      ? params.gateCommands
      : [
          ["pnpm", "format:check"],
          ["pnpm", "tsgo"],
          ["pnpm", "lint"],
        ];
  const committerScript = params.committerScript ?? "scripts/committer";

  return {
    execute: async (proposal, opts) => {
      if (!proposal.patchOps || proposal.patchOps.length === 0) {
        return {
          ok: false,
          message: "proposal has no patch operations",
          changedPaths: [],
          checks: [],
        };
      }

      await ensureMirrorRepo(targetRepoDir, mirrorDir);

      const branchName = `evolution/${proposal.id}`;
      const checkout = await runCommand(
        ["git", "-C", mirrorDir, "checkout", "-B", branchName],
        mirrorDir,
        120_000,
      );
      if (checkout.code !== 0) {
        return {
          ok: false,
          message: `failed to create mirror branch: ${checkout.stderr.trim()}`,
          changedPaths: [],
          checks: [],
        };
      }

      const applied = await applyPatchOps({
        repoDir: mirrorDir,
        patchOps: proposal.patchOps,
        mergeScope: opts.mergeScope,
      });
      if (!applied.ok) {
        return {
          ok: false,
          message: applied.message ?? "failed to apply patch ops",
          changedPaths: applied.changedPaths,
          checks: [],
        };
      }

      const checks = await (async () => {
        const checksList: CommandCheck[] = [];
        for (const argv of gateCommands) {
          const started = Date.now();
          const result = await runCommand(argv, mirrorDir);
          const durationMs = Date.now() - started;
          const command = argv.join(" ");
          checksList.push({
            command,
            ok: result.code === 0,
            durationMs,
            stderrTail: result.stderr.trim().slice(-3000) || undefined,
          });
          if (result.code !== 0) {
            break;
          }
        }
        return checksList;
      })();
      const failing = checks.find((check) => !check.ok);
      if (failing) {
        return {
          ok: false,
          message: `gating check failed: ${failing.command}`,
          changedPaths: applied.changedPaths,
          checks,
        };
      }

      const targetDirty = await collectDirtyPaths(targetRepoDir);
      const overlapping = applied.changedPaths.filter((entry) => targetDirty.has(entry));
      if (overlapping.length > 0) {
        return {
          ok: false,
          message: `target repo has overlapping dirty paths: ${overlapping.join(", ")}`,
          changedPaths: applied.changedPaths,
          checks,
        };
      }

      const appliedToTarget = await applyMirrorDiffToTarget({
        mirrorDir,
        targetRepoDir,
      });
      if (!appliedToTarget.ok) {
        return {
          ok: false,
          message: appliedToTarget.message ?? "failed to apply mirror changes to target",
          changedPaths: applied.changedPaths,
          checks,
        };
      }

      const commitTitle = proposal.title.replace(/\s+/g, " ").trim().slice(0, 72);
      const commit = await runCommand(
        [
          "bash",
          committerScript,
          `Evolution: ${proposal.id} ${commitTitle}`,
          ...applied.changedPaths,
        ],
        targetRepoDir,
        120_000,
      );
      if (commit.code !== 0) {
        return {
          ok: false,
          message: `failed to create commit: ${commit.stderr.trim() || commit.stdout.trim()}`,
          changedPaths: applied.changedPaths,
          checks,
        };
      }

      const shaResult = await runCommand(
        ["git", "-C", targetRepoDir, "rev-parse", "HEAD"],
        targetRepoDir,
        30_000,
      );
      const commitSha = shaResult.code === 0 ? shaResult.stdout.trim() : undefined;

      return {
        ok: true,
        message: "proposal executed and locally squashed",
        changedPaths: applied.changedPaths,
        checks,
        commitSha,
      };
    },
  };
}
