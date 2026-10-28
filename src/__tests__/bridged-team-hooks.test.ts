import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgedTeamHookFile, runBridgedTeamHooks } from '../bridged-team-hooks.js';
import { applyBridgedAgentHook, reconcileHooksToAllTools } from '../hooks.js';
import type { HookDef } from '../types.js';

describe('the team hooks a bridge runs', () => {
  const originalHome = process.env.HOME;
  let root: string;
  let project: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-bridged-')));
    process.env.HOME = path.join(root, 'home');
    project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const install = (tool: string, hooks: Record<string, unknown[]>) => {
    const file = bridgedTeamHookFile(tool);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hooks }));
  };
  const entry = (command: string, matcher = '*', id = 'team') => ({
    matcher, hooks: [{ type: 'command', command }], description: `[teamai:hook:${id}]`,
  });

  it('a PreToolUse hook on Bash blocks OMP\'s bash call with the reason the hook printed', async () => {
    install('omp', { PreToolUse: [entry('echo "Commit message names a ticket: add one" >&2; exit 2', 'Bash')] });
    const reply = await runBridgedTeamHooks('omp', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: { command: 'git commit -m wip' } }));
    expect(JSON.parse(reply.stdout)).toEqual({ block: 'Commit message names a ticket: add one' });
  });

  it('a hook on Bash leaves OMP\'s read call alone', async () => {
    install('omp', { PreToolUse: [entry('exit 2', 'Bash')] });
    const reply = await runBridgedTeamHooks('omp', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'read', tool_input: { path: 'README.md' } }));
    expect(reply).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('a hook gets the Claude payload: Claude\'s tool name, file_path, and the session directory', async () => {
    install('pi', { PreToolUse: [entry('cat > seen.json', 'Edit|Write')] });
    await runBridgedTeamHooks('pi', 'PreToolUse', JSON.stringify({ cwd: project, session_id: 's1', tool_name: 'write', tool_input: { path: 'src/a.ts', content: 'x' } }));
    expect(JSON.parse(fs.readFileSync(path.join(project, 'seen.json'), 'utf8'))).toEqual({
      cwd: project, session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { path: 'src/a.ts', content: 'x', file_path: 'src/a.ts' },
    });
  });

  it('a JSON permission decision of deny blocks, as in Claude Code', async () => {
    const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'No writes under migrations/' } });
    install('opencode', { PreToolUse: [entry(`echo '${deny}'`, 'Write')] });
    const reply = await runBridgedTeamHooks('opencode', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'write', tool_input: { path: 'migrations/1.sql' } }));
    expect(JSON.parse(reply.stdout)).toEqual({ block: 'No writes under migrations/' });
  });

  it('UserPromptSubmit hooks add their stdout, plain or as additionalContext, to the context', async () => {
    const json = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Sprint 42 ends Friday.' } });
    install('omp', { UserPromptSubmit: [entry('echo "On-call: @ana"', '*', 'oncall'), entry(`echo '${json}'`, '*', 'sprint')] });
    const reply = await runBridgedTeamHooks('omp', 'UserPromptSubmit', JSON.stringify({ cwd: project, prompt: 'fix the build' }));
    expect(JSON.parse(reply.stdout)).toEqual({ context: 'On-call: @ana\n\nSprint 42 ends Friday.' });
  });

  it('a PostToolUse or Stop hook runs, and decides nothing for the host', async () => {
    install('pi', { Stop: [entry('touch stopped; echo "keep going" >&2; exit 2')] });
    const reply = await runBridgedTeamHooks('pi', 'Stop', JSON.stringify({ cwd: project }));
    expect(fs.existsSync(path.join(project, 'stopped'))).toBe(true);
    expect(reply).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('a hook that outlives its timeout decides nothing, and says so on stderr', async () => {
    install('omp', { PreToolUse: [{ ...entry('', 'Bash', 'slow-scan'), hooks: [{ type: 'command', command: 'sleep 5; exit 2', timeout: 0.2 }] }] });
    const reply = await runBridgedTeamHooks('omp', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: { command: 'ls' } }));
    expect(reply).toEqual({ code: 0, stdout: '', stderr: 'teamai: team hook slow-scan timed out after 0.2s\n' });
  });

  it('Kiro reads a block as exit 2 with the reason on stderr, and context as plain stdout', async () => {
    install('kiro', { PreToolUse: [entry('echo "Run the tests first" >&2; exit 2', 'Bash')], SessionStart: [entry('echo "Release freeze until Monday"')] });
    expect(await runBridgedTeamHooks('kiro', 'PreToolUse', JSON.stringify({ cwd: project, tool_name: 'execute_bash', tool_input: { command: 'npm publish' } })))
      .toEqual({ code: 2, stdout: '', stderr: 'Run the tests first\n' });
    expect(await runBridgedTeamHooks('kiro', 'SessionStart', JSON.stringify({ cwd: project })))
      .toEqual({ code: 0, stdout: 'Release freeze until Monday\n', stderr: '' });
  });

  it('Hermes reads a block as its decision JSON, and runs SessionStart context on the first turn\'s prompt', async () => {
    install('hermes', {
      PreToolUse: [entry('echo "No force push" >&2; exit 2', 'Bash')],
      SessionStart: [entry('echo "Release freeze until Monday"')],
      UserPromptSubmit: [entry('node -e "process.stdin.on(\'data\', (d) => console.log(JSON.parse(d).prompt))"')],
    });
    const block = await runBridgedTeamHooks('hermes', 'PreToolUse', JSON.stringify({ hook_event_name: 'pre_tool_call', cwd: project, tool_name: 'terminal', tool_input: { command: 'rm -rf build' } }));
    expect(JSON.parse(block.stdout)).toEqual({ decision: 'block', reason: 'No force push' });
    const first = await runBridgedTeamHooks('hermes', 'UserPromptSubmit', JSON.stringify({ hook_event_name: 'pre_llm_call', cwd: project, extra: { is_first_turn: true, user_message: 'hello' } }));
    expect(JSON.parse(first.stdout)).toEqual({ context: 'Release freeze until Monday\n\nhello' });
    const later = await runBridgedTeamHooks('hermes', 'UserPromptSubmit', JSON.stringify({ hook_event_name: 'pre_llm_call', cwd: project, extra: { is_first_turn: false, user_message: 'again' } }));
    expect(JSON.parse(later.stdout)).toEqual({ context: 'again' });
  });
});

