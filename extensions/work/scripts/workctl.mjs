#!/usr/bin/env node
import { execSync } from "node:child_process";
import crypto from "node:crypto";
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
  const { sessionKey: _ignored, env, ...args } = params;
  const githubEnv = await resolveGitHubEnv();
  const result = await invokeTool({
    tool: "exec",
    args: {
      ...args,
      env: { ...githubEnv, ...(env || {}) },
    },
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

const githubTokenCache = {
  token: "",
  expiresAtMs: 0,
};

function resolveGitHubAuthMode() {
  const directToken = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (directToken) {
    return "env-token";
  }
  const appId = String(process.env.GITHUB_APP_ID || "").trim();
  const installationId = String(process.env.GITHUB_APP_INSTALLATION_ID || "").trim();
  const privateKey = resolveGitHubAppPrivateKey();
  if (appId && installationId && privateKey) {
    return "github-app";
  }
  return "missing";
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll(/=+$/g, "");
}

function resolveGitHubAppPrivateKey() {
  const explicit = String(process.env.GITHUB_APP_PRIVATE_KEY || "").trim();
  if (explicit) {
    return explicit.replaceAll("\\n", "\n");
  }
  const keyFile = String(process.env.GITHUB_APP_PRIVATE_KEY_FILE || "").trim();
  if (!keyFile) {
    return "";
  }
  return fs.readFileSync(keyFile, "utf8").replaceAll("\\n", "\n").trim();
}

async function mintGitHubAppToken() {
  const directToken = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (directToken) {
    return directToken;
  }
  const nowMs = Date.now();
  if (githubTokenCache.token && githubTokenCache.expiresAtMs - nowMs > 60_000) {
    return githubTokenCache.token;
  }
  const appId = String(process.env.GITHUB_APP_ID || "").trim();
  const installationId = String(process.env.GITHUB_APP_INSTALLATION_ID || "").trim();
  const privateKey = resolveGitHubAppPrivateKey();
  if (!appId || !installationId || !privateKey) {
    return "";
  }
  const nowSec = Math.floor(nowMs / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: nowSec - 30,
      exp: nowSec + 9 * 60,
      iss: appId,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey);
  const jwt = `${unsigned}.${base64UrlEncode(signature)}`;
  const res = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "openclaw-workctl",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!res.ok || !parsed?.token) {
    throw new Error(
      parsed?.message || `GitHub App token mint failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
    );
  }
  const expiresAtMs = parsed?.expires_at ? Date.parse(parsed.expires_at) : nowMs + 50 * 60_000;
  githubTokenCache.token = String(parsed.token);
  githubTokenCache.expiresAtMs = Number.isFinite(expiresAtMs) ? expiresAtMs : nowMs + 50 * 60_000;
  return githubTokenCache.token;
}

async function resolveGitHubEnv() {
  const token = await mintGitHubAppToken();
  const authMode = resolveGitHubAuthMode();
  if (!token) {
    return { OPENCLAW_GITHUB_AUTH_MODE: authMode };
  }
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    OPENCLAW_GITHUB_AUTH_MODE: authMode,
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

function resolveStateRoot() {
  const explicit = String(
    process.env.OPENCLAW_STATE_DIR || process.env.CLAWDBOT_STATE_DIR || "",
  ).trim();
  if (explicit) {
    return explicit;
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveAutomationEventsPath() {
  return path.join(resolveStateRoot(), "automation", "events.jsonl");
}

function appendAutomationRawEvent(event) {
  const filePath = resolveAutomationEventsPath();
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
}

function resolveRunContextPath(repoDir) {
  return path.join(repoDir, ".openclaw", "automation-run.json");
}

function readRunContext(repoDir) {
  const filePath = resolveRunContextPath(repoDir);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeRunContext(repoDir, value) {
  const filePath = resolveRunContextPath(repoDir);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function currentRun(repoDir) {
  return readRunContext(repoDir)?.run || null;
}

function upsertRun(repoDir, run) {
  writeRunContext(repoDir, { run });
  appendAutomationRawEvent({
    kind: "run.upsert",
    ts: Date.now(),
    run,
  });
  return run;
}

function withRun(repoDir, mutate) {
  const run = currentRun(repoDir);
  if (!run) {
    return null;
  }
  const next = mutate({
    ...run,
    updatedAtMs: Date.now(),
  });
  return upsertRun(repoDir, next);
}

function appendRunStep(repoDir, step) {
  const run = currentRun(repoDir);
  if (!run) {
    return null;
  }
  const entry = {
    id: step.id || crypto.randomUUID(),
    runId: run.id,
    ts: Date.now(),
    ...step,
  };
  appendAutomationRawEvent({
    kind: "step.append",
    ts: entry.ts,
    step: entry,
  });
  withRun(repoDir, (current) => ({
    ...current,
    lastStepLabel: entry.label,
    status: entry.status === "failed" ? "failed" : current.status,
  }));
  return entry;
}

function appendRunAudit(repoDir, entry) {
  const run = currentRun(repoDir);
  const auditEntry = {
    id: entry.id || crypto.randomUUID(),
    runId: run?.id,
    repo: run?.repo,
    branch: run?.branch,
    ts: Date.now(),
    ...entry,
  };
  appendAutomationRawEvent({
    kind: "audit.append",
    ts: auditEntry.ts,
    entry: auditEntry,
  });
  return auditEntry;
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
  const trimmed = repo.trim();
  if (!trimmed) return null;
  const httpsMatch =
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (httpsMatch?.[1] && httpsMatch?.[2]) {
    const owner = httpsMatch[1];
    const name = httpsMatch[2];
    return { owner, name, full: `${owner}/${name}` };
  }
  if (trimmed.includes("/")) {
    const [owner, name] = trimmed.split("/", 2);
    if (!owner || !name) return null;
    return { owner, name, full: `${owner}/${name}` };
  }
  return { owner: null, name: trimmed, full: trimmed };
}

function resolveWorkRoot(raw) {
  const p = raw?.trim() || "~/work/repos";
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function repoDirFor(workRoot, repo) {
  const n = normalizeRepoName(repo);
  if (!n) return null;
  return n.owner ? path.join(workRoot, n.owner, n.name) : path.join(workRoot, n.name);
}

function validateGitRefName(value, label) {
  const v = String(value || "").trim();
  if (!v || !/^[A-Za-z0-9._/-]+$/.test(v) || v.startsWith("-") || v.includes("..")) {
    die(`invalid ${label}`, { value: v });
  }
  return v;
}

function validateRepoSlug(value, label) {
  const v = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) {
    die(`invalid ${label}`, { value: v });
  }
  return v;
}

function normalizePath(p) {
  return String(p || "").replaceAll("\\", "/");
}

function globToRegExp(glob) {
  const g = normalizePath(glob);
  let out = "^";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      const next = g[i + 1];
      if (next === "*") {
        const after = g[i + 2];
        if (after === "/") {
          out += "(?:.*\\/)?";
          i += 2;
          continue;
        }
        out += ".*";
        i += 1;
        continue;
      }
      out += "[^/]*";
      continue;
    }
    if ("\\.^$+?()[]{}|".includes(ch)) {
      out += `\\${ch}`;
      continue;
    }
    if (ch === "/") {
      out += "\\/";
      continue;
    }
    out += ch;
  }
  out += "$";
  return new RegExp(out);
}

function matchesAny(filePath, patterns) {
  const p = normalizePath(filePath);
  for (const pat of patterns || []) {
    if (!pat) continue;
    if (globToRegExp(String(pat)).test(p)) return true;
  }
  return false;
}

function matchesAnyFromList(files, patterns) {
  for (const f of files || []) {
    if (matchesAny(f, patterns)) return true;
  }
  return false;
}

function loadClawforgeContract(repoDir) {
  const contractPath = path.join(repoDir, ".clawforge", "contract.json");
  if (!fs.existsSync(contractPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (e) {
    return { error: `invalid ClawForge contract JSON: ${String(e)}` };
  }
}

function gitChangedFilesAgainstOriginBase(repoDir, base) {
  const safeBase = validateGitRefName(base, "base branch");
  try {
    const out = execSync(`git -C ${JSON.stringify(repoDir)} diff --name-only origin/${safeBase}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(normalizePath);
  } catch {
    return null;
  }
}

function classifyClawforgeRiskTier(changedFiles, rules) {
  for (const rule of rules || []) {
    const tier = String(rule?.tier || "").trim();
    const matchAny = rule?.matchAny || [];
    if (!tier) continue;
    if (matchesAnyFromList(changedFiles, matchAny)) return tier;
  }
  return "high";
}

function hasPackageJsonScript(repoDir, scriptName) {
  const pkgPath = path.join(repoDir, "package.json");
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return Boolean(pkg?.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, scriptName));
  } catch {
    return false;
  }
}

