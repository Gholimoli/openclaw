import { describe, expect, it } from "vitest";
import {
  classifyMergePath,
  evaluateCandidatePaths,
  isStringLiteralOnlyChange,
  validatePromptLiteralOnlyEdits,
} from "./policy.js";

describe("evolution policy", () => {
  it("classifies docs, prompts, dashboard, and denied paths", () => {
    expect(classifyMergePath("docs/gateway/configuration.md")).toBe("docs");
    expect(classifyMergePath("src/agents/system-prompt.ts")).toBe("prompts");
    expect(classifyMergePath("ui/src/ui/app.ts")).toBe("dashboard");
    expect(classifyMergePath("src/gateway/server.impl.ts")).toBe("deny");
    expect(classifyMergePath("package.json")).toBe("deny");
  });

  it("rejects runtime paths when evaluating merge scope", () => {
    const result = evaluateCandidatePaths(
      ["docs/gateway/configuration.md", "src/gateway/server.impl.ts"],
      ["docs", "prompts", "dashboard"],
    );
    expect(result.ok).toBe(false);
    expect(result.deniedPaths).toContain("src/gateway/server.impl.ts");
  });

  it("accepts prompt edits that only change literal content", () => {
    const before = `export const PROMPT = "Hello world";\n`;
    const after = `export const PROMPT = "Hello safer world";\n`;
    expect(isStringLiteralOnlyChange({ before, after })).toBe(true);
    const check = validatePromptLiteralOnlyEdits({
      repoRoot: "/repo",
      filePath: "/repo/src/agents/system-prompt.ts",
      before,
      after,
    });
    expect(check.ok).toBe(true);
  });

  it("rejects prompt edits with structural changes", () => {
    const before = `export const PROMPT = "Hello world";\n`;
    const after = `export const PROMPT = "Hello world";\nexport const EXTRA = true;\n`;
    expect(isStringLiteralOnlyChange({ before, after })).toBe(false);
    const check = validatePromptLiteralOnlyEdits({
      repoRoot: "/repo",
      filePath: "/repo/src/agents/system-prompt.ts",
      before,
      after,
    });
    expect(check.ok).toBe(false);
  });
});
