import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(process.cwd(), "ops/vps/promote-release.sh");

type TestContext = {
  binDir: string;
  currentLink: string;
  deployRoot: string;
  homeDir: string;
  openclawLog: string;
  repoDir: string;
  sha: string;
  systemctlLog: string;
};

const writeExecutable = async (filePath: string, contents: string) => {
  await writeFile(filePath, contents);
  await chmod(filePath, 0o755);
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenClaw Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "OpenClaw Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();

describe("ops/vps/promote-release.sh", () => {
  let ctx!: TestContext;

  beforeEach(async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-promote-release-"));
    const homeDir = path.join(rootDir, "home");
    const repoDir = path.join(rootDir, "repo");
    const bareRepoDir = path.join(rootDir, "origin.git");
    const deployRoot = path.join(homeDir, "deploy", "openclaw");
    const currentLink = path.join(homeDir, "openclaw-current");
    const binDir = path.join(rootDir, "bin");
    const systemctlLog = path.join(rootDir, "systemctl.log");
    const openclawLog = path.join(rootDir, "openclaw.log");

    await mkdir(homeDir, { recursive: true });
    await mkdir(path.join(homeDir, ".openclaw"), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await mkdir(path.join(deployRoot, "releases"), { recursive: true });

    execFileSync("git", ["init", "--bare", bareRepoDir], { encoding: "utf8" });
    execFileSync("git", ["init", "-b", "main", repoDir], { encoding: "utf8" });
    await writeFile(path.join(repoDir, "README.md"), "test\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "test commit");
    git(repoDir, "remote", "add", "origin", bareRepoDir);
    git(repoDir, "push", "-u", "origin", "main");

    const sha = git(repoDir, "rev-parse", "HEAD");
    const releaseDir = path.join(deployRoot, "releases", sha);
    const previousReleaseDir = path.join(deployRoot, "releases", "previous");

    await mkdir(path.join(releaseDir, "ops", "vps"), { recursive: true });
    await mkdir(path.join(releaseDir, "dist", "hooks", "bundled"), { recursive: true });
    await mkdir(path.join(releaseDir, "extensions"), { recursive: true });
    await mkdir(path.join(releaseDir, "skills"), { recursive: true });
    await writeFile(path.join(releaseDir, ".release-ready"), "");
    await writeFile(path.join(releaseDir, "openclaw.mjs"), "console.log('openclaw');\n");
    await writeFile(
      path.join(homeDir, ".openclaw", "openclaw.json"),
      JSON.stringify(
        {
          channels: {
            telegram: {
              capabilities: { inlineButtons: "off" },
              allowFrom: ["7652107499"],
              groupAllowFrom: ["7652107499"],
            },
          },
          approvals: {
            exec: {
              mode: "targets",
              targets: [{ channel: "telegram", to: "7652107499" }],
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    await writeExecutable(
      path.join(releaseDir, "ops", "vps", "sync-coding-pack-config.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
node --input-type=module <<'NODE'
import fs from "node:fs";
const configPath = process.env.HOME + "/.openclaw/openclaw.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.channels ??= {};
config.channels.telegram ??= {};
config.channels.telegram.capabilities = { inlineButtons: "allowlist" };
config.approvals ??= {};
config.approvals.exec ??= {};
config.approvals.exec.mode = "both";
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");
NODE
`,
    );
    await writeExecutable(
      path.join(releaseDir, "ops", "vps", "verify-coding-pack-config.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
node --input-type=module <<'NODE'
import fs from "node:fs";
const configPath = process.env.HOME + "/.openclaw/openclaw.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (config?.channels?.telegram?.capabilities?.inlineButtons !== "allowlist") {
  process.exit(1);
}
if (config?.approvals?.exec?.mode !== "both") {
  process.exit(1);
}
NODE
printf '%s\\n' "verify ok"
`,
    );

    await mkdir(previousReleaseDir, { recursive: true });
    await symlink(previousReleaseDir, currentLink);
    await writeFile(path.join(homeDir, ".openclaw", ".env"), "");

    await writeExecutable(
      path.join(binDir, "systemctl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${systemctlLog}"
scope="system"
if [[ "\${1:-}" == "--user" ]]; then
  scope="user"
  shift
fi
cmd="\${1:-}"
shift || true
case "$cmd" in
  show)
    unit="\${1:-}"
    shift || true
    if [[ "$scope:$unit" == "user:openclaw-gateway.service" ]]; then
      printf 'not-found\\n'
      exit 0
    fi
    if [[ "$scope:$unit" == "system:openclaw.service" ]]; then
      if [[ " $* " == *" LoadState "* ]]; then
        printf 'loaded\\n'
        exit 0
      fi
      if [[ " $* " == *" NRestarts "* ]]; then
        printf '4\\n'
        exit 0
      fi
    fi
    printf 'not-found\\n'
    ;;
  restart)
    unit="\${1:-}"
    [[ "$scope:$unit" == "system:openclaw.service" ]] || exit 1
    ;;
  *)
    ;;
esac
`,
    );

    await writeExecutable(
      path.join(binDir, "sudo"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-n" ]]; then
  shift
fi
exec "$@"
`,
    );

    await writeExecutable(
      path.join(binDir, "timeout"),
      `#!/usr/bin/env bash
set -euo pipefail
shift
exec "$@"
`,
    );

    await writeExecutable(
      path.join(binDir, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '{"ok":true}\\n'
`,
    );

    await writeExecutable(
      path.join(binDir, "openclaw"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${openclawLog}"
`,
    );

    await writeExecutable(
      path.join(binDir, "pnpm"),
      `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm stub\\n'
`,
    );

    ctx = {
      binDir,
      currentLink,
      deployRoot,
      homeDir,
      openclawLog,
      repoDir,
      sha,
      systemctlLog,
    };
  });

  afterEach(async () => {
    if (ctx?.homeDir) {
      await rm(path.dirname(ctx.homeDir), { force: true, recursive: true });
    }
  });

  it("auto-detects the live system service and promotes the prepared release", async () => {
    await execFileAsync("bash", [scriptPath, ctx.sha], {
      env: {
        ...process.env,
        HOME: ctx.homeDir,
        OPENCLAW_DEPLOY_ROOT: ctx.deployRoot,
        OPENCLAW_REPO_DIR: ctx.repoDir,
        PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(await readFile(path.join(ctx.deployRoot, "last-known-good.sha"), "utf8")).toBe(
      `${ctx.sha}\n`,
    );
    expect(
      await readFile(path.join(ctx.homeDir, ".local", "share", "pnpm", "openclaw"), "utf8"),
    ).toContain(ctx.sha);

    expect(await realpath(ctx.currentLink)).toBe(
      await realpath(path.join(ctx.deployRoot, "releases", ctx.sha)),
    );

    const systemctlCalls = await readFile(ctx.systemctlLog, "utf8");
    expect(systemctlCalls).toContain("--user show openclaw-gateway.service -p LoadState --value");
    expect(systemctlCalls).toContain("show openclaw.service -p LoadState --value");
    expect(systemctlCalls).toContain("restart openclaw.service");

    const openclawCalls = await readFile(ctx.openclawLog, "utf8");
    expect(openclawCalls).toContain("channels status --probe");
    expect(openclawCalls).toContain("system event --mode now --text");

    const liveConfig = JSON.parse(
      await readFile(path.join(ctx.homeDir, ".openclaw", "openclaw.json"), "utf8"),
    ) as {
      approvals?: { exec?: { mode?: string } };
      channels?: { telegram?: { capabilities?: { inlineButtons?: string } } };
    };
    expect(liveConfig.channels?.telegram?.capabilities?.inlineButtons).toBe("allowlist");
    expect(liveConfig.approvals?.exec?.mode).toBe("both");
  });

  it("fails before cutover when live config verification fails", async () => {
    const verifyScript = path.join(
      ctx.deployRoot,
      "releases",
      ctx.sha,
      "ops",
      "vps",
      "verify-coding-pack-config.sh",
    );
    await writeExecutable(
      verifyScript,
      "#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' \"drift detected\" >&2\nexit 1\n",
    );

    await expect(
      execFileAsync("bash", [scriptPath, ctx.sha], {
        env: {
          ...process.env,
          HOME: ctx.homeDir,
          OPENCLAW_DEPLOY_ROOT: ctx.deployRoot,
          OPENCLAW_REPO_DIR: ctx.repoDir,
          PATH: `${ctx.binDir}:${process.env.PATH ?? ""}`,
        },
      }),
    ).rejects.toMatchObject({ code: 1 });

    expect(await realpath(ctx.currentLink)).toBe(
      await realpath(path.join(ctx.deployRoot, "releases", "previous")),
    );
    expect(existsSync(path.join(ctx.deployRoot, "last-known-good.sha"))).toBe(false);

    const systemctlCalls = await readFile(ctx.systemctlLog, "utf8");
    expect(systemctlCalls).not.toContain("restart openclaw.service");
  });
});