function computeClawforgeContext(repoDir, base) {
  const contract = loadClawforgeContract(repoDir);
  if (!contract || contract?.error) {
    return contract?.error ? { enabled: false, error: contract.error } : null;
  }

  const changedFiles = gitChangedFilesAgainstOriginBase(repoDir, base);
  const files = changedFiles ?? [];

  const riskTier = changedFiles
    ? classifyClawforgeRiskTier(files, contract?.riskTierRules || [])
    : "high";

  const evidenceRules = Array.isArray(contract?.evidenceRules) ? contract.evidenceRules : [];
  const requireUiEvidence = evidenceRules.some((rule) => {
    const req = Array.isArray(rule?.require) ? rule.require : [];
    return req.includes("ui_evidence") && matchesAnyFromList(files, rule?.matchAny || []);
  });

  return {
    enabled: true,
    riskTier,
    requireUiEvidence,
    changedFilesCount: files.length,
  };
}

async function runRequiredExec({ sessionKey, cwd, command, timeout = 600, pty = false, error }) {
  const res = await execViaGateway({
    sessionKey,
    command,
    workdir: cwd,
    timeout,
    pty,
  });
  if (res.status !== "completed" || (typeof res.exitCode === "number" && res.exitCode !== 0)) {
    die(error || "command failed", { command, tail: res.tail, exitCode: res.exitCode });
  }
  return res;
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

function buildCheckCommands(cwd, opts = {}) {
  const pm = detectPm(cwd);
  if (!pm) {
    return [];
  }
  const clawforge = opts?.clawforge?.enabled ? opts.clawforge : null;
  const riskTier = String(clawforge?.riskTier || "").trim();
  const requireUiEvidence = Boolean(clawforge?.requireUiEvidence);
  const cmds = [];
  if (pm === "pnpm") {
    cmds.push("pnpm install --frozen-lockfile");
    cmds.push("pnpm check");

    if (riskTier === "high") {
      cmds.push("pnpm build");
      cmds.push("pnpm protocol:check");
      cmds.push("pnpm test");
    } else if (riskTier === "medium") {
      cmds.push("pnpm test");
    } else if (riskTier === "low") {
      if (hasPackageJsonScript(cwd, "test:fast")) {
        cmds.push("pnpm test:fast");
      } else {
        cmds.push("pnpm test");
      }
    } else {
      cmds.push("pnpm test");
    }

    if (requireUiEvidence) {
      if (fs.existsSync(path.join(cwd, "ui", "package.json"))) {
        cmds.push("pnpm --dir ui exec playwright install chromium");
      }
      if (hasPackageJsonScript(cwd, "test:ui")) {
        cmds.push("pnpm test:ui");
      }
    }
    return cmds;
  }
  if (pm === "npm") {
    return ["npm ci", "npm run lint || true", "npm test || true"];
  }
  if (pm === "bun") {
    return ["bun install --frozen-lockfile", "bun run lint || true", "bun test || true"];
  }
  if (pm === "yarn") {
    return ["yarn install --frozen-lockfile", "yarn lint || true", "yarn test || true"];
  }
  return [];
}

async function runChecks(sessionKey, cwd, opts = {}) {
  const pm = detectPm(cwd);
  if (!pm)
    return { ok: true, ran: [], note: "No JS package manager lockfile found; skipping checks." };

  const clawforge = opts?.clawforge?.enabled ? opts.clawforge : null;
  const riskTier = String(clawforge?.riskTier || "").trim();
  const requireUiEvidence = Boolean(clawforge?.requireUiEvidence);
  const cmds = buildCheckCommands(cwd, opts);

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
        ...(clawforge
          ? {
              clawforge: {
                riskTier,
                requireUiEvidence,
                changedFilesCount: clawforge.changedFilesCount,
              },
            }
          : {}),
      };
    }
  }
  return { ok: true, ran };
}

