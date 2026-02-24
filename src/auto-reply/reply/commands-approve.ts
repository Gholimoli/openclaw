import type { CommandHandler } from "./commands-types.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  isInternalMessageChannel,
} from "../../utils/message-channel.js";

const COMMAND = "/approve";
const USAGE = "Usage: /approve <id> allow-once|allow-always|deny";
const DEFAULT_LIST_LIMIT = 5;

const DECISION_ALIASES: Record<string, "allow-once" | "allow-always" | "deny"> = {
  allow: "allow-once",
  once: "allow-once",
  "allow-once": "allow-once",
  allowonce: "allow-once",
  always: "allow-always",
  "allow-always": "allow-always",
  allowalways: "allow-always",
  deny: "deny",
  reject: "deny",
  block: "deny",
};

type ParsedApproveCommand =
  | { ok: true; action: "list" }
  | { ok: true; action: "resolve"; id: string; decision: "allow-once" | "allow-always" | "deny" }
  | { ok: false; error: string };

type ExecApprovalListResponse = {
  items?: Array<{
    id?: unknown;
    createdAtMs?: unknown;
    expiresAtMs?: unknown;
    request?: {
      command?: unknown;
      cwd?: unknown;
      host?: unknown;
      agentId?: unknown;
      sessionKey?: unknown;
    };
  }>;
};

function parseApproveCommand(raw: string): ParsedApproveCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(COMMAND)) {
    return null;
  }
  const rest = trimmed.slice(COMMAND.length).trim();
  if (!rest) {
    return { ok: true, action: "list" };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return { ok: false, error: USAGE };
  }

  const first = tokens[0].toLowerCase();
  const second = tokens[1].toLowerCase();

  if (DECISION_ALIASES[first]) {
    return {
      ok: true,
      action: "resolve",
      decision: DECISION_ALIASES[first],
      id: tokens.slice(1).join(" ").trim(),
    };
  }
  if (DECISION_ALIASES[second]) {
    return {
      ok: true,
      action: "resolve",
      decision: DECISION_ALIASES[second],
      id: tokens[0],
    };
  }
  return { ok: false, error: USAGE };
}

function buildResolvedByLabel(params: Parameters<CommandHandler>[0]): string {
  const channel = params.command.channel;
  const sender = params.command.senderId ?? "unknown";
  return `${channel}:${sender}`;
}

function normalizeListItems(value: ExecApprovalListResponse["items"]) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const id = typeof item?.id === "string" ? item.id.trim() : "";
      if (!id) {
        return null;
      }
      const command =
        typeof item?.request?.command === "string"
          ? item.request.command.trim()
          : "<unknown command>";
      const expiresAtMs =
        typeof item?.expiresAtMs === "number" && Number.isFinite(item.expiresAtMs)
          ? item.expiresAtMs
          : null;
      return {
        id,
        command,
        expiresAtMs,
      };
    })
    .filter((item): item is { id: string; command: string; expiresAtMs: number | null } =>
      Boolean(item),
    );
}

function formatCommandPreview(command: string, maxChars = 120): string {
  const flattened = command.replace(/\s+/g, " ").trim();
  if (!flattened) {
    return "<unknown command>";
  }
  if (flattened.length <= maxChars) {
    return flattened;
  }
  return `${flattened.slice(0, maxChars - 3)}...`;
}

function formatPendingApprovalsReply(params: {
  sessionScoped: boolean;
  items: Array<{ id: string; command: string; expiresAtMs: number | null }>;
}): string {
  const now = Date.now();
  const lines: string[] = [];
  lines.push(
    params.sessionScoped
      ? "Pending exec approvals for this session:"
      : "Pending exec approvals (all sessions):",
  );
  for (const item of params.items) {
    const expiresIn =
      typeof item.expiresAtMs === "number"
        ? Math.max(0, Math.round((item.expiresAtMs - now) / 1000))
        : null;
    lines.push(
      `• ${item.id}${expiresIn === null ? "" : ` (expires in ${expiresIn}s)`}: ${formatCommandPreview(item.command)}`,
    );
    lines.push(`/approve ${item.id} allow-once`);
    lines.push(`/approve ${item.id} allow-always`);
    lines.push(`/approve ${item.id} deny`);
  }
  return lines.join("\n");
}

export const handleApproveCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const parsed = parseApproveCommand(normalized);
  if (!parsed) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  if (isInternalMessageChannel(params.command.channel)) {
    const scopes = params.ctx.GatewayClientScopes ?? [];
    const hasApprovals = scopes.includes("operator.approvals") || scopes.includes("operator.admin");
    if (!hasApprovals) {
      logVerbose("Ignoring /approve from gateway client missing operator.approvals.");
      return {
        shouldContinue: false,
        reply: {
          text: "❌ /approve requires operator.approvals for gateway clients.",
        },
      };
    }
  }

  const resolvedBy = buildResolvedByLabel(params);

  if (parsed.action === "list") {
    const sessionKey = params.sessionKey?.trim();
    try {
      const list = await callGateway<ExecApprovalListResponse>({
        method: "exec.approval.list",
        params: {
          limit: DEFAULT_LIST_LIMIT,
          ...(sessionKey ? { sessionKey } : {}),
        },
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientDisplayName: `Chat approval (${resolvedBy})`,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      });
      const items = normalizeListItems(list.items);
      if (items.length === 0) {
        return {
          shouldContinue: false,
          reply: {
            text: sessionKey
              ? `No pending exec approvals for this session.\n${USAGE}`
              : `No pending exec approvals.\n${USAGE}`,
          },
        };
      }
      return {
        shouldContinue: false,
        reply: {
          text: formatPendingApprovalsReply({
            sessionScoped: Boolean(sessionKey),
            items,
          }),
        },
      };
    } catch (err) {
      return {
        shouldContinue: false,
        reply: {
          text: `❌ Failed to list approvals: ${String(err)}`,
        },
      };
    }
  }

  try {
    await callGateway({
      method: "exec.approval.resolve",
      params: { id: parsed.id, decision: parsed.decision },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat approval (${resolvedBy})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
  } catch (err) {
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Failed to submit approval: ${String(err)}`,
      },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: `✅ Exec approval ${parsed.decision} submitted for ${parsed.id}.` },
  };
};
