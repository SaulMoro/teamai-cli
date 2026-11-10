import path from 'node:path';
import { ClaudeCodeAdapter } from '@teamai/tool-core/formats/claude-code';
import { CodexAdapter } from '@teamai/tool-core/formats/codex';
import { HOST_PROCESSES } from '@teamai/shared/exec';
import { getUserHome } from '@teamai/shared/home';
import type { SessionHost } from '@teamai/tool-core/sessions/platform';
import type { AgentAdapter } from '@teamai/tool-core/sessions/base';

// ─── The tool session a T3 thread ran ───
//
//  T3's MCP does not name the session its provider started, so the runtime finds it where the tool keeps it: the
//  transcript the thread's tool wrote for the step's worktree since the thread was launched, in the tool home the
//  thread's provider instance runs it in (`instanceToolHome`). The stores are spelled here because a runtime package
//  cannot read the tool registry (src/tool-registry.ts) and may not import a tool family; they move to tool-core's
//  session-store lookup once it exists.
//

// The runtime only reads sessions, and only writing one runs a Codex CLI to index it.
const READ_ONLY_HOST: SessionHost = { processes: HOST_PROCESSES, codexCli: () => ['codex'] };

/**
 * The T3 provider drivers this runtime runs, each with the teamai tool it is, its name in T3, its tool's home under a
 * user's home, the variable that moves that home, and the store its sessions are in under a tool home.
 */
export const DRIVERS = {
  claudeAgent: { tool: 'claude', label: 'Claude', home: '.claude', homeEnv: 'CLAUDE_CONFIG_DIR', sessions: (toolHome: string) => new ClaudeCodeAdapter('claude-code', path.join(toolHome, 'projects')) },
  codex: { tool: 'codex', label: 'Codex', home: '.codex', homeEnv: 'CODEX_HOME', sessions: (toolHome: string) => new CodexAdapter('codex', path.join(toolHome, 'sessions'), READ_ONLY_HOST) },
} as const satisfies Record<string, { tool: string; label: string; home: string; homeEnv: string; sessions(toolHome: string): AgentAdapter }>;

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

/**
 * The id of the first session the tool of `driver` started in `cwd` at or after `since`, in `toolHome`, other than
 * `other`, or undefined when it kept none. A task the thread delegates may start a later session in the same folder;
 * that one is not the step's. `other` is a session the thread cannot have, such as that of an earlier thread in the
 * folder whose conversation the step did not go on in, which may have started within the clock's slack.
 */
export async function sessionSince({ driver, toolHome, cwd, since, other }: { driver: Driver; toolHome: string; cwd: string; since: number; other?: string }): Promise<string | undefined> {
  const sessions = await DRIVERS[driver].sessions(toolHome).listConversations(cwd);
  const started = sessions.filter((session) => session.sessionId !== other && Date.parse(session.createdAt) >= since - CLOCK_SLACK_MS);

  return started.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]?.sessionId;
}
