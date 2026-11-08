import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallLaunch } from '@teamai/tool-core/launch';
import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import { FAKE_AGENT_MARKERS, fakeAgent, type FakeAgentOptions, type FakeAgentTool } from './fake-agent.js';

const made: string[] = [];
const started: number[] = [];

afterEach(() => {
  const alive = started.splice(0).filter((pid) => {
    try {
      process.kill(pid, 0);

      return true;
    } catch {
      return false;
    }
  });

  for (const pid of alive) process.kill(-pid, 'SIGKILL');
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  expect(alive, 'fake agents left running').toEqual([]);
});

function scratch(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-')));

  made.push(dir);

  return dir;
}

/** Runs the fake as teamai's call profile does, with `prompt` on stdin, and gives what it printed and its exit code. */
function ran(executable: string, args: string[], prompt: string, { cwd, env = {}, killAfterMs }: { cwd: string; env?: Record<string, string>; killAfterMs?: number }): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, detached: true });
    let stdout = '';

    if (child.pid !== undefined) started.push(child.pid);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', (code) => resolve({ stdout, code }));
    child.stdin.end(prompt);
    if (killAfterMs !== undefined) setTimeout(() => child.pid !== undefined && process.kill(-child.pid, 'SIGTERM'), killAfterMs);
  });
}

const PROFILES: Record<FakeAgentTool, CallLaunch> = {
  claude: BUILT_IN_TOOLS.claude.launch.claude.call,
  opencode: BUILT_IN_TOOLS.opencode.launch.opencode.call,
};

function agent(tool: FakeAgentTool, options: Omit<FakeAgentOptions, 'bin'> = {}) {
  const root = scratch();

  return { root, home: path.join(root, 'h'), cwd: root, ...fakeAgent(tool, { bin: path.join(root, 'b'), ...options }) };
}

describe.each(['claude', 'opencode'] as const)('fake %s', (tool) => {
  const args = (): string[] => [...PROFILES[tool].args({ prompt: 'q', promptFile: '/p', lastMessageFile: '/l' })];

  it('answers in the recorded format, which the family reads as the answer it was given', async () => {
    const { executable, cwd, home, calls } = agent(tool, { answer: 'It uses Jest.' });

    const out = await ran(executable, args(), 'Which test runner?', { cwd, env: { HOME: home } });

    expect({ code: out.code, read: PROFILES[tool].read({ stdout: out.stdout, lastMessage: undefined }) }).toMatchObject({ code: 0, read: { ok: true, text: 'It uses Jest.' } });
    expect(calls()).toEqual([{ args: args(), prompt: 'Which test runner?', cwd }]);
  });

  it('answers what the first matching entry gives', async () => {
    const { executable, cwd, home } = agent(tool, { answer: 'default', answers: [{ when: 'color', answer: 'blue' }] });

    const out = await ran(executable, args(), 'Name one color.', { cwd, env: { HOME: home } });

    expect(PROFILES[tool].read({ stdout: out.stdout, lastMessage: undefined })).toMatchObject({ ok: true, text: 'blue' });
  });

  it('fails as the recording failed when the prompt asks it to', async () => {
    const { executable, cwd, home } = agent(tool);

    const out = await ran(executable, args(), `Go. ${FAKE_AGENT_MARKERS.fail}`, { cwd, env: { HOME: home } });

    expect({ code: out.code, read: PROFILES[tool].read({ stdout: out.stdout, lastMessage: undefined }) }).toMatchObject({ code: 1, read: { ok: false } });
  });

  it('goes silent after its first line when it hangs, until it is stopped', async () => {
    const { executable, cwd, home } = agent(tool, { always: ['hang'] });

    const out = await ran(executable, [...args(), '--output-format=stream-json'], 'Go.', { cwd, env: { HOME: home }, killAfterMs: 800 });

    expect({ lines: out.stdout.trim().split('\n').length, code: out.code }).toEqual({ lines: 1, code: null });
  });

  it('commits the prompt in its cwd when asked', async () => {
    const { executable, cwd, home } = agent(tool);

    execFileSync('git', ['init', '-q', cwd]);
    execFileSync('git', ['-C', cwd, 'commit', '-q', '--allow-empty', '-m', 'base'], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
    await ran(executable, args(), `Change it. ${FAKE_AGENT_MARKERS.commit}`, { cwd, env: { HOME: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });

    expect(execFileSync('git', ['-C', cwd, 'log', '--format=%s'], { encoding: 'utf8' }).trim().split('\n')).toEqual(['agent commit', 'base']);
  });
});

describe('fake claude sessions', () => {
  it('writes its session and a subagent where Claude Code keeps them, even from a cwd over 200 characters', async () => {
    const { executable, root, home } = agent('claude', { always: ['subagent'] });
    const cwd = path.join(root, 'a'.repeat(120), 'b'.repeat(120));

    fs.mkdirSync(cwd, { recursive: true });
    const out = await ran(executable, ['-p', '--output-format', 'json'], 'Go.', { cwd, env: { HOME: home } });
    const sessionId = String(JSON.parse(out.stdout).session_id);
    const projects = fs.readdirSync(path.join(home, '.claude', 'projects'));

    expect(projects).toHaveLength(1);
    expect(projects[0]?.length).toBeLessThan(255);
    const project = path.join(home, '.claude', 'projects', projects[0] ?? '');

    expect(fs.readdirSync(project).sort()).toEqual([sessionId, `${sessionId}.jsonl`]);
    expect(fs.readdirSync(path.join(project, sessionId, 'subagents'))).toEqual(['agent-a1.jsonl']);
  });

  it('keeps no session when the call asks for none', async () => {
    const { executable, cwd, home } = agent('claude');

    await ran(executable, ['-p', '--no-session-persistence', '--output-format', 'json'], 'Go.', { cwd, env: { HOME: home } });

    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('puts a JSON reply in structured_output when the call gives a schema', async () => {
    const { executable, cwd, home } = agent('claude', { answer: '{"verdict":"pass"}' });

    const out = await ran(executable, ['-p', '--output-format', 'json', '--json-schema', '{}'], 'Judge.', { cwd, env: { HOME: home } });

    expect(JSON.parse(out.stdout)).toMatchObject({ type: 'result', structured_output: { verdict: 'pass' } });
  });
});
