import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";

const state = vi.hoisted(() => ({
  runWorkLobster: vi.fn(),
  resumeWorkLobster: vi.fn(),
  runWorkctlJson: vi.fn(),
}));

vi.mock("./run-lobster.js", () => ({
  resolveWorkflowsDir: () => "/tmp/workflows",
  resolveWorkctlPath: () => "/tmp/workctl.mjs",
  runWorkLobster: (...args: unknown[]) => state.runWorkLobster(...args),
  resumeWorkLobster: (...args: unknown[]) => state.resumeWorkLobster(...args),
}));

vi.mock("./run-workctl.js", () => ({
  runWorkctlJson: (...args: unknown[]) => state.runWorkctlJson(...args),
}));

import { createWorkTool } from "./work-tool.js";

function fakeApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return {
    id: "work",
    name: "work",
    source: "test",
    config: {
      agents: {
        list: [
          {
            id: "coder",
            model: {
              primary: "openai-codex/gpt-5.3-codex",
              fallbacks: ["openai/gpt-5.4", "google-gemini-cli/gemini-3-pro-preview"],
            },
          },
        ],
        defaults: {
          model: { primary: "openai-codex/gpt-5.3-codex" },
        },
      },
    },
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
    registerCommand() {},
    on() {},
    resolvePath: (p) => p,
    ...overrides,
  };
}

function fakeCtx(overrides: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext {
  return {
    config: fakeApi().config,
    agentId: "main",
    sandboxed: false,
    ...overrides,
  };
}

describe("work tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the live agent default planner model for task workflows", async () => {
    state.runWorkLobster.mockResolvedValue({
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: {
        type: "approval_request",
        prompt: "Commit?",
        items: [],
        resumeToken: "resume-1",
      },
    });

    const tool = createWorkTool(fakeApi(), fakeCtx());
    await tool.execute("call-1", {
      action: "task",
      repo: "Gholimoli/moltbot-sandbox",
      message: "x",
    });

    const [, params] = state.runWorkLobster.mock.calls[0] ?? [];
    const argsJson = JSON.parse(String(params?.argsJson ?? "{}"));
    expect(argsJson.plannerModel).toBe("openai-codex/gpt-5.3-codex");
    expect(argsJson.implementationModel).toBe("gpt-5.3-codex");
    expect(argsJson.implementationFallbackModel).toBe("gpt-5.4");
    expect(argsJson.fallbackModel).toBe("gemini-3-pro-preview");
  });

  it("prefers an explicit planner model override for task workflows", async () => {
    state.runWorkLobster.mockResolvedValue({
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: {
        type: "approval_request",
        prompt: "Commit?",
        items: [],
        resumeToken: "resume-2",
      },
    });

    const tool = createWorkTool(fakeApi(), fakeCtx());
    await tool.execute("call-2", {
      action: "task",
      repo: "Gholimoli/moltbot-sandbox",
      message: "x",
      plannerModel: "openai-codex/gpt-5.3-codex-spark",
    });

    const [, params] = state.runWorkLobster.mock.calls[0] ?? [];
    const argsJson = JSON.parse(String(params?.argsJson ?? "{}"));
    expect(argsJson.plannerModel).toBe("openai-codex/gpt-5.3-codex-spark");
  });

  it("does not rewrite bare planner model ids", async () => {
    state.runWorkLobster.mockResolvedValue({
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: {
        type: "approval_request",
        prompt: "Commit?",
        items: [],
        resumeToken: "resume-3",
      },
    });

    const config = {
      agents: {
        list: [
          {
            id: "coder",
            model: {
              primary: "openai-codex/gpt-5.3-codex",
              fallbacks: ["google-gemini-cli/gemini-3-pro-preview"],
            },
          },
        ],
        defaults: {
          model: { primary: "gpt-5.4" },
        },
      },
    };
    const tool = createWorkTool(fakeApi({ config }), fakeCtx({ config }));
    await tool.execute("call-3", {
      action: "task",
      repo: "Gholimoli/moltbot-sandbox",
      message: "x",
    });

    const [, params] = state.runWorkLobster.mock.calls[0] ?? [];
    const argsJson = JSON.parse(String(params?.argsJson ?? "{}"));
    expect(argsJson.plannerModel).toBe("gpt-5.4");
  });

  it("normalizes provider-prefixed implementation overrides for task workflows", async () => {
    state.runWorkLobster.mockResolvedValue({
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: {
        type: "approval_request",
        prompt: "Commit?",
        items: [],
        resumeToken: "resume-4",
      },
    });

    const tool = createWorkTool(fakeApi(), fakeCtx());
    await tool.execute("call-4", {
      action: "task",
      repo: "Gholimoli/moltbot-sandbox",
      message: "x",
      implementationModel: "openai-codex/gpt-5.3-codex",
      implementationFallbackModel: "openai/gpt-5.4",
      fallbackModel: "google-gemini-cli/gemini-3-pro-preview",
    });

    const [, params] = state.runWorkLobster.mock.calls[0] ?? [];
    const argsJson = JSON.parse(String(params?.argsJson ?? "{}"));
    expect(argsJson.implementationModel).toBe("gpt-5.3-codex");
    expect(argsJson.implementationFallbackModel).toBe("gpt-5.4");
    expect(argsJson.fallbackModel).toBe("gemini-3-pro-preview");
  });

  it("normalizes implementation models for direct fix runs", async () => {
    state.runWorkctlJson
      .mockResolvedValueOnce({ repoDir: "/tmp/repos/Gholimoli/moltbot-sandbox" })
      .mockResolvedValueOnce({
        repoDir: "/tmp/repos/Gholimoli/moltbot-sandbox",
        base: "main",
        checks: { ok: true },
        fix: { code: 0, status: "completed", tail: "ok" },
      });

    const tool = createWorkTool(fakeApi(), fakeCtx());
    await tool.execute("call-5", {
      action: "fix",
      repo: "Gholimoli/moltbot-sandbox",
      implementationModel: "openai-codex/gpt-5.3-codex",
      implementationFallbackModel: "openai/gpt-5.4",
      fallbackModel: "google-gemini-cli/gemini-3-pro-preview",
    });

    const [fixCall] = state.runWorkctlJson.mock.calls[1] ?? [];
    expect(fixCall?.args).toMatchObject({
      "implementation-model": "gpt-5.3-codex",
      "implementation-fallback-model": "gpt-5.4",
      "fallback-model": "gemini-3-pro-preview",
    });
  });

  it("runs review directly and returns the workctl result in output", async () => {
    state.runWorkctlJson
      .mockResolvedValueOnce({ repoDir: "/tmp/repos/Gholimoli/moltbot-sandbox" })
      .mockResolvedValueOnce({
        repoDir: "/tmp/repos/Gholimoli/moltbot-sandbox",
        base: "main",
        checks: { ok: true },
        review: { code: 0, status: "completed", tail: "ok" },
      });

    const tool = createWorkTool(fakeApi(), fakeCtx());
    const result = await tool.execute("call-6", {
      action: "review",
      repo: "Gholimoli/moltbot-sandbox",
      base: "main",
    });

    expect(state.runWorkLobster).not.toHaveBeenCalled();
    expect(state.runWorkctlJson).toHaveBeenCalledTimes(2);
    expect(result.details).toEqual({
      ok: true,
      status: "ok",
      output: [
        {
          repoDir: "/tmp/repos/Gholimoli/moltbot-sandbox",
          base: "main",
          checks: { ok: true },
          review: { code: 0, status: "completed", tail: "ok" },
        },
      ],
      requiresApproval: null,
    });
  });
});
