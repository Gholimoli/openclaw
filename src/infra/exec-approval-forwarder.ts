import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  ExecApprovalForwardingConfig,
  ExecApprovalForwardTarget,
} from "../config/types.approvals.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalResolved,
} from "./exec-approvals.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { listEnabledTelegramAccounts } from "../telegram/accounts.js";
import {
  buildExecApprovalDefaultButtons,
  type ExecApprovalButtonRow,
} from "../telegram/exec-approval-buttons.js";
import {
  isTelegramInlineButtonsEnabled,
  resolveTelegramTargetChatType,
} from "../telegram/inline-buttons.js";
import { editMessageTelegram } from "../telegram/send.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import { resolveSessionDeliveryTarget } from "./outbound/targets.js";

const log = createSubsystemLogger("gateway/exec-approvals");

export type { ExecApprovalRequest, ExecApprovalResolved };

type ForwardTarget = ExecApprovalForwardTarget & { source: "session" | "target" };

type PendingApproval = {
  request: ExecApprovalRequest;
  targets: ForwardTarget[];
  telegramMessages: Array<{
    to: string;
    accountId?: string;
    messageId: string;
    text: string;
  }>;
  timeoutId: NodeJS.Timeout | null;
};

export type ExecApprovalForwarder = {
  handleRequested: (request: ExecApprovalRequest) => Promise<void>;
  handleResolved: (resolved: ExecApprovalResolved) => Promise<void>;
  stop: () => void;
};

export type ExecApprovalForwarderDeps = {
  getConfig?: () => OpenClawConfig;
  deliver?: typeof deliverOutboundPayloads;
  editTelegramMessage?: typeof import("../telegram/send.js").editMessageTelegram;
  nowMs?: () => number;
  resolveSessionTarget?: (params: {
    cfg: OpenClawConfig;
    request: ExecApprovalRequest;
  }) => ExecApprovalForwardTarget | null;
};

const DEFAULT_MODE = "session" as const;

function normalizeMode(mode?: ExecApprovalForwardingConfig["mode"]) {
  return mode ?? DEFAULT_MODE;
}

function matchSessionFilter(sessionKey: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return sessionKey.includes(pattern) || new RegExp(pattern).test(sessionKey);
    } catch {
      return sessionKey.includes(pattern);
    }
  });
}

type ForwardingDecision = {
  shouldForward: boolean;
  telegramDefaultOnly: boolean;
};

function hasEnabledTelegramTargets(cfg: OpenClawConfig): boolean {
  if (cfg.channels?.telegram?.enabled === false) {
    return false;
  }
  try {
    return listEnabledTelegramAccounts(cfg).some((account) => account.tokenSource !== "none");
  } catch {
    return false;
  }
}

function shouldForward(params: {
  cfg: OpenClawConfig;
  config?: ExecApprovalForwardingConfig;
  request: ExecApprovalRequest;
}): ForwardingDecision {
  const config = params.config;
  if (config?.enabled === false) {
    return { shouldForward: false, telegramDefaultOnly: false };
  }
  const telegramDefaultOnly = !config;
  if (telegramDefaultOnly && !hasEnabledTelegramTargets(params.cfg)) {
    return { shouldForward: false, telegramDefaultOnly };
  }
  if (config?.agentFilter?.length) {
    const agentId =
      params.request.request.agentId ??
      parseAgentSessionKey(params.request.request.sessionKey)?.agentId;
    if (!agentId) {
      return { shouldForward: false, telegramDefaultOnly };
    }
    if (!config.agentFilter.includes(agentId)) {
      return { shouldForward: false, telegramDefaultOnly };
    }
  }
  if (config?.sessionFilter?.length) {
    const sessionKey = params.request.request.sessionKey;
    if (!sessionKey) {
      return { shouldForward: false, telegramDefaultOnly };
    }
    if (!matchSessionFilter(sessionKey, config.sessionFilter)) {
      return { shouldForward: false, telegramDefaultOnly };
    }
  }
  return { shouldForward: true, telegramDefaultOnly };
}

function buildTargetKey(target: ExecApprovalForwardTarget): string {
  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  const accountId = target.accountId ?? "";
  const threadId = target.threadId ?? "";
  return [channel, target.to, accountId, threadId].join(":");
}

function formatApprovalCommand(command: string): { inline: boolean; text: string } {
  if (!command.includes("\n") && !command.includes("`")) {
    return { inline: true, text: `\`${command}\`` };
  }

  let fence = "```";
  while (command.includes(fence)) {
    fence += "`";
  }
  return { inline: false, text: `${fence}\n${command}\n${fence}` };
}

