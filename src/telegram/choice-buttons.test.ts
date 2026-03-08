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

  it("requires remaining message text after stripping the options line", () => {
    expect(resolveTelegramAutoChoiceMenu("Options: yes, no.")).toBeNull();
  });
});
