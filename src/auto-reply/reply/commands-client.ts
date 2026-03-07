import type { CommandHandler } from "./commands-types.js";
import { logVerbose } from "../../globals.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import {
  listTelegramClientRouteSummaries,
  resolveTelegramClientPeerIdFromContext,
  resolveTelegramClientRouteSummary,
  setTelegramClientRouteAssignment,
} from "../../telegram/client-routing.js";

type ParsedClientCommand =
  | { action: "status"; peerId?: string }
  | { action: "list" }
  | { action: "assign"; agentId: string; peerId?: string }
  | { action: "clear"; peerId?: string };

function parseClientCommand(raw: string): ParsedClientCommand | null {
  const trimmed = raw.trim();
  if (trimmed !== "/client" && !trimmed.startsWith("/client ")) {
    return null;
  }
  const args = trimmed === "/client" ? [] : trimmed.slice("/client".length).trim().split(/\s+/);
  const action = (args[0] || "status").toLowerCase();
  if (action === "list") {
    return { action: "list" };
  }
  if (action === "status") {
    return { action: "status", peerId: args[1] };
  }
  if (action === "assign" || action === "agent" || action === "route") {
    const agentId = args[1]?.trim();
    if (!agentId) {
      return null;
    }
    return { action: "assign", agentId, peerId: args[2] };
  }
  if (action === "clear" || action === "release") {
    return { action: "clear", peerId: args[1] };
  }
  return null;
}

function formatSummary(summary: NonNullable<ReturnType<typeof resolveTelegramClientRouteSummary>>) {
  const lines = [
    `Telegram client route: ${summary.label ?? summary.peerId}`,
    `Peer: ${summary.peerId}`,
    `Account: ${summary.accountId}`,
    `Enabled: ${summary.enabled ? "yes" : "no"}`,
    `Default agent: ${summary.defaultAgentId ?? "-"}`,
    `Assigned agent: ${summary.assignedAgentId ?? "-"}`,
  ];
  if (summary.allowedAgents && summary.allowedAgents.length > 0) {
    lines.push(`Allowed agents: ${summary.allowedAgents.join(", ")}`);
  }
  if (summary.updatedAt) {
    lines.push(`Updated: ${new Date(summary.updatedAt).toISOString()}`);
  }
  if (summary.updatedBy) {
    lines.push(`Updated by: ${summary.updatedBy}`);
  }
  return lines.join("\n");
}

function resolveTargetPeerId(params: { parsed: ParsedClientCommand; currentPeerId?: string }) {
  if ("peerId" in params.parsed && params.parsed.peerId?.trim()) {
    return params.parsed.peerId.trim();
  }
  return params.currentPeerId?.trim();
}

export const handleTelegramClientCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.channel !== "telegram") {
    return null;
  }
  const parsed = parseClientCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /client from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const currentPeerId = resolveTelegramClientPeerIdFromContext(params.ctx);
  const accountId = params.ctx.AccountId;
  if (parsed.action === "list") {
    const entries = listTelegramClientRouteSummaries({
      cfg: params.cfg,
      accountId,
    });
    if (entries.length === 0) {
      return {
        shouldContinue: false,
        reply: {
          text: "No Telegram client routes are configured for this account.",
        },
      };
    }
    const lines = ["Telegram client routes:"];
    for (const entry of entries.slice(0, 20)) {
      const label = entry.label ?? entry.peerId;
      const assigned = entry.assignedAgentId ?? entry.defaultAgentId ?? "-";
      lines.push(`- ${label} (${entry.peerId}) -> ${assigned}`);
    }
    if (entries.length > 20) {
      lines.push(`- ... ${entries.length - 20} more`);
    }
    return {
      shouldContinue: false,
      reply: { text: lines.join("\n") },
    };
  }

  const peerId = resolveTargetPeerId({ parsed, currentPeerId });
  if (!peerId) {
    return {
      shouldContinue: false,
      reply: {
        text: "Usage: /client status [peer]\n/client list\n/client assign <agent> [peer]\n/client clear [peer]",
      },
    };
  }

  if (parsed.action === "status") {
    const summary = resolveTelegramClientRouteSummary({
      cfg: params.cfg,
      accountId,
      peerId,
    });
    return {
      shouldContinue: false,
      reply: {
        text: summary
          ? formatSummary(summary)
          : `Telegram client route not configured for peer ${peerId}.`,
      },
    };
  }

  const updated = await setTelegramClientRouteAssignment({
    cfg: params.cfg,
    accountId,
    peerId,
    agentId: parsed.action === "assign" ? parsed.agentId : undefined,
    updatedBy: params.command.senderId,
  });
  if (!updated) {
    return {
      shouldContinue: false,
      reply: {
        text: `Telegram client route not configured for peer ${peerId}.`,
      },
    };
  }
  const eventText =
    parsed.action === "assign"
      ? `Telegram client route updated: ${peerId} -> ${updated.assignedAgentId ?? "-"}`
      : `Telegram client route cleared: ${peerId}`;
  enqueueSystemEvent(eventText, { sessionKey: params.sessionKey });
  return {
    shouldContinue: false,
    reply: {
      text:
        parsed.action === "assign"
          ? `Client route updated.\n${formatSummary(updated)}`
          : `Client route cleared.\n${formatSummary(updated)}`,
    },
  };
};
