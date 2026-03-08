import { describe, expect, it, vi } from "vitest";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
} from "../../../src/plugins/types.js";

const state = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("./work-tool.js", () => ({
  createWorkTool: () => ({
    execute: (...args: unknown[]) => state.execute(...args),
  }),
}));

import { registerWorkCommand } from "./work-command.js";

function fakeApi(
  registerCommand: (def: OpenClawPluginCommandDefinition) => void,
): OpenClawPluginApi {
  return {
    id: "work",
    name: "work",
    source: "test",
    config: {},
    pluginConfig: {},
    // oxlint-disable-next-line typescript/no-explicit-any
    runtime: { version: "test" } as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool() {},
    registerHttpHandler() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerHook() {},
    registerHttpRoute() {},
    registerCommand,
    on() {},
    resolvePath: (p) => p,
  };
}

describe("work command", () => {
  it("renders the first successful output item instead of the raw envelope", async () => {
    let registered: OpenClawPluginCommandDefinition | undefined;
    registerWorkCommand(
      fakeApi((def) => {
        registered = def;
      }),
    );

    state.execute.mockResolvedValue({
      details: {
        ok: true,
        status: "ok",
        output: [{ checks: { ok: true }, review: { code: 0, status: "completed" } }],
        requiresApproval: null,
      },
    });

    const result = await registered?.handler({
      channel: "telegram",
      isAuthorizedSender: true,
      args: "review Gholimoli/moltbot-sandbox --base main",
      commandBody: "/work review Gholimoli/moltbot-sandbox --base main",
      config: {},
    });

    expect(result).toEqual({
      text: JSON.stringify(
        { checks: { ok: true }, review: { code: 0, status: "completed" } },
        null,
        2,
      ),
    });
  });

  it("renders structured workctl failures with the underlying cause", async () => {
    let registered: OpenClawPluginCommandDefinition | undefined;
    registerWorkCommand(
      fakeApi((def) => {
        registered = def;
      }),
    );

    const error = new Error("workctl failed");
    Object.assign(error, {
      payload: {
        ok: false,
        error: "review AI step failed",
        cause:
          "tool execution failed: Authentication required. Please run 'coderabbit auth login'.",
      },
    });
    state.execute.mockRejectedValue(error);

    const result = await registered?.handler({
      channel: "telegram",
      isAuthorizedSender: true,
      args: "review Gholimoli/moltbot-sandbox --base main",
      commandBody: "/work review Gholimoli/moltbot-sandbox --base main",
      config: {},
    });

    expect(result).toEqual({
      text:
        "work failed:\nreview AI step failed\n\n" +
        "tool execution failed: Authentication required. Please run 'coderabbit auth login'.",
    });
  });

  it("renders Telegram approval replies with inline buttons plus fallback text", async () => {
    let registered: OpenClawPluginCommandDefinition | undefined;
    registerWorkCommand(
      fakeApi((def) => {
        registered = def;
      }),
    );

    state.execute.mockResolvedValue({
      details: {
        ok: true,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "Commit changes for repo?",
          items: [],
          resumeToken: "resume-1",
        },
      },
    });

    const result = await registered?.handler({
      channel: "telegram",
      channelId: "telegram",
      isAuthorizedSender: true,
      args: "task owner/repo do the thing",
      commandBody: "/work task owner/repo do the thing",
      config: {},
    });

    expect(result).toEqual({
      text:
        "Commit changes for repo?\n\nresumeToken:\nresume-1\n\nResume:\n" +
        "/work resume resume-1 --approve yes\n/work resume resume-1 --approve no",
      channelData: {
        telegram: {
          buttons: [
            [
              { text: "Approve", callback_data: "xwk1:y" },
              { text: "Deny", callback_data: "xwk1:n" },
            ],
          ],
        },
      },
    });
  });

  it("keeps non-Telegram approval replies as text-only", async () => {
    let registered: OpenClawPluginCommandDefinition | undefined;
    registerWorkCommand(
      fakeApi((def) => {
        registered = def;
      }),
    );

    state.execute.mockResolvedValue({
      details: {
        ok: true,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "Commit changes for repo?",
          items: [],
          resumeToken: "resume-2",
        },
      },
    });

    const result = await registered?.handler({
      channel: "discord",
      channelId: "discord",
      isAuthorizedSender: true,
      args: "task owner/repo do the thing",
      commandBody: "/work task owner/repo do the thing",
      config: {},
    });

    expect(result).toEqual({
      text:
        "Commit changes for repo?\n\nresumeToken:\nresume-2\n\nResume:\n" +
        "/work resume resume-2 --approve yes\n/work resume resume-2 --approve no",
    });
  });
});
