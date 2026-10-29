import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, PRODUCT_URL, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';
import { fakeTrialDriver, type DriverUnderTest } from '../helpers/fake-trial-driver.js';

/** The suite of the contract: one check task `fix`, and the arms `claude` and `codex`, with `trial` when given. */
function twoArms(timeout: string, trial?: string): string {
  return `schemaVersion: v1alpha1
name: fix
description: Fix the answer with two tools.
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: claude
  - name: codex
    tool: codex
repetitions: 1
timeout: ${timeout}
${trial ? `trial: ${trial}\n` : ''}`;
}

const DRIVERS: Array<{ name: string; make(fixture: BenchmarkFixture): DriverUnderTest }> = [
  {
    name: 'a fake external driver',
    make: (fixture) => fakeTrialDriver({
      teamai: fixture.teamai, env: fixture.env, pauseMs: 1000,
      tools: { claude: path.join(fixture.bin, 'claude'), codex: path.join(fixture.bin, 'codex') },
    }),
  },
];

const SANDBOX_CLAUDE = { workspace: ['read-only', 'new', 'continue'], isolation: 'sandbox', tools: ['claude'], trials: ['claude'] };
const RecordSchema = z.object({ benchmark: z.object({
  tasks: z.array(z.object({ id: z.string(), baseline: z.string() })),
  trials: z.array(z.object({ order: z.number(), arm: z.string(), result: z.string(), limit: z.string().optional() })),
}) });
const RunSchema = z.object({ status: z.string(), steps: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()) });

async function started(fixture: BenchmarkFixture): Promise<string> {
  const answer = envelope(await fixture.teamai(['workflow', 'start', 'fix', '--benchmark']));
  if (typeof answer.data?.run !== 'string') throw new Error(`no run: ${JSON.stringify(answer)}`);
  return answer.data.run;
}

describe.each(DRIVERS)('the benchmark trial contract, driven by $name', ({ make }) => {
  it('runs only the trial whose tool the driver lists, and the suite timeout settles the other not_run', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false, suite: twoArms('15s') });
    try {
      const status = fixture.status();
      const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.teamClone, encoding: 'utf8' }).trim();
      const runId = await started(fixture);

      const result = await make(fixture).drive({ runId, can: SANDBOX_CLAUDE, prepare: true, maxPolls: 40 });

      expect(result.leased).toEqual(['trials.r1.fix.claude.prompt']);
      expect(result.done).toMatchObject({ outcome: 'failed', failure: { code: 'timeout' } });
      expect(result.done?.text).toContain('| claude | claude | tool default (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) |');
      expect(result.done?.text).toContain('| codex | codex | tool default (team) | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0% (0/1) |');
      expect(result.done?.text).toContain('These results hold for these tasks, this run and this machine.');
      const record = RecordSchema.parse(fixture.endRecord(runId)).benchmark;
      // teamai ran the baseline inside next --prepare, so the driver was leased only the prompt.
      expect(record.tasks).toEqual([expect.objectContaining({ id: 'fix', baseline: 'valid' })]);
      expect(record.trials).toEqual([
        expect.objectContaining({ order: 1, arm: 'claude', result: 'passed' }),
        expect.objectContaining({ order: 2, arm: 'codex', result: 'not_run' }),
      ]);
      const prompt = RunSchema.parse(fixture.runFile(runId)).steps.find((step) => step.id === 'trials.r1.fix.claude.prompt');
      expect(prompt).toMatchObject({ status: 'succeeded', tool: 'claude', model: 'fake-claude', session: 'fake-session', durationMs: expect.any(Number) });
      // The driver sends neither: teamai observed both of the clone it prepared.
      expect(prompt).toMatchObject({ agent: { team: { revision: baseline }, project: { commit: fixture.startingCommit } } });
      expect(fixture.toolLaunches().map((launch) => launch.tool)).toEqual(['claude']);
      expect(fixture.trialRootEntries()).toEqual([]);
      expect(fixture.status()).toBe(status);
    } finally {
      fixture.remove();
    }
  });

  it('stops the tool at the trial timeout the lease sets, and the check decides the trial its report says a limit ended', async () => {
    const fixture = await benchmarkFixture({ tool: 'hangs', sandbox: false, suite: twoArms('15s', '{ timeout: 3s }') });
    try {
      const runId = await started(fixture);

      const result = await make(fixture).drive({ runId, can: SANDBOX_CLAUDE, prepare: true, maxPolls: 40 });

      expect(result.leased).toEqual(['trials.r1.fix.claude.prompt']);
      expect(result.done?.text).toContain('| claude | claude | tool default (team) | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0% (0/1) |');
      expect(RecordSchema.parse(fixture.endRecord(runId)).benchmark.trials).toEqual([
        expect.objectContaining({ order: 1, arm: 'claude', result: 'failed', limit: 'timeout' }),
        expect.objectContaining({ order: 2, arm: 'codex', result: 'not_run' }),
      ]);
    } finally {
      fixture.remove();
    }
  });

  it.each([
    ['declares nothing', {}, true, ['trials', 'sandbox']],
    ['lists no trials', { isolation: 'sandbox' }, true, ['trials']],
    ['provides clones but does not ask --prepare', { ...SANDBOX_CLAUDE, workspace: [...SANDBOX_CLAUDE.workspace, 'clone'] }, false, ['prepare']],
  ])('holds the task baseline, and so every trial, from a driver that %s', async (_, can, prepare, missing) => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false, suite: twoArms('10m') });
    try {
      const runId = await started(fixture);

      const result = await make(fixture).drive({ runId, can, prepare, maxPolls: 1 });

      expect(result.leased).toEqual([]);
      expect(result.held).toEqual([expect.objectContaining({ step: 'baselines.fix', missing: expect.arrayContaining(missing) })]);
      expect(fixture.toolLaunches()).toEqual([]);
    } finally {
      fixture.remove();
    }
  });

  it("gives the tool a clone of its own, from which a control command does not reach the member's run", async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false, suite: twoArms('10m') });
    try {
      const status = fixture.status();
      const runId = await started(fixture);
      fixture.probeControl(runId);

      await make(fixture).drive({ runId, can: SANDBOX_CLAUDE, prepare: true, maxPolls: 3 });

      const [launch] = fixture.toolLaunches();
      expect(launch).toMatchObject({ tool: 'claude', ownGit: true, head: fixture.startingCommit, remotes: '' });
      expect(path.relative(fixture.work, launch?.cwd ?? fixture.work).startsWith('..')).toBe(true);
      // A run id reaches the member's run from any directory, so the lease's env carries the attempt marker, which
      // refuses every call that changes a run.
      expect(fixture.probeAnswers()).toEqual([{ error: expect.objectContaining({ code: 'nested_workflow' }) }]);
      const run = RunSchema.parse(fixture.runFile(runId));
      expect(run.status).toBe('running');
      expect(run.steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
      expect(fixture.status()).toBe(status);
    } finally {
      fixture.remove();
    }
  });
});