async function resolveRepoMetadata(sessionKey, repoDir) {
  const remote = await execViaGateway({
    sessionKey,
    command: "git remote get-url origin",
    workdir: repoDir,
    timeout: 120,
  }).catch(() => null);
  const remoteUrl = remote?.status === "completed" ? String(remote.tail || "").trim() : "";
  const repo = normalizeRepoName(remoteUrl);
  const baseMeta = {
    repo: repo?.full || path.basename(repoDir),
    repoUrl: remoteUrl || undefined,
    defaultBranch: "",
    activePrNumbers: [],
  };
  const gh = await execViaGateway({
    sessionKey,
    command: "gh repo view --json nameWithOwner,url,defaultBranchRef",
    workdir: repoDir,
    timeout: 120,
  }).catch(() => null);
  if (gh?.status === "completed") {
    try {
      const parsed = JSON.parse(gh.tail || "{}");
      baseMeta.repo = String(parsed.nameWithOwner || baseMeta.repo).trim() || baseMeta.repo;
      baseMeta.repoUrl = String(parsed.url || baseMeta.repoUrl || "").trim() || undefined;
      baseMeta.defaultBranch =
        String(parsed?.defaultBranchRef?.name || "").trim() || baseMeta.defaultBranch;
    } catch {}
  }
  const prs = await execViaGateway({
    sessionKey,
    command: "gh pr list --state open --json number --limit 20",
    workdir: repoDir,
    timeout: 120,
  }).catch(() => null);
  if (prs?.status === "completed") {
    try {
      const parsed = JSON.parse(prs.tail || "[]");
      if (Array.isArray(parsed)) {
        baseMeta.activePrNumbers = parsed
          .map((entry) => Number.parseInt(String(entry?.number || ""), 10))
          .filter((value) => Number.isFinite(value) && value > 0);
      }
    } catch {}
  }
  return baseMeta;
}

async function probeToolchain(sessionKey, cwd) {
  const res = await execViaGateway({
    sessionKey,
    command:
      "bash -lc 'for bin in codex gemini gemini-yolo agent cursor-agent agent-full cursor-agent-full gcloud x-cli gh git coderabbit; do " +
      'if command -v "$bin" >/dev/null 2>&1; then printf "%s=ok\\n" "$bin"; else printf "%s=missing\\n" "$bin"; fi; ' +
      "done; " +
      'if [ -f "$HOME/.codex/config.toml" ]; then echo CODEX_CONFIG=ok; else echo CODEX_CONFIG=missing; fi; ' +
      'if [ -f "$HOME/.gemini/policies/openclaw-yolo.toml" ]; then echo GEMINI_POLICY=ok; else echo GEMINI_POLICY=missing; fi; ' +
      'if [ -f "$HOME/.config/x-cli/.env" ]; then echo X_CLI_AUTH=ok; else echo X_CLI_AUTH=missing; fi; ' +
      'if [ -n "$OPENCLAW_GITHUB_AUTH_MODE" ]; then echo OPENCLAW_GITHUB_AUTH_MODE="$OPENCLAW_GITHUB_AUTH_MODE"; else echo OPENCLAW_GITHUB_AUTH_MODE=missing; fi; ' +
      'if [ -n "$OPENAI_API_KEY" ]; then echo OPENAI_API_KEY=ok; else echo OPENAI_API_KEY=missing; fi; ' +
      'if [ -n "$GEMINI_API_KEY" ]; then echo GEMINI_API_KEY=ok; else echo GEMINI_API_KEY=missing; fi; ' +
      'if command -v gcloud >/dev/null 2>&1; then active="$(gcloud auth list --filter=status:ACTIVE --format='\''value(account)'\'' 2>/dev/null | head -n 1 || true)"; if [ -n "$active" ]; then echo GCLOUD_AUTH=ok; else echo GCLOUD_AUTH=missing; fi; else echo GCLOUD_AUTH=missing; fi\'',
    workdir: cwd,
    timeout: 120,
  });
  const lines = String(res.tail || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const map = {};
  for (const line of lines) {
    const [key, value] = line.split("=", 2);
    if (!key || !value) continue;
    map[key] = value;
  }
  return map;
}

function defaultAcceptanceCriteria(message) {
  return [
    "Implement the requested change in the target repository.",
    "Run the required local validation commands for the repo risk tier.",
    "Prepare the branch for review and PR creation without broadening approvals.",
    `Address this request: ${message}`,
  ];
}

function buildSpecPacket(params) {
  const availableClis = Array.isArray(params.availableClis) ? params.availableClis : [];
  return {
    repo: params.repo,
    repoUrl: params.repoUrl,
    repoDir: params.repoDir,
    base: params.base,
    branch: params.branch,
    defaultBranch: params.defaultBranch || undefined,
    userRequest: params.message,
    goal: params.message,
    nonGoals: [
      "Do not modify deployment policy or network exposure.",
      "Do not bypass approvals for commit, push, merge, or deploy.",
      "Do not introduce unrelated refactors.",
    ],
    acceptanceCriteria: defaultAcceptanceCriteria(params.message),
    riskTier: params.clawforge?.riskTier || "high",
    checks: buildCheckCommands(params.repoDir, { clawforge: params.clawforge }),
    approvalRequirements: ["commit changes", "push branch + open PR"],
    activePrNumbers: params.activePrNumbers || [],
    planner: {
      agentId: params.plannerAgentId || "main",
      displayName: params.plannerDisplayName || "Ted",
      model: params.plannerModel || "gpt-5.4",
    },
    implementation: {
      agentId: params.implementationAgentId || "coder",
      primaryCli: "codex",
      fallbackCli: "gemini",
      availableClis,
      accessMode: "full-access",
      authMode: "hybrid",
      model: params.implementationModel || undefined,
      fallbackModel: params.fallbackModel || undefined,
    },
  };
}

