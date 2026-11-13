import path from 'node:path';
import { HOST_PROCESSES } from '@teamai/shared/exec';
import { ClaudeCodeAdapter } from '@teamai/tool-core/formats/claude-code';
import { CodexAdapter } from '@teamai/tool-core/formats/codex';
import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import { stepUsage, type StepTokenFormat } from '@teamai/tool-core/step-usage';
import type { PaseoTool } from './providers.js';

// ─── The tokens a step's agent billed ────────────────────
//
//  Paseo reports a turn's usage without the tokens written to the prompt cache, so the runtime reads them where the
//  agent's tool keeps them: the transcript of its session, in the tool home the session was found in, on a daemon on this
//  machine. OpenCode's steps report none.
//

// The runtime only reads sessions, and only writing one runs a tool's CLI, so each tool is its own command here.
const SESSION_READER_HOST = { processes: HOST_PROCESSES, executablesOf: (tool: string) => [tool] };

/** Where a tool's session transcripts are under a tool home, and the format they record tokens in. */
type Transcript = { sessions(toolHome: string): AgentAdapter; tokens: StepTokenFormat };

/** The transcript each tool's sessions record their tokens in, or undefined when the runtime reads none. */
const TRANSCRIPTS: Record<PaseoTool, Transcript | undefined> = {
  claude: { sessions: (toolHome) => new ClaudeCodeAdapter('claude-code', path.join(toolHome, 'projects')), tokens: 'claude-jsonl' },
  codex: { sessions: (toolHome) => new CodexAdapter('codex', path.join(toolHome, 'sessions'), SESSION_READER_HOST), tokens: 'codex-rollout' },
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
 * The tokens a step billed in session `sessionId` of `tool`, kept in `toolHome` for `cwd`, as `stepUsage` reads them
 * (`turnSentAt` for a turn sent to an agent that already ran). Undefined when the tool's transcript records no tokens or
 * cannot be found: the step then reports no usage, never zero.
 */
export async function sessionUsage({ tool, toolHome, cwd, sessionId, turnSentAt }: { tool: PaseoTool; toolHome: string; cwd: string; sessionId: string; turnSentAt?: number }) {
  const format = TRANSCRIPTS[tool];

  if (format === undefined) return undefined;
  const transcriptPath = await transcriptOf(format, { toolHome, cwd, sessionId });

  return transcriptPath === undefined ? undefined : stepUsage({ format: format.tokens, transcriptPath, sessionId, ...(turnSentAt !== undefined && { turnSentAt }) });
}