describe('pull delivers the team hooks to a bridged tool', () => {
  const originalHome = process.env.HOME;
  let root: string;
  let home: string;
  let project: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-bridged-pull-')));
    home = path.join(root, 'home');
    process.env.HOME = home;
    project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const manifest = () => path.join(home, '.teamai', 'managed-hooks.json');
  const teamHook = (over: Partial<HookDef> = {}): HookDef => ({
    source: 'team', key: 'no-force-push', event: 'PreToolUse', matcher: 'Bash',
    command: 'grep -Eq \'push (-f|--force)\\b\' && { echo "Use --force-with-lease" >&2; exit 2; } || true',
    timeout: 10, description: '[teamai:hook:no-force-push] Refuse a force push', ...over,
  });
  const bash = (command: string) => JSON.stringify({ cwd: project, tool_name: 'bash', tool_input: { command } });

  it('OMP: a team PreToolUse hook reaches its file and blocks the call it names', async () => {
    fs.mkdirSync(path.join(home, '.omp', 'agent'), { recursive: true });
    await reconcileHooksToAllTools({ omp: {} }, home, [teamHook(), teamHook({ key: 'claude-only', tools: ['claude'], description: '[teamai:hook:claude-only]' })], manifest());
    const hooks = JSON.parse(fs.readFileSync(bridgedTeamHookFile('omp'), 'utf8')).hooks;
    expect(Object.keys(hooks)).toEqual(['PreToolUse']);
    expect(hooks.PreToolUse.map((e: { description: string }) => e.description)).toEqual(['[teamai:hook:no-force-push] Refuse a force push']);
    expect(JSON.parse((await runBridgedTeamHooks('omp', 'PreToolUse', bash('jj push -f origin main'))).stdout)).toEqual({ block: 'Use --force-with-lease' });
    expect((await runBridgedTeamHooks('omp', 'PreToolUse', bash('jj push origin main'))).stdout).toBe('');
  });

  it('a pull keeps the agent hook the HTTP local agent installed beside the team\'s', async () => {
    fs.mkdirSync(path.join(home, '.omp', 'agent'), { recursive: true });
    await applyBridgedAgentHook('omp', { slug: 'no-rm', event: 'PreToolUse', matcher: 'Bash', command: 'grep -q "rm -rf" && { echo "No rm -rf" >&2; exit 2; } || true' });

    await reconcileHooksToAllTools({ omp: {} }, home, [teamHook()], manifest());
    await reconcileHooksToAllTools({ omp: {} }, home, [teamHook()], manifest());

    expect(JSON.parse((await runBridgedTeamHooks('omp', 'PreToolUse', bash('rm -rf build'))).stdout)).toEqual({ block: 'No rm -rf' });
    expect(JSON.parse((await runBridgedTeamHooks('omp', 'PreToolUse', bash('jj push -f'))).stdout)).toEqual({ block: 'Use --force-with-lease' });
  });
});
