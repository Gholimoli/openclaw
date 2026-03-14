import { describe, expect, it } from "vitest";
import { stripDowngradedToolCallText } from "./pi-embedded-utils.js";

describe("stripDowngradedToolCallText", () => {
  it("strips leaked to=apply_patch code syntax", () => {
    const text =
      "Intro.\n" +
      "to=apply_patch code\n" +
      "*** Begin Patch\n" +
      "*** Add File: note.txt\n" +
      "+hello\n" +
      "*** End Patch\n" +
      "Back to the user.";

    expect(stripDowngradedToolCallText(text)).toBe("Intro.\nBack to the user.");
  });
});
