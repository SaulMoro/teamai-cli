/**
 * Real CLI: a one-task, one-arm check suite, started with `workflow start --benchmark` in a member's checkout, and run
 * on the local driver in a declared sandbox.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveRunMode } from '../../launch-context.js';
import { benchmarkFixture, envelope, FIX_SUITE, fixTask, PRODUCT_URL, said, TEAM_URL, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

interface StepTree {
  id: string;
  workflow?: { steps: StepTree[] };
}
const StepTreeSchema: z.ZodType<StepTree> = z.lazy(() => z.object({
  id: z.string(),
  workflow: z.object({ steps: z.array(StepTreeSchema) }).optional(),
}));
const RunFileSchema = z.object({
  teamRevision: z.string(),
  runMode: z.string().optional(),
  benchmark: z.object({ baselineTeamRevision: z.string(), trials: z.array(z.unknown()) }).passthrough(),
  definition: z.object({ steps: z.array(StepTreeSchema) }).passthrough(),
}).passthrough();

const DoneSchema = z.object({ outcome: z.string(), end: z.string(), benchmark: z.object({ text: z.string() }) }).passthrough();
const EndRecordSchema = z.object({ status: z.string(), benchmark: z.object({ trials: z.array(z.unknown()) }).passthrough() }).passthrough();
const CAPTION = 'These results hold for these tasks, this run and this machine.';
const NO_SANDBOX = 'This machine is not declared a sandbox, so benchmark trials did not run. Run benchmarks in CI or a container, and declare it with --sandbox.';
const USER_SCOPE = '--team-ref pins one workspace, but this team also reaches it through user scope, where every workspace shares one copy. Remove the user-scope install, or turn off inheritUserScope, to pin a workspace.';

const TWO_BY_TWO = `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: claude
  - name: codex
    tool: codex
repetitions: 2
timeout: 10m
`;

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

function occurrences(text: string, line: string): number {
  return text.split(line).length - 1;
}

function leafSteps(steps: StepTree[], prefix = ''): string[] {
  return steps.flatMap((step) => (step.workflow ? leafSteps(step.workflow.steps, `${prefix}${step.id}.`) : [`${prefix}${step.id}`]));
}

describe('benchmark on the local driver', () => {
  it('start stores the plan', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true });
    fixtures.push(fixture);
    const teamHead = execFileSync('git', ['--git-dir', fixture.teamOrigin, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark']);
    const answer = envelope(started);
    const run = String(answer.data?.run);
    const stored = RunFileSchema.parse(fixture.runFile(run));
    const driver = { kind: 'ci', machine: 'ci', workspace: fixture.work, can: { workspace: ['read-only', 'new', 'continue'] } };
    const next = envelope(await fixture.teamai(['workflow', 'next', run, '--json', JSON.stringify({ driver })]));
    const beforePull = fixture.runFile(run);
    fixture.pushTeam({ 'benchmarks/fix/tasks/fix.yaml': fixTask(fixture.startingCommit, 'Change the answer.') });
    const pulled = await fixture.teamai(['pull']);

    expect(started.code, said(started)).toBe(0);
    expect(stored.teamRevision).toBe(teamHead);
    // The fixture's CLI inherits this process's CI and TEAMAI_MODE.
    expect(stored.runMode).toBe(resolveRunMode(process.env));
    expect(stored.benchmark).toMatchObject({
      suite: { name: 'fix', repo: 'https://github.com/fixture/app.git' },
      baselineTeamRevision: teamHead,
      selection: { additionalRoles: [], projects: [], excludedSkills: [] },
      repetitions: 1,
      tasks: [{ id: 'fix', startingCommit: fixture.startingCommit, judge: 'check' }],
      arms: [{ name: 'claude', tool: 'claude', team: { kind: 'pulled', revision: teamHead } }],
      trials: [{ order: 1, repetition: 1, task: 'fix', arm: 'claude', step: 'trials.r1.fix.claude.prompt' }],
    });
    expect(leafSteps(stored.definition.steps)).toEqual(['baselines.fix', 'trials.r1.fix.claude.prompt', 'trials.r1.fix.claude.check', 'settled']);
    expect(next).toMatchObject({ data: { wait: { held: [{ step: 'baselines.fix', missing: ['trials', 'sandbox', 'prepare'] }] } } });
    expect(pulled.code, said(pulled)).toBe(0);
    expect(fs.readFileSync(path.join(fixture.teamClone, 'benchmarks', 'fix', 'tasks', 'fix.yaml'), 'utf8')).toContain('Change the answer.');
    expect(fixture.runFile(run)).toEqual(beforePull);
  }, 120_000);

  it.each([
    ['passed', 'fixes', '100% (1/1)'],
    ['failed', 'does-nothing', '0% (0/1)'],
  ] as const)('%s', async (result, tool, passRate) => {
    const fixture = await benchmarkFixture({ tool, sandbox: true });
    fixtures.push(fixture);
    const before = fixture.status();

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);
    const answer = envelope(started);
    const done = DoneSchema.parse(answer.data?.done);
    const record = EndRecordSchema.parse(fixture.endRecord(String(done.run)));
    const [launch, ...more] = fixture.toolLaunches();

    expect(started.code, said(started)).toBe(0);
    expect(done).toMatchObject({ outcome: 'succeeded', end: 'settled' });
    expect(done.benchmark.text).toContain(passRate);
    expect(done.benchmark.text).toContain(CAPTION);
    expect(started.stderr).toContain(done.benchmark.text);
    expect(record.status).toBe('succeeded');
    expect(record.benchmark.trials).toMatchObject([{ task: 'fix', arm: 'claude', repetition: 1, order: 1, step: 'trials.r1.fix.claude.prompt', result }]);
    expect(more).toEqual([]);
    expect(launch).toMatchObject({ ownGit: true, head: fixture.startingCommit, remotes: '' });
    expect(launch?.cwd.startsWith(path.join(fixture.tmp, 'teamai-trials'))).toBe(true);
    expect(fixture.trialRootEntries()).toEqual([]);
    expect(fixture.status()).toBe(before);
  }, 120_000);

  it('eight trials', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fails-first', sandbox: true, suite: TWO_BY_TWO,
      tasks: { one: fixTask('{{startingCommit}}'), two: fixTask('{{startingCommit}}') },
    });
    fixtures.push(fixture);
    const before = fixture.status();

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);
    const done = DoneSchema.parse(envelope(started).data?.done);
    const record = EndRecordSchema.parse(fixture.endRecord(String(done.run)));
    const launches = fixture.toolLaunches();

    expect(started.code, said(started)).toBe(0);
    expect(done).toMatchObject({ outcome: 'succeeded', end: 'settled' });
    expect(record.benchmark.trials).toMatchObject([
      { order: 1, repetition: 1, task: 'one', arm: 'claude', step: 'trials.r1.one.claude.prompt', result: 'error' },
      { order: 2, repetition: 1, task: 'one', arm: 'codex', step: 'trials.r1.one.codex.prompt', result: 'passed' },
      { order: 3, repetition: 1, task: 'two', arm: 'claude', step: 'trials.r1.two.claude.prompt', result: 'passed' },
      { order: 4, repetition: 1, task: 'two', arm: 'codex', step: 'trials.r1.two.codex.prompt', result: 'passed' },
      { order: 5, repetition: 2, task: 'one', arm: 'codex', step: 'trials.r2.one.codex.prompt', result: 'passed' },
      { order: 6, repetition: 2, task: 'one', arm: 'claude', step: 'trials.r2.one.claude.prompt', result: 'passed' },
      { order: 7, repetition: 2, task: 'two', arm: 'codex', step: 'trials.r2.two.codex.prompt', result: 'passed' },
      { order: 8, repetition: 2, task: 'two', arm: 'claude', step: 'trials.r2.two.claude.prompt', result: 'passed' },
    ]);
    expect(launches.map((launch) => launch.tool)).toEqual(['claude', 'codex', 'claude', 'codex', 'codex', 'claude', 'codex', 'claude']);
    expect(new Set(launches.map((launch) => launch.cwd)).size).toBe(8);
    for (const launch of launches) expect(launch).toMatchObject({ ownGit: true, head: fixture.startingCommit, remotes: '' });
    expect(done.benchmark.text).toContain('| claude | claude | tool default (team) | 4 | 3 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 75% (3/4) |');
    expect(done.benchmark.text).toContain('| codex | codex | tool default (team) | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (4/4) |');
    expect(fixture.trialRootEntries()).toEqual([]);
    expect(fixture.status()).toBe(before);
  }, 120_000);

  it('--sandbox declares a sandbox for this process only', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false });
    fixtures.push(fixture);

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local', '--sandbox']);
    const done = DoneSchema.parse(envelope(started).data?.done);
    const record = EndRecordSchema.parse(fixture.endRecord(String(done.run)));
    const again = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);

    expect(started.code, said(started)).toBe(0);
    expect(record.benchmark.trials).toEqual([expect.objectContaining({ arm: 'claude', result: 'passed' })]);
    expect(occurrences(started.stderr, NO_SANDBOX)).toBe(0);
    expect(occurrences(again.stderr, NO_SANDBOX)).toBe(1);
  }, 120_000);

  it('no sandbox', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false });
    fixtures.push(fixture);

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);
    const done = DoneSchema.parse(envelope(started).data?.done);
    const record = EndRecordSchema.parse(fixture.endRecord(String(done.run)));

    expect(started.code, said(started)).toBe(0);
    expect(done).toMatchObject({ outcome: 'succeeded', end: 'settled' });
    expect(occurrences(started.stderr, NO_SANDBOX)).toBe(1);
    expect(record.benchmark.trials).toEqual([expect.objectContaining({ arm: 'claude', result: 'not_run' })]);
    expect(done.benchmark.text).toContain('| claude | claude | tool default (team) | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0% (0/1) |');
    expect(fixture.toolLaunches()).toEqual([]);
  }, 120_000);

  it('--describe is refused, as a benchmark takes no inputs, and starts nothing', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true });
    fixtures.push(fixture);

    const described = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--describe']);

    expect(described.code, said(described)).toBe(1);
    expect(envelope(described).error).toEqual({ code: 'invalid_arguments', message: '--describe shows a workflow\'s metadata and input schemas, and a benchmark takes no inputs: its suite sets its tasks and arms. Start it again without --describe.' });
    expect(fixture.toolLaunches()).toEqual([]);
  }, 120_000);

  it('a tool that hangs is stopped at the suite timeout', async () => {
    const fixture = await benchmarkFixture({ tool: 'hangs', sandbox: true, suite: FIX_SUITE.replace('timeout: 10m', 'timeout: 20s') });
    fixtures.push(fixture);

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);
    const done = envelope(started).data?.done;

    expect(started.code, said(started)).toBe(1);
    expect(done).toMatchObject({ outcome: 'failed', failure: { code: 'timeout' } });
    expect(started.stderr).toContain('| claude | claude | tool default (team) | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0% (0/1) |');
    expect(fixture.toolLaunches().map((launch) => launch.tool)).toEqual(['claude']);
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);

  it('tool missing', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], suite: TWO_BY_TWO });
    fixtures.push(fixture);

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);
    const done = DoneSchema.parse(envelope(started).data?.done);
    const record = EndRecordSchema.parse(fixture.endRecord(String(done.run)));

    expect(started.code, said(started)).toBe(0);
    expect(done).toMatchObject({ outcome: 'succeeded', end: 'settled' });
    expect(occurrences(started.stderr, 'Arm "codex" uses codex, which the local driver cannot run, so its trials did not run.')).toBe(1);
    expect(started.stderr).not.toContain(NO_SANDBOX);
    expect(record.benchmark.trials).toEqual([
      expect.objectContaining({ order: 1, arm: 'claude', result: 'passed' }),
      expect.objectContaining({ order: 2, arm: 'codex', result: 'not_run' }),
      expect.objectContaining({ order: 3, arm: 'codex', result: 'not_run' }),
      expect.objectContaining({ order: 4, arm: 'claude', result: 'passed' }),
    ]);
    expect(fixture.toolLaunches().map((launch) => launch.tool)).toEqual(['claude', 'claude']);
  }, 120_000);

  it('user scope reaches the team', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true });
    fixtures.push(fixture);
    const user = await fixture.teamai(['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force']);

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);
    const done = DoneSchema.parse(envelope(started).data?.done);
    const record = EndRecordSchema.parse(fixture.endRecord(String(done.run)));

    expect(user.code, said(user)).toBe(0);
    expect(started.code, said(started)).toBe(0);
    expect(done).toMatchObject({ outcome: 'succeeded', end: 'settled' });
    expect(occurrences(started.stderr, USER_SCOPE)).toBe(1);
    expect(record.benchmark.trials).toEqual([expect.objectContaining({ arm: 'claude', result: 'not_run' })]);
    expect(fixture.toolLaunches()).toEqual([]);
  }, 120_000);
});
