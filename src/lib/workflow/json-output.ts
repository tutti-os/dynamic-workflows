import type { WorkflowValue } from "./types";

const RAW_EXCERPT_LIMIT = 200;

export class AgentJsonOutputError extends Error {
  constructor(raw: string) {
    super(
      `Agent output declared output: "json" but no JSON value could be parsed from it. Raw output excerpt: ${excerptRawOutput(raw)}`,
    );
    this.name = "AgentJsonOutputError";
  }
}

/**
 * Extraction policy for `output: "json"` agent messages, tried in order:
 * 1. the whole trimmed message as JSON,
 * 2. the last fenced code block that parses as JSON,
 * 3. the last balanced top-level {...} or [...] span that parses as JSON.
 * Nothing parses -> AgentJsonOutputError with a short raw excerpt.
 */
export function extractAgentJsonOutput(raw: string): WorkflowValue {
  const trimmed = raw.trim();

  const whole = tryParseJson(trimmed);
  if (whole.ok) {
    return whole.value;
  }

  const fenced = lastParsableFencedBlock(trimmed);
  if (fenced.ok) {
    return fenced.value;
  }

  const balanced = lastParsableBalancedSpan(trimmed);
  if (balanced.ok) {
    return balanced.value;
  }

  throw new AgentJsonOutputError(raw);
}

type ParseResult =
  | { ok: true; value: WorkflowValue }
  | { ok: false };

function tryParseJson(text: string): ParseResult {
  if (!text) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) as WorkflowValue };
  } catch {
    return { ok: false };
  }
}

const FENCED_BLOCK_PATTERN = /```[^\n]*\n([\s\S]*?)```/g;

function lastParsableFencedBlock(text: string): ParseResult {
  let result: ParseResult = { ok: false };
  for (const match of text.matchAll(FENCED_BLOCK_PATTERN)) {
    const parsed = tryParseJson(match[1].trim());
    if (parsed.ok) {
      result = parsed;
    }
  }
  return result;
}

function lastParsableBalancedSpan(text: string): ParseResult {
  const spans: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "{" || char === "[") {
      const end = findBalancedEnd(text, index);
      if (end !== -1) {
        spans.push(text.slice(index, end + 1));
        index = end + 1;
        continue;
      }
    }
    index += 1;
  }

  for (let position = spans.length - 1; position >= 0; position -= 1) {
    const parsed = tryParseJson(spans[position]);
    if (parsed.ok) {
      return parsed;
    }
  }
  return { ok: false };
}

function findBalancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function excerptRawOutput(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (collapsed.length <= RAW_EXCERPT_LIMIT) {
    return collapsed || "(empty)";
  }
  return `${collapsed.slice(0, RAW_EXCERPT_LIMIT)}…`;
}
