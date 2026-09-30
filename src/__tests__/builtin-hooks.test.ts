import { describe, it, expect } from 'vitest';
import { builtinHookDefs, applyBuiltinOverride } from '../builtin-hooks.js';

describe('builtinHookDefs — unified built-in hook model', () => {
  it('returns 7 built-in defs for Claude in canonical order, all tagged source=builtin', () => {
    const defs = builtinHookDefs('claude');
    expect(defs).toHaveLength(7);
    expect(defs.every((d) => d.source === 'builtin')).toBe(true);
    expect(defs.map((d) => d.event)).toEqual([
      'SessionStart', 'Stop',
      'PostToolUse', 'PostToolUse', 'PostToolUse',
      'UserPromptSubmit', 'SubagentStop',
    ]);
  });

  it('adds SubagentStop only for the agents that fire it (#884)', () => {
    const subagentStop = (tool: string) => builtinHookDefs(tool).filter((d) => d.event === 'SubagentStop');
    for (const tool of ['claude', 'claude-internal', 'tclaude', 'codex', 'codex-internal', 'tcodex', 'codebuddy', 'qoder', 'qoder-cn']) {
      expect(subagentStop(tool)).toEqual([expect.objectContaining({
        key: 'Hook dispatch subagent-stop',
        matcher: '*',
        command: expect.stringContaining(`hook-dispatch subagent-stop --tool ${tool}`),
      })]);
    }
    // Cursor and Copilot run a subagent in a session of its own that no hook links to its parent;
    // ZCode has no such event and rejects the whole hooks block on an unknown key.
    for (const tool of ['cursor', 'copilot', 'zcode', 'workbuddy']) expect(subagentStop(tool)).toEqual([]);
  });

  it('adds a lifecycle-complete SessionEnd hook only for Copilot', () => {
    const defs = builtinHookDefs('copilot');
    expect(defs).toHaveLength(7);
    expect(defs.at(-1)).toEqual(expect.objectContaining({
      event: 'SessionEnd',
      matcher: '*',
      timeout: 15,
      command: expect.stringContaining('hook-dispatch session-end --tool copilot'),
    }));
    expect(builtinHookDefs('claude').some((d) => d.event === 'SessionEnd')).toBe(false);
  });

  it('Claude defs carry no timeout; Cursor defs carry per-hook timeouts', () => {
    expect(builtinHookDefs('claude').every((d) => d.timeout === undefined)).toBe(true);
    const cursor = builtinHookDefs('cursor');
    expect(cursor.find((d) => d.key === 'Hook dispatch session-start')?.timeout).toBe(15);
    expect(cursor.find((d) => d.key === 'Hook dispatch post-tool-use TodoWrite')?.timeout).toBe(3);
  });

  it('embeds the --tool identifier and [teamai] description marker', () => {
    const def = builtinHookDefs('codebuddy')[0];
    expect(def.command).toContain('--tool codebuddy');
    expect(def.description.startsWith('[teamai] ')).toBe(true);
  });
});

describe('applyBuiltinOverride (§4.8)', () => {
  it('is a no-op for an absent or empty override', () => {
    const defs = builtinHookDefs('cursor');
    expect(applyBuiltinOverride(defs)).toBe(defs);
    expect(applyBuiltinOverride(defs, { disabled: [], overrides: {} })).toEqual(defs);
  });

  it('drops disabled built-in keys', () => {
    const defs = applyBuiltinOverride(builtinHookDefs('claude'), {
      disabled: ['Hook dispatch post-tool-use TodoWrite'],
    });
    expect(defs).toHaveLength(builtinHookDefs('claude').length - 1);
    expect(defs.some((d) => d.key === 'Hook dispatch post-tool-use TodoWrite')).toBe(false);
  });

  it('applies a whitelisted timeout override', () => {
    const defs = applyBuiltinOverride(builtinHookDefs('cursor'), {
      overrides: { 'Hook dispatch stop': { timeout: 99 } },
    });
    expect(defs.find((d) => d.key === 'Hook dispatch stop')?.timeout).toBe(99);
  });
});
