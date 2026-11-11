import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_PROCESSES } from '@teamai/shared/exec';
import { CodexAdapter } from '@teamai/tool-core/formats/codex';
import { FAKE_AGENT_MARKERS, fakeAgent, leftFakeAgents, runFakeAgent } from '@teamai/tool-testing/fake-agent';
import { launch } from '../launch.js';
import { codexFake } from './index.js';

const call = launch.codex.call;
const step = launch.codex.step;
const made: string[] = [];

afterEach(() => {
  const left = leftFakeAgents();

  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  expect(left, 'fake agents left running').toEqual([]);
});

function scratch(): { root: string; home: string; bin: string; codexHome: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')));

  made.push(root);

  return { root, home: path.join(root, 'h'), bin: path.join(root, 'b'), codexHome: path.join(root, 'c') };
}

const stepArgs = (prompt: string, resume?: string): string[] => step.args({ prompt, resultDir: '/r', streamsUsage: true, ...(resume && { resume }) }, { interactive: false, opencodeMajor: 2 });

/** The thread a `codex exec --json` run started, from its first event. */
const threadOf = (stdout: string): string => {
  const first: unknown = JSON.parse(stdout.split('\n')[0] ?? '');

  return first !== null && typeof first === 'object' && 'thread_id' in first && typeof first.thread_id === 'string' ? first.thread_id : '';
};

/** Every rollout under `<CODEX_HOME>/sessions`, relative to it. */
const rollouts = (codexHome: string): string[] => {
  const sessions = path.join(codexHome, 'sessions');

  return fs.existsSync(sessions) ? fs.readdirSync(sessions, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.jsonl')) : [];
};

describe('fake codex', () => {
  it('answers a call in the recorded format, which the Codex call profile reads as the answer it was given', async () => {
    const { root, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin, answer: 'It uses Jest.' });
    const lastMessageFile = path.join(root, 'last-message.txt');

    const out = await runFakeAgent(agent.executable, call.args({ prompt: '', promptFile: '', lastMessageFile }), 'Which test runner?', { cwd: root, env: { HOME: home, CODEX_HOME: codexHome } });

    // codex-cli 0.167.0 printed input_tokens 20707 and output_tokens 51 for this turn.
    expect({ code: out.code, read: call.read({ stdout: out.stdout, lastMessage: fs.readFileSync(lastMessageFile, 'utf8') }) })
      .toMatchObject({ code: 0, read: { ok: true, text: 'It uses Jest.', tokens: { input: 20707, output: 51 } } });
  });

  it('fails as the recorded failure, which the profile reads as a failure', async () => {
    const { root, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin });
    const lastMessageFile = path.join(root, 'last-message.txt');

    const out = await runFakeAgent(agent.executable, call.args({ prompt: '', promptFile: '', lastMessageFile }), `Go. ${FAKE_AGENT_MARKERS.fail}`, { cwd: root, env: { HOME: home, CODEX_HOME: codexHome } });

    expect({ code: out.code, read: call.read({ stdout: out.stdout, lastMessage: undefined }), wrote: fs.existsSync(lastMessageFile) })
      .toMatchObject({ code: 1, read: { ok: false, message: expect.stringContaining('gpt-nonexistent') }, wrote: false });
  });

  it('prints its thread first, and only that when it hangs', async () => {
    const { root, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin, always: ['hang'] });

    const out = await runFakeAgent(agent.executable, stepArgs('Go.'), '', { cwd: root, env: { HOME: home, CODEX_HOME: codexHome }, stopAfterMs: 800 });

    expect(out.stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ type: 'thread.started', thread_id: expect.any(String) }]);
  });

  it('keeps a step\'s session where Codex does, under CODEX_HOME by the day it started, for the Codex reader', async () => {
    const { root, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin });

    const out = await runFakeAgent(agent.executable, stepArgs('Review it.'), '', { cwd: root, env: { HOME: home, CODEX_HOME: codexHome } });
    const thread = threadOf(out.stdout);

    // codex-cli 0.167.0 wrote sessions/2026/11/11/rollout-2026-11-11T07-43-39-<thread>.jsonl for a run it started then.
    expect(rollouts(codexHome)).toEqual([expect.stringMatching(new RegExp(`^\\d{4}/\\d{2}/\\d{2}/rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${thread}\\.jsonl$`))]);
    const session = await new CodexAdapter('codex', path.join(codexHome, 'sessions'), { processes: HOST_PROCESSES, executablesOf: (tool) => [tool] }).readSession({ sessionId: thread, projectPath: root });
    expect({ code: out.code, id: session.sessionId, cwd: session.cwd }).toEqual({ code: 0, id: thread, cwd: root });
  });

  it('continues the thread it is given to resume, in that thread\'s session', async () => {
    const { root, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin });
    const env = { HOME: home, CODEX_HOME: codexHome };
    const first = await runFakeAgent(agent.executable, stepArgs('Review it.'), '', { cwd: root, env });

    const resumed = await runFakeAgent(agent.executable, stepArgs('Now fix it.', threadOf(first.stdout)), '', { cwd: root, env });

    expect({ thread: threadOf(resumed.stdout), sessions: rollouts(codexHome).length }).toEqual({ thread: threadOf(first.stdout), sessions: 1 });
  });

  it('writes nothing under CODEX_HOME for an ephemeral run, as Codex does', async () => {
    const { root, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin });

    await runFakeAgent(agent.executable, ['exec', '--json', '--ephemeral', 'Judge it.'], '', { cwd: root, env: { HOME: home, CODEX_HOME: codexHome } });

    expect(rollouts(codexHome)).toEqual([]);
  });
});
