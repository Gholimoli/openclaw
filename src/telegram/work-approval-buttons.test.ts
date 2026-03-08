import { describe, expect, it } from "vitest";
import {
  buildTelegramWorkApprovalButtons,
  extractTelegramWorkResumeToken,
  parseTelegramWorkApprovalCallbackData,
} from "./work-approval-buttons.js";

describe("work-approval-buttons", () => {
  it("builds approve and deny buttons", () => {
    expect(buildTelegramWorkApprovalButtons()).toEqual([
      [
        { text: "Approve", callback_data: "xwk1:y" },
        { text: "Deny", callback_data: "xwk1:n" },
      ],
    ]);
  });

  it("parses approval callbacks", () => {
    expect(parseTelegramWorkApprovalCallbackData("xwk1:y")).toEqual({ action: "approve" });
    expect(parseTelegramWorkApprovalCallbackData("xwk1:n")).toEqual({ action: "deny" });
    expect(parseTelegramWorkApprovalCallbackData("xwk1:x")).toBeNull();
  });

  it("extracts the resume token from the fallback text", () => {
    expect(
      extractTelegramWorkResumeToken(
        "Commit?\n\nresumeToken:\nresume-123\n\nResume:\n/work resume resume-123 --approve yes\n/work resume resume-123 --approve no",
      ),
    ).toBe("resume-123");
  });
});
