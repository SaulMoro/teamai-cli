/**
 * Real CLI: the names a trial never sees stay out of its setup, its tool and its check on every driver, also when the
 * team env declares one of them, and out of whatever git starts in the clone after the tool ran there.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, PRODUCT_URL, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';
import { fakeTrialDriver } from '../helpers/fake-trial-driver.js';

const WITHHELD = ['GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN', 'GL_TOKEN', 'CI_JOB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS'];
const WITH_SETUP = `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: claude
repetitions: 1
timeout: 10m
setup:
  command: env > "$FIXTURE_ROOT/setup.env"
`;
const TASK = `schemaVersion: v1alpha1
title: Fix the answer
prompt: Make node test.js pass.
startingCommit: '{{startingCommit}}'
check:
  run: env > "$FIXTURE_ROOT/check.env" && node test.js
  protect: [test.js]
`;
const CRITERIA_TASK = `schemaVersion: v1alpha1
title: Fix the answer
prompt: Make answer.js export 42.
startingCommit: '{{startingCommit}}'
successCriteria: answer.js exports 42.
`;
const SANDBOX_CLAUDE = { workspace: ['read-only', 'new', 'continue'], isolation: 'sandbox', trials: ['claude'] };
const RecordSchema = z.object({ benchmark: z.object({ trials: z.array(z.object({ result: z.string() }).passthrough()) }) });

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

async function startedRun(fixture: BenchmarkFixture, args: string[] = []): Promise<string> {
  const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', ...args]);
  const answer = envelope(started);
  const run = answer.data?.run ?? z.object({ run: z.string() }).safeParse(answer.data?.done).data?.run;
  if (typeof run !== 'string') throw new Error(`no run: ${said(started)}`);
  return run;
}

const DRIVERS: Array<{ name: string; run(fixture: BenchmarkFixture): Promise<string> }> = [
  { name: 'the local driver', run: (fixture) => startedRun(fixture, ['--driver', 'local']) },
  {
    name: 'a fake external driver',
    run: async (fixture) => {
      const runId = await startedRun(fixture);
      const driver = fakeTrialDriver({ teamai: fixture.teamai, env: fixture.env, pauseMs: 500, tools: { claude: path.join(fixture.bin, 'claude') } });
      await driver.drive({ runId, can: SANDBOX_CLAUDE, prepare: true, maxPolls: 10 });
      return runId;
    },
  },
];

describe.each(DRIVERS)('the strip list on $name', ({ run }) => {
  it('keeps every withheld name out of setup, the tool and the check', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], suite: WITH_SETUP, tasks: { fix: TASK }, printsEnv: true,
      team: { 'env/env.yaml': 'variables:\n  - key: GH_TOKEN\n    value: from-the-team\n' },
    });
    fixtures.push(fixture);
    for (const name of WITHHELD) fixture.env[name] = `member-${name.toLowerCase()}`;
    fixture.env.BENCHMARK_VISIBLE = 'seen';

    const runId = await run(fixture);

    expect(fixture.toolLaunches()).toHaveLength(1);
    for (const who of ['setup', 'tool', 'check']) {
      const seen = fs.readFileSync(path.join(fixture.root, `${who}.env`), 'utf8').split('\n').map((line) => line.split('=')[0]);
      expect(seen, who).toContain('BENCHMARK_VISIBLE');
      expect(seen.filter((name) => WITHHELD.includes(name ?? '')), who).toEqual([]);
    }
    const stored = z.object({ steps: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()) }).parse(fixture.runFile(runId));
    expect(stored.steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
  }, 120_000);

  it('keeps a withheld name out of setup also when the suite setup requires it', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], tasks: { fix: TASK }, printsEnv: true,
      suite: `${WITH_SETUP}  requires:\n    env: [GH_TOKEN]\n`,
    });
    fixtures.push(fixture);
    fixture.env.GH_TOKEN = 'member-gh-token';

    const runId = await run(fixture);

    const seen = fs.readFileSync(path.join(fixture.root, 'setup.env'), 'utf8').split('\n').map((line) => line.split('=')[0]);
    expect(seen).not.toContain('GH_TOKEN');
    const stored = z.object({ steps: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()) }).parse(fixture.runFile(runId));
    expect(stored.steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
  }, 120_000);
});

describe('git in the clone once the tool ran there', () => {
  const LeaseSchema = z.object({ data: z.object({ lease: z.object({ attempt: z.string(), revision: z.number(), cwd: z.string() }) }) });

  /** A script that writes the environment it was started with to `<name>.env` in the fixture's root, and fails. */
  function recorder(fixture: BenchmarkFixture, name: string): string {
    const file = path.join(fixture.root, `${name}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\nenv > "$FIXTURE_ROOT/${name}.env"\nexit 1\n`, { mode: 0o755 });
    return file;
  }

  it('runs no hook or fsmonitor the agent configured there, and gives a filter git still runs none of the withheld names', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'] });
    fixtures.push(fixture);
    for (const name of WITHHELD) fixture.env[name] = `member-${name.toLowerCase()}`;
    fixture.env.BENCHMARK_VISIBLE = 'seen';
    const runId = await startedRun(fixture);
    const driver = { kind: 'external', machine: 'by-hand', workspace: fixture.work };
    const next = async () => envelope(await fixture.teamai(['workflow', 'next', runId, '--prepare', '--json', JSON.stringify({ driver: { ...driver, can: SANDBOX_CLAUDE }, running: [] })]));
    const { lease } = LeaseSchema.parse(await next()).data;
    const hooks = path.join(fixture.root, 'agent-hooks');
    fs.mkdirSync(hooks);
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit']) fs.copyFileSync(recorder(fixture, 'hook'), path.join(hooks, hook));
    const agentGit = (args: string[]) => execFileSync('git', args, { cwd: lease.cwd, env: fixture.env });
    agentGit(['config', 'core.hooksPath', hooks]);
    agentGit(['config', 'core.fsmonitor', recorder(fixture, 'fsmonitor')]);
    agentGit(['config', 'filter.agent.clean', 'env > "$FIXTURE_ROOT/filter.env"; cat']);
    fs.writeFileSync(path.join(lease.cwd, '.gitattributes'), 'answer.js filter=agent\n');
    fs.writeFileSync(path.join(lease.cwd, 'answer.js'), 'module.exports = 42;\n');

    const reported = envelope(await fixture.teamai(['workflow', 'report', runId, '--json', JSON.stringify({ driver, tool: 'claude', attempt: lease.attempt, revision: lease.revision, outcome: 'success' })]));
    const checked = await next();

    expect(reported).toMatchObject({ data: { accepted: true } });
    expect(checked).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.existsSync(path.join(fixture.root, 'hook.env'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, 'fsmonitor.env'))).toBe(false);
    const filtered = fs.readFileSync(path.join(fixture.root, 'filter.env'), 'utf8').split('\n').map((line) => line.split('=')[0]);
    expect(filtered).toContain('BENCHMARK_VISIBLE');
    expect(filtered.filter((name) => WITHHELD.includes(name ?? ''))).toEqual([]);
  }, 120_000);

  it('runs no hook the agent configured as hook.<name>.command there, whatever its name', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'] });
    fixtures.push(fixture);
    const runId = await startedRun(fixture);
    const driver = { kind: 'external', machine: 'by-hand', workspace: fixture.work };
    const next = async () => envelope(await fixture.teamai(['workflow', 'next', runId, '--prepare', '--json', JSON.stringify({ driver: { ...driver, can: SANDBOX_CLAUDE }, running: [] })]));
    const { lease } = LeaseSchema.parse(await next()).data;
    const agentGit = (args: string[]) => execFileSync('git', args, { cwd: lease.cwd, env: fixture.env });
    for (const name of ['from-agent', 'from.agent', 'from=agent']) {
      agentGit(['config', `hook.${name}.command`, recorder(fixture, 'hook')]);
      for (const event of ['pre-commit', 'commit-msg', 'post-commit', 'post-index-change', 'reference-transaction']) agentGit(['config', '--add', `hook.${name}.event`, event]);
    }
    fs.writeFileSync(path.join(lease.cwd, 'answer.js'), 'module.exports = 42;\n');

    const reported = envelope(await fixture.teamai(['workflow', 'report', runId, '--json', JSON.stringify({ driver, tool: 'claude', attempt: lease.attempt, revision: lease.revision, outcome: 'success' })]));
    const checked = await next();

    expect(fs.existsSync(path.join(fixture.root, 'hook.env'))).toBe(false);
    expect(reported).toMatchObject({ data: { accepted: true } });
    expect(checked).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(RecordSchema.parse(fixture.endRecord(runId)).benchmark.trials).toEqual([expect.objectContaining({ result: 'passed' })]);
  }, 120_000);

  it('shows the judge what the agent changed from the starting commit itself, when the agent replaced that commit with git replace', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], tasks: { fix: CRITERIA_TASK } });
    fixtures.push(fixture);
    const runId = await startedRun(fixture);
    const driver = { kind: 'external', machine: 'by-hand', workspace: fixture.work };
    const next = async () => envelope(await fixture.teamai(['workflow', 'next', runId, '--prepare', '--json', JSON.stringify({ driver: { ...driver, can: SANDBOX_CLAUDE }, running: [] })]));
    const { lease } = LeaseSchema.parse(await next()).data;
    const agentGit = (args: string[]) => execFileSync('git', args, { cwd: lease.cwd, env: fixture.env });
    fs.writeFileSync(path.join(lease.cwd, 'answer.js'), 'module.exports = 42;\n');
    agentGit(['add', 'answer.js']);
    agentGit(['commit', '-q', '-m', 'the fix']);
    agentGit(['replace', fixture.startingCommit, 'HEAD']);
    const judge = { kind: 'external', machine: 'judge', workspace: fixture.work };

    const reported = envelope(await fixture.teamai(['workflow', 'report', runId, '--json', JSON.stringify({ driver, tool: 'claude', attempt: lease.attempt, revision: lease.revision, outcome: 'success' })]));
    const leased = z.object({ data: z.object({ lease: z.object({ ref: z.string() }) }) })
      .parse(envelope(await fixture.teamai(['score', '--next', '--json', JSON.stringify({ driver: { ...judge, can: { judge: { isolation: 'verified', tools: ['claude'] } } } })])));
    await fixture.teamai(['score', '--lease', leased.data.lease.ref, '--json', JSON.stringify({ driver: judge })]);

    expect(reported).toMatchObject({ data: { accepted: true } });
    expect(fixture.judgeLaunches()).toEqual([expect.objectContaining({ diff: expect.stringContaining('+module.exports = 42;') })]);
  }, 120_000);
});
