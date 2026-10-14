/**
 * agent-session-platform.test.ts — the session platform a workflow tool name reads and writes.
 */
import { describe, it, expect } from 'vitest';
import { AgentSession } from '../session-flow/agent-session.js';

describe('AgentSession.platformForTool', () => {
  it.each([
    ['claude', 'claude-code'],
    ['claude-internal', 'claude-internal'],
    ['tclaude', 'tclaude'],
    ['codex', 'codex'],
    ['codex-internal', 'codex-internal'],
    ['tcodex', 'tcodex'],
    ['opencode', 'opencode'],
  ])('maps the workflow tool %s to the %s platform', (tool, platform) => {
    expect(AgentSession.platformForTool(tool)).toBe(platform);
  });

  it('maps a tool without a session platform to undefined', () => {
    expect(AgentSession.platformForTool('gemini')).toBeUndefined();
  });
});
