export type ExecApprovalCallbackAction =
  | "allow-once"
  | "always"
  | "confirm-always"
  | "deny"
  | "back";

export type ParsedExecApprovalCallback = {
  approvalId: string;
  action: ExecApprovalCallbackAction;
};

export type ExecApprovalButtonRow = Array<{ text: string; callback_data: string }>;

const CALLBACK_PREFIX = "xap1";
const MAX_CALLBACK_DATA_BYTES = 64;

const ACTION_TO_OP: Record<ExecApprovalCallbackAction, string> = {
  "allow-once": "o",
  always: "a",
  "confirm-always": "c",
  deny: "d",
  back: "b",
};

const OP_TO_ACTION: Record<string, ExecApprovalCallbackAction> = {
  o: "allow-once",
  a: "always",
  c: "confirm-always",
  d: "deny",
  b: "back",
};

function encodeApprovalId(approvalId: string): string | null {
  const trimmed = approvalId.trim();
  if (!trimmed) {
    return null;
  }
  const encoded = encodeURIComponent(trimmed);
  return encoded ? encoded : null;
}

function decodeApprovalId(encoded: string): string | null {
  if (!encoded.trim()) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(encoded).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

export function buildExecApprovalCallbackData(params: {
  approvalId: string;
  action: ExecApprovalCallbackAction;
}): string | null {
  const encodedId = encodeApprovalId(params.approvalId);
  if (!encodedId) {
    return null;
  }
  const op = ACTION_TO_OP[params.action];
  if (!op) {
    return null;
  }
  const data = `${CALLBACK_PREFIX}:${op}:${encodedId}`;
  if (Buffer.byteLength(data, "utf8") > MAX_CALLBACK_DATA_BYTES) {
    return null;
  }
  return data;
}

export function parseExecApprovalCallbackData(data: string): ParsedExecApprovalCallback | null {
  const trimmed = data.trim();
  const match = /^xap1:([a-z]):(.+)$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const op = match[1]?.toLowerCase();
  const action = OP_TO_ACTION[op ?? ""];
  if (!action) {
    return null;
  }
  const approvalId = decodeApprovalId(match[2] ?? "");
  if (!approvalId) {
    return null;
  }
  return { approvalId, action };
}

export function buildExecApprovalDefaultButtons(
  approvalId: string,
): ExecApprovalButtonRow[] | null {
  const allowOnce = buildExecApprovalCallbackData({ approvalId, action: "allow-once" });
  const always = buildExecApprovalCallbackData({ approvalId, action: "always" });
  const deny = buildExecApprovalCallbackData({ approvalId, action: "deny" });
  if (!allowOnce || !always || !deny) {
    return null;
  }
  return [
    [
      { text: "Approve", callback_data: allowOnce },
      { text: "Deny", callback_data: deny },
    ],
    [{ text: "Always allow", callback_data: always }],
  ];
}

export function buildExecApprovalConfirmButtons(
  approvalId: string,
): ExecApprovalButtonRow[] | null {
  const confirm = buildExecApprovalCallbackData({ approvalId, action: "confirm-always" });
  const back = buildExecApprovalCallbackData({ approvalId, action: "back" });
  if (!confirm || !back) {
    return null;
  }
  return [
    [{ text: "Confirm always allow", callback_data: confirm }],
    [{ text: "Back", callback_data: back }],
  ];
}
