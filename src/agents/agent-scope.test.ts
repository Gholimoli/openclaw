import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentConfig, resolveMergedAgentSystemPrompt } from "./agent-scope.js";

describe("resolveAgentConfig", () => {
  it("returns the per-agent systemPrompt when configured", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "power",
            systemPrompt: "Consult the operator before risky production changes.",
          },
        ],
      },
    };

    expect(resolveAgentConfig(cfg, "power")?.systemPrompt).toBe(
      "Consult the operator before risky production changes.",
    );
  });
});

describe("resolveMergedAgentSystemPrompt", () => {
  it("prepends the per-agent systemPrompt and de-duplicates identical sections", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "power",
            systemPrompt: "Consult the operator before risky production changes.",
          },
        ],
      },
    };

    expect(
      resolveMergedAgentSystemPrompt({
        cfg,
        agentId: "power",
        extraSystemPrompt: "Consult the operator before risky production changes.",
      }),
    ).toBe("Consult the operator before risky production changes.");
  });
});
