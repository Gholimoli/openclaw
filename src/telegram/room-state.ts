import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveMirroredTranscriptText } from "../config/sessions/transcript.js";

export type TelegramRoomStateKind = "human" | "agent" | "system";

export type TelegramRoomStateEntry = {
  kind: TelegramRoomStateKind;
  actorLabel: string;
  body: string;
  timestamp: number;
  messageId?: string;
  agentId?: string;
};

type TelegramRoomStateFile = {
  version: 1;
  entries: TelegramRoomStateEntry[];
};

const ROOM_STATE_VERSION = 1 as const;
const writeChains = new Map<string, Promise<TelegramRoomStateEntry[]>>();

function sanitizePathSegment(value: string): string {
  return encodeURIComponent(value.trim() || "default");
}

export function resolveTelegramRoomStatePath(params: {
  accountId?: string | null;
  peerId: string;
}): string {
  return path.join(
    resolveStateDir(process.env),
    "telegram",
    "rooms",
    sanitizePathSegment(params.accountId?.trim() || "default"),
    `${sanitizePathSegment(params.peerId)}.json`,
  );
}

function normalizeBody(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function trimEntries(entries: TelegramRoomStateEntry[], limit: number): TelegramRoomStateEntry[] {
  if (limit <= 0) {
    return [];
  }
  if (entries.length <= limit) {
    return entries;
  }
  return entries.slice(entries.length - limit);
}

function readEntriesSync(filePath: string): TelegramRoomStateEntry[] {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<TelegramRoomStateFile>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      return [];
    }
    return parsed.entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const body = typeof entry.body === "string" ? normalizeBody(entry.body) : "";
      const actorLabel = typeof entry.actorLabel === "string" ? entry.actorLabel.trim() : "";
      const kind = entry.kind;
      const timestamp =
        typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
          ? entry.timestamp
          : Date.now();
      if (!body || !actorLabel) {
        return [];
      }
      if (kind !== "human" && kind !== "agent" && kind !== "system") {
        return [];
      }
      return [
        {
          kind,
          actorLabel,
          body,
          timestamp,
          messageId:
            typeof entry.messageId === "string" && entry.messageId.trim()
              ? entry.messageId.trim()
              : undefined,
          agentId:
            typeof entry.agentId === "string" && entry.agentId.trim()
              ? entry.agentId.trim()
              : undefined,
        } satisfies TelegramRoomStateEntry,
      ];
    });
  } catch {
    return [];
  }
}

async function writeEntries(filePath: string, entries: TelegramRoomStateEntry[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const payload: TelegramRoomStateFile = {
    version: ROOM_STATE_VERSION,
    entries,
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.promises.rename(tmpPath, filePath);
}

export async function readTelegramRoomStateEntries(params: {
  accountId?: string | null;
  peerId: string;
  limit?: number;
}): Promise<TelegramRoomStateEntry[]> {
  const filePath = resolveTelegramRoomStatePath(params);
  const entries = readEntriesSync(filePath);
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(0, Math.floor(params.limit))
      : undefined;
  return typeof limit === "number" ? trimEntries(entries, limit) : entries;
}

export async function appendTelegramRoomStateEntry(params: {
  accountId?: string | null;
  peerId: string;
  historyLimit: number;
  entry: TelegramRoomStateEntry;
}): Promise<TelegramRoomStateEntry[]> {
  const filePath = resolveTelegramRoomStatePath(params);
  const key = filePath;
  const previous = writeChains.get(key) ?? Promise.resolve(readEntriesSync(filePath));
  const next = previous
    .catch(() => readEntriesSync(filePath))
    .then(async (entries) => {
      const body = normalizeBody(params.entry.body);
      const actorLabel = params.entry.actorLabel.trim();
      if (!body || !actorLabel) {
        return trimEntries(entries, params.historyLimit);
      }
      const merged = trimEntries(
        [
          ...entries,
          {
            ...params.entry,
            body,
            actorLabel,
            timestamp:
              typeof params.entry.timestamp === "number" && Number.isFinite(params.entry.timestamp)
                ? params.entry.timestamp
                : Date.now(),
          },
        ],
        params.historyLimit,
      );
      await writeEntries(filePath, merged);
      return merged;
    })
    .finally(() => {
      if (writeChains.get(key) === next) {
        writeChains.delete(key);
      }
    });
  writeChains.set(key, next);
  return await next;
}

export async function appendTelegramRoomStateVisibleReply(params: {
  accountId?: string | null;
  peerId: string;
  historyLimit: number;
  actorLabel: string;
  agentId: string;
  text?: string;
  mediaUrls?: string[];
}): Promise<TelegramRoomStateEntry[] | null> {
  const body = resolveMirroredTranscriptText({
    text: params.text,
    mediaUrls: params.mediaUrls,
  });
  if (!body) {
    return null;
  }
  return await appendTelegramRoomStateEntry({
    accountId: params.accountId,
    peerId: params.peerId,
    historyLimit: params.historyLimit,
    entry: {
      kind: "agent",
      actorLabel: params.actorLabel,
      body,
      agentId: params.agentId,
      timestamp: Date.now(),
    },
  });
}

export function buildTelegramRoomStateContext(params: {
  entries: TelegramRoomStateEntry[];
  excludeMessageId?: string;
}): string | undefined {
  const lines = params.entries
    .filter((entry) => entry.messageId !== params.excludeMessageId)
    .map((entry) => `${entry.actorLabel}: ${entry.body}`);
  if (lines.length === 0) {
    return undefined;
  }
  return ["Shared room log (untrusted room-visible context):", ...lines].join("\n");
}
