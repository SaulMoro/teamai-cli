// ─── The tail of a stream ───
//
//  A provider streams what a command prints as it comes, and keeps only its end, for the reason a failure names or the
//  answer a command ends with: a command that never stops printing would otherwise grow the runtime without bound, and
//  past V8's longest string, crash it (sandcastle's `boundedTail.ts`).
//

/** How many UTF-16 code units a tail keeps by default: far above any answer a command ends with. */
export const TAIL_CHARS = 64 * 1024;

export interface BoundedTail {
  push(chunk: string): void;
  /** The newest chunks, joined, at most the tail's budget long, never starting with half a character. */
  text(): string;
}

/** A tail of at most `max` code units: the oldest chunks go first, and of one chunk longer than that, its end. */
export function boundedTail(max = TAIL_CHARS): BoundedTail {
  const chunks: string[] = [];
  let length = 0;

  return {
    push(chunk) {
      const kept = chunk.length > max ? chunk.slice(chunk.length - max) : chunk;
      chunks.push(kept);
      length += kept.length;

      while (length > max && chunks.length > 1) length -= chunks.shift()?.length ?? 0;
    },
    text() {
      const joined = chunks.join('');
      const first = joined.charCodeAt(0);

      // A low surrogate first is the second half of a character whose first half was cut.
      return first >= 0xdc00 && first <= 0xdfff ? joined.slice(1) : joined;
    },
  };
}
