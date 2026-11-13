import path from 'node:path';
import type { PromptUsageSchema } from '@teamai/runtime-protocol';
import { ClaudeCodeAdapter } from '@teamai/tool-core/formats/claude-code';
import { readClaudeJsonl } from '@teamai/tool-core/formats/claude-jsonl';
import { CodexAdapter } from '@teamai/tool-core/formats/codex';
import { readCodexRollout } from '@teamai/tool-core/formats/codex-rollout';
import { addTokenUsage, type TokenReading, type TokenSource, type TokenUsage } from '@teamai/tool-core/tokens';
import { HOST_PROCESSES } from '@teamai/shared/exec';
import { getUserHome } from '@teamai/shared/home';
import type { SessionHost } from '@teamai/tool-core/sessions/platform';
import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import type { z } from 'zod';

// ─── The tool session a T3 thread ran ───
//
//  T3's MCP does not name the session its provider started, so the runtime finds it where the tool keeps it: the
//  transcript the thread's tool wrote for the step's worktree since the thread was launched, in the tool home the
//  thread's provider instance runs it in (`instanceToolHome`). The tokens a step billed are read from that transcript.
//  The stores are spelled here because a runtime package
//  cannot read the tool registry (src/tool-registry.ts) and may not import a tool family; they move to tool-core's
//  session-store lookup once it exists.
//

// The runtime only reads sessions, and only writing one runs a tool's CLI, so each tool is its own command here.
const SESSION_READER_HOST: SessionHost = { processes: HOST_PROCESSES, executablesOf: (tool) => [tool] };

type PromptUsage = z.infer<typeof PromptUsageSchema>;

/**
 * The T3 provider drivers this runtime runs, each with the teamai tool it is, its name in T3, its tool's home under a
 * user's home, the variable that moves that home, the store its sessions are in under a tool home, and how its
 * transcript records tokens: the reader of its format, and the tokens as the tool's own end-of-run usage reports them,
 * which is what a step that runs the tool on this machine reports.
 */
export const DRIVERS = {
  claudeAgent: {
    tool: 'claude', label: 'Claude', home: '.claude', homeEnv: 'CLAUDE_CONFIG_DIR', sessions: (toolHome: string) => new ClaudeCodeAdapter('claude-code', path.join(toolHome, 'projects')),
    tokens: { read: readClaudeJsonl, reported: (tokens: TokenUsage): PromptUsage => ({ input: tokens.input, output: tokens.output, cachedInput: tokens.cacheRead }) },
  },
  codex: {
    tool: 'codex', label: 'Codex', home: '.codex', homeEnv: 'CODEX_HOME', sessions: (toolHome: string) => new CodexAdapter('codex', path.join(toolHome, 'sessions'), SESSION_READER_HOST),
    // Codex counts cached input inside its input tokens.
    tokens: { read: readCodexRollout, reported: (tokens: TokenUsage): PromptUsage => ({ input: tokens.input + tokens.cacheRead + tokens.cacheCreation, output: tokens.output, cachedInput: tokens.cacheRead }) },
  },
} as const satisfies Record<string, {
  tool: string; label: string; home: string; homeEnv: string; sessions(toolHome: string): AgentAdapter;
  tokens: { read(source: TokenSource): Promise<TokenReading>; reported(tokens: TokenUsage): PromptUsage };
}>;

export type Driver = keyof typeof DRIVERS;

export type ToolId = (typeof DRIVERS)[Driver]['tool'];

function isDriver(name: string): name is Driver {
  return Object.hasOwn(DRIVERS, name);
}

/** The T3 drivers this runtime runs, in the order it offers their tools. */
export const DRIVER_NAMES: readonly Driver[] = Object.keys(DRIVERS).filter(isDriver);

/** The T3 driver of `tool`, when this runtime runs it. */
export function driverOf(tool: string): Driver | undefined {
  return DRIVER_NAMES.find((driver) => DRIVERS[driver].tool === tool);
}

/** The teamai tool T3's `driver` is, when this runtime runs it. */
export function toolOf(driver: string): ToolId | undefined {
  return isDriver(driver) ? DRIVERS[driver].tool : undefined;
}

/** How much earlier than the launch a record the thread's work left (a transcript, a delegated task) may be stamped and still be its. */
export const CLOCK_SLACK_MS = 5_000;

/** Whether `toolHome` is the home teamai reads `driver`'s sessions in when a session names none: the tool's, in this HOME. */
export function isDefaultToolHome(driver: Driver, toolHome: string): boolean {
  return path.resolve(toolHome) === path.join(getUserHome(), DRIVERS[driver].home);
}

/** A session a step's tool kept: its id, and the transcript it is in when the store names one. */
export type KeptSession = { id: string; transcript?: string };

/**
 * The first session the tool of `driver` started in `cwd` at or after `since`, in `toolHome`, other than `other`, or
 * undefined when it kept none. A task the thread delegates may start a later session in the same folder; that one is
 * not the step's. `other` is a session the thread cannot have, such as that of an earlier thread in the folder whose
 * conversation the step did not go on in, which may have started within the clock's slack.
 */
export async function sessionSince({ driver, toolHome, cwd, since, other }: { driver: Driver; toolHome: string; cwd: string; since: number; other?: string }): Promise<KeptSession | undefined> {
  const sessions = await DRIVERS[driver].sessions(toolHome).listConversations(cwd);
  const started = sessions.filter((session) => session.sessionId !== other && Date.parse(session.createdAt) >= since - CLOCK_SLACK_MS);
  const first = started.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];

  return first && { id: first.sessionId, ...(first.filePath !== undefined && { transcript: first.filePath }) };
}

/**
 * The tokens the step billed in `session`, as its tool's own end-of-run usage reports them: every request of the
 * session for a thread the step launched, and only those at or after `turnSentAt` for a turn it sent to an earlier
 * step's thread, whose session holds that step's requests too. Undefined when the transcript cannot be read or records
 * no request in that span, or, for a turn, records a request without the time that would place it in or out of the turn:
 * the step then reports no usage, never zero.
 */
export async function stepUsage({ driver, session, turnSentAt }: { driver: Driver; session: KeptSession; turnSentAt?: number }): Promise<PromptUsage | undefined> {
  if (session.transcript === undefined) return undefined;
  const format = DRIVERS[driver].tokens;
  // A Codex turn's usage may land just after T3 shows the run ended, so the read waits for it as for a Stop hook.
  const { requests } = await format.read({ transcriptPath: session.transcript, sessionId: session.id, settled: false });
  const billed = requests.map((request) => ({ tokens: request.tokens, at: Date.parse(request.timestamp) }));

  if (turnSentAt !== undefined && billed.some(({ at }) => Number.isNaN(at))) return undefined;
  const own = billed.filter(({ at }) => turnSentAt === undefined || at >= turnSentAt).map(({ tokens }) => tokens);

  return own.length === 0 ? undefined : format.reported(own.reduce((sum, tokens) => addTokenUsage(sum, tokens)));
}
