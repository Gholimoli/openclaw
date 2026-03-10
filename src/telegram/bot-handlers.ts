import type { Message } from "@grammyjs/types";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type { TelegramContext } from "./bot/types.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
import { buildCommandsPaginationKeyboard } from "../auto-reply/reply/commands-info.js";
import { buildModelsProviderData } from "../auto-reply/reply/commands-models.js";
import { buildMentionRegexes, matchesMentionWithExplicit } from "../auto-reply/reply/mentions.js";
import { resolveStoredModelOverride } from "../auto-reply/reply/model-selection.js";
import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import { buildCommandsMessagePaginated } from "../auto-reply/status.js";
import { resolveMentionGatingWithBypass } from "../channels/mention-gating.js";
import { resolveChannelConfigWrites } from "../channels/plugins/config-writes.js";
import { loadConfig } from "../config/config.js";
import { writeConfigFile } from "../config/io.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { danger, logVerbose, warn } from "../globals.js";
import { readChannelAllowFromStore } from "../pairing/pairing-store.js";
import { buildAgentSessionKey } from "../routing/resolve-route.js";
import { buildAgentMainSessionKey, DEFAULT_MAIN_KEY } from "../routing/session-key.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { firstDefined, isSenderAllowed, normalizeAllowFromWithStore } from "./bot-access.js";
import { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import { MEDIA_GROUP_TIMEOUT_MS, type MediaGroupEntry } from "./bot-updates.js";
import { resolveMedia } from "./bot/delivery.js";
import {
  buildSenderLabel,
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  expandTextLinks,
  hasBotMention,
  resolveTelegramForumThreadId,
} from "./bot/helpers.js";
import { parseTelegramChoiceCallbackData } from "./choice-buttons.js";
import { resolveTelegramClientRoute } from "./client-routing.js";
import {
  buildExecApprovalConfirmButtons,
  buildExecApprovalDefaultButtons,
  parseExecApprovalCallbackData,
} from "./exec-approval-buttons.js";
import { migrateTelegramGroupConfig } from "./group-migration.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  type ProviderInfo,
} from "./model-buttons.js";
import { resolveTelegramRoomPlan, resolveTelegramRoomSpeakerLabel } from "./orchestration.js";
import {
  appendTelegramRoomStateEntry,
  buildTelegramRoomStateContext,
  readTelegramRoomStateEntries,
} from "./room-state.js";
import { buildInlineKeyboard } from "./send.js";
import {
  extractTelegramWorkResumeToken,
  parseTelegramWorkApprovalCallbackData,
} from "./work-approval-buttons.js";

