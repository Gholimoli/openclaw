export type TelegramWorkApprovalAction = "approve" | "deny";

export type ParsedTelegramWorkApprovalCallback = {
  action: TelegramWorkApprovalAction;
};

export type TelegramWorkApprovalButtonRow = Array<{ text: string; callback_data: string }>;

const CALLBACK_PREFIX = "xwk1";

export function buildTelegramWorkApprovalCallbackData(action: TelegramWorkApprovalAction): string {
  return `${CALLBACK_PREFIX}:${action === "approve" ? "y" : "n"}`;
}

export function parseTelegramWorkApprovalCallbackData(
  data: string,
): ParsedTelegramWorkApprovalCallback | null {
  const trimmed = data.trim();
  if (trimmed === `${CALLBACK_PREFIX}:y`) {
    return { action: "approve" };
  }
  if (trimmed === `${CALLBACK_PREFIX}:n`) {
    return { action: "deny" };
  }
  return null;
}

export function buildTelegramWorkApprovalButtons(): TelegramWorkApprovalButtonRow[] {
  return [
    [
      {
        text: "Approve",
        callback_data: buildTelegramWorkApprovalCallbackData("approve"),
      },
      {
        text: "Deny",
        callback_data: buildTelegramWorkApprovalCallbackData("deny"),
      },
    ],
  ];
}

export function extractTelegramWorkResumeToken(messageText: string): string | null {
  const trimmed = messageText.trim();
  if (!trimmed) {
    return null;
  }

  const resumeTokenMatch = /(?:^|\n)resumeToken:\s*\n([^\n]+)\s*(?:\n|$)/i.exec(trimmed);
  if (resumeTokenMatch?.[1]?.trim()) {
    return resumeTokenMatch[1].trim();
  }

  const resumeCommandMatch = /\/work resume (\S+) --approve (?:yes|no)\b/i.exec(trimmed);
  if (resumeCommandMatch?.[1]?.trim()) {
    return resumeCommandMatch[1].trim();
  }

  return null;
}
