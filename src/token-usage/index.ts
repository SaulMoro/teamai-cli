/**
 * What each AI tool's sessions spent: tokens, the model of each request, and
 * the cost a tool reported. A tool names the format it writes in its `TOOLS`
 * entry (`tokens`); `readTokenUsage` reads a session in that format, and
 * `priceTokens` (./pricing.ts) prices its requests.
 */
import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import type { TokenReading, TokenSource } from '@teamai/tool-core/tokens';
import { readAgyTranscript } from './formats/agy-transcript.js';
import { readCodebuddy } from './formats/codebuddy.js';
import { readMuseSession } from './formats/muse-session.js';
import { readOpencodeDb } from './formats/opencode-db.js';

const FORMATS = {
  'claude-jsonl': BUILT_IN_TOOLS.claude.tokens['claude-jsonl'],
  'codex-rollout': BUILT_IN_TOOLS.codex.tokens['codex-rollout'],
  codebuddy: readCodebuddy,
  'muse-session': readMuseSession,
  'agy-transcript': readAgyTranscript,
  'pi-session': BUILT_IN_TOOLS.pi.tokens['pi-session'],
  'opencode-db': readOpencodeDb,
} satisfies Record<string, (source: TokenSource) => Promise<TokenReading>>;

/** A transcript format teamai reads token usage from. */
export type TokenFormatId = keyof typeof FORMATS;

export function isTokenFormatId(format: string): format is TokenFormatId {
  return Object.hasOwn(FORMATS, format);
}

/** Read a session's token usage in `format`. A source that is missing or unreadable reads as no usage. */
export function readTokenUsage(format: TokenFormatId, source: TokenSource): Promise<TokenReading> {
  return FORMATS[format](source);
}
