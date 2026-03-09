import { describe, expect, it } from "vitest";
import {
  extractLegacyExecTextCalls,
  stripLegacyExecTextCallsInPayloads,
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

  it("recovers bare command JSON when the surrounding text cues an approval request", () => {
    const text =
      'Run a harmless, read-only command (`pwd`) as a shell approval test. Please approve.{"cmd":"pwd"}Run a harmless, read-only shell command (`pwd`) as an approval test. Please approve.';
    expect(extractLegacyExecTextCalls(text)).toEqual({
      cleanedText:
        "Run a harmless, read-only command (`pwd`) as a shell approval test. Please approve. Run a harmless, read-only shell command (`pwd`) as an approval test. Please approve.",
      calls: [{ command: "pwd" }],
    });
  });

  it("does not recover bare command JSON examples without approval/tool cues", () => {
    const text = 'JSON example: {"cmd":"pwd"}';
    expect(extractLegacyExecTextCalls(text)).toEqual({
      cleanedText: text,
      calls: [],
    });
  });

  it("strips recovered legacy calls from payloads without executing them", async () => {
    const payloads = await stripLegacyExecTextCallsInPayloads({
      payloads: [
        {
          text:
            `Intro. ` +
            `[exec cmd="echo hello"]{"cmd":"echo hello"}` +
            `\nNow choose **Approve / Deny**.`,
        },
      ],
    });

    expect(payloads).toEqual([
      {
        text: "Intro.\nNow choose **Approve / Deny**.",
      },
    ]);
  });

  it("strips recovered bare command JSON from payloads without executing it", async () => {
    const payloads = await stripLegacyExecTextCallsInPayloads({
      payloads: [
        {
          text: 'Run a harmless, read-only command (`pwd`) as a shell approval test. Please approve.{"cmd":"pwd"}Run a harmless, read-only shell command (`pwd`) as an approval test. Please approve.',
        },
      ],
    });

    expect(payloads).toEqual([
      {
        text: "Run a harmless, read-only command (`pwd`) as a shell approval test. Please approve. Run a harmless, read-only shell command (`pwd`) as an approval test. Please approve.",
      },
    ]);
  });

  it("drops payloads that only contained a legacy exec marker", async () => {
    const payloads = await stripLegacyExecTextCallsInPayloads({
      payloads: [{ text: `[exec cmd="echo hello"]{"cmd":"echo hello"}` }],
    });
    expect(payloads).toBeUndefined();
  });
});
