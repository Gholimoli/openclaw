import fs from "node:fs";
import path from "node:path";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig, TelegramClientConfig } from "../config/config.js";
import type { ResolvedAgentRoute, RoutePeer } from "../routing/resolve-route.js";
import { listAgentIds } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import {
  buildAgentMainSessionKey,
  buildAgentPeerSessionKey,
  normalizeAccountId,
  normalizeAgentId,
} from "../routing/session-key.js";

export type TelegramClientRouteState = {
  peerId: string;
  accountId: string;
  agentId?: string;
  updatedAt: number;
  updatedBy?: string;
};

type TelegramClientRouteStore = {
  version: 1;
  routes: Record<string, TelegramClientRouteState>;
};

export type TelegramResolvedClientRoute = {
  peerId: string;
  route: ResolvedAgentRoute;
  clientConfig?: TelegramClientConfig;
  routeState?: TelegramClientRouteState;
  assignedAgentId?: string;
  overrideApplied: boolean;
};

export type TelegramResolvedClientRouteSummary = {
  peerId: string;
  accountId: string;
  enabled: boolean;
  label?: string;
  defaultAgentId?: string;
  assignedAgentId?: string;
  allowedAgents?: string[];
  updatedAt?: number;
  updatedBy?: string;
};

const STORE_VERSION = 1 as const;
let cachedStorePath = "";
let cachedStoreMtimeMs = -1;
let cachedStore: TelegramClientRouteStore | null = null;

export function clearTelegramClientRouteStoreCacheForTest() {
  cachedStorePath = "";
  cachedStoreMtimeMs = -1;
  cachedStore = null;
}

function resolveStorePath() {
  return path.join(resolveStateDir(process.env), "telegram", "client-routes.json");
}

function buildStoreKey(accountId: string, peerId: string) {
  return `${normalizeAccountId(accountId)}:${peerId.trim()}`;
}

function loadStore(): TelegramClientRouteStore {
  const storePath = resolveStorePath();
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(storePath).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (cachedStore && cachedStorePath === storePath && cachedStoreMtimeMs === mtimeMs) {
    return cachedStore;
  }
  let next: TelegramClientRouteStore = { version: STORE_VERSION, routes: {} };
  try {
    const parsed = JSON.parse(
      fs.readFileSync(storePath, "utf8"),
    ) as Partial<TelegramClientRouteStore>;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.routes &&
      typeof parsed.routes === "object"
    ) {
      next = {
        version: STORE_VERSION,
        routes: Object.fromEntries(
          Object.entries(parsed.routes).flatMap(([key, value]) => {
            if (!value || typeof value !== "object") {
              return [];
            }
            const route = value as Partial<TelegramClientRouteState>;
            const peerId = typeof route.peerId === "string" ? route.peerId.trim() : "";
            if (!peerId) {
              return [];
            }
            const accountId = normalizeAccountId(route.accountId);
            const agentId =
              typeof route.agentId === "string" && route.agentId.trim()
                ? normalizeAgentId(route.agentId)
                : undefined;
            return [
              [
                key,
                {
                  peerId,
                  accountId,
                  agentId,
                  updatedAt:
                    typeof route.updatedAt === "number" && Number.isFinite(route.updatedAt)
                      ? route.updatedAt
                      : 0,
                  updatedBy:
                    typeof route.updatedBy === "string" && route.updatedBy.trim()
                      ? route.updatedBy.trim()
                      : undefined,
                } satisfies TelegramClientRouteState,
              ],
            ];
          }),
        ),
      };
    }
  } catch {
    next = { version: STORE_VERSION, routes: {} };
  }
  cachedStorePath = storePath;
  cachedStoreMtimeMs = mtimeMs;
  cachedStore = next;
  return next;
}

