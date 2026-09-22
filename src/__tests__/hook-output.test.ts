import { describe, it, expect } from 'vitest';
import { formatStopHookOutput, RELAY_TO_USER } from '../utils/hook-output.js';
import { STOP_STDOUT_UNSUPPORTED_TOOLS } from '../utils/tool-names.js';

describe('formatStopHookOutput', () => {
  it('claude: returns hookSpecificOutput format', () => {
    const result = formatStopHookOutput('hello', 'claude');
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(parsed.hookSpecificOutput.additionalContext).toBe('hello');
  });

  it('codebuddy: returns hookSpecificOutput format (same as claude)', () => {
    const result = formatStopHookOutput('msg', 'codebuddy');
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.additionalContext).toBe('msg');
  });

  it('cursor: returns {followup_message} and asks the model to relay it', () => {
    // Cursor does not show the payload, so the user only reads it if the model
    // passes it on.
    const result = formatStopHookOutput('test', 'cursor');
    const parsed = JSON.parse(result);
    expect(parsed.followup_message).toBe(`${RELAY_TO_USER}test`);
    expect(parsed.hookSpecificOutput).toBeUndefined();
    expect(parsed.message).toBeUndefined();
  });

  it('unknown tool: defaults to hookSpecificOutput (Claude schema)', () => {
    const result = formatStopHookOutput('x', 'unknown');
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput.additionalContext).toBe('x');
  });

  it('workbuddy: uses Claude hookSpecificOutput format', () => {
    const result = formatStopHookOutput('wb', 'workbuddy');
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput.additionalContext).toBe('wb');
  });

  it('tool identifier is case-insensitive for cursor detection', () => {
    const result = formatStopHookOutput('t', 'Cursor');
    const parsed = JSON.parse(result);
    expect(parsed.followup_message).toBe(`${RELAY_TO_USER}t`);
  });

  it('returns valid JSON string', () => {
    const result = formatStopHookOutput('any message', 'claude');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('empty message is preserved in output', () => {
    const result = formatStopHookOutput('', 'claude');
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput.additionalContext).toBe('');
  });
});

/**
 * The bug this file now guards (#719): Claude Code prints the Stop payload as
 * "Stop hook feedback". A payload it prints cannot also order the model to print
 * it, or the user reads the order and then the message a second time.
 */
it.each(['claude', 'codebuddy', 'workbuddy', 'unknown-tool'])(
  'a Stop payload the host displays carries no relay order (%s)',
  (tool) => {
    const parsed = JSON.parse(formatStopHookOutput('[teamai] body', tool));
    expect(parsed.hookSpecificOutput.additionalContext).toBe('[teamai] body');
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('verbatim');
  },
);

it.each(['codex', 'codex-internal', 'tcodex'])(
  'the Codex family never reaches the formatter, it stashes instead (%s)',
  (tool) => {
    expect(STOP_STDOUT_UNSUPPORTED_TOOLS.has(tool)).toBe(true);
  },
);

describe('buildVotesNudge', () => {
  it('names the candidates, the marker and the empty case, in English', async () => {
    const { buildVotesNudge } = await import('../hook-handlers.js');
    const msg = buildVotesNudge(['auth-retry', 'k8s-oom']);

    expect(msg).toContain('auth-retry, k8s-oom');
    expect(msg).toContain('<!-- teamai:referenced-doc-ids:');
    expect(msg).toContain('empty list');
    // Claude Code prints the Stop payload, so this reaches the terminal. The
    // repository rule is that user-facing CLI output is English (#719).
    expect(msg).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
