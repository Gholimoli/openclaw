import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  EvolutionAuditEntry,
  EvolutionInsight,
  EvolutionPauseState,
  EvolutionProposal,
  EvolutionRun,
  EvolutionSourceStore,
  OfficeActivityEntry,
  OfficeLayout,
} from "./types.js";
import { resolveStateDir } from "../config/paths.js";

export type EvolutionPaths = {
  root: string;
  sourcesPath: string;
  insightsPath: string;
  proposalsPath: string;
  runsPath: string;
  auditPath: string;
  officeLayoutPath: string;
  officeActivityPath: string;
  pausePath: string;
  mirrorDir: string;
};

const DEFAULT_LAYOUT: OfficeLayout = {
  version: 1,
  tileSize: 16,
  width: 64,
  height: 32,
  placements: {},
};

const DEFAULT_SOURCE_STORE: EvolutionSourceStore = {
  version: 1,
  sources: [],
  cursors: {},
};

const DEFAULT_PAUSE_STATE: EvolutionPauseState = {
  paused: false,
  updatedAtMs: 0,
  consecutiveFailures: 0,
  recentFailureTimestamps: [],
};

export function resolveEvolutionPaths(stateDir = resolveStateDir()): EvolutionPaths {
  const root = path.join(path.resolve(stateDir), "evolution");
  return {
    root,
    sourcesPath: path.join(root, "sources.json"),
    insightsPath: path.join(root, "insights.jsonl"),
    proposalsPath: path.join(root, "proposals.jsonl"),
    runsPath: path.join(root, "runs.jsonl"),
    auditPath: path.join(root, "audit.jsonl"),
    officeLayoutPath: path.join(root, "office.layout.json"),
    officeActivityPath: path.join(root, "office.activity.jsonl"),
    pausePath: path.join(root, "pause.json"),
    mirrorDir: path.join(root, "mirror", "openclaw"),
  };
}

async function ensureDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function readJsonOrDefault<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown) {
  await ensureDir(filePath);
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, filePath);
}

const writesByFile = new Map<string, Promise<void>>();

export async function appendJsonl(filePath: string, entry: unknown) {
  const resolved = path.resolve(filePath);
  const prev = writesByFile.get(resolved) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await ensureDir(resolved);
      await fs.appendFile(resolved, `${JSON.stringify(entry)}\n`, "utf-8");
    });
  writesByFile.set(resolved, next);
  await next;
}

export async function readJsonl<T>(filePath: string, opts?: { limit?: number }): Promise<T[]> {
  const limit = Math.max(1, Math.floor(opts?.limit ?? 50_000));
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const parsed: T[] = [];
    for (let i = Math.max(0, lines.length - limit); i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) {
        continue;
      }
      try {
        parsed.push(JSON.parse(line) as T);
      } catch {
        // Ignore malformed lines to preserve log continuity.
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

async function pruneJsonl(filePath: string, opts: { maxBytes: number; keepLines: number }) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size <= opts.maxBytes) {
    return;
  }
  const rows = await readJsonl<unknown>(filePath, { limit: opts.keepLines });
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
  await fs.rename(tmp, filePath);
}

export type EvolutionStore = {
  paths: EvolutionPaths;
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  readSources: () => Promise<EvolutionSourceStore>;
  writeSources: (value: EvolutionSourceStore) => Promise<void>;
  readInsights: (limit?: number) => Promise<EvolutionInsight[]>;
  appendInsight: (value: EvolutionInsight) => Promise<void>;
  readProposals: (limit?: number) => Promise<EvolutionProposal[]>;
  appendProposal: (value: EvolutionProposal) => Promise<void>;
  replaceProposals: (rows: EvolutionProposal[]) => Promise<void>;
  appendRun: (value: EvolutionRun) => Promise<void>;
  readRuns: (limit?: number) => Promise<EvolutionRun[]>;
  appendAudit: (value: EvolutionAuditEntry) => Promise<void>;
  readAudit: (limit?: number) => Promise<EvolutionAuditEntry[]>;
  readPauseState: () => Promise<EvolutionPauseState>;
  writePauseState: (value: EvolutionPauseState) => Promise<void>;
  readOfficeLayout: () => Promise<OfficeLayout>;
  writeOfficeLayout: (value: OfficeLayout) => Promise<void>;
  appendOfficeActivity: (value: OfficeActivityEntry) => Promise<void>;
  readOfficeActivity: (limit?: number) => Promise<OfficeActivityEntry[]>;
};

export function createEvolutionStore(paths: EvolutionPaths): EvolutionStore {
  let lock = Promise.resolve();
  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = lock;
    let release: (() => void) | undefined;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };

  return {
    paths,
    withLock,
    readSources: async () => await readJsonOrDefault(paths.sourcesPath, DEFAULT_SOURCE_STORE),
    writeSources: async (value) => await writeJsonAtomic(paths.sourcesPath, value),
    readInsights: async (limit) => await readJsonl<EvolutionInsight>(paths.insightsPath, { limit }),
    appendInsight: async (value) => {
      await appendJsonl(paths.insightsPath, value);
      await pruneJsonl(paths.insightsPath, { maxBytes: 20_000_000, keepLines: 200_000 });
    },
    readProposals: async (limit) =>
      await readJsonl<EvolutionProposal>(paths.proposalsPath, { limit }),
    appendProposal: async (value) => {
      await appendJsonl(paths.proposalsPath, value);
      await pruneJsonl(paths.proposalsPath, { maxBytes: 20_000_000, keepLines: 100_000 });
    },
    replaceProposals: async (rows) => {
      await ensureDir(paths.proposalsPath);
      const tmp = `${paths.proposalsPath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tmp, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf-8");
      await fs.rename(tmp, paths.proposalsPath);
    },
    appendRun: async (value) => {
      await appendJsonl(paths.runsPath, value);
      await pruneJsonl(paths.runsPath, { maxBytes: 8_000_000, keepLines: 50_000 });
    },
    readRuns: async (limit) => await readJsonl<EvolutionRun>(paths.runsPath, { limit }),
    appendAudit: async (value) => {
      await appendJsonl(paths.auditPath, value);
      await pruneJsonl(paths.auditPath, { maxBytes: 20_000_000, keepLines: 100_000 });
    },
    readAudit: async (limit) => await readJsonl<EvolutionAuditEntry>(paths.auditPath, { limit }),
    readPauseState: async () => await readJsonOrDefault(paths.pausePath, DEFAULT_PAUSE_STATE),
    writePauseState: async (value) => await writeJsonAtomic(paths.pausePath, value),
    readOfficeLayout: async () => await readJsonOrDefault(paths.officeLayoutPath, DEFAULT_LAYOUT),
    writeOfficeLayout: async (value) => await writeJsonAtomic(paths.officeLayoutPath, value),
    appendOfficeActivity: async (value) => {
      await appendJsonl(paths.officeActivityPath, value);
      await pruneJsonl(paths.officeActivityPath, {
        maxBytes: 10_000_000,
        keepLines: 100_000,
      });
    },
    readOfficeActivity: async (limit) =>
      await readJsonl<OfficeActivityEntry>(paths.officeActivityPath, { limit }),
  };
}