async function saveStore(store: TelegramClientRouteStore) {
  const storePath = resolveStorePath();
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.tmp`;
  await fs.promises.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await fs.promises.rename(tmpPath, storePath);
  try {
    cachedStoreMtimeMs = fs.statSync(storePath).mtimeMs;
  } catch {
    cachedStoreMtimeMs = -1;
  }
  cachedStorePath = storePath;
  cachedStore = store;
}

function resolveClientConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  peerId: string;
}): TelegramClientConfig | undefined {
  const telegram = params.cfg.channels?.telegram;
  if (!telegram) {
    return undefined;
  }
  const accountId = normalizeAccountId(params.accountId);
  const base = telegram.clients?.[params.peerId];
  const account = telegram.accounts?.[accountId]?.clients?.[params.peerId];
  if (!base && !account) {
    return undefined;
  }
  return {
    ...base,
    ...account,
  };
}

function normalizeAllowedAgents(
  cfg: OpenClawConfig,
  client?: TelegramClientConfig,
): string[] | undefined {
  const raw = Array.isArray(client?.allowedAgents) ? client.allowedAgents : undefined;
  if (!raw) {
    return undefined;
  }
  const valid = new Set(listAgentIds(cfg));
  const next = raw
    .map((entry) => normalizeAgentId(entry))
    .filter((entry) => entry && valid.has(entry));
  return next.length > 0 ? next : [];
}

function resolveAssignedAgentId(params: {
  cfg: OpenClawConfig;
  clientConfig?: TelegramClientConfig;
  routeState?: TelegramClientRouteState;
}): string | undefined {
  const validAgents = new Set(listAgentIds(params.cfg));
  const allowedAgents = normalizeAllowedAgents(params.cfg, params.clientConfig);
  const candidate = params.routeState?.agentId || params.clientConfig?.defaultAgentId;
  if (!candidate || !candidate.trim()) {
    return undefined;
  }
  const normalized = normalizeAgentId(candidate);
  if (!validAgents.has(normalized)) {
    return undefined;
  }
  if (allowedAgents && allowedAgents.length > 0 && !allowedAgents.includes(normalized)) {
    return undefined;
  }
  return normalized;
}

export function resolveTelegramClientPeerIdFromContext(
  ctx: Pick<MsgContext, "From">,
): string | undefined {
  const from = ctx.From?.trim() ?? "";
  if (!from) {
    return undefined;
  }
  if (from.startsWith("telegram:group:")) {
    return from.slice("telegram:group:".length) || undefined;
  }
  if (from.startsWith("telegram:")) {
    return from.slice("telegram:".length) || undefined;
  }
  return undefined;
}

export function resolveTelegramClientRoute(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  peer: RoutePeer;
  parentPeer?: RoutePeer | null;
}): TelegramResolvedClientRoute {
  const accountId = normalizeAccountId(params.accountId);
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "telegram",
    accountId,
    peer: params.peer,
    parentPeer: params.parentPeer,
  });
  const clientConfig = resolveClientConfig({
    cfg: params.cfg,
    accountId,
    peerId: params.peer.id,
  });
  const routeState = loadStore().routes[buildStoreKey(accountId, params.peer.id)];
  const enabled = clientConfig?.enabled !== false && Boolean(clientConfig);
  if (!enabled) {
    return {
      peerId: params.peer.id,
      route,
      clientConfig,
      routeState,
      assignedAgentId: undefined,
      overrideApplied: false,
    };
  }
  const assignedAgentId = resolveAssignedAgentId({
    cfg: params.cfg,
    clientConfig,
    routeState,
  });
  if (!assignedAgentId || assignedAgentId === route.agentId) {
    return {
      peerId: params.peer.id,
      route,
      clientConfig,
      routeState,
      assignedAgentId,
      overrideApplied: false,
    };
  }
  return {
    peerId: params.peer.id,
    route: {
      ...route,
      agentId: assignedAgentId,
      mainSessionKey: buildAgentMainSessionKey({ agentId: assignedAgentId }),
      sessionKey: buildAgentPeerSessionKey({
        agentId: assignedAgentId,
        channel: "telegram",
        accountId,
        peerKind: params.peer.kind,
        peerId: params.peer.id,
        dmScope: params.cfg.session?.dmScope,
        identityLinks: params.cfg.session?.identityLinks,
      }),
    },
    clientConfig,
    routeState,
    assignedAgentId,
    overrideApplied: true,
  };
}

export async function setTelegramClientRouteAssignment(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  peerId: string;
  agentId?: string;
  updatedBy?: string;
}) {
  const accountId = normalizeAccountId(params.accountId);
  const peerId = params.peerId.trim();
  if (!peerId) {
    throw new Error("peerId is required");
  }
  const clientConfig = resolveClientConfig({
    cfg: params.cfg,
    accountId,
    peerId,
  });
  if (!clientConfig || clientConfig.enabled === false) {
    throw new Error("telegram client route is not enabled for this peer");
  }
  const allowedAgents = normalizeAllowedAgents(params.cfg, clientConfig);
  const agentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? normalizeAgentId(params.agentId)
      : undefined;
  if (agentId) {
    const valid = new Set(listAgentIds(params.cfg));
    if (!valid.has(agentId)) {
      throw new Error(`unknown agent: ${params.agentId}`);
    }
    if (allowedAgents && allowedAgents.length > 0 && !allowedAgents.includes(agentId)) {
      throw new Error(`agent ${agentId} is not allowed for this Telegram client`);
    }
  }
  const store = loadStore();
  const key = buildStoreKey(accountId, peerId);
  if (!agentId) {
    delete store.routes[key];
  } else {
    store.routes[key] = {
      peerId,
      accountId,
      agentId,
      updatedAt: Date.now(),
      updatedBy: params.updatedBy?.trim() || undefined,
    };
  }
  await saveStore(store);
  return resolveTelegramClientRouteSummary({
    cfg: params.cfg,
    accountId,
    peerId,
  });
}

export function resolveTelegramClientRouteSummary(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  peerId: string;
}): TelegramResolvedClientRouteSummary | null {
  const accountId = normalizeAccountId(params.accountId);
  const peerId = params.peerId.trim();
  if (!peerId) {
    return null;
  }
  const clientConfig = resolveClientConfig({
    cfg: params.cfg,
    accountId,
    peerId,
  });
  const routeState = loadStore().routes[buildStoreKey(accountId, peerId)];
  if (!clientConfig && !routeState) {
    return null;
  }
  const allowedAgents = normalizeAllowedAgents(params.cfg, clientConfig);
  return {
    peerId,
    accountId,
    enabled: clientConfig?.enabled !== false,
    label: clientConfig?.label?.trim() || undefined,
    defaultAgentId: clientConfig?.defaultAgentId
      ? normalizeAgentId(clientConfig.defaultAgentId)
      : undefined,
    assignedAgentId: routeState?.agentId,
    allowedAgents,
    updatedAt: routeState?.updatedAt,
    updatedBy: routeState?.updatedBy,
  };
}

export function listTelegramClientRouteSummaries(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramResolvedClientRouteSummary[] {
  const accountId = normalizeAccountId(params.accountId);
  const telegram = params.cfg.channels?.telegram;
  const configuredPeerIds = new Set<string>();
  const baseClients = telegram?.clients ? Object.keys(telegram.clients) : [];
  const accountClients = telegram?.accounts?.[accountId]?.clients
    ? Object.keys(telegram.accounts[accountId]?.clients ?? {})
    : [];
  for (const peerId of [...baseClients, ...accountClients]) {
    if (peerId.trim()) {
      configuredPeerIds.add(peerId.trim());
    }
  }
  const store = loadStore();
  for (const route of Object.values(store.routes)) {
    if (route.accountId === accountId && route.peerId.trim()) {
      configuredPeerIds.add(route.peerId.trim());
    }
  }
  return Array.from(configuredPeerIds)
    .map((peerId) =>
      resolveTelegramClientRouteSummary({
        cfg: params.cfg,
        accountId,
        peerId,
      }),
    )
    .filter((entry): entry is TelegramResolvedClientRouteSummary => Boolean(entry))
    .toSorted((a, b) => (a.label || a.peerId).localeCompare(b.label || b.peerId));
}
