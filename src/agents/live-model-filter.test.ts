import { describe, expect, it } from "vitest";
import { isModernModelRef } from "./live-model-filter.js";

describe("isModernModelRef", () => {
  it("treats openai/gpt-5.4 as a modern model", () => {
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4" })).toBe(true);
  });

  it("treats openrouter refs containing gpt-5.4 as modern", () => {
    expect(isModernModelRef({ provider: "openrouter", id: "openai/gpt-5.4" })).toBe(true);
  });
});
