#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function die(message) {
  process.stderr.write(`clawforge-preflight: ${message}\n`);
  process.exit(1);
}

function mustEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) {
    die(`missing required env var: ${name}`);
  }
  return v;
}

function readJsonFile(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
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
          // `**/` matches zero or more directories.
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
    if (!pat) {
      continue;
    }
    if (globToRegExp(String(pat)).test(p)) {
      return true;
    }
  }
  return false;
}

function classifyRiskTier(changedFiles, rules) {
  for (const rule of rules || []) {
    const tier = String(rule?.tier || "").trim();
    const matchAny = rule?.matchAny || [];
    if (!tier) {
      continue;
    }
    for (const file of changedFiles) {
      if (matchesAny(file, matchAny)) {
        return tier;
      }
    }
  }
  return "high";
}

function readChangedFiles(baseSha) {
  try {
    const out = execSync(`git diff --name-only ${baseSha} HEAD`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(normalizePath);
  } catch {
    process.stderr.write(`clawforge-preflight: git diff failed, fail-safe to high tier\n`);
    return null;
  }
}

function writeOutputs(outputs) {
  const outFile = mustEnv("GITHUB_OUTPUT");
  let buf = "";
  for (const [k, v] of Object.entries(outputs)) {
    buf += `${k}=${String(v)}\n`;
  }
  fs.appendFileSync(outFile, buf, "utf8");
}

async function ghJson(urlPath) {
  const token = mustEnv("GITHUB_TOKEN");
  const repo = mustEnv("GITHUB_REPOSITORY");
  const url = `https://api.github.com/repos/${repo}${urlPath}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "openclaw-clawforge-preflight",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status} ${urlPath}: ${text.slice(0, 500)}`);
  }
  return await res.json();
}

async function waitForCodeRabbit({ prNumber, expectedHeadSha, appSlugMatch, timeoutMinutes }) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMinutes || 20)) * 60_000;
  const match = String(appSlugMatch || "coderabbit").toLowerCase();

  while (Date.now() < deadline) {
    const pr = await ghJson(`/pulls/${prNumber}`);
    const headSha = String(pr?.head?.sha || "");
    if (!headSha) {
      throw new Error("Unable to resolve PR head SHA from GitHub API.");
    }
    if (headSha !== expectedHeadSha) {
      throw new Error(
        `PR head SHA changed while waiting for review agent. expected=${expectedHeadSha} observed=${headSha}`,
      );
    }

    const checkRunsResp = await ghJson(`/commits/${expectedHeadSha}/check-runs?per_page=100`);
    const checkRuns = Array.isArray(checkRunsResp?.check_runs) ? checkRunsResp.check_runs : [];
    const matches = checkRuns.filter((cr) => {
      const slug = String(cr?.app?.slug || "").toLowerCase();
      const name = String(cr?.app?.name || "").toLowerCase();
      return (slug && slug.includes(match)) || (name && name.includes(match));
    });

    if (matches.length > 0) {
      const notCompleted = matches.filter((cr) => String(cr?.status || "") !== "completed");
      if (notCompleted.length === 0) {
        const bad = matches.filter((cr) => String(cr?.conclusion || "") !== "success");
        if (bad.length === 0) {
          process.stdout.write(
            `clawforge-preflight: CodeRabbit check runs: ${matches.length} completed success\n`,
          );
          return;
        }

        const summary = bad
          .map((cr) => `${String(cr?.name || "unknown")}=${String(cr?.conclusion || "unknown")}`)
          .slice(0, 5)
          .join(", ");
        throw new Error(`Review agent check runs completed but not successful: ${summary}`);
      }
    }

    await new Promise((r) => setTimeout(r, 15_000));
  }

  throw new Error("Timed out waiting for CodeRabbit check runs to complete successfully.");
}

