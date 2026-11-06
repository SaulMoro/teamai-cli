import path from 'node:path';
import { ClaudeCodeAdapter } from '@teamai/tool-core/formats/claude-code';
import { CodexAdapter } from '@teamai/tool-core/formats/codex';
import { getUserHome } from '@teamai/tool-core/home';
import type { AgentAdapter } from '@teamai/tool-core/sessions/base';

// ─── The tool session a T3 thread ran ───
//
//  T3's MCP does not name the session its provider started, so the runtime finds it where the tool keeps it: the
//  transcript the thread's tool wrote for the step's worktree since the thread was launched. T3's default provider
//  instances use the tool's default home. The stores are spelled here because a runtime package cannot read the
//  tool registry (src/tool-registry.ts) and may not import a tool family; they move to tool-core's session-store
//  lookup once it exists.
//

/** The T3 provider drivers this runtime runs, each with the teamai tool it is and the store its sessions are in. */
export const DRIVERS = {
  claudeAgent: { tool: 'claude', sessions: () => new ClaudeCodeAdapter('claude-code', path.join(getUserHome(), '.claude', 'projects')) },
  codex: { tool: 'codex', sessions: () => new CodexAdapter('codex', path.join(getUserHome(), '.codex', 'sessions')) },
} as const satisfies Record<string, { tool: string; sessions(): AgentAdapter }>;

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

/** How much earlier than the launch a transcript's first record may be stamped and still be the thread's. */
const CLOCK_SLACK_MS = 5_000;

/** The id of the newest session the tool of `driver` started in `cwd` at or after `since`, or undefined when it kept none. */
export async function sessionSince(driver: Driver, cwd: string, since: number): Promise<string | undefined> {
  const sessions = await DRIVERS[driver].sessions().listConversations(cwd);
  const started = sessions.filter((session) => Date.parse(session.createdAt) >= since - CLOCK_SLACK_MS);

  return started.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]?.sessionId;
}
