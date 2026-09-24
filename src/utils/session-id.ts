/**
 * Shared session ID derivation for hook handlers.
 *
 * Different hooks need a stable identifier for the current AI coding session.
 * This helper centralizes the priority order so callers don't duplicate the
 * fallback logic.
 */

import { resolveHookCwd } from './hook-cwd.js';
import { COPILOT_TOOL_ID } from '../types.js';

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
