import { describe, expect, it } from "vitest";
import {
  buildTelegramChoiceButtons,
  parseTelegramChoiceCallbackData,
  resolveTelegramAutoChoiceMenu,
} from "./choice-buttons.js";

describe("choice-buttons", () => {
  it("converts a trailing simple Options line into buttons", () => {
    const result = resolveTelegramAutoChoiceMenu("Choose a mode.\nOptions: on, off.");
    expect(result).toEqual({
      text: "Choose a mode.",
      buttons: [
        [
          { text: "on", callback_data: "xcm1:on" },
          { text: "off", callback_data: "xcm1:off" },
        ],
      ],
    });
  });

  it("ignores complex parameterized options", () => {
    expect(
      resolveTelegramAutoChoiceMenu(
        "Current exec defaults.\nOptions: host=sandbox|gateway|node, security=deny|allowlist|full.",
      ),
    ).toBeNull();
  });

  it("parses generated callback data back into the selected choice", () => {
    const buttons = buildTelegramChoiceButtons(["on", "off"]);
    const callbackData = buttons?.[0]?.[1]?.callback_data;
    expect(callbackData).toBe("xcm1:off");
    expect(parseTelegramChoiceCallbackData(callbackData ?? "")).toEqual({ choice: "off" });
  });

  it("converts emphasized slash-separated choices into buttons when the text cues a menu", () => {
    const text =
      "Test approval request (harmless):\n- Command: `echo APPROVAL_TEST_3_OK`\n\nYou should see it show up as pending with **Approve / Deny**. Tap **Deny** first and tell me whether anything runs.";
    expect(resolveTelegramAutoChoiceMenu(text)).toEqual({
      text,
      buttons: [
        [
          { text: "Approve", callback_data: "xcm1:Approve" },
          { text: "Deny", callback_data: "xcm1:Deny" },
        ],
      ],
    });
  });

  it("requires remaining message text after stripping the options line", () => {
    expect(resolveTelegramAutoChoiceMenu("Options: yes, no.")).toBeNull();
  });
});
