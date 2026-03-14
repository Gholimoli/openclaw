import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveAuthProfileStore } from "./auth-profiles.js";
import {
  ensurePiAuthJsonFromAuthProfiles,
  ensurePiAuthJsonFromAuthProfilesSync,
} from "./pi-auth-json.js";

describe("ensurePiAuthJsonFromAuthProfiles", () => {
  it("writes openai-codex oauth credentials into auth.json for pi-coding-agent discovery", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      },
      agentDir,
    );

    const first = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(first.wrote).toBe(true);

    const authPath = path.join(agentDir, "auth.json");
    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, unknown>;
    expect(auth["openai-codex"]).toMatchObject({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
    });

    const second = await ensurePiAuthJsonFromAuthProfiles(agentDir);
    expect(second.wrote).toBe(false);
  });

  it("writes google-gemini-cli oauth credentials with projectId into auth.json", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "google-gemini-cli:user@example.com": {
            type: "oauth",
            provider: "google-gemini-cli",
            access: "gemini-access",
            refresh: "gemini-refresh",
            expires: Date.now() + 60_000,
            projectId: "example-project",
            email: "user@example.com",
          },
        },
      },
      agentDir,
    );

    const result = ensurePiAuthJsonFromAuthProfilesSync(agentDir);
    expect(result.wrote).toBe(true);

    const auth = JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(auth["google-gemini-cli"]).toMatchObject({
      type: "oauth",
      access: "gemini-access",
      refresh: "gemini-refresh",
      projectId: "example-project",
      email: "user@example.com",
    });
  });
});
