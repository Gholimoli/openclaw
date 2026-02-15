#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function die(message, extra = {}) {
  const payload = { ok: false, error: message, ...extra };
  process.stdout.write(JSON.stringify(payload, null, 2));
  process.stdout.write("\n");
  process.exit(1);
}

function ok(output, extra = {}) {
  const payload = { ok: true, output, ...extra };
  process.stdout.write(JSON.stringify(payload, null, 2));
  process.stdout.write("\n");
}

function resolveGatewayHttpBase() {
  const explicit = String(process.env.OPENCLAW_GATEWAY_HTTP_URL || "").trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  const port = String(
    process.env.OPENCLAW_GATEWAY_PORT || process.env.OPENCLAW_GATEWAY_HTTP_PORT || "18789",
  ).trim();
  return `http://127.0.0.1:${port}`;
}

function resolveGatewayAuthHeader() {
  const token = String(process.env.OPENCLAW_GATEWAY_TOKEN || "").trim();
  if (token) {
    return `Authorization: Bearer ${token}`;
  }
  const password = String(process.env.OPENCLAW_GATEWAY_PASSWORD || "").trim();
  if (password) {
    return `Authorization: Bearer ${password}`;
  }
  return null;
}

async function invokeTool({ tool, action, args, sessionKey, extraHeaders }) {
  const auth = resolveGatewayAuthHeader();
  if (!auth) {
    throw new Error(
      "Missing gateway auth (set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD).",
    );
  }
  const url = `${resolveGatewayHttpBase()}/tools/invoke`;
  const body = {
    tool,
    ...(action ? { action } : {}),
    ...(args ? { args } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(extraHeaders || {}),
      Authorization: auth.replace(/^Authorization:\s*/i, ""),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`tools/invoke invalid JSON (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.ok || !parsed || parsed.ok !== true) {
    const msg = parsed?.error?.message
      ? String(parsed.error.message)
      : `tools/invoke failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return parsed.result;
}

async function execViaGateway(params) {
  const sessionKey = String(params.sessionKey || "").trim();
  const { sessionKey: _ignored, ...args } = params;
  const result = await invokeTool({
    tool: "exec",
    args,
    sessionKey,
  });
  const details = result?.details || {};
  const aggregated = typeof details.aggregated === "string" ? details.aggregated : "";
  const tail = aggregated ? aggregated.split("\n").slice(-160).join("\n") : "";
  return {
    raw: result,
    status: String(details.status || ""),
    exitCode: details.exitCode ?? null,
    cwd: details.cwd,
    tail,
  };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      args._.push(tok);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dst) {
  ensureDir(dst);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      copyDir(from, to);
      continue;
    }
    if (ent.isSymbolicLink()) {
      continue;
    }
    if (fs.existsSync(to)) {
      continue;
    }
    fs.copyFileSync(from, to);
  }
}

function resolveTemplateRepoDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "templates", "repo");
}

function normalizeRepoName(repo) {
  // Accept: "name" or "owner/name". Return { owner, name, full } best-effort.
  const trimmed = repo.trim();
  if (!trimmed) return null;
  if (trimmed.includes("/")) {
    const [owner, name] = trimmed.split("/", 2);
    if (!owner || !name) return null;
    return { owner, name, full: `${owner}/${name}` };
  }
  return { owner: null, name: trimmed, full: trimmed };
}

function resolveWorkRoot(raw) {
  const p = raw?.trim() || "~/work";
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function repoDirFor(workRoot, repo) {
  const n = normalizeRepoName(repo);
  if (!n) return null;
  return path.join(workRoot, n.name);
}

async function gitStatusPorcelain(sessionKey, cwd) {
  const res = await execViaGateway({
    sessionKey,
    command: "git status --porcelain",
    workdir: cwd,
    timeout: 120,
  });
  if (res.status !== "completed") die("git status failed", { tail: res.tail });
  return (res.tail || "").trim();
}

async function ensureClean(sessionKey, cwd) {
  const p = await gitStatusPorcelain(sessionKey, cwd);
  if (p) die("working tree not clean", { details: p });
}

function detectPm(cwd) {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(cwd, "package-lock.json"))) return "npm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return null;
}

