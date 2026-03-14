import { describe, expect, it } from "vitest";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";

describe("AgentEntrySchema systemPrompt", () => {
  it("accepts a per-agent systemPrompt", () => {
    const parsed = AgentEntrySchema.parse({
      id: "power",
      systemPrompt: "Consult the operator before deploys or destructive changes.",
    });

    expect(parsed.systemPrompt).toBe("Consult the operator before deploys or destructive changes.");
  });
});