function buildRequestMessage(request: ExecApprovalRequest, nowMs: number) {
  const lines: string[] = ["🔒 Exec approval required", `ID: ${request.id}`];
  const command = formatApprovalCommand(request.request.command);
  if (command.inline) {
    lines.push(`Command: ${command.text}`);
  } else {
    lines.push("Command:");
    lines.push(command.text);
  }
  if (request.request.cwd) {
    lines.push(`CWD: ${request.request.cwd}`);
  }
  if (request.request.host) {
    lines.push(`Host: ${request.request.host}`);
  }
  if (request.request.agentId) {
    lines.push(`Agent: ${request.request.agentId}`);
  }
  if (request.request.security) {
    lines.push(`Security: ${request.request.security}`);
  }
  if (request.request.ask) {
    lines.push(`Ask: ${request.request.ask}`);
  }
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  lines.push(`Expires in: ${expiresIn}s`);
  lines.push("Reply with: /approve <id> allow-once|allow-always|deny");
  return lines.join("\n");
}

function decisionLabel(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "allowed once";
  }
  if (decision === "allow-always") {
    return "allowed always";
  }
  return "denied";
}

function buildResolvedMessage(resolved: ExecApprovalResolved) {
  const base = `✅ Exec approval ${decisionLabel(resolved.decision)}.`;
  const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
  return `${base}${by} ID: ${resolved.id}`;
}

function buildExpiredMessage(request: ExecApprovalRequest) {
  return `⏱️ Exec approval expired. ID: ${request.id}`;
}

function buildTelegramRequestButtons(params: {
  cfg: OpenClawConfig;
  target: ForwardTarget;
  approvalId: string;
}): ExecApprovalButtonRow[] | null {
  if (resolveTelegramTargetChatType(params.target.to) !== "direct") {
    return null;
  }
  if (
    !isTelegramInlineButtonsEnabled({
      cfg: params.cfg,
      accountId: params.target.accountId ?? null,
    })
  ) {
    return null;
  }
  return buildExecApprovalDefaultButtons(params.approvalId);
}

function buildRequestPayload(params: {
  cfg: OpenClawConfig;
  target: ForwardTarget;
  request: ExecApprovalRequest;
  nowMs: number;
}): ReplyPayload {
  const text = buildRequestMessage(params.request, params.nowMs);
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  if (channel !== "telegram") {
    return { text };
  }
  const buttons = buildTelegramRequestButtons({
    cfg: params.cfg,
    target: params.target,
    approvalId: params.request.id,
  });
  if (!buttons) {
    return { text };
  }
  return {
    text,
    channelData: {
      telegram: { buttons },
    },
  };
}

function defaultResolveSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): ExecApprovalForwardTarget | null {
  const sessionKey = params.request.request.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = parsed?.agentId ?? params.request.request.agentId ?? "main";
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return null;
  }
  const target = resolveSessionDeliveryTarget({ entry, requestedChannel: "last" });
  if (!target.channel || !target.to) {
    return null;
  }
  if (!isDeliverableMessageChannel(target.channel)) {
    return null;
  }
  return {
    channel: target.channel,
    to: target.to,
    accountId: target.accountId,
    threadId: target.threadId,
  };
}

async function deliverToTargets(params: {
  cfg: OpenClawConfig;
  targets: ForwardTarget[];
  buildPayload: (target: ForwardTarget) => ReplyPayload | null;
  deliver: typeof deliverOutboundPayloads;
  shouldSend?: () => boolean;
}): Promise<
  Array<{
    channel: "telegram";
    to: string;
    accountId?: string;
    messageId: string;
    text: string;
  }>
> {
  const sentMessages: Array<{
    channel: "telegram";
    to: string;
    accountId?: string;
    messageId: string;
    text: string;
  }> = [];
  const deliveries = params.targets.map(async (target) => {
    if (params.shouldSend && !params.shouldSend()) {
      return;
    }
    const channel = normalizeMessageChannel(target.channel) ?? target.channel;
    if (!isDeliverableMessageChannel(channel)) {
      return;
    }
    const payload = params.buildPayload(target);
    if (!payload) {
      return;
    }
    try {
      const results = await params.deliver({
        cfg: params.cfg,
        channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        payloads: [payload],
      });
      if (
        channel === "telegram" &&
        resolveTelegramTargetChatType(target.to) === "direct" &&
        typeof payload.text === "string" &&
        payload.text.trim()
      ) {
        for (const result of results) {
          sentMessages.push({
            channel: "telegram",
            to: target.to,
            accountId: target.accountId,
            messageId: result.messageId,
            text: payload.text,
          });
        }
      }
    } catch (err) {
      log.error(`exec approvals: failed to deliver to ${channel}:${target.to}: ${String(err)}`);
    }
  });
  await Promise.allSettled(deliveries);
  return sentMessages;
}

