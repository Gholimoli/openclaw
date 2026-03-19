import type { Message } from "@grammyjs/types";
import type { OpenClawConfig, TelegramAccountConfig } from "../config/config.js";
import type {
  TelegramResolvedClientOrchestrationSummary,
  TelegramResolvedClientRoute,
} from "./client-routing.js";
import type { TelegramRoomStateEntry } from "./room-state.js";
import { listAgentIds } from "../agents/agent-scope.js";
import { resolveIdentityName } from "../agents/identity.js";
import { buildAgentAddressRegexes, matchesMentionPatterns } from "../auto-reply/reply/mentions.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveTelegramRoomReplyTargetAgentId } from "./room-state.js";

export type TelegramRoomTarget = {
  agentId: string;
  allowWithoutMention?: boolean;
};

export type TelegramRoomStateConfig = {
  accountId?: string | null;
  peerId: string;
  historyLimit: number;
  includeAgentReplies: boolean;
  multiSpeakerRoom: boolean;
};

export type TelegramRoomPlan =
  | {
      kind: "single";
      targets: TelegramRoomTarget[];
    }
  | {
      kind: "client-orchestration" | "broadcast" | "addressed-group";
      targets: TelegramRoomTarget[];
      strategy: "sequential" | "parallel";
      roomState: TelegramRoomStateConfig;
    };

function normalizeAgentIds(cfg: OpenClawConfig, ids: string[] | undefined): string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }
  const valid = new Set((cfg.agents?.list ?? []).map((agent) => normalizeAgentId(agent.id)));
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of ids) {
    const normalized = normalizeAgentId(raw);
    if (!normalized || !valid.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    next.push(normalized);
  }
  return next;
}

export function detectMentionedTelegramAgents(params: {
  cfg: OpenClawConfig;
  text: string;
  agentIds: string[];
}): string[] {
  const text = params.text.trim();
  if (!text) {
    return [];
  }
  return normalizeAgentIds(params.cfg, params.agentIds).filter((agentId) =>
    matchesMentionPatterns(text, buildAgentAddressRegexes(params.cfg, agentId)),
  );
}

function resolveTelegramGroupAddressingMode(
  telegramCfg: TelegramAccountConfig | undefined,
): "legacy" | "addressed" {
  return telegramCfg?.groupAddressing === "legacy" ? "legacy" : "addressed";
}

function resolveAllowedClientAgentIds(params: {
  cfg: OpenClawConfig;
  resolvedClientRoute: TelegramResolvedClientRoute;
}): string[] {
  const raw = params.resolvedClientRoute.clientConfig?.allowedAgents;
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  return normalizeAgentIds(params.cfg, raw);
}

function resolveNonOrchestratedAddressableAgents(params: {
  cfg: OpenClawConfig;
  resolvedClientRoute: TelegramResolvedClientRoute;
}): string[] {
  const leadAgentId = params.resolvedClientRoute.route.agentId;
  const restrictedAgents = resolveAllowedClientAgentIds(params);
  const candidates =
    restrictedAgents.length > 0 ? [leadAgentId, ...restrictedAgents] : listAgentIds(params.cfg);
  return normalizeAgentIds(params.cfg, candidates);
}

function detectRepliedTelegramAgent(params: {
  roomEntries?: TelegramRoomStateEntry[];
  message: Message;
  agentIds: string[];
}): string | undefined {
  const replyTargetId = params.message.reply_to_message?.message_id;
  if (replyTargetId == null || !params.roomEntries?.length) {
    return undefined;
  }
  const agentId = resolveTelegramRoomReplyTargetAgentId({
    entries: params.roomEntries,
    replyToMessageId: replyTargetId,
  });
  return agentId && params.agentIds.includes(agentId) ? agentId : undefined;
}

