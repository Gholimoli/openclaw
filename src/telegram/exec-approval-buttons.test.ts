import { describe, expect, it } from "vitest";
import {
  buildExecApprovalCallbackData,
  buildExecApprovalConfirmButtons,
  buildExecApprovalDefaultButtons,
  parseExecApprovalCallbackData,
} from "./exec-approval-buttons.js";

describe("exec approval telegram buttons", () => {
  it("builds and parses callback data", () => {
    const data = buildExecApprovalCallbackData({
      approvalId: "123e4567-e89b-12d3-a456-426614174000",
      action: "allow-once",
    });
    expect(data).toBeTruthy();
    expect(parseExecApprovalCallbackData(data ?? "")).toEqual({
      approvalId: "123e4567-e89b-12d3-a456-426614174000",
      action: "allow-once",
    });
  });

  it("rejects unknown callback payloads", () => {
    expect(parseExecApprovalCallbackData("unknown")).toBeNull();
    expect(parseExecApprovalCallbackData("xap1:z:abc")).toBeNull();
  });

  it("builds default and confirm keyboards", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const defaults = buildExecApprovalDefaultButtons(id);
    expect(defaults).toHaveLength(2);
    expect(defaults?.[0]).toHaveLength(2);
    expect(defaults?.[1]).toHaveLength(1);

    const confirm = buildExecApprovalConfirmButtons(id);
    expect(confirm).toHaveLength(2);
    expect(confirm?.[0]?.[0]?.text).toContain("Confirm");
    expect(confirm?.[1]?.[0]?.text).toBe("Back");
  });

  it("falls back when id cannot fit telegram callback_data limit", () => {
    const longId = "x".repeat(120);
    expect(
      buildExecApprovalCallbackData({
        approvalId: longId,
        action: "allow-once",
      }),
    ).toBeNull();
    expect(buildExecApprovalDefaultButtons(longId)).toBeNull();
    expect(buildExecApprovalConfirmButtons(longId)).toBeNull();
  });
});
