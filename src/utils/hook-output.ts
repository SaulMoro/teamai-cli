/**
 * Ask the model to relay a message the host will not show by itself.
 *
 * Only for a payload the user cannot see. Claude Code prints the Stop payload
 * as "Stop hook feedback", so adding this there makes the user read the order
 * and then read the message a second time from the model (#719).
 */
export const RELAY_TO_USER =
  'Print the following message verbatim to the user (do NOT paraphrase, summarize, or explain its origin):\n\n';

/**
 * Format Stop hook STDOUT for the given AI tool.
 *
 * Schema choice per tool:
 * - Cursor: `{ followup_message }`, which Cursor feeds to the model without
 *   showing it, so a message meant for the user is relayed (Cursor stop hook docs).
 * - Everyone else (Claude / unknown): `{ hookSpecificOutput: { hookEventName:
 *   'Stop', additionalContext } }` (Claude Code stop hook docs — the "additional
 *   context that continues the conversation" branch, NOT top-level `stopReason`,
 *   which requires `continue:false` and aborts the run). Claude Code shows this
 *   to the user, so it carries the message alone.
 *
 * CodeBuddy, WorkBuddy and the Codex family never reach here: their callers
 * check `STOP_STDOUT_UNSUPPORTED_TOOLS` and stash the message for the next
 * UserPromptSubmit instead.
 */
export function formatStopHookOutput(message: string, tool: string): string {
  const normalized = tool?.toLowerCase() ?? '';

  if (normalized === 'cursor') {
    return JSON.stringify({ followup_message: RELAY_TO_USER + message });
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: message,
    },
  });
}