function resolveAddressedTargets(params: {
  cfg: OpenClawConfig;
  message: Message;
  leadAgentId: string;
  candidateAgentIds: string[];
  roomEntries?: TelegramRoomStateEntry[];
}): TelegramRoomTarget[] {
  const text = (params.message.text ?? params.message.caption ?? "").trim();
  const mentionedAgentIds = detectMentionedTelegramAgents({
    cfg: params.cfg,
    text,
    agentIds: params.candidateAgentIds,
  });
  const repliedAgentId = detectRepliedTelegramAgent({
    roomEntries: params.roomEntries,
    message: params.message,
    agentIds: params.candidateAgentIds,
  });
  const addressedAgentIds = dedupeTargets(
    [
      ...mentionedAgentIds.map((agentId) => ({ agentId })),
      ...(repliedAgentId ? [{ agentId: repliedAgentId }] : []),
    ].filter((target) => params.candidateAgentIds.includes(target.agentId)),
  ).map((target) => target.agentId);

  if (addressedAgentIds.length === 0) {
    return [{ agentId: params.leadAgentId, allowWithoutMention: true }];
  }
  return addressedAgentIds.map((agentId) => ({
    agentId,
    ...(agentId === params.leadAgentId ? { allowWithoutMention: true } : {}),
  }));
}

function resolveRoomHistoryLimit(telegramCfg: TelegramAccountConfig | undefined): number {
  const raw = telegramCfg?.historyLimit;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.floor(raw));
  }
  return 40;
}

function dedupeTargets(targets: TelegramRoomTarget[]): TelegramRoomTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.agentId)) {
      return false;
    }
    seen.add(target.agentId);
    return true;
  });
}

export function resolveTelegramRoomPlan(params: {
  cfg: OpenClawConfig;
  telegramCfg?: TelegramAccountConfig;
  peerId: string;
  accountId?: string | null;
  message: Message;
  resolvedClientRoute: TelegramResolvedClientRoute;
  roomEntries?: TelegramRoomStateEntry[];
}): TelegramRoomPlan {
  const clientOrchestration = params.resolvedClientRoute.clientConfig?.orchestration;
  const summary: TelegramResolvedClientOrchestrationSummary | undefined = params.resolvedClientRoute
    .clientConfig
    ? {
        enabled: clientOrchestration?.enabled === true,
        peerAgents: normalizeAgentIds(params.cfg, clientOrchestration?.peerAgents),
        peerReplyPolicy:
          clientOrchestration?.peerReplyPolicy === "observe" ||
          clientOrchestration?.peerReplyPolicy === "auto"
            ? clientOrchestration.peerReplyPolicy
            : "mention",
        historyLimit:
          typeof clientOrchestration?.historyLimit === "number" &&
          Number.isFinite(clientOrchestration.historyLimit)
            ? Math.max(0, Math.floor(clientOrchestration.historyLimit))
            : 40,
        strategy: clientOrchestration?.strategy === "parallel" ? "parallel" : "sequential",
        includeAgentReplies: clientOrchestration?.includeAgentReplies !== false,
      }
    : undefined;
  if (summary?.enabled) {
    return resolveClientOrchestrationPlan({
      cfg: params.cfg,
      peerId: params.peerId,
      accountId: params.accountId,
      message: params.message,
      resolvedClientRoute: params.resolvedClientRoute,
      orchestration: summary,
      roomEntries: params.roomEntries,
    });
  }

  const rawBroadcastAgents = params.cfg.broadcast?.[params.peerId];
  const broadcastAgents = normalizeAgentIds(
    params.cfg,
    Array.isArray(rawBroadcastAgents) ? rawBroadcastAgents : undefined,
  );
  if (broadcastAgents.length > 0) {
    return {
      kind: "broadcast",
      targets: broadcastAgents.map((agentId) => ({ agentId, allowWithoutMention: true })),
      strategy: params.cfg.broadcast?.strategy === "sequential" ? "sequential" : "parallel",
      roomState: {
        accountId: params.accountId,
        peerId: params.peerId,
        historyLimit: resolveRoomHistoryLimit(params.telegramCfg),
        includeAgentReplies: true,
        multiSpeakerRoom: broadcastAgents.length > 1,
      },
    };
  }

  const isGroup =
    params.message.chat?.type === "group" || params.message.chat?.type === "supergroup";
  if (isGroup && resolveTelegramGroupAddressingMode(params.telegramCfg) !== "legacy") {
    const leadAgentId = params.resolvedClientRoute.route.agentId;
    const candidateAgentIds = resolveNonOrchestratedAddressableAgents({
      cfg: params.cfg,
      resolvedClientRoute: params.resolvedClientRoute,
    });
    return {
      kind: "addressed-group",
      targets: resolveAddressedTargets({
        cfg: params.cfg,
        message: params.message,
        leadAgentId,
        candidateAgentIds,
        roomEntries: params.roomEntries,
      }),
      strategy: "sequential",
      roomState: {
        accountId: params.accountId,
        peerId: params.peerId,
        historyLimit: resolveRoomHistoryLimit(params.telegramCfg),
        includeAgentReplies: true,
        multiSpeakerRoom: candidateAgentIds.length > 1,
      },
    };
  }

  return {
    kind: "single",
    targets: [{ agentId: params.resolvedClientRoute.route.agentId }],
  };
}

