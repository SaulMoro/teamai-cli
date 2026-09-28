/**
 * Shared session ID derivation for hook handlers.
 *
 * Different hooks need a stable identifier for the current AI coding session.
 * This helper centralizes the priority order so callers don't duplicate the
 * fallback logic.
 */

import { resolveHookCwd } from './hook-cwd.js';
import { COPILOT_TOOL_ID } from '../types.js';

// Each agent's own session variable, in the order they are read. Each one
// equals the session_id that agent's hooks receive, so a CLI command run from
// the agent's shell (e.g. `teamai recall`) joins the hook's session.
// Codex: CODEX_SESSION_ID (>= 0.148) is the root session, the id its hooks
// get; CODEX_THREAD_ID is a subagent's own id. CodeBuddy also sets
// CLAUDE_SESSION_ID as an alias, so its own variable comes first. Pi is absent:
// its hook bridge sends no session id, so its hooks record under the pid
// fallback and PI_SESSION_ID would name a session with no events.
export const AGENT_SESSION_ENV = [
    'CLAUDE_CODE_SESSION_ID',    // Claude Code
    'CODEX_SESSION_ID',          // Codex >= 0.148
    'CODEBUDDY_SESSION_ID',      // CodeBuddy
    'COPILOT_AGENT_SESSION_ID',  // Copilot CLI >= 1.0.29
    'CURSOR_CONVERSATION_ID',    // Cursor
    'CLAUDE_SESSION_ID',         // CodeBuddy's alias and older setups
] as const;

/**
 * The running agent's session id from its environment, or undefined when none
 * is set. For CLI commands an agent runs from its shell (`recall`,
 * `contribute`, `session save`), which get no hook payload. Hooks keep using
 * deriveSessionId: a bridge that sends no session_id (OpenCode, Pi, OMP) can
 * inherit another agent's variable when started from that agent's shell.
 *
 * An agent started from another agent's shell inherits the outer agent's
 * variable next to its own, so when several are set the one whose session has
 * the latest hook event wins: the inner agent's hooks fire while the outer
 * agent waits on the tool call that runs it. With no events for any of them,
 * the variable order decides.
 */
export async function agentSessionIdFromEnv(): Promise<string | undefined> {
    const ids = [...new Set(AGENT_SESSION_ENV.map((name) => process.env[name]).filter((v) => !!v))];
    if (ids.length <= 1) return ids[0];

    // Loaded here: dashboard-collector imports this module.
    const { readEvents } = await import('../dashboard-collector.js');
    let latest: { sessionId: string; timestamp: string } | undefined;
    for (const event of await readEvents()) {
        if (ids.includes(event.sessionId) && (!latest || event.timestamp > latest.timestamp)) {
            latest = event;
        }
    }
    return latest?.sessionId ?? ids[0];
}

export interface DeriveSessionIdOptions {
    /** When true, include the working directory in the PID fallback. */
    includeCwd?: boolean;
}

/**
 * Derive a stable session ID from a hook payload.
 *
 * Priority:
 *   1. Explicit `session_id` field from the hook payload
 *   2. Explicit `sessionId` field from camelCase hook payloads
 *   3. `CLAUDE_SESSION_ID` environment variable
 *   4. `pid-${process.ppid ?? process.pid}` (or `pid-${ppid}-${cwd}` when includeCwd is true)
 */
export function deriveSessionId(
    data: Record<string, unknown>,
    options: DeriveSessionIdOptions = {},
): string {
    if (typeof data.session_id === 'string' && data.session_id) {
        return data.session_id;
    }

    if (typeof data.sessionId === 'string' && data.sessionId) {
        return data.sessionId;
    }

    if (process.env.CLAUDE_SESSION_ID) {
        return process.env.CLAUDE_SESSION_ID;
    }

    const ppid = process.ppid ?? process.pid;
    if (options.includeCwd) {
        const cwd = resolveHookCwd(data) ?? process.cwd();
        return `pid-${ppid}-${cwd}`;
    }

    return `pid-${ppid}`;
}

/**
 * The session id a hook's events carry. Copilot's fallback takes no cwd, so it
 * persists no workspace path. The dispatcher (and its detached child) and the
 * dashboard's event writers all derive it here, so they always agree.
 */
export function deriveDispatchSessionId(
    data: Record<string, unknown>,
    tool: string,
): string {
    return deriveSessionId(data, { includeCwd: tool.toLowerCase() !== COPILOT_TOOL_ID });
}
