import path from "node:path";
import ts from "typescript";

export const PROMPT_ALLOWLIST = new Set([
  "src/agents/system-prompt.ts",
  "src/agents/pi-embedded-runner/system-prompt.ts",
  "src/auto-reply/reply/session-reset-prompt.ts",
  "src/gateway/agent-prompt.ts",
  "src/wizard/prompts.ts",
]);

const DASHBOARD_ALLOW_PREFIXES = [
  "ui/",
  "src/commands/dashboard.ts",
  "src/gateway/control-ui.ts",
  "src/gateway/control-ui-shared.ts",
  "src/infra/control-ui-assets.ts",
];

const HARD_DENY_PATTERNS = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^bun\.lockb?$/,
  /^appcast\.xml$/,
  /^\.github\//,
  /^scripts\/release/i,
  /^scripts\/publish/i,
  /credentials/i,
  /auth/i,
  /sandbox/i,
];

export type MergePathClassification = "docs" | "prompts" | "dashboard" | "deny";

function normalizeRepoPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  return normalized;
}

export function classifyMergePath(filePath: string): MergePathClassification {
  const normalized = normalizeRepoPath(filePath);
  if (!normalized) {
    return "deny";
  }

  for (const deny of HARD_DENY_PATTERNS) {
    if (deny.test(normalized)) {
      return "deny";
    }
  }

  if (normalized === "README.md" || normalized.startsWith("docs/")) {
    return "docs";
  }
  if (PROMPT_ALLOWLIST.has(normalized)) {
    return "prompts";
  }
  for (const prefix of DASHBOARD_ALLOW_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix)) {
      return "dashboard";
    }
  }

  if (normalized.startsWith("src/")) {
    return "deny";
  }

  return "deny";
}

export function isPathAllowedByScope(
  filePath: string,
  scope: Array<"docs" | "prompts" | "dashboard">,
): boolean {
  const kind = classifyMergePath(filePath);
  if (kind === "deny") {
    return false;
  }
  return scope.includes(kind);
}

export function evaluateCandidatePaths(
  filePaths: string[],
  scope: Array<"docs" | "prompts" | "dashboard">,
): {
  ok: boolean;
  deniedPaths: string[];
  pathRisk: number;
  classes: Record<string, MergePathClassification>;
} {
  const classes: Record<string, MergePathClassification> = {};
  const deniedPaths: string[] = [];
  for (const rawPath of filePaths) {
    const normalized = normalizeRepoPath(rawPath);
    const kind = classifyMergePath(normalized);
    classes[normalized] = kind;
    if (!isPathAllowedByScope(normalized, scope)) {
      deniedPaths.push(normalized);
    }
  }

  const maxRisk = deniedPaths.length > 0 ? 90 : 10;
  const promptCount = filePaths.filter((entry) =>
    PROMPT_ALLOWLIST.has(normalizeRepoPath(entry)),
  ).length;
  const pathRisk = Math.min(100, maxRisk + Math.max(0, promptCount - 1) * 5);

  return {
    ok: deniedPaths.length === 0,
    deniedPaths,
    pathRisk,
    classes,
  };
}

function collectLiteralContentRanges(
  sourceFile: ts.SourceFile,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const start = node.getStart(sourceFile);
      const end = node.getEnd();
      if (end - start >= 2) {
        ranges.push({ start: start + 1, end: end - 1 });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  return ranges;
}

function stripLiteralContents(text: string, ranges: Array<{ start: number; end: number }>): string {
  let cursor = 0;
  const output: string[] = [];
  for (const range of ranges) {
    const start = Math.max(0, Math.min(text.length, range.start));
    const end = Math.max(start, Math.min(text.length, range.end));
    if (start > cursor) {
      output.push(text.slice(cursor, start));
    }
    cursor = end;
  }
  if (cursor < text.length) {
    output.push(text.slice(cursor));
  }
  return output.join("");
}

export function isStringLiteralOnlyChange(params: { before: string; after: string }): boolean {
  const beforeFile = ts.createSourceFile("before.ts", params.before, ts.ScriptTarget.Latest, true);
  const afterFile = ts.createSourceFile("after.ts", params.after, ts.ScriptTarget.Latest, true);

  const beforeRanges = collectLiteralContentRanges(beforeFile);
  const afterRanges = collectLiteralContentRanges(afterFile);

  const beforeSkeleton = stripLiteralContents(params.before, beforeRanges);
  const afterSkeleton = stripLiteralContents(params.after, afterRanges);
  return beforeSkeleton === afterSkeleton;
}

export function validatePromptLiteralOnlyEdits(params: {
  repoRoot: string;
  filePath: string;
  before: string;
  after: string;
}): { ok: boolean; reason?: string } {
  const normalized = normalizeRepoPath(
    path.relative(params.repoRoot, path.resolve(params.repoRoot, params.filePath)),
  );
  if (!PROMPT_ALLOWLIST.has(normalized)) {
    return { ok: false, reason: "prompt file outside allowlist" };
  }
  if (!isStringLiteralOnlyChange({ before: params.before, after: params.after })) {
    return { ok: false, reason: "prompt edits contain structural code changes" };
  }
  return { ok: true };
}
