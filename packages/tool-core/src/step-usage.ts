import { readClaudeJsonl } from './formats/claude-jsonl.js';
import { readCodexRollout } from './formats/codex-rollout.js';
import type { TokenUsage as ReportedTokens } from './stdout.js';
import { addTokenUsage, type TokenReading, type TokenSource, type TokenUsage } from './tokens.js';

/**
 * The transcript formats a runtime reads a step's tokens from, each with its reader and the tokens as the tool's own
 * end-of-run usage reports them, which is what a step that runs the tool on this machine reports. Claude Code reports no
 * tokens written to the prompt cache; Codex counts cached input inside its input tokens.
 */
const STEP_FORMATS = {
  'claude-jsonl': { read: readClaudeJsonl, reported: (tokens) => ({ input: tokens.input, output: tokens.output, cachedInput: tokens.cacheRead }) },
  'codex-rollout': { read: readCodexRollout, reported: (tokens) => ({ input: tokens.input + tokens.cacheRead + tokens.cacheCreation, output: tokens.output, cachedInput: tokens.cacheRead }) },
} satisfies Record<string, { read(source: TokenSource): Promise<TokenReading>; reported(tokens: TokenUsage): ReportedTokens }>;

export type StepTokenFormat = keyof typeof STEP_FORMATS;

/**
 * The tokens a step billed in session `sessionId`, whose transcript in `format` is `transcriptPath`, as the tool's own
 * end-of-run usage reports them: every request of the session for a step that started it, and only those at or after
 * `turnSentAt` for a turn the step sent to an earlier step's conversation, whose session holds that step's requests too.
 * Undefined when the transcript is missing or unreadable or records no request in that span, or, for a turn, records a
 * request without the time that would place it in or out of the turn: the step then reports no usage, never zero.
 */
export async function stepUsage({ format, transcriptPath, sessionId, turnSentAt }: { format: StepTokenFormat; transcriptPath: string; sessionId: string; turnSentAt?: number }): Promise<ReportedTokens | undefined> {
  const { read, reported } = STEP_FORMATS[format];
  // A Codex turn's usage may land just after the tool shows the turn ended, so the read waits for it as for a Stop hook.
  const { requests } = await read({ transcriptPath, sessionId, settled: false });
  const billed = requests.map((request) => ({ tokens: request.tokens, at: Date.parse(request.timestamp) }));

  if (turnSentAt !== undefined && billed.some(({ at }) => Number.isNaN(at))) return undefined;
  const own = billed.filter(({ at }) => turnSentAt === undefined || at >= turnSentAt).map(({ tokens }) => tokens);

  return own.length === 0 ? undefined : reported(own.reduce((sum, tokens) => addTokenUsage(sum, tokens)));
}
