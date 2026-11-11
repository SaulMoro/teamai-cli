import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_AGENT_MARKERS, fakeAgent, leftFakeAgents, runFakeAgent, type FakeAgentRecording } from './fake-agent.js';

/** A tool that printed two lines for real: a start line, then its answer. */
const RECORDING: FakeAgentRecording = {
  executable: 'tool',
  version: 'tool 1.0.0',
  data: { answer: 'recorded answer' },
  script: String.raw`
  await say('start');
  if (does('hang')) return hang();
  if (does('fail')) { await say('error: recorded failure'); process.exit(1); }
  await say('answer: ' + (reply ?? data.answer));
  process.exit(0);
`,
};

const made: string[] = [];

afterEach(() => {
  const left = leftFakeAgents();

  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  expect(left, 'fake agents left running').toEqual([]);
});

function scratch(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-')));

  made.push(dir);

  return dir;
}

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

describe('fakeAgent', () => {
  it('answers --version, records each call, and prints the recording', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b') });

    const version = await runFakeAgent(agent.executable, ['--version'], '', { cwd });
    const out = await runFakeAgent(agent.executable, ['-p'], 'Which runner?', { cwd });

    expect({ version: version.stdout, out }).toEqual({ version: 'tool 1.0.0\n', out: { stdout: 'start\nanswer: recorded answer\n', code: 0 } });
    expect(agent.calls()).toEqual([{ args: ['-p'], prompt: 'Which runner?', cwd }]);
  });

  it('replies with the first matching answer, else the default one', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b'), answer: 'default', answers: [{ when: 'color', answer: 'blue' }] });

    expect([(await runFakeAgent(agent.executable, [], 'Name one color.', { cwd })).stdout, (await runFakeAgent(agent.executable, [], 'Name a city.', { cwd })).stdout])
      .toEqual(['start\nanswer: blue\n', 'start\nanswer: default\n']);
  });

  it('lets a before script change the reply or exit on its own', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b'), before: "if (prompt.includes('stop')) { process.stderr.write('rate limited'); process.exit(3); } reply = prompt.toUpperCase();" });

    expect([await runFakeAgent(agent.executable, [], 'stop', { cwd }), await runFakeAgent(agent.executable, [], 'go', { cwd })])
      .toEqual([{ stdout: '', code: 3 }, { stdout: 'start\nanswer: GO\n', code: 0 }]);
  });

  it('fails as the recording failed when the prompt asks it to', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b') });

    expect(await runFakeAgent(agent.executable, [], `Go. ${FAKE_AGENT_MARKERS.fail}`, { cwd })).toEqual({ stdout: 'start\nerror: recorded failure\n', code: 1 });
  });

  it('goes silent after its first line when it hangs, until it is stopped', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b'), always: ['hang'] });

    expect(await runFakeAgent(agent.executable, [], 'Go.', { cwd, stopAfterMs: 800 })).toEqual({ stdout: 'start\n', code: null });
  });

  it('spaces its lines out when slow', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b'), slowMs: 300 });
    const begun = performance.now();

    await runFakeAgent(agent.executable, [], `Go. ${FAKE_AGENT_MARKERS.slow}`, { cwd });

    expect(performance.now() - begun).toBeGreaterThanOrEqual(600);
  });

  it('commits the prompt in its cwd when asked', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b') });

    execFileSync('git', ['init', '-q', cwd]);
    execFileSync('git', ['-C', cwd, 'commit', '-q', '--allow-empty', '-m', 'base'], { env: { ...process.env, ...GIT_ENV } });
    await runFakeAgent(agent.executable, [], `Change it. ${FAKE_AGENT_MARKERS.commit}`, { cwd, env: GIT_ENV });

    expect(execFileSync('git', ['-C', cwd, 'log', '--format=%s'], { encoding: 'utf8' }).trim().split('\n')).toEqual(['agent commit', 'base']);
  });
});