function buildImplementationPrompt(params) {
  const lines = [
    "You are the OpenClaw implementation worker inside the coder sandbox.",
    "Use the structured packet below as the source of truth for repo, goal, non-goals, checks, and approvals.",
    "Keep changes minimal and task-scoped. Do not broaden network, approval, or deployment policy.",
  ];

  if (params.failureContext) {
    lines.push(
      "This is a remediation pass. Fix only the reported failures and preserve all passing behavior.",
    );
  }

  lines.push(
    "",
    "Structured implementation packet:",
    "```json",
    JSON.stringify(params.specPacket, null, 2),
    "```",
  );

  if (params.failureContext) {
    lines.push(
      "",
      "Failure context:",
      "```json",
      JSON.stringify(params.failureContext, null, 2),
      "```",
    );
  }

  return lines.join("\n");
}

async function gitHeadSha(sessionKey, cwd) {
  const res = await execViaGateway({
    sessionKey,
    command: "git rev-parse HEAD",
    workdir: cwd,
    timeout: 120,
  });
  if (res.status !== "completed") return "";
  return (res.tail || "").trim();
}

async function coderabbitReview(sessionKey, cwd, base) {
  // CodeRabbit CLI usage is provider-dependent; keep this best-effort.
  // Users can override by wrapping coderabbit in their own script.
  const headSha = await gitHeadSha(sessionKey, cwd);

  const baseCmd = `coderabbit review --base ${JSON.stringify(base)}`;
  const candidates = [`${baseCmd} --plain`, `${baseCmd} --prompt-only`, baseCmd];

  const attempts = [];
  for (const cmd of candidates) {
    const res = await execViaGateway({
      sessionKey,
      command: cmd,
      workdir: cwd,
      pty: true,
      timeout: 3600,
    });
    const code = res.exitCode ?? 0;
    const status = res.status;
    const tail = res.tail;
    attempts.push({ cmd, code, status });

    const isUnknownFlag =
      code !== 0 &&
      typeof tail === "string" &&
      (tail.includes("unknown option") ||
        tail.includes("Unknown option") ||
        tail.includes("unrecognized option") ||
        tail.includes("flag provided but not defined"));

    if (code !== 0 && cmd !== baseCmd && isUnknownFlag) {
      continue;
    }

    return { code, status, tail, headSha, cmd, attempts };
  }

  return { code: 1, status: "completed", tail: "coderabbit review failed", headSha, attempts };
}