function resolveClientOrchestrationPlan(params: {
  cfg: OpenClawConfig;
  peerId: string;
  accountId?: string | null;
  message: Message;
  resolvedClientRoute: TelegramResolvedClientRoute;
  orchestration: TelegramResolvedClientOrchestrationSummary;
  roomEntries?: TelegramRoomStateEntry[];
}): TelegramRoomPlan {
  const leadAgentId =
    params.resolvedClientRoute.assignedAgentId ??
    params.resolvedClientRoute.clientConfig?.defaultAgentId ??
    params.resolvedClientRoute.route.agentId;
  const peerAgents = params.orchestration.peerAgents.filter((id) => id !== leadAgentId);
  const addressedTargets = resolveAddressedTargets({
    cfg: params.cfg,
    message: params.message,
    leadAgentId,
    candidateAgentIds: [leadAgentId, ...peerAgents],
    roomEntries: params.roomEntries,
  });

  let targets: TelegramRoomTarget[];
  switch (params.orchestration.peerReplyPolicy) {
    case "observe":
      targets = [{ agentId: leadAgentId, allowWithoutMention: true }];
      break;
    case "auto":
      targets = [
        { agentId: leadAgentId, allowWithoutMention: true },
        ...peerAgents.map((agentId) => ({ agentId })),
      ];
      break;
    case "addressed":
      targets = addressedTargets;
      break;
    default:
      const text = (params.message.text ?? params.message.caption ?? "").trim();
      const leadMentioned = detectMentionedTelegramAgents({
        cfg: params.cfg,
        text,
        agentIds: [leadAgentId],
      }).includes(leadAgentId);
      const mentionedPeers = detectMentionedTelegramAgents({
        cfg: params.cfg,
        text,
        agentIds: peerAgents,
      });
      if (mentionedPeers.length === 0) {
        targets = [{ agentId: leadAgentId, allowWithoutMention: true }];
      } else {
        targets = [
          ...(leadMentioned ? [{ agentId: leadAgentId, allowWithoutMention: true }] : []),
          ...mentionedPeers.map((agentId) => ({ agentId })),
        ];
      }
      break;
  }

  return {
    kind: "client-orchestration",
    targets: dedupeTargets(targets),
    strategy: params.orchestration.strategy,
    roomState: {
      accountId: params.accountId,
      peerId: params.peerId,
      historyLimit: params.orchestration.historyLimit,
      includeAgentReplies: params.orchestration.includeAgentReplies,
      multiSpeakerRoom: params.orchestration.peerAgents.length > 0,
    },
  };
}

export function resolveTelegramRoomSpeakerLabel(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string {
  return resolveIdentityName(params.cfg, params.agentId) ?? params.agentId;
}
