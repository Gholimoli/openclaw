import { describe, expect, it, vi } from "vitest";
import {
  extractLegacyExecTextCalls,
  recoverLegacyExecTextCallsInPayloads,
} from "./legacy-exec-fallback.js";

describe("legacy exec fallback", () => {
  it("extracts legacy exec markers and preserves surrounding text", () => {
    const text =
      `I’ll queue a no-risk command that produces observable output only (no side effects) so you can Approve/Deny end-to-end.` +
      `[exec cmd="bash -lc 'hostname; date -u; echo APPROVAL_E2E_OK'"]` +
      `{"cmd":"bash -lc 'hostname; date -u; echo APPROVAL_E2E_OK'"}` +
      `[[reply_to_current]]\nE2E test request (safe, output-only):`;

    expect(extractLegacyExecTextCalls(text)).toEqual({
      cleanedText:
        "I’ll queue a no-risk command that produces observable output only (no side effects) so you can Approve/Deny end-to-end.[[reply_to_current]]\nE2E test request (safe, output-only):",
      calls: [{ command: "bash -lc 'hostname; date -u; echo APPROVAL_E2E_OK'" }],
    });
  });

  it("falls back to JSON cmd when the tag omits a parsed command", () => {
    const text = `Before\n[exec]{"cmd":"echo from-json"}\nAfter`;
    expect(extractLegacyExecTextCalls(text)).toEqual({
      cleanedText: "Before\nAfter",
      calls: [{ command: "echo from-json" }],
    });
  });

  it("invokes exec for recovered legacy calls and strips the raw marker from payloads", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "Approval required." }],
    }));
    const createTools = vi.fn(() => [{ name: "exec", execute }]);

    const payloads = await recoverLegacyExecTextCallsInPayloads({
      payloads: [
        {
          text:
            `Intro. ` +
            `[exec cmd="echo hello"]{"cmd":"echo hello"}` +
            `\nNow choose **Approve / Deny**.`,
        },
      ],
      createTools: createTools as never,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/^legacy_exec_/),
      { command: "echo hello" },
      undefined,
    );
    expect(payloads).toEqual([
      {
        text: "Intro.\nNow choose **Approve / Deny**.",
      },
    ]);
  });

  it("drops payloads that only contained a legacy exec marker", async () => {
    const execute = vi.fn(async () => ({}));
    const payloads = await recoverLegacyExecTextCallsInPayloads({
      payloads: [{ text: `[exec cmd="echo hello"]{"cmd":"echo hello"}` }],
      createTools: (() => [{ name: "exec", execute }]) as never,
    });
    expect(payloads).toBeUndefined();
  });
});