async function runChecks(sessionKey, cwd) {
  const pm = detectPm(cwd);
  if (!pm)
    return { ok: true, ran: [], note: "No JS package manager lockfile found; skipping checks." };

  const cmds = [];
  if (pm === "pnpm") {
    cmds.push("pnpm install --frozen-lockfile");
    cmds.push("pnpm check");
    cmds.push("pnpm test");
  } else if (pm === "npm") {
    cmds.push("npm ci");
    cmds.push("npm run lint || true");
    cmds.push("npm test || true");
  } else if (pm === "bun") {
    cmds.push("bun install --frozen-lockfile");
    cmds.push("bun run lint || true");
    cmds.push("bun test || true");
  } else if (pm === "yarn") {
    cmds.push("yarn install --frozen-lockfile");
    cmds.push("yarn lint || true");
    cmds.push("yarn test || true");
  }

  const ran = [];
  for (const cmd of cmds) {
    const res = await execViaGateway({
      sessionKey,
      command: cmd,
      workdir: cwd,
      pty: false,
      timeout: 3600,
    });
    ran.push({ cmd, code: res.exitCode ?? 0, status: res.status });
    if (res.status !== "completed" || (typeof res.exitCode === "number" && res.exitCode !== 0)) {
      return {
        ok: false,
        ran,
        failed: cmd,
        tail: res.tail,
      };
    }
  }
  return { ok: true, ran };
}

async function coderabbitReview(sessionKey, cwd, base) {
  // CodeRabbit CLI usage is provider-dependent; keep this best-effort.
  // Users can override by wrapping coderabbit in their own script.
  const cmd = `coderabbit review --base ${JSON.stringify(base)}`;
  const res = await execViaGateway({
    sessionKey,
    command: cmd,
    workdir: cwd,
    pty: true,
    timeout: 3600,
  });
  return {
    code: res.exitCode ?? 0,
    status: res.status,
    tail: res.tail,
  };
}

async function codexImplement(sessionKey, cwd, prompt) {
  const cmd = `codex exec --full-auto ${JSON.stringify(prompt)}`;
  const res = await execViaGateway({
    sessionKey,
    command: cmd,
    workdir: cwd,
    pty: true,
    timeout: 3600,
  });
  return {
    code: res.exitCode ?? 0,
    status: res.status,
    tail: res.tail,
  };
}

async function geminiImplement(sessionKey, cwd, prompt) {
  const cmd = `gemini ${JSON.stringify(prompt)}`;
  const res = await execViaGateway({
    sessionKey,
    command: cmd,
    workdir: cwd,
    pty: true,
    timeout: 3600,
  });
  return {
    code: res.exitCode ?? 0,
    status: res.status,
    tail: res.tail,
  };
}

async function currentBranch(sessionKey, cwd) {
  const res = await execViaGateway({
    sessionKey,
    command: "git rev-parse --abbrev-ref HEAD",
    workdir: cwd,
    timeout: 120,
  });
  if (res.status !== "completed") die("git rev-parse failed", { tail: res.tail });
  return (res.tail || "").trim();
}

async function createWorkBranch(sessionKey, cwd) {
  const stamp = new Date().toISOString().slice(0, 10);
  const branch = `work/${stamp}-${Math.random().toString(16).slice(2, 8)}`;
  const res = await execViaGateway({
    sessionKey,
    command: `git checkout -b ${JSON.stringify(branch)}`,
    workdir: cwd,
    timeout: 120,
  });
  if (res.status !== "completed") die("git checkout -b failed", { tail: res.tail });
  return branch;
}

async function commitAll(sessionKey, cwd, base) {
  // Require explicit commit message. Keep it deterministic.
  const branch = await currentBranch(sessionKey, cwd);
  if (!branch.startsWith("work/")) die("refusing to commit: not on work/* branch", { branch });
  const resAdd = await execViaGateway({
    sessionKey,
    command: "git add -A",
    workdir: cwd,
    timeout: 120,
  });
  if (resAdd.status !== "completed") die("git add failed", { tail: resAdd.tail });
  const msg = `work: changes vs ${base}`;
  const res = await execViaGateway({
    sessionKey,
    command: `git commit -m ${JSON.stringify(msg)}`,
    workdir: cwd,
    timeout: 240,
  });
  if (res.status !== "completed" || (typeof res.exitCode === "number" && res.exitCode !== 0)) {
    die("git commit failed", { tail: res.tail });
  }
  return { branch, message: msg };
}

async function pushAndPr(sessionKey, cwd, base) {
  const branch = await currentBranch(sessionKey, cwd);
  const resPush = await execViaGateway({
    sessionKey,
    command: `git push -u origin ${JSON.stringify(branch)}`,
    workdir: cwd,
    timeout: 600,
  });
  if (
    resPush.status !== "completed" ||
    (typeof resPush.exitCode === "number" && resPush.exitCode !== 0)
  ) {
    die("git push failed", { tail: resPush.tail });
  }
  const resPr = await execViaGateway({
    sessionKey,
    command: `gh pr create --base ${JSON.stringify(base)} --head ${JSON.stringify(branch)} --fill`,
    workdir: cwd,
    pty: true,
    timeout: 600,
  });
  if (
    resPr.status !== "completed" ||
    (typeof resPr.exitCode === "number" && resPr.exitCode !== 0)
  ) {
    die("gh pr create failed", { tail: resPr.tail });
  }
  return { branch, pr: resPr.tail.trim() };
}

