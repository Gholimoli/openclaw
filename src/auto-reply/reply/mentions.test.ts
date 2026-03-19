import { describe, expect, it } from "vitest";
import {
  buildAgentAddressRegexes,
  matchesMentionPatterns,
  matchesMentionWithExplicit,
} from "./mentions.js";

describe("matchesMentionWithExplicit", () => {
  const mentionRegexes = [/\bopenclaw\b/i];

  it("checks mentionPatterns even when explicit mention is available", () => {
    const result = matchesMentionWithExplicit({
      text: "@openclaw hello",
      mentionRegexes,
      explicit: {
        hasAnyMention: true,
        isExplicitlyMentioned: false,
        canResolveExplicit: true,
      },
    });
    expect(result).toBe(true);
  });

  it("returns false when explicit is false and no regex match", () => {
    const result = matchesMentionWithExplicit({
      text: "<@999999> hello",
      mentionRegexes,
      explicit: {
        hasAnyMention: true,
        isExplicitlyMentioned: false,
        canResolveExplicit: true,
      },
    });
    expect(result).toBe(false);
  });

  it("returns true when explicitly mentioned even if regexes do not match", () => {
    const result = matchesMentionWithExplicit({
      text: "<@123456>",
      mentionRegexes: [],
      explicit: {
        hasAnyMention: true,
        isExplicitlyMentioned: true,
        canResolveExplicit: true,
      },
    });
    expect(result).toBe(true);
  });

  it("falls back to regex matching when explicit mention cannot be resolved", () => {
    const result = matchesMentionWithExplicit({
      text: "openclaw please",
      mentionRegexes,
      explicit: {
        hasAnyMention: true,
        isExplicitlyMentioned: false,
        canResolveExplicit: false,
      },
    });
    expect(result).toBe(true);
  });

  it("uses only agent-specific patterns or identity names for addressed-agent matching", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            identity: { name: "Ted" },
          },
          {
            id: "power",
            identity: { name: "Power" },
          },
        ],
      },
      messages: {
        groupChat: {
          mentionPatterns: ["\\bopenclaw\\b"],
        },
      },
    };

    const mainRegexes = buildAgentAddressRegexes(cfg, "main");
    const powerRegexes = buildAgentAddressRegexes(cfg, "power");

    expect(matchesMentionPatterns("Ted can you handle this?", mainRegexes)).toBe(true);
    expect(matchesMentionPatterns("Power can you handle this?", powerRegexes)).toBe(true);
    expect(matchesMentionPatterns("openclaw can you handle this?", mainRegexes)).toBe(false);
    expect(matchesMentionPatterns("openclaw can you handle this?", powerRegexes)).toBe(false);
  });
});