export const registerTelegramHandlers = ({
  cfg,
  accountId,
  bot,
  opts,
  runtime,
  mediaMaxBytes,
  telegramCfg,
  groupAllowFrom,
  resolveGroupActivation,
  resolveGroupPolicy,
  resolveGroupRequireMention,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  processMessage,
  logger,
}: RegisterTelegramHandlerParams) => {
  const DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS = 1500;
  const TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS = 4000;
  const TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS =
    typeof opts.testTimings?.textFragmentGapMs === "number" &&
    Number.isFinite(opts.testTimings.textFragmentGapMs)
      ? Math.max(10, Math.floor(opts.testTimings.textFragmentGapMs))
      : DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS;
  const TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP = 1;
  const TELEGRAM_TEXT_FRAGMENT_MAX_PARTS = 12;
  const TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS = 50_000;
  const mediaGroupTimeoutMs =
    typeof opts.testTimings?.mediaGroupFlushMs === "number" &&
    Number.isFinite(opts.testTimings.mediaGroupFlushMs)
      ? Math.max(10, Math.floor(opts.testTimings.mediaGroupFlushMs))
      : MEDIA_GROUP_TIMEOUT_MS;

  const mediaGroupBuffer = new Map<string, MediaGroupEntry>();
  let mediaGroupProcessing: Promise<void> = Promise.resolve();

  type TextFragmentEntry = {
    key: string;
    messages: Array<{ msg: Message; ctx: TelegramContext; receivedAtMs: number }>;
    timer: ReturnType<typeof setTimeout>;
  };
  const textFragmentBuffer = new Map<string, TextFragmentEntry>();
  let textFragmentProcessing: Promise<void> = Promise.resolve();

  const debounceMs = resolveInboundDebounceMs({ cfg, channel: "telegram" });
  type TelegramDebounceEntry = {
    ctx: TelegramContext;
    msg: Message;
    allMedia: TelegramMediaRef[];
    storeAllowFrom: string[];
    debounceKey: string | null;
    botUsername?: string;
  };
  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: (entry) => {
      if (entry.allMedia.length > 0) {
        return false;
      }
      const text = entry.msg.text ?? entry.msg.caption ?? "";
      if (!text.trim()) {
        return false;
      }
      return !hasControlCommand(text, cfg, { botUsername: entry.botUsername });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await processInboundTelegramRoom(last.ctx, last.allMedia, last.storeAllowFrom);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.msg.text ?? entry.msg.caption ?? "")
        .filter(Boolean)
        .join("\n");
      if (!combinedText.trim()) {
        return;
      }
      const first = entries[0];
      const baseCtx = first.ctx;
      const getFile =
        typeof baseCtx.getFile === "function" ? baseCtx.getFile.bind(baseCtx) : async () => ({});
      const syntheticMessage: Message = {
        ...first.msg,
        text: combinedText,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
        date: last.msg.date ?? first.msg.date,
      };
      const messageIdOverride = last.msg.message_id ? String(last.msg.message_id) : undefined;
      await processInboundTelegramRoom(
        { message: syntheticMessage, me: baseCtx.me, getFile },
        [],
        first.storeAllowFrom,
        messageIdOverride ? { messageIdOverride } : undefined,
      );
    },
    onError: (err) => {
      runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
    },
  });

  const resolveTelegramSessionModel = (params: {
    chatId: number | string;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    resolvedThreadId?: number;
  }): string | undefined => {
    const resolvedThreadId =
      params.resolvedThreadId ??
      resolveTelegramForumThreadId({
        isForum: params.isForum,
        messageThreadId: params.messageThreadId,
      });
    const peerId = params.isGroup
      ? buildTelegramGroupPeerId(params.chatId, resolvedThreadId)
      : String(params.chatId);
    const parentPeer = buildTelegramParentPeer({
      isGroup: params.isGroup,
      resolvedThreadId,
      chatId: params.chatId,
    });
    const route = resolveTelegramClientRoute({
      cfg,
      accountId,
      peer: {
        kind: params.isGroup ? "group" : "direct",
        id: peerId,
      },
      parentPeer,
    }).route;
    const baseSessionKey = route.sessionKey;
    const dmThreadId = !params.isGroup ? params.messageThreadId : undefined;
    const threadKeys =
      dmThreadId != null
        ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(dmThreadId) })
        : null;
    const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
    const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    const storedOverride = resolveStoredModelOverride({
      sessionEntry: entry,
      sessionStore: store,
      sessionKey,
    });
    if (storedOverride) {
      return storedOverride.provider
        ? `${storedOverride.provider}/${storedOverride.model}`
        : storedOverride.model;
    }
    const provider = entry?.modelProvider?.trim();
    const model = entry?.model?.trim();
    if (provider && model) {
      return `${provider}/${model}`;
    }
    const modelCfg = cfg.agents?.defaults?.model;
    return typeof modelCfg === "string" ? modelCfg : modelCfg?.primary;
  };

  const buildRoomTargetRoute = (params: {
    agentId: string;
    peerId: string;
    isGroup: boolean;
    route: ReturnType<typeof resolveTelegramClientRoute>["route"];
  }) => ({
    ...params.route,
    agentId: params.agentId,
    sessionKey: buildAgentSessionKey({
      agentId: params.agentId,
      channel: "telegram",
      accountId: params.route.accountId,
      peer: {
        kind: params.isGroup ? "group" : "direct",
        id: params.peerId,
      },
      dmScope: cfg.session?.dmScope,
      identityLinks: cfg.session?.identityLinks,
    }),
    mainSessionKey: buildAgentMainSessionKey({
      agentId: params.agentId,
      mainKey: DEFAULT_MAIN_KEY,
    }),
  });

  const resolveVisibleRoomBody = (msg: Message, allMedia: TelegramMediaRef[]): string => {
    const rawText = expandTextLinks(
      msg.text ?? msg.caption ?? "",
      msg.entities ?? msg.caption_entities,
    ).trim();
    if (rawText) {
      return rawText;
    }
    if (msg.sticker) {
      return "<media:sticker>";
    }
    if (msg.photo) {
      return allMedia.length > 1 ? `<media:image> (${allMedia.length} images)` : "<media:image>";
    }
    if (msg.video || msg.video_note) {
      return "<media:video>";
    }
    if (msg.audio || msg.voice) {
      return "<media:audio>";
    }
    if (msg.document) {
      return "<media:document>";
    }
    if (allMedia.length > 0) {
      return allMedia.length > 1 ? `<media> (${allMedia.length} items)` : "<media>";
    }
    return "";
  };

  const shouldFanoutTelegramBroadcast = (params: {
    cfg: ReturnType<typeof loadConfig>;
    msg: Message;
    route: ReturnType<typeof resolveTelegramClientRoute>["route"];
    groupConfig?: ReturnType<typeof resolveTelegramGroupConfig>["groupConfig"];
    topicConfig?: ReturnType<typeof resolveTelegramGroupConfig>["topicConfig"];
    chatId: string | number;
    resolvedThreadId?: number;
    isGroup: boolean;
    botUsername?: string;
    botId?: number;
  }): boolean => {
    if (!params.isGroup) {
      return true;
    }
    const activationOverride = resolveGroupActivation({
      chatId: params.chatId,
      messageThreadId: params.resolvedThreadId,
      sessionKey: params.route.sessionKey,
      agentId: params.route.agentId,
    });
    const requireMention = firstDefined(
      activationOverride,
      params.topicConfig?.requireMention,
      params.groupConfig?.requireMention,
      resolveGroupRequireMention(params.chatId),
    );
    if (!requireMention) {
      return true;
    }
    const text = params.msg.text ?? params.msg.caption ?? "";
    const mentionRegexes = buildMentionRegexes(params.cfg, params.route.agentId);
    const hasAnyMention = (params.msg.entities ?? params.msg.caption_entities ?? []).some(
      (entity) => entity.type === "mention",
    );
    const explicitlyMentioned = params.botUsername
      ? hasBotMention(params.msg, params.botUsername)
      : false;
    const implicitMention =
      params.botId != null && params.msg.reply_to_message?.from?.id === params.botId;
    const wasMentioned = matchesMentionWithExplicit({
      text,
      mentionRegexes,
      explicit: {
        hasAnyMention,
        isExplicitlyMentioned: explicitlyMentioned,
        canResolveExplicit: Boolean(params.botUsername),
      },
    });
    return !resolveMentionGatingWithBypass({
      isGroup: true,
      requireMention: true,
      canDetectMention: Boolean(params.botUsername) || mentionRegexes.length > 0,
      wasMentioned,
      implicitMention,
      hasAnyMention,
      allowTextCommands: true,
      hasControlCommand: hasControlCommand(text, params.cfg, {
        botUsername: params.botUsername,
      }),
      commandAuthorized: true,
    }).shouldSkip;
  };

  const processInboundTelegramRoom = async (
    primaryCtx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: { messageIdOverride?: string; forceWasMentioned?: boolean },
  ) => {
    const msg = primaryCtx.message;
    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const messageThreadId = msg.message_thread_id;
    const isForum = msg.chat.is_forum === true;
    const resolvedThreadId = resolveTelegramForumThreadId({
      isForum,
      messageThreadId,
    });
    const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId);
    const parentPeer = buildTelegramParentPeer({ isGroup, resolvedThreadId, chatId });
    const freshCfg = loadConfig();
    const resolvedClientRoute = resolveTelegramClientRoute({
      cfg: freshCfg,
      accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: peerId,
      },
      parentPeer,
    });
    const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
    const plan = resolveTelegramRoomPlan({
      cfg: freshCfg,
      telegramCfg,
      peerId,
      accountId,
      message: msg,
      resolvedClientRoute,
    });

    if (plan.kind === "single") {
      await processMessage(primaryCtx, allMedia, storeAllowFrom, options);
      return;
    }

    if (
      plan.kind === "broadcast" &&
      !shouldFanoutTelegramBroadcast({
        cfg: freshCfg,
        msg,
        route: resolvedClientRoute.route,
        groupConfig,
        topicConfig,
        chatId,
        resolvedThreadId,
        isGroup,
        botUsername: primaryCtx.me?.username?.toLowerCase(),
        botId: primaryCtx.me?.id,
      })
    ) {
      logger.info({ chatId, reason: "broadcast-no-mention" }, "skipping broadcast message");
      return;
    }

    const messageId = options?.messageIdOverride ?? String(msg.message_id);
    const visibleBody = resolveVisibleRoomBody(msg, allMedia);
    if (visibleBody) {
      await appendTelegramRoomStateEntry({
        accountId: plan.roomState.accountId,
        peerId: plan.roomState.peerId,
        historyLimit: plan.roomState.historyLimit,
        entry: {
          kind: "human",
          actorLabel: buildSenderLabel(msg, msg.from?.id ? String(msg.from.id) : chatId),
          body: visibleBody,
          timestamp: msg.date ? msg.date * 1000 : Date.now(),
          messageId,
        },
      });
    }

    const roomEntries = await readTelegramRoomStateEntries({
      accountId: plan.roomState.accountId,
      peerId: plan.roomState.peerId,
      limit: plan.roomState.historyLimit,
    });
    const roomContext = buildTelegramRoomStateContext({
      entries: roomEntries,
      excludeMessageId: messageId,
    });

    const runTarget = async (target: (typeof plan.targets)[number]) => {
      const routeOverride =
        target.agentId === resolvedClientRoute.route.agentId
          ? resolvedClientRoute.route
          : buildRoomTargetRoute({
              agentId: target.agentId,
              peerId,
              isGroup,
              route: resolvedClientRoute.route,
            });
      const speakerLabel = resolveTelegramRoomSpeakerLabel({
        cfg: freshCfg,
        agentId: target.agentId,
      });
      await processMessage(primaryCtx, allMedia, storeAllowFrom, {
        ...options,
        routeOverride,
        resolvedClientRouteOverride: resolvedClientRoute,
        allowWithoutMention: target.allowWithoutMention,
        skipPendingHistory: true,
        untrustedContext: roomContext ? [roomContext] : undefined,
        roomState: plan.roomState,
        roomSpeakerLabel: speakerLabel,
        responsePrefixOverride: plan.roomState.multiSpeakerRoom ? `[${speakerLabel}]` : undefined,
      });
    };

    if (plan.strategy === "parallel") {
      await Promise.allSettled(plan.targets.map(runTarget));
      return;
    }
    for (const target of plan.targets) {
      await runTarget(target);
    }
  };

  const processMediaGroup = async (entry: MediaGroupEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const captionMsg = entry.messages.find((m) => m.msg.caption || m.msg.text);
      const primaryEntry = captionMsg ?? entry.messages[0];

      const allMedia: TelegramMediaRef[] = [];
      for (const { ctx } of entry.messages) {
        const media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);
        if (media) {
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
          });
        }
      }

      const storeAllowFrom = await readChannelAllowFromStore("telegram").catch(() => []);
      await processInboundTelegramRoom(primaryEntry.ctx, allMedia, storeAllowFrom);
    } catch (err) {
      runtime.error?.(danger(`media group handler failed: ${String(err)}`));
    }
  };

  const flushTextFragments = async (entry: TextFragmentEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) {
        return;
      }

      const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
      if (!combinedText.trim()) {
        return;
      }

      const syntheticMessage: Message = {
        ...first.msg,
        text: combinedText,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
        date: last.msg.date ?? first.msg.date,
      };

      const storeAllowFrom = await readChannelAllowFromStore("telegram").catch(() => []);
      const baseCtx = first.ctx;
      const getFile =
        typeof baseCtx.getFile === "function" ? baseCtx.getFile.bind(baseCtx) : async () => ({});

      await processInboundTelegramRoom(
        { message: syntheticMessage, me: baseCtx.me, getFile },
        [],
        storeAllowFrom,
        { messageIdOverride: String(last.msg.message_id) },
      );
    } catch (err) {
      runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
    }
  };

  const scheduleTextFragmentFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      textFragmentBuffer.delete(entry.key);
      textFragmentProcessing = textFragmentProcessing
        .then(async () => {
          await flushTextFragments(entry);
        })
        .catch(() => undefined);
      await textFragmentProcessing;
    }, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
  };

  bot.on("callback_query", async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback) {
      return;
    }
    if (shouldSkipUpdate(ctx)) {
      return;
    }
    let callbackAnswered = false;
    const answerCallback = async (params?: { text?: string; show_alert?: boolean }) => {
      if (callbackAnswered) {
        return;
      }
      callbackAnswered = true;
      await withTelegramApiErrorLogging({
        operation: "answerCallbackQuery",
        runtime,
        fn: () => bot.api.answerCallbackQuery(callback.id, params),
      }).catch(() => {});
    };
    try {
      const data = (callback.data ?? "").trim();
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) {
        return;
      }
      const currentText = callbackMessage.text ?? callbackMessage.caption ?? "";
      const approvalCallback = parseExecApprovalCallbackData(data);
      const workApprovalCallback = parseTelegramWorkApprovalCallbackData(data);
      const choiceCallback = parseTelegramChoiceCallbackData(data);
      const requiresAllowlistedCallbackActor =
        approvalCallback !== null || workApprovalCallback !== null || choiceCallback !== null;
      const unauthorizedCallbackText = "Only approved Telegram users can use these buttons.";

      const editCallbackButtons = async (
        buttons: Array<Array<{ text: string; callback_data: string }>>,
      ) => {
        const keyboard = buildInlineKeyboard(buttons);
        try {
          await bot.api.editMessageText(
            callbackMessage.chat.id,
            callbackMessage.message_id,
            currentText,
            {
              reply_markup: keyboard ?? { inline_keyboard: [] },
            },
          );
        } catch (editErr) {
          const errStr = String(editErr);
          if (!errStr.includes("message is not modified")) {
            throw editErr;
          }
        }
      };

      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg,
        accountId,
      });
      if (inlineButtonsScope === "off") {
        return;
      }

      const chatId = callbackMessage.chat.id;
      const isGroup =
        callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
      if (inlineButtonsScope === "dm" && isGroup) {
        return;
      }
      if (inlineButtonsScope === "group" && !isGroup) {
        return;
      }

      const messageThreadId = callbackMessage.message_thread_id;
      const isForum = callbackMessage.chat.is_forum === true;
      const resolvedThreadId = resolveTelegramForumThreadId({
        isForum,
        messageThreadId,
      });
      const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
      const storeAllowFrom = await readChannelAllowFromStore("telegram").catch(() => []);
      const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
      const effectiveGroupAllow = normalizeAllowFromWithStore({
        allowFrom: groupAllowOverride ?? groupAllowFrom,
        storeAllowFrom,
      });
      const effectiveDmAllow = normalizeAllowFromWithStore({
        allowFrom: telegramCfg.allowFrom,
        storeAllowFrom,
      });
      const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
      const senderId = callback.from?.id ? String(callback.from.id) : "";
      const senderUsername = callback.from?.username ?? "";

      if (isGroup) {
        if (groupConfig?.enabled === false) {
          logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
          if (requiresAllowlistedCallbackActor) {
            await answerCallback({ text: unauthorizedCallbackText });
          }
          return;
        }
        if (topicConfig?.enabled === false) {
          logVerbose(
            `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
          );
          if (requiresAllowlistedCallbackActor) {
            await answerCallback({ text: unauthorizedCallbackText });
          }
          return;
        }
        if (typeof groupAllowOverride !== "undefined") {
          const allowed =
            senderId &&
            isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId,
              senderUsername,
            });
          if (!allowed) {
            logVerbose(
              `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`,
            );
            if (requiresAllowlistedCallbackActor) {
              await answerCallback({ text: unauthorizedCallbackText });
            }
            return;
          }
        }
        const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
        const groupPolicy = firstDefined(
          topicConfig?.groupPolicy,
          groupConfig?.groupPolicy,
          telegramCfg.groupPolicy,
          defaultGroupPolicy,
          "open",
        );
        if (groupPolicy === "disabled") {
          logVerbose(`Blocked telegram group message (groupPolicy: disabled)`);
          if (requiresAllowlistedCallbackActor) {
            await answerCallback({ text: unauthorizedCallbackText });
          }
          return;
        }
        if (groupPolicy === "allowlist") {
          if (!senderId) {
            logVerbose(`Blocked telegram group message (no sender ID, groupPolicy: allowlist)`);
            if (requiresAllowlistedCallbackActor) {
              await answerCallback({ text: unauthorizedCallbackText });
            }
            return;
          }
          if (!effectiveGroupAllow.hasEntries) {
            logVerbose(
              "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
            );
            if (requiresAllowlistedCallbackActor) {
              await answerCallback({ text: unauthorizedCallbackText });
            }
            return;
          }
          if (
            !isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId,
              senderUsername,
            })
          ) {
            logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
            if (requiresAllowlistedCallbackActor) {
              await answerCallback({ text: unauthorizedCallbackText });
            }
            return;
          }
        }
        const groupAllowlist = resolveGroupPolicy(chatId);
        if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
          logger.info(
            { chatId, title: callbackMessage.chat.title, reason: "not-allowed" },
            "skipping group message",
          );
          if (requiresAllowlistedCallbackActor) {
            await answerCallback({ text: unauthorizedCallbackText });
          }
          return;
        }
        if (requiresAllowlistedCallbackActor) {
          const allowed =
            effectiveGroupAllow.hasWildcard ||
            (effectiveGroupAllow.hasEntries &&
              isSenderAllowed({
                allow: effectiveGroupAllow,
                senderId,
                senderUsername,
              }));
          if (!allowed) {
            logVerbose(
              `Blocked telegram callback from ${senderId || "unknown"} (no group allowlist entry)`,
            );
            await answerCallback({ text: unauthorizedCallbackText });
            return;
          }
        }
      }

      if (inlineButtonsScope === "allowlist") {
        if (!isGroup) {
          if (dmPolicy === "disabled") {
            if (requiresAllowlistedCallbackActor) {
              await answerCallback({ text: unauthorizedCallbackText });
            }
            return;
          }
          if (dmPolicy !== "open") {
            const allowed =
              effectiveDmAllow.hasWildcard ||
              (effectiveDmAllow.hasEntries &&
                isSenderAllowed({
                  allow: effectiveDmAllow,
                  senderId,
                  senderUsername,
                }));
            if (!allowed) {
              if (requiresAllowlistedCallbackActor) {
                await answerCallback({ text: unauthorizedCallbackText });
              }
              return;
            }
          }
        } else {
          const allowed =
            effectiveGroupAllow.hasWildcard ||
            (effectiveGroupAllow.hasEntries &&
              isSenderAllowed({
                allow: effectiveGroupAllow,
                senderId,
                senderUsername,
              }));
          if (!allowed) {
            if (requiresAllowlistedCallbackActor) {
              await answerCallback({ text: unauthorizedCallbackText });
            }
            return;
          }
        }
      }

      await answerCallback();

      if (approvalCallback) {
        if (approvalCallback.action === "always") {
          const buttons = buildExecApprovalConfirmButtons(approvalCallback.approvalId);
          await editCallbackButtons(buttons ?? []);
          return;
        }

        if (approvalCallback.action === "back") {
          const buttons = buildExecApprovalDefaultButtons(approvalCallback.approvalId);
          await editCallbackButtons(buttons ?? []);
          return;
        }

        const decision =
          approvalCallback.action === "allow-once"
            ? "allow-once"
            : approvalCallback.action === "deny"
              ? "deny"
              : "allow-always";

        await editCallbackButtons([]).catch(() => undefined);

        const syntheticMessage: Message = {
          ...callbackMessage,
          from: callback.from,
          text: `/approve ${approvalCallback.approvalId} ${decision}`,
          caption: undefined,
          caption_entities: undefined,
          entities: undefined,
        };
        const getFile =
          typeof ctx.getFile === "function" ? ctx.getFile.bind(ctx) : async () => ({});
        await processMessage(
          { message: syntheticMessage, me: ctx.me, getFile },
          [],
          storeAllowFrom,
          {
            forceWasMentioned: true,
            messageIdOverride: callback.id,
          },
        );
        return;
      }

      if (workApprovalCallback) {
        const token = extractTelegramWorkResumeToken(currentText);
        if (!token) {
          return;
        }
        await editCallbackButtons([]).catch(() => undefined);
        const decision = workApprovalCallback.action === "approve" ? "yes" : "no";
        const syntheticMessage: Message = {
          ...callbackMessage,
          from: callback.from,
          text: `/work resume ${token} --approve ${decision}`,
          caption: undefined,
          caption_entities: undefined,
          entities: undefined,
        };
        const getFile =
          typeof ctx.getFile === "function" ? ctx.getFile.bind(ctx) : async () => ({});
        await processMessage(
          { message: syntheticMessage, me: ctx.me, getFile },
          [],
          storeAllowFrom,
          {
            forceWasMentioned: true,
            messageIdOverride: callback.id,
          },
        );
        return;
      }

      const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
      if (paginationMatch) {
        const pageValue = paginationMatch[1];
        if (pageValue === "noop") {
          return;
        }

        const page = Number.parseInt(pageValue, 10);
        if (Number.isNaN(page) || page < 1) {
          return;
        }

        const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(cfg) || undefined;
        const skillCommands = listSkillCommandsForAgents({
          cfg,
          agentIds: agentId ? [agentId] : undefined,
        });
        const result = buildCommandsMessagePaginated(cfg, skillCommands, {
          page,
          surface: "telegram",
        });

        const keyboard =
          result.totalPages > 1
            ? buildInlineKeyboard(
                buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId),
              )
            : undefined;

        try {
          await bot.api.editMessageText(
            callbackMessage.chat.id,
            callbackMessage.message_id,
            result.text,
            keyboard ? { reply_markup: keyboard } : undefined,
          );
        } catch (editErr) {
          const errStr = String(editErr);
          if (!errStr.includes("message is not modified")) {
            throw editErr;
          }
        }
        return;
      }

      // Model selection callback handler (mdl_prov, mdl_list_*, mdl_sel_*, mdl_back)
      const modelCallback = parseModelCallbackData(data);
      if (modelCallback) {
        const modelData = await buildModelsProviderData(cfg);
        const { byProvider, providers } = modelData;

        const editMessageWithButtons = async (
          text: string,
          buttons: ReturnType<typeof buildProviderKeyboard>,
        ) => {
          const keyboard = buildInlineKeyboard(buttons);
          try {
            await bot.api.editMessageText(
              callbackMessage.chat.id,
              callbackMessage.message_id,
              text,
              keyboard ? { reply_markup: keyboard } : undefined,
            );
          } catch (editErr) {
            const errStr = String(editErr);
            if (errStr.includes("no text in the message")) {
              try {
                await bot.api.deleteMessage(callbackMessage.chat.id, callbackMessage.message_id);
              } catch {}
              await bot.api.sendMessage(
                callbackMessage.chat.id,
                text,
                keyboard ? { reply_markup: keyboard } : undefined,
              );
            } else if (!errStr.includes("message is not modified")) {
              throw editErr;
            }
          }
        };

        if (modelCallback.type === "providers" || modelCallback.type === "back") {
          if (providers.length === 0) {
            await editMessageWithButtons("No providers available.", []);
            return;
          }
          const providerInfos: ProviderInfo[] = providers.map((p) => ({
            id: p,
            count: byProvider.get(p)?.size ?? 0,
          }));
          const buttons = buildProviderKeyboard(providerInfos);
          await editMessageWithButtons("Select a provider:", buttons);
          return;
        }

        if (modelCallback.type === "list") {
          const { provider, page } = modelCallback;
          const modelSet = byProvider.get(provider);
          if (!modelSet || modelSet.size === 0) {
            // Provider not found or no models - show providers list
            const providerInfos: ProviderInfo[] = providers.map((p) => ({
              id: p,
              count: byProvider.get(p)?.size ?? 0,
            }));
            const buttons = buildProviderKeyboard(providerInfos);
            await editMessageWithButtons(
              `Unknown provider: ${provider}\n\nSelect a provider:`,
              buttons,
            );
            return;
          }
          const models = [...modelSet].toSorted();
          const pageSize = getModelsPageSize();
          const totalPages = calculateTotalPages(models.length, pageSize);
          const safePage = Math.max(1, Math.min(page, totalPages));

          // Resolve current model from session (prefer overrides)
          const currentModel = resolveTelegramSessionModel({
            chatId,
            isGroup,
            isForum,
            messageThreadId,
            resolvedThreadId,
          });

          const buttons = buildModelsKeyboard({
            provider,
            models,
            currentModel,
            currentPage: safePage,
            totalPages,
            pageSize,
          });
          const text = `Models (${provider}) — ${models.length} available`;
          await editMessageWithButtons(text, buttons);
          return;
        }

        if (modelCallback.type === "select") {
          const { provider, model } = modelCallback;
          // Process model selection as a synthetic message with /model command
          const syntheticMessage: Message = {
            ...callbackMessage,
            from: callback.from,
            text: `/model ${provider}/${model}`,
            caption: undefined,
            caption_entities: undefined,
            entities: undefined,
          };
          const getFile =
            typeof ctx.getFile === "function" ? ctx.getFile.bind(ctx) : async () => ({});
          await processMessage(
            { message: syntheticMessage, me: ctx.me, getFile },
            [],
            storeAllowFrom,
            {
              forceWasMentioned: true,
              messageIdOverride: callback.id,
            },
          );
          return;
        }

        return;
      }

      if (choiceCallback) {
        await editCallbackButtons([]).catch(() => undefined);
        const syntheticMessage: Message = {
          ...callbackMessage,
          from: callback.from,
          text: choiceCallback.choice,
          caption: undefined,
          caption_entities: undefined,
          entities: undefined,
        };
        const getFile =
          typeof ctx.getFile === "function" ? ctx.getFile.bind(ctx) : async () => ({});
        await processMessage(
          { message: syntheticMessage, me: ctx.me, getFile },
          [],
          storeAllowFrom,
          {
            forceWasMentioned: true,
            messageIdOverride: callback.id,
          },
        );
        return;
      }

      const syntheticMessage: Message = {
        ...callbackMessage,
        from: callback.from,
        text: data,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
      };
      const getFile = typeof ctx.getFile === "function" ? ctx.getFile.bind(ctx) : async () => ({});
      await processMessage({ message: syntheticMessage, me: ctx.me, getFile }, [], storeAllowFrom, {
        forceWasMentioned: true,
        messageIdOverride: callback.id,
      });
    } catch (err) {
      runtime.error?.(danger(`callback handler failed: ${String(err)}`));
    } finally {
      await answerCallback();
    }
  });

  // Handle group migration to supergroup (chat ID changes)
  bot.on("message:migrate_to_chat_id", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg?.migrate_to_chat_id) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const oldChatId = String(msg.chat.id);
      const newChatId = String(msg.migrate_to_chat_id);
      const chatTitle = msg.chat.title ?? "Unknown";

      runtime.log?.(warn(`[telegram] Group migrated: "${chatTitle}" ${oldChatId} → ${newChatId}`));

      if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
        runtime.log?.(warn("[telegram] Config writes disabled; skipping group config migration."));
        return;
      }

      // Check if old chat ID has config and migrate it
      const currentConfig = loadConfig();
      const migration = migrateTelegramGroupConfig({
        cfg: currentConfig,
        accountId,
        oldChatId,
        newChatId,
      });

      if (migration.migrated) {
        runtime.log?.(warn(`[telegram] Migrating group config from ${oldChatId} to ${newChatId}`));
        migrateTelegramGroupConfig({ cfg, accountId, oldChatId, newChatId });
        await writeConfigFile(currentConfig);
        runtime.log?.(warn(`[telegram] Group config migrated and saved successfully`));
      } else if (migration.skippedExisting) {
        runtime.log?.(
          warn(
            `[telegram] Group config already exists for ${newChatId}; leaving ${oldChatId} unchanged`,
          ),
        );
      } else {
        runtime.log?.(
          warn(`[telegram] No config found for old group ID ${oldChatId}, migration logged only`),
        );
      }
    } catch (err) {
      runtime.error?.(danger(`[telegram] Group migration handler failed: ${String(err)}`));
    }
  });

  bot.on("message", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const chatId = msg.chat.id;
      const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
      const messageThreadId = msg.message_thread_id;
      const isForum = msg.chat.is_forum === true;
      const resolvedThreadId = resolveTelegramForumThreadId({
        isForum,
        messageThreadId,
      });
      const storeAllowFrom = await readChannelAllowFromStore("telegram").catch(() => []);
      const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
      const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
      const effectiveGroupAllow = normalizeAllowFromWithStore({
        allowFrom: groupAllowOverride ?? groupAllowFrom,
        storeAllowFrom,
      });
      const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";

      if (isGroup) {
        if (groupConfig?.enabled === false) {
          logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
          return;
        }
        if (topicConfig?.enabled === false) {
          logVerbose(
            `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
          );
          return;
        }
        if (hasGroupAllowOverride) {
          const senderId = msg.from?.id;
          const senderUsername = msg.from?.username ?? "";
          const allowed =
            senderId != null &&
            isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId: String(senderId),
              senderUsername,
            });
          if (!allowed) {
            logVerbose(
              `Blocked telegram group sender ${senderId ?? "unknown"} (group allowFrom override)`,
            );
            return;
          }
        }
        // Group policy filtering: controls how group messages are handled
        // - "open": groups bypass allowFrom, only mention-gating applies
        // - "disabled": block all group messages entirely
        // - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
        const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
        const groupPolicy = firstDefined(
          topicConfig?.groupPolicy,
          groupConfig?.groupPolicy,
          telegramCfg.groupPolicy,
          defaultGroupPolicy,
          "open",
        );
        if (groupPolicy === "disabled") {
          logVerbose(`Blocked telegram group message (groupPolicy: disabled)`);
          return;
        }
        if (groupPolicy === "allowlist") {
          // For allowlist mode, the sender (msg.from.id) must be in allowFrom
          const senderId = msg.from?.id;
          if (senderId == null) {
            logVerbose(`Blocked telegram group message (no sender ID, groupPolicy: allowlist)`);
            return;
          }
          if (!effectiveGroupAllow.hasEntries) {
            logVerbose(
              "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
            );
            return;
          }
          const senderUsername = msg.from?.username ?? "";
          if (
            !isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId: String(senderId),
              senderUsername,
            })
          ) {
            logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
            return;
          }
        }

        // Group allowlist based on configured group IDs.
        const groupAllowlist = resolveGroupPolicy(chatId);
        if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
          logger.info(
            { chatId, title: msg.chat.title, reason: "not-allowed" },
            "skipping group message",
          );
          return;
        }
      }

      // Text fragment handling - Telegram splits long pastes into multiple inbound messages (~4096 chars).
      // We buffer “near-limit” messages and append immediately-following parts.
      const text = typeof msg.text === "string" ? msg.text : undefined;
      const isCommandLike = (text ?? "").trim().startsWith("/");
      if (text && !isCommandLike) {
        const nowMs = Date.now();
        const senderId = msg.from?.id != null ? String(msg.from.id) : "unknown";
        const key = `text:${chatId}:${resolvedThreadId ?? "main"}:${senderId}`;
        const existing = textFragmentBuffer.get(key);

        if (existing) {
          const last = existing.messages.at(-1);
          const lastMsgId = last?.msg.message_id;
          const lastReceivedAtMs = last?.receivedAtMs ?? nowMs;
          const idGap = typeof lastMsgId === "number" ? msg.message_id - lastMsgId : Infinity;
          const timeGapMs = nowMs - lastReceivedAtMs;
          const canAppend =
            idGap > 0 &&
            idGap <= TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP &&
            timeGapMs >= 0 &&
            timeGapMs <= TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS;

          if (canAppend) {
            const currentTotalChars = existing.messages.reduce(
              (sum, m) => sum + (m.msg.text?.length ?? 0),
              0,
            );
            const nextTotalChars = currentTotalChars + text.length;
            if (
              existing.messages.length + 1 <= TELEGRAM_TEXT_FRAGMENT_MAX_PARTS &&
              nextTotalChars <= TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS
            ) {
              existing.messages.push({ msg, ctx, receivedAtMs: nowMs });
              scheduleTextFragmentFlush(existing);
              return;
            }
          }

          // Not appendable (or limits exceeded): flush buffered entry first, then continue normally.
          clearTimeout(existing.timer);
          textFragmentBuffer.delete(key);
          textFragmentProcessing = textFragmentProcessing
            .then(async () => {
              await flushTextFragments(existing);
            })
            .catch(() => undefined);
          await textFragmentProcessing;
        }

        const shouldStart = text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS;
        if (shouldStart) {
          const entry: TextFragmentEntry = {
            key,
            messages: [{ msg, ctx, receivedAtMs: nowMs }],
            timer: setTimeout(() => {}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS),
          };
          textFragmentBuffer.set(key, entry);
          scheduleTextFragmentFlush(entry);
          return;
        }
      }

      // Media group handling - buffer multi-image messages
      const mediaGroupId = msg.media_group_id;
      if (mediaGroupId) {
        const existing = mediaGroupBuffer.get(mediaGroupId);
        if (existing) {
          clearTimeout(existing.timer);
          existing.messages.push({ msg, ctx });
          existing.timer = setTimeout(async () => {
            mediaGroupBuffer.delete(mediaGroupId);
            mediaGroupProcessing = mediaGroupProcessing
              .then(async () => {
                await processMediaGroup(existing);
              })
              .catch(() => undefined);
            await mediaGroupProcessing;
          }, mediaGroupTimeoutMs);
        } else {
          const entry: MediaGroupEntry = {
            messages: [{ msg, ctx }],
            timer: setTimeout(async () => {
              mediaGroupBuffer.delete(mediaGroupId);
              mediaGroupProcessing = mediaGroupProcessing
                .then(async () => {
                  await processMediaGroup(entry);
                })
                .catch(() => undefined);
              await mediaGroupProcessing;
            }, mediaGroupTimeoutMs),
          };
          mediaGroupBuffer.set(mediaGroupId, entry);
        }
        return;
      }

      let media: Awaited<ReturnType<typeof resolveMedia>> = null;
      try {
        media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);
      } catch (mediaErr) {
        const errMsg = String(mediaErr);
        if (errMsg.includes("exceeds") && errMsg.includes("MB limit")) {
          const limitMb = Math.round(mediaMaxBytes / (1024 * 1024));
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(chatId, `⚠️ File too large. Maximum size is ${limitMb}MB.`, {
                reply_to_message_id: msg.message_id,
              }),
          }).catch(() => {});
          logger.warn({ chatId, error: errMsg }, "media exceeds size limit");
          return;
        }
        throw mediaErr;
      }

      // Skip sticker-only messages where the sticker was skipped (animated/video)
      // These have no media and no text content to process.
      const hasText = Boolean((msg.text ?? msg.caption ?? "").trim());
      if (msg.sticker && !media && !hasText) {
        logVerbose("telegram: skipping sticker-only message (unsupported sticker type)");
        return;
      }

      const allMedia = media
        ? [
            {
              path: media.path,
              contentType: media.contentType,
              stickerMetadata: media.stickerMetadata,
            },
          ]
        : [];
      const senderId = msg.from?.id ? String(msg.from.id) : "";
      const conversationKey =
        resolvedThreadId != null ? `${chatId}:topic:${resolvedThreadId}` : String(chatId);
      const debounceKey = senderId
        ? `telegram:${accountId ?? "default"}:${conversationKey}:${senderId}`
        : null;
      await inboundDebouncer.enqueue({
        ctx,
        msg,
        allMedia,
        storeAllowFrom,
        debounceKey,
        botUsername: ctx.me?.username,
      });
    } catch (err) {
      runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  });
};