async function clearTelegramButtons(params: {
  cfg: OpenClawConfig;
  messages: PendingApproval["telegramMessages"];
  editTelegramMessage: typeof import("../telegram/send.js").editMessageTelegram;
}) {
  await Promise.allSettled(
    params.messages.map(async (message) => {
      try {
        await params.editTelegramMessage(message.to, message.messageId, message.text, {
          accountId: message.accountId,
          cfg: params.cfg,
          buttons: [],
        });
      } catch (err) {
        log.warn(
          `exec approvals: failed to clear telegram buttons for ${message.to}:${message.messageId}: ${String(err)}`,
        );
      }
    }),
  );
}

export function createExecApprovalForwarder(
  deps: ExecApprovalForwarderDeps = {},
): ExecApprovalForwarder {
  const getConfig = deps.getConfig ?? loadConfig;
  const deliver = deps.deliver ?? deliverOutboundPayloads;
  const editTelegramMessage = deps.editTelegramMessage ?? editMessageTelegram;
  const nowMs = deps.nowMs ?? Date.now;
  const resolveSessionTarget = deps.resolveSessionTarget ?? defaultResolveSessionTarget;
  const pending = new Map<string, PendingApproval>();

  const handleRequested = async (request: ExecApprovalRequest) => {
    const cfg = getConfig();
    const config = cfg.approvals?.exec;
    const forwarding = shouldForward({ cfg, config, request });
    if (!forwarding.shouldForward) {
      return;
    }

    const mode = forwarding.telegramDefaultOnly ? DEFAULT_MODE : normalizeMode(config?.mode);
    const targets: ForwardTarget[] = [];
    const seen = new Set<string>();

    if (mode === "session" || mode === "both") {
      const sessionTarget = resolveSessionTarget({ cfg, request });
      if (sessionTarget) {
        const sessionChannel =
          normalizeMessageChannel(sessionTarget.channel) ?? sessionTarget.channel;
        if (forwarding.telegramDefaultOnly && sessionChannel !== "telegram") {
          return;
        }
        const key = buildTargetKey(sessionTarget);
        if (!seen.has(key)) {
          seen.add(key);
          targets.push({ ...sessionTarget, source: "session" });
        }
      }
    }

    if (mode === "targets" || mode === "both") {
      const explicitTargets = config?.targets ?? [];
      for (const target of explicitTargets) {
        const channel = normalizeMessageChannel(target.channel) ?? target.channel;
        if (forwarding.telegramDefaultOnly && channel !== "telegram") {
          continue;
        }
        const key = buildTargetKey(target);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        targets.push({ ...target, source: "target" });
      }
    }

    if (targets.length === 0) {
      return;
    }

    const expiresInMs = Math.max(0, request.expiresAtMs - nowMs());
    const timeoutId = setTimeout(() => {
      void (async () => {
        const entry = pending.get(request.id);
        if (!entry) {
          return;
        }
        pending.delete(request.id);
        await clearTelegramButtons({
          cfg,
          messages: entry.telegramMessages,
          editTelegramMessage,
        });
        const expiredText = buildExpiredMessage(request);
        await deliverToTargets({
          cfg,
          targets: entry.targets,
          deliver,
          buildPayload: () => ({ text: expiredText }),
        });
      })();
    }, expiresInMs);
    timeoutId.unref?.();

    const pendingEntry: PendingApproval = {
      request,
      targets,
      telegramMessages: [],
      timeoutId,
    };
    pending.set(request.id, pendingEntry);

    if (pending.get(request.id) !== pendingEntry) {
      return;
    }

    pendingEntry.telegramMessages = await deliverToTargets({
      cfg,
      targets,
      deliver,
      buildPayload: (target) =>
        buildRequestPayload({
          cfg,
          target,
          request,
          nowMs: nowMs(),
        }),
      shouldSend: () => pending.get(request.id) === pendingEntry,
    });
  };

  const handleResolved = async (resolved: ExecApprovalResolved) => {
    const entry = pending.get(resolved.id);
    if (!entry) {
      return;
    }
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
    }
    pending.delete(resolved.id);

    const cfg = getConfig();
    await clearTelegramButtons({
      cfg,
      messages: entry.telegramMessages,
      editTelegramMessage,
    });
    const text = buildResolvedMessage(resolved);
    await deliverToTargets({
      cfg,
      targets: entry.targets,
      deliver,
      buildPayload: () => ({ text }),
    });
  };

  const stop = () => {
    for (const entry of pending.values()) {
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
      }
    }
    pending.clear();
  };

  return { handleRequested, handleResolved, stop };
}

export function shouldForwardExecApproval(params: {
  cfg?: OpenClawConfig;
  config?: ExecApprovalForwardingConfig;
  request: ExecApprovalRequest;
}): boolean {
  return shouldForward({
    cfg: params.cfg ?? loadConfig(),
    config: params.config,
    request: params.request,
  }).shouldForward;
}
