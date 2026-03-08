import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import type { ExecToolDefaults, ProcessToolDefaults } from "./bash-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

type ExecLikeTool = {
  name: string;
  execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
};

type PayloadLike = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
};

type RecoverLegacyExecPayloadsParams = {
  payloads?: PayloadLike[];
  disableTools?: boolean;
  abortSignal?: AbortSignal;
  exec?: ExecToolDefaults & ProcessToolDefaults;
  messageProvider?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  senderIsOwner?: boolean;
  sessionKey?: string;
  agentDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  modelProvider?: string;
  modelId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
  modelHasVision?: boolean;
  requireExplicitMessageTarget?: boolean;
  createTools?: typeof createOpenClawCodingTools;
  onRecoverError?: (error: unknown, command: string) => void;
};

type LegacyExecTextCall = {
  command: string;
};

function readQuotedValue(text: string, start: number): { value: string; nextIndex: number } | null {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  let value = "";
  let escaped = false;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      value += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === quote) {
      return { value, nextIndex: i + 1 };
    }
    value += ch;
  }
  return null;
}

function parseBalancedJsonObject(
  text: string,
  start: number,
): { raw: string; nextIndex: number } | null {
  if (text[start] !== "{") {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          raw: text.slice(start, i + 1),
          nextIndex: i + 1,
        };
      }
    }
  }
  return null;
}

function parseExecCommandFromTag(tagBody: string): string | null {
  const cmdMatch = /\bcmd\s*=\s*/i.exec(tagBody);
  if (!cmdMatch) {
    return null;
  }
  let index = cmdMatch.index + cmdMatch[0].length;
  while (index < tagBody.length && /\s/.test(tagBody[index] ?? "")) {
    index += 1;
  }
  const quoted = readQuotedValue(tagBody, index);
  if (quoted) {
    return quoted.value.trim() || null;
  }
  const raw = tagBody.slice(index).trim();
  if (!raw) {
    return null;
  }
  const end = raw.search(/\s+\w+\s*=/);
  return (end >= 0 ? raw.slice(0, end) : raw).trim() || null;
}

function normalizeExecCleanup(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractLegacyExecTextCalls(text: string): {
  cleanedText: string;
  calls: LegacyExecTextCall[];
} {
  if (!text.includes("[exec")) {
    return { cleanedText: text, calls: [] };
  }

  const calls: LegacyExecTextCall[] = [];
  let cleaned = "";
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf("[exec", cursor);
    if (start < 0) {
      cleaned += text.slice(cursor);
      break;
    }

    cleaned += text.slice(cursor, start);
    const endBracket = text.indexOf("]", start);
    if (endBracket < 0) {
      cleaned += text.slice(start);
      break;
    }

    const tagBody = text.slice(start + 1, endBracket);
    let command = parseExecCommandFromTag(tagBody);
    let nextIndex = endBracket + 1;
    while (nextIndex < text.length && /\s/.test(text[nextIndex] ?? "")) {
      nextIndex += 1;
    }

    const parsedJson = nextIndex < text.length ? parseBalancedJsonObject(text, nextIndex) : null;
    if (parsedJson) {
      try {
        const parsed = JSON.parse(parsedJson.raw) as { cmd?: unknown; command?: unknown };
        if (!command) {
          if (typeof parsed.cmd === "string" && parsed.cmd.trim()) {
            command = parsed.cmd.trim();
          } else if (typeof parsed.command === "string" && parsed.command.trim()) {
            command = parsed.command.trim();
          }
        }
        nextIndex = parsedJson.nextIndex;
      } catch {
        // Leave the JSON blob in the visible text if it was not valid JSON.
      }
    }

    if (!command) {
      cleaned += text.slice(start, nextIndex);
    } else {
      calls.push({ command });
      if (cleaned.endsWith("\n")) {
        let lookahead = nextIndex;
        while (lookahead < text.length && (text[lookahead] === " " || text[lookahead] === "\t")) {
          lookahead += 1;
        }
        if (text[lookahead] === "\r") {
          lookahead += 1;
        }
        if (text[lookahead] === "\n") {
          nextIndex = lookahead + 1;
        }
      }
    }
    cursor = nextIndex;
  }

  return {
    cleanedText: normalizeExecCleanup(cleaned),
    calls,
  };
}

export async function recoverLegacyExecTextCallsInPayloads(
  params: RecoverLegacyExecPayloadsParams,
): Promise<PayloadLike[] | undefined> {
  if (!params.payloads?.length || params.disableTools) {
    return params.payloads;
  }

  let tools: ExecLikeTool[] | null = null;
  let execTool: ExecLikeTool | undefined;
  const createTools = params.createTools ?? createOpenClawCodingTools;
  const nextPayloads: PayloadLike[] = [];

  for (const payload of params.payloads) {
    if (typeof payload.text !== "string" || !payload.text.includes("[exec")) {
      nextPayloads.push(payload);
      continue;
    }

    const { cleanedText, calls } = extractLegacyExecTextCalls(payload.text);
    if (calls.length === 0) {
      nextPayloads.push(payload);
      continue;
    }

    if (!tools) {
      tools = createTools({
        exec: params.exec,
        messageProvider: params.messageProvider,
        agentAccountId: params.agentAccountId,
        messageTo: params.messageTo,
        messageThreadId: params.messageThreadId,
        groupId: params.groupId,
        groupChannel: params.groupChannel,
        groupSpace: params.groupSpace,
        senderId: params.senderId,
        senderName: params.senderName,
        senderUsername: params.senderUsername,
        senderE164: params.senderE164,
        senderIsOwner: params.senderIsOwner,
        sessionKey: params.sessionKey,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        config: params.config,
        abortSignal: params.abortSignal,
        modelProvider: params.modelProvider,
        modelId: params.modelId,
        currentChannelId: params.currentChannelId,
        currentThreadTs: params.currentThreadTs,
        replyToMode: params.replyToMode,
        hasRepliedRef: params.hasRepliedRef,
        modelHasVision: params.modelHasVision,
        requireExplicitMessageTarget: params.requireExplicitMessageTarget,
        disableMessageTool: true,
      }) as ExecLikeTool[];
      execTool = tools.find((tool) => tool.name === "exec");
    }

    if (!execTool) {
      nextPayloads.push(payload);
      continue;
    }

    for (const call of calls) {
      try {
        await execTool.execute(
          `legacy_exec_${crypto.randomUUID()}`,
          { command: call.command },
          params.abortSignal,
        );
      } catch (error) {
        params.onRecoverError?.(error, call.command);
      }
    }

    const nextPayload: PayloadLike = {
      ...payload,
      text: cleanedText || undefined,
    };
    if (nextPayload.text || nextPayload.mediaUrl || (nextPayload.mediaUrls?.length ?? 0) > 0) {
      nextPayloads.push(nextPayload);
    }
  }

  return nextPayloads.length > 0 ? nextPayloads : undefined;
}
