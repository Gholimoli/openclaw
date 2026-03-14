import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  appendSyntheticAgentMessage,
  extractRecoverableLegacyToolCalls,
  resolveLegacyTextToolArgs,
} from "./attempt.js";

describe("legacy tool recovery helpers", () => {
  it("recovers exec args from leaked pseudo-tool text", () => {
    const assistant = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'Checking host.\nto=exec code\n```json\n{"command":"hostname"}\n```',
        },
      ],
      api: "openai-responses",
      provider: "openai-codex",
      model: "gpt-5.3-codex",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } as const;

    const calls = extractRecoverableLegacyToolCalls({
      assistant,
      tools: [
        {
          name: "exec",
          label: "exec",
          description: "exec",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string" },
            },
            required: ["command"],
          },
          execute: async () => ({
            content: [{ type: "text", text: "ok" }],
            details: {},
          }),
        },
      ],
    });

    expect(calls).toEqual([{ toolName: "exec", args: { command: "hostname" } }]);
  });

  it("maps raw apply_patch payloads to the input parameter", () => {
    const args = resolveLegacyTextToolArgs({
      tool: {
        name: "apply_patch",
        label: "apply_patch",
        description: "apply patch",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string" },
          },
          required: ["input"],
        },
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
          details: {},
        }),
      },
      rawInput: "*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch",
    });

    expect(args).toEqual({
      input: "*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch",
    });
  });

  it("persists synthetic tool call and tool result messages to the session transcript", () => {
    const appended: Array<{ role?: string }> = [];
    const agent = {
      appendMessage(message: { role?: string }) {
        appended.push(message);
      },
    };
    const sessionManager = guardSessionManager(SessionManager.inMemory());
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "legacycall1", name: "apply_patch", arguments: {} }],
      api: "openai-responses",
      provider: "openai-codex",
      model: "gpt-5.3-codex",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    const toolResult = {
      role: "toolResult",
      toolCallId: "legacycall1",
      toolName: "apply_patch",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: Date.now(),
    };

    appendSyntheticAgentMessage({ agent, sessionManager, message: assistant as never });
    appendSyntheticAgentMessage({ agent, sessionManager, message: toolResult as never });

    const transcriptMessages = sessionManager
      .getEntries()
      .filter((entry) => entry.type === "message")
      .map((entry) => (entry as { message: { role?: string } }).message.role);

    expect(appended).toHaveLength(2);
    expect(transcriptMessages).toEqual(["assistant", "toolResult"]);
  });
});
