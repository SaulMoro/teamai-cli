import path from 'node:path';
import type { PromptUsageSchema } from '@teamai/runtime-protocol';
import { HOST_PROCESSES } from '@teamai/shared/exec';
import { ClaudeCodeAdapter } from '@teamai/tool-core/formats/claude-code';
import { readClaudeJsonl } from '@teamai/tool-core/formats/claude-jsonl';
import { CodexAdapter } from '@teamai/tool-core/formats/codex';
import { readCodexRollout } from '@teamai/tool-core/formats/codex-rollout';
import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import { addTokenUsage, type TokenReading, type TokenSource, type TokenUsage } from '@teamai/tool-core/tokens';
import type { z } from 'zod';
import type { PaseoTool } from './providers.js';

// ─── The tokens a step's agent billed ────────────────────
//
//  Paseo reports a turn's usage without the tokens written to the prompt cache, so the runtime reads them where the
//  agent's tool keeps them: the transcript of its session, in the tool home the session was found in, on a daemon on this
//  machine. OpenCode's steps report none.
//

type PromptUsage = z.infer<typeof PromptUsageSchema>;

// The runtime only reads sessions, and only writing one runs a tool's CLI, so each tool is its own command here.
const SESSION_READER_HOST = { processes: HOST_PROCESSES, executablesOf: (tool: string) => [tool] };

/** How a tool's session transcript records its tokens. */
type Transcript = { sessions(toolHome: string): AgentAdapter; read(source: TokenSource): Promise<TokenReading>; reported(tokens: TokenUsage): PromptUsage };

/**
 * The transcript each tool's sessions record their tokens in, or undefined when the runtime reads none: the store its
 * sessions are in under a tool home, the reader of its format, and the tokens as the tool's own end-of-run usage reports
 * them, which is what a step that runs the tool on this machine reports.
 */
const TRANSCRIPTS: Record<PaseoTool, Transcript | undefined> = {
  claude: {
    sessions: (toolHome) => new ClaudeCodeAdapter('claude-code', path.join(toolHome, 'projects')),
    read: readClaudeJsonl,
    reported: (tokens) => ({ input: tokens.input, output: tokens.output, cachedInput: tokens.cacheRead }),
  },
  codex: {
    sessions: (toolHome) => new CodexAdapter('codex', path.join(toolHome, 'sessions'), SESSION_READER_HOST),
    read: readCodexRollout,
    // Codex counts cached input inside its input tokens.
    reported: (tokens) => ({ input: tokens.input + tokens.cacheRead + tokens.cacheCreation, output: tokens.output, cachedInput: tokens.cacheRead }),
  },
  // OpenCode keeps its sessions in a database only its tool family reads.
  opencode: undefined,
};

/** Whether a step on `tool` can report its tokens, read from its session's transcript on this machine. */
export function readsTokens(tool: PaseoTool): boolean {
  return TRANSCRIPTS[tool] !== undefined;
}

/**
 * The transcript of session `sessionId` in `toolHome`, or undefined when the store does not list it, or cannot be listed,
 * as a folder the daemon's tool can write and teamai cannot read: the step it ran finished all the same.
 */
async function transcriptOf(format: Transcript, { toolHome, cwd, sessionId }: { toolHome: string; cwd: string; sessionId: string }): Promise<string | undefined> {
  try {
    return (await format.sessions(toolHome).listConversations(cwd)).find((session) => session.sessionId === sessionId)?.filePath;
  } catch {
    return undefined;
  }
}

/**
 * The tokens a step billed in session `sessionId` of `tool`, kept in `toolHome` for `cwd`, as the tool's own end-of-run
 * usage reports them: every request of the session for an agent the step created, and only those at or after
 * `turnSentAt` for a turn it sent to an agent that already ran, whose session holds an earlier step's requests too.
 * Undefined when the tool's transcript records no tokens, cannot be found or read, or records no request in that span,
 * or, for a turn, records a request without the time that would place it in or out of the turn: the step then reports no
 * usage, never zero.
 */
export async function stepUsage({ tool, toolHome, cwd, sessionId, turnSentAt }: { tool: PaseoTool; toolHome: string; cwd: string; sessionId: string; turnSentAt?: number }): Promise<PromptUsage | undefined> {
  const format = TRANSCRIPTS[tool];

  if (format === undefined) return undefined;
  const transcript = await transcriptOf(format, { toolHome, cwd, sessionId });

  if (transcript === undefined) return undefined;
  // A Codex turn's usage may land just after Paseo shows the agent idle, so the read waits for it as for a Stop hook.
  const { requests } = await format.read({ transcriptPath: transcript, sessionId, settled: false });
  const billed = requests.map((request) => ({ tokens: request.tokens, at: Date.parse(request.timestamp) }));

  if (turnSentAt !== undefined && billed.some(({ at }) => Number.isNaN(at))) return undefined;
  const own = billed.filter(({ at }) => turnSentAt === undefined || at >= turnSentAt).map(({ tokens }) => tokens);

  return own.length === 0 ? undefined : format.reported(own.reduce((sum, tokens) => addTokenUsage(sum, tokens)));
}