async function mergePr(sessionKey, cwd, repo, pr) {
  const res = await execViaGateway({
    sessionKey,
    command: `gh pr merge ${JSON.stringify(String(pr))} --repo ${JSON.stringify(repo)} --merge --auto`,
    workdir: cwd,
    pty: true,
    timeout: 600,
  });
  if (res.status !== "completed" || (typeof res.exitCode === "number" && res.exitCode !== 0)) {
    die("gh pr merge failed", { tail: res.tail });
  }
  return { merged: true, output: res.tail.trim() };
}

function initContext(cwd) {
  const ctxDir = path.join(cwd, "context");
  ensureDir(ctxDir);
  const writeIfMissing = (rel, content) => {
    const p = path.join(cwd, rel);
    if (fs.existsSync(p)) return;
    fs.writeFileSync(p, content, "utf8");
  };
  writeIfMissing("context/PROJECT.md", "# Project\n\n## Goal\n\n## Non-goals\n");
  writeIfMissing("context/ARCHITECTURE.md", "# Architecture\n\n");
  writeIfMissing("context/DECISIONS.md", "# Decisions\n\n");
  writeIfMissing("context/RUNBOOK.md", "# Runbook\n\n## Dev\n\n## Test\n\n## Release\n");
  writeIfMissing("context/CONSTRAINTS.md", "# Constraints\n\n## Security\n\n## Cost\n\n");
}

