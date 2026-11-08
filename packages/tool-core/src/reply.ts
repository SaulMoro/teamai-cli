import type { z } from 'zod';

const FENCE = /```[\w-]*[ \t]*\n([\s\S]*?)\n?[ \t]*```/g;

/**
 * The JSON value an AI tool's reply holds, checked against `schema` (`JsonValueSchema` for any JSON value), or undefined when it holds none that matches.
 *
 * The reply is read as a whole first. Otherwise the last fenced block that holds JSON wins, then the last JSON
 * object or array written in the prose, so a reply that explains itself before or after its answer still counts.
 */
export function extractReply<T>(text: string, schema: z.ZodType<T>): T | undefined {
  const found = wholeOf(text) ?? lastFencedOf(text) ?? lastInlineOf(text);

  if (found === undefined) return undefined;
  const parsed = schema.safeParse(found.value);

  return parsed.success ? parsed.data : undefined;
}

type Found = { value: unknown } | undefined;

function jsonOf(text: string): Found {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

function wholeOf(text: string): Found {
  const trimmed = text.trim();

  return trimmed === '' ? undefined : jsonOf(trimmed);
}

function lastFencedOf(text: string): Found {
  const bodies = [...text.matchAll(FENCE)].map((match) => match[1] ?? '');

  for (const body of bodies.toReversed()) {
    const found = wholeOf(body);

    if (found !== undefined) return found;
  }

  return undefined;
}

/** The last top-level `{…}` or `[…]` in prose that parses as JSON. */
function lastInlineOf(text: string): Found {
  let last: Found;

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const end = closingOf(text, start);

    if (end === undefined) continue;
    const found = jsonOf(text.slice(start, end + 1));

    if (found === undefined) continue;
    last = found;
    start = end;
  }

  return last;
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
