import type { z } from 'zod';

const FENCE = /```[\w-]*[ \t]*\n?([\s\S]*?)\n?[ \t]*```/g;

/**
 * The JSON value an AI tool's reply holds, checked against `schema` (`JsonValueSchema` for any JSON value), or
 * undefined when it holds none that matches.
 *
 * The reply is read as a whole first. Otherwise the fenced blocks that hold JSON, last first, then the JSON objects
 * and arrays written in the prose, last first: the first one `schema` accepts wins, so a reply that explains itself
 * before or after its answer, or quotes an example after it, still counts.
 */
export function extractReply<T>(text: string, schema: z.ZodType<T>): T | undefined {
  for (const value of candidatesOf(text)) {
    const parsed = schema.safeParse(value);

    if (parsed.success) return parsed.data;
  }

  return undefined;
}

function* candidatesOf(text: string): Generator<unknown> {
  const whole = jsonOf(text);

  if (whole !== undefined) {
    yield whole.value;

    return;
  }

  for (const match of [...text.matchAll(FENCE)].toReversed()) {
    const fenced = jsonOf(match[1] ?? '');

    if (fenced !== undefined) yield fenced.value;
  }

  for (const inline of inlineValuesOf(text).toReversed()) yield inline;
}

function jsonOf(text: string): { value: unknown } | undefined {
  const trimmed = text.trim();

  if (trimmed === '') return undefined;

  try {
    return { value: JSON.parse(trimmed) };
  } catch {
    return undefined;
  }
}

/** Every top-level `{…}` or `[…]` in prose that parses as JSON, in order. */
function inlineValuesOf(text: string): unknown[] {
  const values: unknown[] = [];

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const end = closingOf(text, start);

    if (end === undefined) continue;
    const found = jsonOf(text.slice(start, end + 1));

    if (found === undefined) continue;
    values.push(found.value);
    start = end;
  }

  return values;
}

/** Where the bracket opened at `start` closes, skipping brackets inside JSON strings, or undefined when it never does. */
function closingOf(text: string, start: number): number | undefined {
  const open: string[] = [];
  let inString = false;

  for (let at = start; at < text.length; at++) {
    const char = text[at];

    if (inString) {
      if (char === '\\') at++;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') open.push('}');
    else if (char === '[') open.push(']');
    else if (char === '}' || char === ']') {
      if (open.pop() !== char) return undefined;

      if (open.length === 0) return at;
    }
  }

  return undefined;
}
