type PayloadLike = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
};

type StripLegacyExecPayloadsParams = {
  payloads?: PayloadLike[];
};

type LegacyExecTextCall = {
  command: string;
};

const BARE_JSON_EXEC_CUE_RE = /\b(?:approve|approval|deny|pending|shell|exec|tool|command|run)\b/i;

function extractCommandFromJsonBlob(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { cmd?: unknown; command?: unknown };
    const command =
      typeof parsed.cmd === "string" && parsed.cmd.trim()
        ? parsed.cmd.trim()
        : typeof parsed.command === "string" && parsed.command.trim()
          ? parsed.command.trim()
          : null;
    if (!command) {
      return null;
    }
    const allowedKeys = new Set(["cmd", "command"]);
    const parsedRecord = parsed as Record<string, unknown>;
    for (const key of Object.keys(parsedRecord)) {
      if (!allowedKeys.has(key)) {
        return null;
      }
    }
    return command;
  } catch {
    return null;
  }
}

function shouldRecoverBareJsonExec(params: {
  text: string;
  start: number;
  nextIndex: number;
}): boolean {
  const before = params.text.slice(Math.max(0, params.start - 160), params.start);
  const after = params.text.slice(
    params.nextIndex,
    Math.min(params.text.length, params.nextIndex + 160),
  );
  const context = `${before}\n${after}`;
  if (!BARE_JSON_EXEC_CUE_RE.test(context)) {
    return false;
  }
  // Ignore literal examples inside fenced code blocks.
  const fencesBefore = (before.match(/```/g) ?? []).length;
  const fencesAfter = (after.match(/```/g) ?? []).length;
  return fencesBefore % 2 === 0 && fencesAfter % 2 === 0;
}

function needsGapBetween(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  const leftChar = left[left.length - 1] ?? "";
  const rightChar = right[0] ?? "";
  return /\S/.test(leftChar) && /\S/.test(rightChar);
}

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
  if (!text.includes("[exec") && !/"(?:cmd|command)"\s*:/i.test(text)) {
    return { cleanedText: text, calls: [] };
  }

  const calls: LegacyExecTextCall[] = [];
  let cleaned = "";
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf("[exec", cursor);
    const jsonStart = text.indexOf("{", cursor);
    const useJsonCandidate = start < 0 || (jsonStart >= 0 && jsonStart < start);
    if (start < 0 && jsonStart < 0) {
      cleaned += text.slice(cursor);
      break;
    }

    if (useJsonCandidate) {
      const parsedJson = jsonStart >= 0 ? parseBalancedJsonObject(text, jsonStart) : null;
      if (!parsedJson) {
        cleaned += text.slice(cursor, jsonStart + 1);
        cursor = jsonStart + 1;
        continue;
      }
      const command = extractCommandFromJsonBlob(parsedJson.raw);
      if (
        !command ||
        !shouldRecoverBareJsonExec({ text, start: jsonStart, nextIndex: parsedJson.nextIndex })
      ) {
        cleaned += text.slice(cursor, parsedJson.nextIndex);
        cursor = parsedJson.nextIndex;
        continue;
      }
      cleaned += text.slice(cursor, jsonStart);
      calls.push({ command });
      const trailing = text.slice(parsedJson.nextIndex);
      if (needsGapBetween(cleaned, trailing)) {
        cleaned += " ";
      }
      cursor = parsedJson.nextIndex;
      continue;
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
      const jsonCommand = extractCommandFromJsonBlob(parsedJson.raw);
      if (!command) {
        command = jsonCommand;
      }
      if (jsonCommand) {
        nextIndex = parsedJson.nextIndex;
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

export async function stripLegacyExecTextCallsInPayloads(
  params: StripLegacyExecPayloadsParams,
): Promise<PayloadLike[] | undefined> {
  if (!params.payloads?.length) {
    return params.payloads;
  }

  const nextPayloads: PayloadLike[] = [];

  for (const payload of params.payloads) {
    if (typeof payload.text !== "string") {
      nextPayloads.push(payload);
      continue;
    }

    const { cleanedText, calls } = extractLegacyExecTextCalls(payload.text);
    if (calls.length === 0) {
      nextPayloads.push(payload);
      continue;
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