async function main() {
  const repoRoot = process.cwd();
  const contractPath = path.join(repoRoot, ".clawforge", "contract.json");
  if (!fs.existsSync(contractPath)) {
    die(`missing contract: ${contractPath}`);
  }
  const contract = readJsonFile(contractPath);

  const eventName = String(process.env.GITHUB_EVENT_NAME || "").trim();
  const eventPath = mustEnv("GITHUB_EVENT_PATH");
  const event = readJsonFile(eventPath);

  const baseSha =
    eventName === "pull_request"
      ? String(event?.pull_request?.base?.sha || "")
      : eventName === "push"
        ? String(event?.before || "")
        : "";
  if (!baseSha) {
    die(`unsupported or missing base SHA for event: ${eventName}`);
  }

  const changedFiles = readChangedFiles(baseSha);
  const files = changedFiles ?? [];

  const riskTier = changedFiles ? classifyRiskTier(files, contract?.riskTierRules || []) : "high";

  const overrides =
    (contract?.ciPolicy?.scopeOverridesByTier || {})[riskTier] ||
    (contract?.ciPolicy?.scopeOverridesByTier || {})["high"] ||
    {};

  const evidenceRequired = Array.isArray(contract?.evidenceRules)
    ? contract.evidenceRules.some((rule) => matchesAnyFromList(files, rule?.matchAny || []))
    : false;

  // Docs drift rules.
  const driftRules = Array.isArray(contract?.ciPolicy?.docsDriftRules)
    ? contract.ciPolicy.docsDriftRules
    : [];
  for (const rule of driftRules) {
    const ifChangedAny = rule?.ifChangedAny || [];
    const mustAlsoChangeAny = rule?.mustAlsoChangeAny || [];
    const message = String(rule?.message || "ClawForge docs drift rule violated.");
    if (matchesAnyFromList(files, ifChangedAny) && !matchesAnyFromList(files, mustAlsoChangeAny)) {
      process.stderr.write(`clawforge-preflight: ${message}\n`);
      process.stderr.write(`clawforge-preflight: changed files:\n`);
      for (const f of files.slice(0, 200)) {
        process.stderr.write(`- ${f}\n`);
      }
      process.exit(1);
    }
  }

  // Review agent wait (PR only, high risk by default).
  const review = contract?.reviewAgent || {};
  if (
    eventName === "pull_request" &&
    review?.enabled === true &&
    Array.isArray(review?.requiredTiers) &&
    review.requiredTiers.includes(riskTier)
  ) {
    const prNumber = Number(event?.pull_request?.number || 0);
    const headSha = String(event?.pull_request?.head?.sha || "");
    if (!prNumber || !headSha) {
      die("missing PR metadata for review agent wait");
    }
    process.stdout.write(
      `clawforge-preflight: waiting for review agent (tier=${riskTier} pr=#${prNumber} head=${headSha.slice(0, 8)})\n`,
    );
    await waitForCodeRabbit({
      prNumber,
      expectedHeadSha: headSha,
      appSlugMatch: String(review?.appSlugMatch || "coderabbit"),
      timeoutMinutes: Number(review?.timeoutMinutes || 20),
    });
  }

  const outputs = {
    risk_tier: riskTier,
    force_run_node: String(Boolean(overrides?.run_node)),
    force_run_macos: String(Boolean(overrides?.run_macos)),
    force_run_android: String(Boolean(overrides?.run_android)),
    require_ui_evidence: String(Boolean(evidenceRequired || overrides?.run_ui_evidence)),
  };

  writeOutputs(outputs);
  process.stdout.write(
    `clawforge-preflight: ok tier=${riskTier} ui_evidence=${outputs.require_ui_evidence}\n`,
  );
}

function matchesAnyFromList(files, patterns) {
  for (const f of files || []) {
    if (matchesAny(f, patterns)) {
      return true;
    }
  }
  return false;
}

main().catch((e) => {
  process.stderr.write(`clawforge-preflight: ${e?.stack || String(e)}\n`);
  process.exit(1);
});
