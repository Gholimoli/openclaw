export type TelegramChoiceButtonRow = Array<{ text: string; callback_data: string }>;

export type ParsedTelegramChoiceCallback = {
  choice: string;
};

const CALLBACK_PREFIX = "xcm1";
const MAX_CALLBACK_DATA_BYTES = 64;
const OPTIONS_LINE_RE = /^Options:\s*(.+?)(?:\.)?$/i;
const FORBIDDEN_OPTION_CHARS_RE = /[=|<>`]/;
const SIMPLE_OPTION_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+/-]{0,31}$/;

function encodeChoice(choice: string): string | null {
  const trimmed = choice.trim();
  if (!trimmed) {
    return null;
  }
  const encoded = encodeURIComponent(trimmed);
  if (!encoded) {
    return null;
  }
  const data = `${CALLBACK_PREFIX}:${encoded}`;
  if (Buffer.byteLength(data, "utf8") > MAX_CALLBACK_DATA_BYTES) {
    return null;
  }
  return data;
}

export function parseTelegramChoiceCallbackData(data: string): ParsedTelegramChoiceCallback | null {
  const trimmed = data.trim();
  const match = /^xcm1:(.+)$/i.exec(trimmed);
  if (!match?.[1]) {
    return null;
  }
  try {
    const choice = decodeURIComponent(match[1]).trim();
    return choice ? { choice } : null;
  } catch {
    return null;
  }
}

function splitSimpleOptions(text: string): string[] | null {
  if (FORBIDDEN_OPTION_CHARS_RE.test(text)) {
    return null;
  }
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2 || parts.length > 6) {
    return null;
  }
  if (!parts.every((part) => SIMPLE_OPTION_RE.test(part))) {
    return null;
  }
  return Array.from(new Set(parts));
}

export function buildTelegramChoiceButtons(choices: string[]): TelegramChoiceButtonRow[] | null {
  if (choices.length < 2 || choices.length > 6) {
    return null;
  }
  const rows: TelegramChoiceButtonRow[] = [];
  let currentRow: TelegramChoiceButtonRow = [];
  for (const choice of choices) {
    const callback_data = encodeChoice(choice);
    if (!callback_data) {
      return null;
    }
    currentRow.push({ text: choice, callback_data });
    if (currentRow.length === 2) {
      rows.push(currentRow);
      currentRow = [];
    }
  }
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }
  return rows;
}

export function resolveTelegramAutoChoiceMenu(text: string | undefined): {
  text: string;
  buttons: TelegramChoiceButtonRow[] | null;
} | null {
  const raw = text?.trimEnd();
  if (!raw) {
    return null;
  }

  const lines = raw.split("\n");
  let lastNonEmptyIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]?.trim()) {
      lastNonEmptyIndex = i;
      break;
    }
  }
  if (lastNonEmptyIndex < 0) {
    return null;
  }

  const lastLine = lines[lastNonEmptyIndex]?.trim();
  const match = lastLine ? OPTIONS_LINE_RE.exec(lastLine) : null;
  if (!match?.[1]) {
    return null;
  }

  const choices = splitSimpleOptions(match[1]);
  if (!choices) {
    return null;
  }
  const buttons = buildTelegramChoiceButtons(choices);
  if (!buttons) {
    return null;
  }

  const strippedText = lines.slice(0, lastNonEmptyIndex).join("\n").trimEnd();
  if (!strippedText) {
    return null;
  }

  return {
    text: strippedText,
    buttons,
  };
}