async function codexImplement(sessionKey, cwd, prompt, model) {
  const modelArg =
    typeof model === "string" && model.trim() ? ` --model ${JSON.stringify(model.trim())}` : "";
  const cmd = `codex exec --full-auto${modelArg} ${JSON.stringify(prompt)}`;
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

async function geminiImplement(sessionKey, cwd, prompt, model) {
  const modelArg =
    typeof model === "string" && model.trim() ? ` --model ${JSON.stringify(model.trim())}` : "";
  const cmd = `gemini --approval-mode yolo${modelArg} ${JSON.stringify(prompt)}`;
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

async function resolveMergePreflight(sessionKey, cwd, repo, pr) {
  const view = await execViaGateway({
    sessionKey,
    command:
      `gh pr view ${JSON.stringify(String(pr))}` +
      ` --repo ${JSON.stringify(repo)}` +
      " --json number,headRefOid,mergeStateStatus,reviewDecision,isDraft,title,url",
    workdir: cwd,
    timeout: 120,
  });
  if (view.status !== "completed" || (typeof view.exitCode === "number" && view.exitCode !== 0)) {
    die("gh pr view failed", { tail: view.tail });
  }
  let prMeta = {};
  try {
    prMeta = JSON.parse(view.tail || "{}");
  } catch {
    die("invalid gh pr view json", { tail: view.tail });
  }

  const checks = await execViaGateway({
    sessionKey,
    command:
      `gh pr checks ${JSON.stringify(String(pr))}` +
      ` --repo ${JSON.stringify(repo)}` +
      " --required --json name,bucket,state,workflow,link",
    workdir: cwd,
    timeout: 120,
  });
  if (
    checks.status !== "completed" ||
    (typeof checks.exitCode === "number" && checks.exitCode > 1 && checks.exitCode !== 8)
  ) {
    die("gh pr checks failed", { tail: checks.tail });
  }

  let requiredChecks = [];
  try {
    requiredChecks = JSON.parse(checks.tail || "[]");
  } catch {
    die("invalid gh pr checks json", { tail: checks.tail });
  }

  const blockedReasons = [];
  const mergeStateStatus = String(prMeta.mergeStateStatus || "").trim();
  const reviewDecision = String(prMeta.reviewDecision || "").trim();
  const headSha = String(prMeta.headRefOid || "").trim();

  if (!headSha) {
    blockedReasons.push("missing PR head SHA");
  }
  if (prMeta.isDraft === true) {
    blockedReasons.push("pull request is still a draft");
  }
  if (reviewDecision === "CHANGES_REQUESTED") {
    blockedReasons.push("review decision is CHANGES_REQUESTED");
  }
  if (!["CLEAN", "HAS_HOOKS"].includes(mergeStateStatus)) {
    blockedReasons.push(`merge state is ${mergeStateStatus || "unknown"}`);
  }

  const failingChecks = requiredChecks.filter((entry) => String(entry?.bucket || "") === "fail");
  const pendingChecks = requiredChecks.filter((entry) =>
    ["pending", "skipping", "cancel"].includes(String(entry?.bucket || "")),
  );
  if (failingChecks.length > 0) {
    blockedReasons.push(
      `required checks failing: ${failingChecks.map((entry) => entry.name || entry.workflow || "unknown").join(", ")}`,
    );
  }
  if (pendingChecks.length > 0) {
    blockedReasons.push(
      `required checks pending: ${pendingChecks.map((entry) => entry.name || entry.workflow || "unknown").join(", ")}`,
    );
  }

  return {
    repo,
    pr,
    title: String(prMeta.title || "").trim() || undefined,
    url: String(prMeta.url || "").trim() || undefined,
    headSha,
    mergeStateStatus: mergeStateStatus || undefined,
    reviewDecision: reviewDecision || undefined,
    requiredChecks,
    requiredChecksSummary:
      requiredChecks.length === 0
        ? "no required checks reported"
        : requiredChecks
            .map((entry) => `${entry.name || entry.workflow || "check"}:${entry.bucket || entry.state || "unknown"}`)
            .join(", "),
    blockedReasons,
    ok: blockedReasons.length === 0,
  };
}

async function mergePr(sessionKey, cwd, repo, pr, expectedHeadSha) {
  const preflight = await resolveMergePreflight(sessionKey, cwd, repo, pr);
  if (!preflight.ok) {
    die("merge preflight failed", preflight);
  }
  if (expectedHeadSha && preflight.headSha !== expectedHeadSha) {
    die("merge blocked: PR head changed after approval", {
      expectedHeadSha,
      currentHeadSha: preflight.headSha,
      pr,
      repo,
    });
  }
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

async function ensureRepo({ sessionKey, repo, workRoot, base, createWorkBranch: createBranch }) {
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
  const shouldCreateBranch = createBranch !== false;
  if (!shouldCreateBranch) {
    return { repoDir: dir };
  }
  const branch = await createWorkBranch(sessionKey, dir);
  initContext(dir);
  return { repoDir: dir, branch };
}

async function prepareUpstreamSync({
  sessionKey,
  repo,
  workRoot,
  base,
  upstreamRepo,
  syncBranch,
  keepWorkflowFiles,
}) {
  const safeBase = validateGitRefName(base, "base branch");
  const safeSyncBranch = validateGitRefName(syncBranch, "sync branch");
  const safeUpstreamRepo = validateRepoSlug(upstreamRepo, "upstream repo");
  const keepWorkflows = keepWorkflowFiles !== false;

  const ensured = await ensureRepo({
    sessionKey,
    repo,
    workRoot,
    base: safeBase,
    createWorkBranch: false,
  });
  const repoDir = String(ensured.repoDir || "").trim();
  if (!repoDir) {
    die("failed to resolve repo dir");
  }
  await ensureClean(sessionKey, repoDir);

  await execViaGateway({
    sessionKey,
    command: "git remote remove upstream || true",
    workdir: repoDir,
    timeout: 120,
  });
  await runRequiredExec({
    sessionKey,
    cwd: repoDir,
    command: `git remote add upstream ${JSON.stringify(`https://github.com/${safeUpstreamRepo}.git`)}`,
    timeout: 120,
    error: "git remote add upstream failed",
  });
  await runRequiredExec({
    sessionKey,
    cwd: repoDir,
    command: `git fetch --no-tags origin ${JSON.stringify(safeBase)} --prune`,
    timeout: 600,
    error: "git fetch origin failed",
  });
  await runRequiredExec({
    sessionKey,
    cwd: repoDir,
    command: `git fetch --no-tags upstream ${JSON.stringify(safeBase)} --prune`,
    timeout: 600,
    error: "git fetch upstream failed",
  });

  const counts = await runRequiredExec({
    sessionKey,
    cwd: repoDir,
    command:
      "git rev-list --left-right --count " +
      JSON.stringify(`origin/${safeBase}...upstream/${safeBase}`),
    timeout: 120,
    error: "git rev-list failed",
  });
  const [localOnlyRaw, upstreamOnlyRaw] = String(counts.tail || "")
    .trim()
    .split(/\s+/g);
  const localOnly = Number.parseInt(localOnlyRaw || "0", 10) || 0;
  const upstreamOnly = Number.parseInt(upstreamOnlyRaw || "0", 10) || 0;

  if (upstreamOnly === 0) {
    return {
      status: "already_synced",
      repoDir,
      base: safeBase,
      syncBranch: safeSyncBranch,
      upstreamRepo: safeUpstreamRepo,
      localOnly,
      upstreamOnly,
    };
  }

  await runRequiredExec({
    sessionKey,
    cwd: repoDir,
    command: `git checkout -B ${JSON.stringify(safeSyncBranch)} ${JSON.stringify(`origin/${safeBase}`)}`,
    timeout: 120,
    error: "git checkout sync branch failed",
  });

  const merge = await execViaGateway({
    sessionKey,
    command: `git merge --no-ff --no-commit ${JSON.stringify(`upstream/${safeBase}`)}`,
    workdir: repoDir,
    timeout: 300,
  });
  if (
    merge.status !== "completed" ||
    (typeof merge.exitCode === "number" && merge.exitCode !== 0)
  ) {
    const conflicts = await execViaGateway({
      sessionKey,
      command: "git diff --name-only --diff-filter=U",
      workdir: repoDir,
      timeout: 120,
    });
    await execViaGateway({
      sessionKey,
      command: "git merge --abort || true",
      workdir: repoDir,
      timeout: 120,
    });
    await execViaGateway({
      sessionKey,
      command: `git checkout ${JSON.stringify(safeBase)}`,
      workdir: repoDir,
      timeout: 120,
    });
    return {
      status: "conflicts",
      repoDir,
      base: safeBase,
      syncBranch: safeSyncBranch,
      upstreamRepo: safeUpstreamRepo,
      localOnly,
      upstreamOnly,
      conflicts: String(conflicts.tail || "")
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean),
    };
  }

  if (keepWorkflows) {
    await execViaGateway({
      sessionKey,
      command:
        "git restore --source " +
        JSON.stringify(`origin/${safeBase}`) +
        " --staged --worktree .github/workflows || true",
      workdir: repoDir,
      timeout: 120,
    });
  }

  const noDelta = await execViaGateway({
    sessionKey,
    command: "git diff --cached --quiet && git diff --quiet",
    workdir: repoDir,
    timeout: 120,
  });
  if (noDelta.status === "completed" && (noDelta.exitCode === 0 || noDelta.exitCode === null)) {
    await execViaGateway({
      sessionKey,
      command: "git merge --abort || true",
      workdir: repoDir,
      timeout: 120,
    });
    await execViaGateway({
      sessionKey,
      command: `git checkout ${JSON.stringify(safeBase)}`,
      workdir: repoDir,
      timeout: 120,
    });
    return {
      status: "no_delta_after_keep_rules",
      repoDir,
      base: safeBase,
      syncBranch: safeSyncBranch,
      upstreamRepo: safeUpstreamRepo,
      localOnly,
      upstreamOnly,
    };
  }

  await runRequiredExec({
    sessionKey,
    cwd: repoDir,
    command: `git commit -m ${JSON.stringify(`chore: sync upstream ${safeBase}`)}`,
    timeout: 240,
    error: "git commit failed",
  });

  const commitSummary = await execViaGateway({
    sessionKey,
    command:
      "git log --oneline --no-merges --max-count 80 " + JSON.stringify(`origin/${safeBase}..HEAD`),
    workdir: repoDir,
    timeout: 120,
  });

  return {
    status: "ready_to_publish",
    repoDir,
    base: safeBase,
    syncBranch: safeSyncBranch,
    upstreamRepo: safeUpstreamRepo,
    localOnly,
    upstreamOnly,
    keepWorkflowFiles: keepWorkflows,
    commitSummary: String(commitSummary.tail || "")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 80),
  };
}

async function publishUpstreamSync({ sessionKey, repoDir, base, syncBranch, upstreamRepo }) {
  const safeBase = validateGitRefName(base, "base branch");
  const safeSyncBranch = validateGitRefName(syncBranch, "sync branch");
  const safeUpstreamRepo = validateRepoSlug(upstreamRepo, "upstream repo");

  await runRequiredExec({
    sessionKey,
    cwd: repoDir,
    command: `git checkout ${JSON.stringify(safeSyncBranch)}`,
    timeout: 120,
    error: "git checkout sync branch failed",
  });

  const hasDelta = await execViaGateway({
    sessionKey,
    command: "git diff --quiet " + JSON.stringify(`origin/${safeBase}...HEAD`),
    workdir: repoDir,
    timeout: 120,
  });
  if (hasDelta.status === "completed" && (hasDelta.exitCode === 0 || hasDelta.exitCode === null)) {
    return {
      status: "no_publish_needed",
      reason: `No delta between ${safeSyncBranch} and origin/${safeBase}.`,
      syncBranch: safeSyncBranch,
      base: safeBase,
      upstreamRepo: safeUpstreamRepo,
    };
  }

  await runRequiredExec({
    sessionKey,
    cwd: repoDir,
    command: `git push --force-with-lease origin ${JSON.stringify(safeSyncBranch)}`,
    timeout: 600,
    error: "git push failed",
  });

  const title = `chore: sync upstream ${safeBase}`;
  const body =
    `Automated upstream sync from ${safeUpstreamRepo}:${safeBase}.\n\n` +
    "- Prepared by /work upstream (Lobster + approval gates).\n" +
    "- This PR is never auto-merged.\n";
  const findPr = await execViaGateway({
    sessionKey,
    command:
      "gh pr list --head " +
      JSON.stringify(safeSyncBranch) +
      " --base " +
      JSON.stringify(safeBase) +
      " --state open --json number --jq '.[0].number // empty'",
    workdir: repoDir,
    timeout: 120,
  });
  const prNumber = String(findPr.tail || "").trim();

  if (prNumber) {
    await runRequiredExec({
      sessionKey,
      cwd: repoDir,
      command:
        "gh pr edit " +
        JSON.stringify(prNumber) +
        " --title " +
        JSON.stringify(title) +
        " --body " +
        JSON.stringify(body),
      pty: true,
      timeout: 600,
      error: "gh pr edit failed",
    });
    return {
      status: "pr_updated",
      prNumber,
      syncBranch: safeSyncBranch,
      base: safeBase,
      upstreamRepo: safeUpstreamRepo,
    };
  }

  const created = await runRequiredExec({
    sessionKey,
    cwd: repoDir,
    command:
      "gh pr create --title " +
      JSON.stringify(title) +
      " --body " +
      JSON.stringify(body) +
      " --base " +
      JSON.stringify(safeBase) +
      " --head " +
      JSON.stringify(safeSyncBranch),
    pty: true,
    timeout: 600,
    error: "gh pr create failed",
  });
  return {
    status: "pr_created",
    pr: String(created.tail || "").trim(),
    syncBranch: safeSyncBranch,
    base: safeBase,
    upstreamRepo: safeUpstreamRepo,
  };
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
        "merge-preflight",
        "merge",
        "upstream-sync",
        "upstream-publish",
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

  if (cmd === "upstream-sync") {
    const repo = String(args.repo || "").trim();
    const workRoot = resolveWorkRoot(String(args["work-root"] || args.workRoot || "~/work"));
    const base = String(args.base || "main");
    const upstreamRepo = String(args["upstream-repo"] || args.upstreamRepo || "").trim();
    const syncBranch = String(args["sync-branch"] || args.syncBranch || "").trim();
    const keepWorkflowFilesRaw = String(
      args["keep-workflow-files"] || args.keepWorkflowFiles || "true",
    )
      .trim()
      .toLowerCase();
    const keepWorkflowFiles = !["0", "false", "no", "off"].includes(keepWorkflowFilesRaw);
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    if (!repo) die("--repo required");
    if (!upstreamRepo) die("--upstream-repo required");
    if (!syncBranch) die("--sync-branch required");
    const res = await prepareUpstreamSync({
      sessionKey,
      repo,
      workRoot,
      base,
      upstreamRepo,
      syncBranch,
      keepWorkflowFiles,
    });
    ok(res, { json: res });
    return;
  }

  if (cmd === "upstream-publish") {
    const repoDir = String(args["repo-dir"] || args.repoDir || "").trim();
    const base = String(args.base || "main");
    const upstreamRepo = String(args["upstream-repo"] || args.upstreamRepo || "").trim();
    const syncBranch = String(args["sync-branch"] || args.syncBranch || "").trim();
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    if (!repoDir) die("--repo-dir required");
    if (!upstreamRepo) die("--upstream-repo required");
    if (!syncBranch) die("--sync-branch required");
    const res = await publishUpstreamSync({
      sessionKey,
      repoDir,
      base,
      syncBranch,
      upstreamRepo,
    });
    ok(res, { json: res });
    return;
  }

  if (cmd === "task" || cmd === "fix") {
    const repoDir = String(args["repo-dir"] || args.repoDir || "").trim();
    const base = String(args.base || "main");
    const message = String(args.message || "").trim();
    const plannerModel = String(args["planner-model"] || args.plannerModel || "").trim();
    const implementationModel = String(
      args["implementation-model"] || args.implementationModel || "",
    ).trim();
    const fallbackModel = String(args["fallback-model"] || args.fallbackModel || "").trim();
    const maxFixLoops = Number.parseInt(
      String(args["max-fix-loops"] || args.maxFixLoops || "3"),
      10,
    );
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    if (!repoDir) die("--repo-dir required");
    if (cmd === "task" && !message) die("--message required");

    const workPrompt = cmd === "task" ? message : "Fix outstanding issues and make CI pass.";
    const branch = await currentBranch(sessionKey, repoDir).catch(() => "");
    let clawforge = computeClawforgeContext(repoDir, base);
    if (clawforge?.enabled === false) die("clawforge contract error", { error: clawforge.error });
    const repoMeta = await resolveRepoMetadata(sessionKey, repoDir);
    const toolchain = await probeToolchain(sessionKey, repoDir).catch(() => ({}));
    const availableClis = ["codex", "gemini"].filter((key) => toolchain[key] === "ok");
    const toolchainSummary = [
      "codex",
      "gemini",
      "gemini-yolo",
      "agent",
      "cursor-agent",
      "agent-full",
      "cursor-agent-full",
      "gcloud",
      "x-cli",
      "gh",
      "git",
      "coderabbit",
    ].filter((key) => toolchain[key] === "ok");

    let specPacket = currentRun(repoDir)?.specPacket || null;
    if (cmd === "task" || !currentRun(repoDir)) {
      specPacket = buildSpecPacket({
        repo: repoMeta.repo,
        repoUrl: repoMeta.repoUrl,
        repoDir,
        base,
        branch,
        defaultBranch: repoMeta.defaultBranch || base,
        message: workPrompt,
        clawforge,
        activePrNumbers: repoMeta.activePrNumbers,
        plannerModel,
        implementationModel,
        fallbackModel,
        availableClis,
      });
      upsertRun(repoDir, {
        id: crypto.randomUUID(),
        repo: repoMeta.repo,
        repoUrl: repoMeta.repoUrl,
        repoDir,
        base,
        branch,
        defaultBranch: repoMeta.defaultBranch || base,
        status: "running",
        title: workPrompt.slice(0, 120),
        userRequest: workPrompt,
        riskTier: specPacket.riskTier,
        plannerAgentId: "main",
        plannerDisplayName: "Ted",
        plannerModel: plannerModel || "gpt-5.4",
        implementationAgentId: "coder",
        implementationCli: "codex",
        implementationFallbackCli: "gemini",
        implementationModel: implementationModel || undefined,
        fallbackModel: fallbackModel || undefined,
        startedAtMs: Date.now(),
        updatedAtMs: Date.now(),
        specPacket,
        summary: "Spec prepared and implementation started.",
      });
      appendRunAudit(repoDir, {
        kind: "run.started",
        status: "running",
        message: "Structured implementation packet prepared.",
        actor: { id: "main", type: "agent", label: "Ted" },
        data: {
          specPacket,
          toolchain,
          toolchainSummary,
          githubAuthMode: toolchain.OPENCLAW_GITHUB_AUTH_MODE || "missing",
        },
      });
    }
    const implementationPrompt = buildImplementationPrompt({
      specPacket,
    });
    appendRunStep(repoDir, {
      status: "running",
      label: "Implementation",
      detail: "Dispatching the structured packet to the coder sandbox.",
      actor: { id: "coder", type: "agent", label: "coder" },
      data: {
        availableClis,
        authMode: specPacket?.implementation?.authMode || "hybrid",
        githubAuthMode: toolchain.OPENCLAW_GITHUB_AUTH_MODE || "missing",
      },
    });

    const impl = await codexImplement(sessionKey, repoDir, implementationPrompt, implementationModel);
    let selectedCli = "codex";
    if (impl.code !== 0 || impl.status !== "completed") {
      // Fallback to gemini if codex failed.
      appendRunAudit(repoDir, {
        kind: "implementation.fallback",
        status: "degraded",
        message: "Codex CLI failed; attempting Gemini fallback.",
        actor: { id: "coder", type: "agent", label: "coder" },
        data: { codex: impl },
      });
      const g = await geminiImplement(sessionKey, repoDir, implementationPrompt, fallbackModel);
      if (g.code !== 0 || g.status !== "completed") {
        withRun(repoDir, (run) => ({
          ...run,
          status: "failed",
          finishedAtMs: Date.now(),
          summary: "Implementation failed in both Codex and Gemini fallback.",
        }));
        appendRunStep(repoDir, {
          status: "failed",
          label: "Implementation",
          detail: "Both Codex and Gemini failed.",
          actor: { id: "coder", type: "agent", label: "coder" },
          data: { codex: impl, gemini: g },
        });
        die("coding agent failed", { codex: impl, gemini: g });
      }
      selectedCli = "gemini";
    }
    withRun(repoDir, (run) => ({
      ...run,
      implementationUsedCli: selectedCli,
      summary: `Implementation completed with ${selectedCli}.`,
    }));
    appendRunAudit(repoDir, {
      kind: "implementation.completed",
      status: "completed",
      message: `Structured packet executed with ${selectedCli}.`,
      actor: { id: "coder", type: "agent", label: "coder" },
      data: {
        selectedCli,
        availableClis,
        authMode: specPacket?.implementation?.authMode || "hybrid",
        githubAuthMode: toolchain.OPENCLAW_GITHUB_AUTH_MODE || "missing",
        toolchain,
      },
    });

    let loops = 0;
    let checks = await runChecks(sessionKey, repoDir, { clawforge });
    appendRunStep(repoDir, {
      status: checks.ok ? "completed" : "running",
      label: "Validation",
      detail: checks.ok ? "Required local checks passed." : "Validation failed; entering fix loop.",
      actor: { id: "coder", type: "agent", label: "coder" },
      data: { checks },
    });
    while (!checks.ok && loops < Math.max(1, maxFixLoops)) {
      loops++;
      const fixPrompt = buildImplementationPrompt({
        specPacket,
        failureContext: {
          failedCommand: checks.failed || null,
          tail: checks.tail || "",
          loop: loops,
        },
      });
      appendRunAudit(repoDir, {
        kind: "validation.retry",
        status: "running",
        message: `Validation retry ${loops} started.`,
        actor: { id: "coder", type: "agent", label: "coder" },
        data: { failed: checks.failed, tail: checks.tail || "" },
      });
      const fix = await codexImplement(sessionKey, repoDir, fixPrompt, implementationModel);
      let retryCli = "codex";
      if (fix.code !== 0 || fix.status !== "completed") {
        const g = await geminiImplement(sessionKey, repoDir, fixPrompt, fallbackModel);
        if (g.code !== 0 || g.status !== "completed") break;
        retryCli = "gemini";
      }
      withRun(repoDir, (run) => ({
        ...run,
        implementationUsedCli: retryCli,
      }));
      clawforge = computeClawforgeContext(repoDir, base);
      if (clawforge?.enabled === false) die("clawforge contract error", { error: clawforge.error });
      checks = await runChecks(sessionKey, repoDir, { clawforge });
    }

    const review = await coderabbitReview(sessionKey, repoDir, base);
    appendRunStep(repoDir, {
      status: review.code === 0 ? "completed" : "failed",
      label: "AI review",
      detail:
        review.code === 0 ? "CodeRabbit review completed." : "CodeRabbit review reported an issue.",
      actor: { id: "coderabbit", type: "tool", label: "CodeRabbit" },
      data: { review },
    });
    withRun(repoDir, (run) => ({
      ...run,
      status: checks.ok && review.code === 0 ? "awaiting_approval" : "failed",
      summary:
        checks.ok && review.code === 0
          ? "Implementation complete; awaiting commit approval."
          : "Implementation finished with outstanding validation or review failures.",
      finishedAtMs: checks.ok && review.code === 0 ? undefined : Date.now(),
    }));

    ok({
      repoDir,
      base,
      loops,
      clawforge,
      checks,
      review,
      runId: currentRun(repoDir)?.id || null,
      specPacket: currentRun(repoDir)?.specPacket || null,
    });
    return;
  }

  if (cmd === "review") {
    const repoDir = String(args["repo-dir"] || args.repoDir || "").trim();
    const base = String(args.base || "main");
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    if (!repoDir) die("--repo-dir required");
    const clawforge = computeClawforgeContext(repoDir, base);
    if (clawforge?.enabled === false) die("clawforge contract error", { error: clawforge.error });
    const checks = await runChecks(sessionKey, repoDir, { clawforge });
    const review = await coderabbitReview(sessionKey, repoDir, base);
    ok({ repoDir, base, clawforge, checks, review });
    return;
  }

  if (cmd === "commit") {
    const repoDir = String(args["repo-dir"] || args.repoDir || "").trim();
    const base = String(args.base || "main");
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    if (!repoDir) die("--repo-dir required");
    const res = await commitAll(sessionKey, repoDir, base);
    appendRunStep(repoDir, {
      status: "completed",
      label: "Commit",
      detail: `Committed ${res.branch} with "${res.message}".`,
      actor: { id: "git", type: "tool", label: "git" },
      data: res,
    });
    withRun(repoDir, (run) => ({
      ...run,
      branch: res.branch,
      status: "awaiting_approval",
      summary: "Commit created; awaiting PR push approval.",
    }));
    ok(res);
    return;
  }

  if (cmd === "push-pr") {
    const repoDir = String(args["repo-dir"] || args.repoDir || "").trim();
    const base = String(args.base || "main");
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    if (!repoDir) die("--repo-dir required");
    const res = await pushAndPr(sessionKey, repoDir, base);
    appendRunStep(repoDir, {
      status: "completed",
      label: "Push and PR",
      detail: "Branch pushed and pull request opened.",
      actor: { id: "gh", type: "tool", label: "GitHub CLI" },
      data: res,
    });
    withRun(repoDir, (run) => ({
      ...run,
      branch: res.branch,
      status: "completed",
      finishedAtMs: Date.now(),
      summary: "Pull request opened and ready for CI/merge automation.",
    }));
    ok(res);
    return;
  }

  if (cmd === "merge-preflight") {
    const repoDir = String(args["repo-dir"] || args.repoDir || "").trim();
    const repo = String(args.repo || "").trim();
    const pr = Number.parseInt(String(args.pr || ""), 10);
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    if (!repoDir) die("--repo-dir required");
    if (!repo) die("--repo required");
    if (!Number.isFinite(pr) || pr <= 0) die("--pr required");
    const preflight = await resolveMergePreflight(sessionKey, repoDir, repo, pr);
    if (!preflight.ok) {
      die("merge preflight failed", preflight);
    }
    ok(preflight, { json: preflight });
    return;
  }

  if (cmd === "merge") {
    const repoDir = String(args["repo-dir"] || args.repoDir || "").trim();
    const repo = String(args.repo || "").trim();
    const pr = Number.parseInt(String(args.pr || ""), 10);
    const expectedHeadSha = String(
      args["expected-head-sha"] || args.expectedHeadSha || "",
    ).trim();
    const sessionKey = String(args["session-key"] || args.sessionKey || "agent:coder:main").trim();
    if (!repoDir) die("--repo-dir required");
    if (!repo) die("--repo required");
    if (!Number.isFinite(pr) || pr <= 0) die("--pr required");
    const res = await mergePr(
      sessionKey,
      repoDir,
      repo,
      pr,
      expectedHeadSha || undefined,
    );
    appendRunStep(repoDir, {
      status: "completed",
      label: "Merge",
      detail: `PR #${pr} merge requested.`,
      actor: { id: "gh", type: "tool", label: "GitHub CLI" },
      data: res,
    });
    withRun(repoDir, (run) => ({
      ...run,
      status: "completed",
      finishedAtMs: Date.now(),
      summary: `Merge triggered for PR #${pr}.`,
    }));
    ok(res);
    return;
  }

  die(`unknown command: ${cmd}`);
}

main().catch((e) => die(String(e)));