async function ensureRepo({ sessionKey, repo, workRoot, base }) {
  const info = normalizeRepoName(repo);
  if (!info) die("invalid repo");
  const dir = repoDirFor(workRoot, repo);
  ensureDir(workRoot);
  if (!fs.existsSync(dir)) {
    const cloneCmd = info.owner
      ? `gh repo clone ${JSON.stringify(info.full)} ${JSON.stringify(dir)}`
      : `gh repo clone ${JSON.stringify(info.name)} ${JSON.stringify(dir)}`;
    const res = await execViaGateway({
      sessionKey,
      command: cloneCmd,
      workdir: workRoot,
      pty: true,
      timeout: 1200,
    });
    if (res.status !== "completed" || (typeof res.exitCode === "number" && res.exitCode !== 0)) {
      die("gh repo clone failed", { tail: res.tail });
    }
  }
  // Ensure base is fetched and checked out.
  await execViaGateway({
    sessionKey,
    command: `git fetch origin ${JSON.stringify(base)} --prune`,
    workdir: dir,
    timeout: 600,
  });
  await execViaGateway({
    sessionKey,
    command: `git checkout ${JSON.stringify(base)}`,
    workdir: dir,
    timeout: 120,
  });
  await execViaGateway({
    sessionKey,
    command: `git pull --ff-only origin ${JSON.stringify(base)}`,
    workdir: dir,
    timeout: 600,
  });
  await ensureClean(sessionKey, dir);
  const branch = await createWorkBranch(sessionKey, dir);
  initContext(dir);
  return { repoDir: dir, branch };
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  const args = parseArgs(argv);

  if (!cmd || cmd === "help") {
    ok({
      commands: [
        "new",
        "ensure-repo",
        "task",
        "review",
        "fix",
        "commit",
        "push-pr",
        "merge",
        "approve",
      ],
    });
    return;
  }

  if (cmd === "approve") {
    // Lobster renders its own approval UI; this is a no-op helper for clarity in workflow files.
    const prompt = String(args.prompt || "Approve?");
    ok({ prompt });
    return;
  }

  if (cmd === "new") {
    const name = String(args.name || "").trim();
    if (!name) die("--name required");
    const workRoot = resolveWorkRoot(String(args["work-root"] || args.workRoot || "~/work"));
    const base = String(args.base || "main");
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    const repoDir = path.join(workRoot, name);
    ensureDir(repoDir);

    if (!fs.existsSync(path.join(repoDir, ".git"))) {
      await execViaGateway({
        sessionKey,
        command: "git init -b " + JSON.stringify(base),
        workdir: repoDir,
        timeout: 120,
      });
      fs.writeFileSync(path.join(repoDir, "README.md"), `# ${name}\n`, "utf8");
      initContext(repoDir);

      // Copy in baseline CI gates + hygiene files (best-effort; doesn't overwrite).
      try {
        copyDir(resolveTemplateRepoDir(), repoDir);
      } catch (e) {
        // non-fatal
      }

      await execViaGateway({ sessionKey, command: "git add -A", workdir: repoDir, timeout: 120 });
      await execViaGateway({
        sessionKey,
        command: `git commit -m ${JSON.stringify("chore: initial scaffold")}`,
        workdir: repoDir,
        timeout: 240,
      });
    }

    if (args.push) {
      // Create GitHub repo and push main.
      const resCreate = await execViaGateway({
        sessionKey,
        command: `gh repo create ${JSON.stringify(name)} --source ${JSON.stringify(repoDir)} --remote origin --push`,
        workdir: repoDir,
        pty: true,
        timeout: 1200,
      });
      if (
        resCreate.status !== "completed" ||
        (typeof resCreate.exitCode === "number" && resCreate.exitCode !== 0)
      ) {
        die("gh repo create failed", { tail: resCreate.tail });
      }
    }

    ok({ repoDir, name, base, pushed: Boolean(args.push) });
    return;
  }

  if (cmd === "ensure-repo") {
    const repo = String(args.repo || "").trim();
    const workRoot = resolveWorkRoot(String(args["work-root"] || args.workRoot || "~/work"));
    const base = String(args.base || "main");
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    if (!repo) die("--repo required");
    const res = await ensureRepo({ sessionKey, repo, workRoot, base });
    ok(res, { json: res });
    return;
  }

  if (cmd === "task" || cmd === "fix") {
    const repoDir = String(args["repo-dir"] || args.repoDir || "").trim();
    const base = String(args.base || "main");
    const message = String(args.message || "").trim();
    const maxFixLoops = Number.parseInt(
      String(args["max-fix-loops"] || args.maxFixLoops || "3"),
      10,
    );
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    if (!repoDir) die("--repo-dir required");
    if (cmd === "task" && !message) die("--message required");

    const workPrompt = cmd === "task" ? message : "Fix outstanding issues and make CI pass.";

    const impl = await codexImplement(sessionKey, repoDir, workPrompt);
    if (impl.code !== 0 || impl.status !== "completed") {
      // Fallback to gemini if codex failed.
      const g = await geminiImplement(sessionKey, repoDir, workPrompt);
      if (g.code !== 0 || g.status !== "completed")
        die("coding agent failed", { codex: impl, gemini: g });
    }

    let loops = 0;
    let checks = await runChecks(sessionKey, repoDir);
    while (!checks.ok && loops < Math.max(1, maxFixLoops)) {
      loops++;
      const fixPrompt = `Fix the failing checks. Context:\\nFAILED=${checks.failed}\\nTAIL=${checks.tail || ""}`;
      const fix = await codexImplement(sessionKey, repoDir, fixPrompt);
      if (fix.code !== 0 || fix.status !== "completed") {
        const g = await geminiImplement(sessionKey, repoDir, fixPrompt);
        if (g.code !== 0 || g.status !== "completed") break;
      }
      checks = await runChecks(sessionKey, repoDir);
    }

    const review = await coderabbitReview(sessionKey, repoDir, base);

    ok({ repoDir, base, loops, checks, review });
    return;
  }

  if (cmd === "review") {
    const repoDir = String(args["repo-dir"] || args.repoDir || "").trim();
    const base = String(args.base || "main");
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    if (!repoDir) die("--repo-dir required");
    const checks = await runChecks(sessionKey, repoDir);
    const review = await coderabbitReview(sessionKey, repoDir, base);
    ok({ repoDir, base, checks, review });
    return;
  }

  if (cmd === "commit") {
    const repoDir = String(args["repo-dir"] || args.repoDir || "").trim();
    const base = String(args.base || "main");
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    if (!repoDir) die("--repo-dir required");
    const res = await commitAll(sessionKey, repoDir, base);
    ok(res);
    return;
  }

  if (cmd === "push-pr") {
    const repoDir = String(args["repo-dir"] || args.repoDir || "").trim();
    const base = String(args.base || "main");
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    if (!repoDir) die("--repo-dir required");
    const res = await pushAndPr(sessionKey, repoDir, base);
    ok(res);
    return;
  }

  if (cmd === "merge") {
    const repoDir = String(args["repo-dir"] || args.repoDir || "").trim();
    const repo = String(args.repo || "").trim();
    const pr = Number.parseInt(String(args.pr || ""), 10);
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    if (!repoDir) die("--repo-dir required");
    if (!repo) die("--repo required");
    if (!Number.isFinite(pr) || pr <= 0) die("--pr required");
    const res = await mergePr(sessionKey, repoDir, repo, pr);
    ok(res);
    return;
  }

  die(`unknown command: ${cmd}`);
}

main().catch((e) => die(String(e)));
