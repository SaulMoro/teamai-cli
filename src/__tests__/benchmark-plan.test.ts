import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ScoreLabel } from '../scorers/label.js';
import { LabelStore } from '../scorers/label-store.js';
import type { LocalConfig } from '../types.js';
import { trialsOf } from '../benchmark/plan.js';
import type { BenchmarkSuiteFiles } from '../workflow/conformance-interpreter.js';
import { leaseNext, reconcileRun, reportAttempt } from '../workflow/engine.js';
import { stepDefinitions } from '../workflow/scope.js';
import { buildEndRecord } from '../workflow/records.js';
import type { DriverCan } from '../workflow/requirements.js';
import { cancelRun } from '../workflow/run-controls.js';
import { readRun, runsDir } from '../workflow/store.js';
import type { DriverIdentity } from '../workflow/types.js';
import { benchmarkRunConfig, RUN_START, RUN_TEAM, settleBaselines, startBenchmarkRun } from './helpers/benchmark-fixture.js';

const driver: DriverIdentity = { kind: 'external', machine: 'ci', workspace: '/work' };
const can: DriverCan = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', tools: ['claude'], trials: ['claude'] };
const dirs: string[] = [];
const HeldSchema = z.object({ data: z.object({ wait: z.object({ held: z.array(z.unknown()) }) }) });
const LeaseSchema = z.object({ data: z.object({ lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number() }) }) });

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A check suite of `tasks` tasks t01.. and `arms` arms a01.., arm i on `tools[i]`, and on claude past them; an arm after
 * the first with no tool or team (`teams[i]`) of its own runs model m<i>, as each arm changes one of the defaults.
 * `trial` is the suite's `trial` value.
 */
function suiteOf({ tasks = 1, arms = 1, repetitions = 1, tools = [] as string[], teams = [] as string[], trial = '' } = {}): BenchmarkSuiteFiles {
  const names = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`);
  return {
    name: 'fix',
    suite: `schemaVersion: v1alpha1\nname: fix\nrepo: https://github.com/fixture/app.git\ndefaults: { tool: claude }\narms: [${names('a', arms).map((name, index) => `{ name: ${name}${tools[index] ? `, tool: ${tools[index]}` : teams[index] ? `, team: ${teams[index]}` : index > 0 ? `, model: m${index + 1}` : ''} }`).join(', ')}]\nrepetitions: ${repetitions}\ntimeout: 10m\n${trial ? `trial: ${trial}\n` : ''}`,
    tasks: Object.fromEntries(names('t', tasks).map((name) => [name,
      "schemaVersion: v1alpha1\ntitle: Fix it\nprompt: Make the test pass.\nstartingCommit: '{{startingCommit}}'\ncheck: { run: node test.js, protect: [test.js] }\n"])),
  };
}

async function startFix(shape?: Parameters<typeof suiteOf>[0]): Promise<{ config: LocalConfig; runId: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-plan-'));
  dirs.push(root);
  const config = benchmarkRunConfig(root);
  const started = await startBenchmarkRun(config, suiteOf(shape));
  if ('error' in started) throw new Error(started.error.message);
  return { config, runId: String(started.data.run) };
}

/** The first trial prompt's lease, once every baseline failed on its starting commit, as the tasks expect. */
async function leasePrompt(config: LocalConfig, runId: string): Promise<{ attempt: string; revision: number }> {
  await settleBaselines(config, runId, driver, can);
  const { attempt, revision } = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
  return { attempt, revision };
}

describe('benchmark plan run', () => {
  it.each([
    ['trials', { ...can, trials: [] }, true],
    ['sandbox', { ...can, isolation: 'none' as const }, true],
    ['prepare', can, false],
  ])('holds a task baseline, which runs before any trial, for a driver that lacks %s', async (missing, offered, prepare) => {
    const { config, runId } = await startFix();

    const next = await leaseNext(config, runId, driver, { can: offered, prepare });

    expect(next).toEqual({ data: { wait: { reason: expect.any(String), held: [{ step: 'baselines.t01', reason: expect.any(String), missing: [missing] }] }, cancelled: [] } });
  });

  it('leases a task baseline, a clone of the starting commit with no team assets, before any trial', async () => {
    const { config, runId } = await startFix();

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    expect(next).toMatchObject({ data: { lease: {
      step: 'baselines.t01', command: 'node test.js', trial: { kind: 'baseline', task: 't01' },
      workspace: { mode: 'new', base: { commit: RUN_START }, clone: { commit: RUN_START, team: { treatment: 'none' } } },
    } } });
  });

  it('leases a trial prompt in a clone of the starting commit with the arm\'s team once its task baseline fails there', async () => {
    const { config, runId } = await startFix();
    await settleBaselines(config, runId, driver, can);

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    expect(next).toMatchObject({ data: { lease: {
      step: 'trials.r1.t01.a01.prompt',
      prompt: 'Make the test pass.',
      tool: 'claude',
      trial: { kind: 'prompt', task: 't01', arm: 'a01', repetition: 1, order: 1 },
      workspace: { base: { commit: RUN_START }, configCommit: RUN_START, clone: { commit: RUN_START, team: { revision: RUN_TEAM, treatment: 'pulled' } } },
    } } });
  });

  it.each([
    ['none', { treatment: 'none' }],
    ['{ without: [fixer] }', { revision: RUN_TEAM, selection: { additionalRoles: [], projects: [], excludedSkills: [] }, treatment: { without: ['fixer'] } }],
    ['main', { revision: RUN_TEAM, selection: { additionalRoles: [], projects: [], excludedSkills: [] }, treatment: 'main' }],
  ])('opens each trial of an arm with team %s in a clone with that team', async (team, expected) => {
    const { config, runId } = await startFix({ arms: 2, teams: ['', team] });

    const run = await readRun(config, runId);

    const arm = typeof run === 'object' ? stepDefinitions(run)('trials.r1.t01.a02') : undefined;
    expect(arm?.workspace).toEqual({ clone: { commit: RUN_START, repo: 'https://github.com/fixture/app.git', team: expected } });
  });

  it.each([
    ['the limits its suite sets', '{ timeout: 5m, budget: { tokens: 1000 }, max_turns: 3 }', { timeoutMs: 300_000, tokens: 1000, maxTurns: 3 }],
    ['no limits when its suite sets none', '', undefined],
  ])('leases each trial prompt %s, and records them', async (_, trial, limits) => {
    const { config, runId } = await startFix({ trial });
    await settleBaselines(config, runId, driver, can);

    const next = LeaseSchema.extend({ data: z.object({ lease: z.object({ trial: z.record(z.unknown()) }) }) })
      .parse(await leaseNext(config, runId, driver, { can, prepare: true }));
    await cancelRun(config, runId, {});
    const run = await readRun(config, runId);

    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(next.data.lease.trial.limits).toEqual(limits);
    expect(buildEndRecord(run, run.driver, '').benchmark?.limits).toEqual(limits);
  });

  it("keeps the limit that ended a trial's prompt on its step, and records it", async () => {
    const { config, runId } = await startFix({ trial: '{ timeout: 5m }' });
    const lease = await leasePrompt(config, runId);

    await reportAttempt(config, runId, { ...lease, outcome: 'success', driver, trialReport: {}, limit: 'timeout' });
    await cancelRun(config, runId, {});
    const run = await readRun(config, runId);

    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(run.steps.find((step) => step.id === 'trials.r1.t01.a01.prompt')).toMatchObject({ status: 'succeeded', limit: 'timeout' });
    expect(buildEndRecord(run, run.driver, '').benchmark?.trials).toEqual([expect.objectContaining({ step: 'trials.r1.t01.a01.prompt', limit: 'timeout' })]);
  });

  it("records the suite limits a trial's driver did not enforce", async () => {
    const { config, runId } = await startFix({ trial: '{ budget: { tokens: 1000 }, max_turns: 3 }' });
    const lease = await leasePrompt(config, runId);

    await reportAttempt(config, runId, { ...lease, outcome: 'success', driver, trialReport: {}, tokens: { input: 10, output: 10 }, unenforced: ['budget', 'max_turns'] });
    await cancelRun(config, runId, {});
    const run = await readRun(config, runId);

    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(run.steps.find((step) => step.id === 'trials.r1.t01.a01.prompt')).toMatchObject({
      status: 'succeeded', unenforced: expect.arrayContaining([{ requirement: 'budget' }, { requirement: 'max_turns', asked: 3 }]),
    });
    expect(buildEndRecord(run, run.driver, '').benchmark?.trials).toEqual([expect.objectContaining({ unenforced: ['budget', 'max_turns'] })]);
  });

  it('refuses a trial report that names an unenforced budget its suite does not set', async () => {
    const { config, runId } = await startFix();
    const lease = await leasePrompt(config, runId);

    const answer = await reportAttempt(config, runId, { ...lease, outcome: 'success', driver, trialReport: {}, unenforced: ['budget'] });

    expect(answer).toEqual({ error: { code: 'invalid_report', message: `Attempt ${lease.attempt} of step "trials.r1.t01.a01.prompt": unenforced names budget, which the step does not set` } });
  });

  it('fails a trial prompt under a budget whose report has no tokens, so the trial is an error', async () => {
    const { config, runId } = await startFix({ trial: '{ budget: { tokens: 1000 } }' });
    const lease = await leasePrompt(config, runId);

    await reportAttempt(config, runId, { ...lease, outcome: 'success', driver, trialReport: {} });
    await leaseNext(config, runId, driver, { can, prepare: true });
    const run = await readRun(config, runId);

    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(run.steps.find((step) => step.id === 'trials.r1.t01.a01.prompt')).toMatchObject({ status: 'failed', failure: {
      code: 'budget_unmeasured',
      message: 'Trial step "trials.r1.t01.a01.prompt" runs under its suite\'s trial budget, and its report has no tokens, so the budget cannot count what it spent. Run the arm\'s tool with a driver that reports its tokens, and start the benchmark again.',
    } });
    expect(buildEndRecord(run, run.driver, '').benchmark?.trials).toEqual([expect.objectContaining({ result: 'error' })]);
  });

  it.each<[string, Array<'budget'> | undefined]>([
    ['', undefined],
    [', once when its report also lists it, as a driver that cannot hold the tool to it does', ['budget']],
  ])('records the budget as unenforced when another limit stopped a trial prompt before its tool stated tokens%s, and lets its check decide', async (_, listed) => {
    const { config, runId } = await startFix({ trial: '{ timeout: 5m, budget: { tokens: 1000 } }' });
    const lease = await leasePrompt(config, runId);

    await reportAttempt(config, runId, { ...lease, outcome: 'success', driver, trialReport: {}, limit: 'timeout', ...(listed ? { unenforced: listed } : {}) });
    await cancelRun(config, runId, {});
    const run = await readRun(config, runId);

    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(run.steps.find((step) => step.id === 'trials.r1.t01.a01.prompt')).toMatchObject({ status: 'succeeded', limit: 'timeout', unenforced: expect.arrayContaining([{ requirement: 'budget' }]) });
    expect(buildEndRecord(run, run.driver, '').benchmark?.trials).toEqual([expect.objectContaining({ limit: 'timeout', unenforced: ['budget'] })]);
  });

  it('refuses a trial report whose limit comes with an outcome other than success, and keeps the trial leased', async () => {
    const { config, runId } = await startFix({ trial: '{ timeout: 5m }' });
    const lease = await leasePrompt(config, runId);

    const answer = await reportAttempt(config, runId, { ...lease, outcome: 'failed', driver, trialReport: {}, limit: 'timeout' });
    const run = await readRun(config, runId);

    expect(answer).toEqual({ error: { code: 'invalid_report', message: `Attempt ${lease.attempt} of step "trials.r1.t01.a01.prompt": limit goes with outcome success, since a limit ends the agent's turn and the trial's check or judge decides it; send outcome success, or omit limit` } });
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(run.steps.find((step) => step.id === 'trials.r1.t01.a01.prompt')).toMatchObject({ status: 'leased' });
  });

  it('refuses a trial report teamai did not complete, and accepts the one it did', async () => {
    const { config, runId } = await startFix();
    const lease = await leasePrompt(config, runId);

    const unstamped = await reportAttempt(config, runId, { ...lease, outcome: 'released', driver });
    const stamped = await reportAttempt(config, runId, { ...lease, outcome: 'released', driver, trialReport: {} });

    expect(unstamped).toMatchObject({ error: { code: 'invalid_report', message: expect.stringContaining('is a benchmark trial') } });
    expect(stamped).toMatchObject({ data: { accepted: true } });
  });

  it('ends the run succeeded at its settled end when a trial fails', async () => {
    const { config, runId } = await startFix();
    const lease = await leasePrompt(config, runId);
    await reportAttempt(config, runId, { ...lease, outcome: 'failed', driver, trialReport: {} });

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    expect(next).toMatchObject({ data: { done: { run: runId, outcome: 'succeeded', end: 'settled' } } });
  });

  it('reads a run as corrupt when its plan holds an arm model a record could not publish', async () => {
    const { config, runId } = await startFix({ arms: 2 });
    const file = path.join(runsDir(config), `${runId}.json`);
    const stored = z.object({ benchmark: z.object({ arms: z.array(z.record(z.unknown())) }).passthrough() }).passthrough().parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    stored.benchmark.arms[1] = { ...stored.benchmark.arms[1], model: 'https://user:secret@models.example/m2' };
    fs.writeFileSync(file, JSON.stringify(stored));

    expect(await readRun(config, runId)).toBe('corrupt');
  });

  it.each([
    ['passes', 'invalid'],
    ['could_not_run', 'could_not_run'],
  ] as const)('runs no trial of a task whose baseline %s, and ends the run with its baseline in the record', async (baseline, recorded) => {
    const { config, runId } = await startFix({ arms: 2, repetitions: 2 });
    await settleBaselines(config, runId, driver, can, { t01: baseline });

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(next).toMatchObject({ data: { done: { outcome: 'succeeded', end: 'settled' } } });
    expect(buildEndRecord(run, run.driver, '').benchmark).toMatchObject({
      tasks: [{ id: 't01', baseline: recorded }],
      trials: Array(4).fill(expect.objectContaining({ result: 'not_run' })),
    });
  });

  it('records that the check could not run for a baseline the run stopped while it ran', async () => {
    const { config, runId } = await startFix();
    LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true }));
    await cancelRun(config, runId, {});

    const run = await readRun(config, runId);

    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(buildEndRecord(run, run.driver, '').benchmark).toMatchObject({ tasks: [{ id: 't01', baseline: 'could_not_run' }], trials: [{ result: 'not_run' }] });
  });

  it("runs a task's trials whatever another task's baseline did, and ends at the settled end with both scopes failed", async () => {
    const { config, runId } = await startFix({ tasks: 2 });
    await settleBaselines(config, runId, driver, can, { t01: 'could_not_run' });
    const lease = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
    await reportAttempt(config, runId, { ...lease, outcome: 'failed', driver, trialReport: {} });

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(lease.step).toBe('trials.r1.t02.a01.prompt');
    expect(next).toMatchObject({ data: { done: { outcome: 'succeeded', end: 'settled' } } });
    expect(buildEndRecord(run, run.driver, '').benchmark).toMatchObject({
      tasks: [{ id: 't01', baseline: 'could_not_run' }, { id: 't02', baseline: 'valid' }],
      trials: [{ task: 't01', result: 'not_run' }, { task: 't02', result: 'error' }],
    });
  });

  it('settles at once every baseline and trial its only driver cannot take, so the run ends', async () => {
    const { config, runId } = await startFix({ tasks: 2, arms: 2, repetitions: 2 });

    const next = await leaseNext(config, runId, driver, { can: { ...can, isolation: 'none' }, prepare: true, alone: true });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(next).toMatchObject({ data: { done: { outcome: 'succeeded', end: 'settled' } } });
    expect(buildEndRecord(run, run.driver, '').benchmark).toMatchObject({
      tasks: [{ id: 't01', baseline: 'not_run' }, { id: 't02', baseline: 'not_run' }],
      trials: Array(8).fill(expect.objectContaining({ result: 'not_run' })),
    });
  });

  it('leases its only driver the trials it can take, and settles the others at once', async () => {
    const { config, runId } = await startFix({ arms: 2, tools: ['codex'] });
    await settleBaselines(config, runId, driver, can);

    const next = await leaseNext(config, runId, driver, { can, prepare: true, alone: true });

    const run = await readRun(config, runId);
    expect(next).toMatchObject({ data: { lease: { step: 'trials.r1.t01.a02.prompt' } } });
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'trials.r1.t01.a01.prompt')).toMatchObject({ status: 'failed', failure: { code: 'tool_unavailable' } });
  });

  it('rotates the arms by one place per repetition', () => {
    const arms = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];

    const trials = trialsOf([{ id: 'task' }], arms, 3);

    expect(trials.map((trial) => `${trial.repetition}${trial.arm}`)).toEqual(['1A', '1B', '1C', '2B', '2C', '2A', '3C', '3A', '3B']);
    expect(trials.map((trial) => trial.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  // Retried, so a busy machine's one slow round does not fail it; a regression is slow every time. A second leaves room for
  // a CI runner several times slower than a laptop, where each takes tens of milliseconds.
  it('reconciles a new run of 20 tasks, 6 arms and 10 repetitions, and answers a poll on it, in under a second each', { retry: 2 }, async () => {
    const { config, runId } = await startFix({ tasks: 20, arms: 6, repetitions: 10 });
    await settleBaselines(config, runId, driver, can);
    const lacksTrials = { ...can, trials: [] };
    const reconciled: number[] = [];
    const polled: number[] = [];
    const reconcileMs: number[] = [];
    const pollMs: number[] = [];

    for (let round = 0; round < 3; round += 1) {
      const run = await readRun(config, runId);
      if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
      const started = performance.now();
      const result = reconcileRun(run, new Date().toISOString());
      reconcileMs.push(performance.now() - started);
      reconciled.push('ready' in result ? result.ready.length : 0);
    }
    await leaseNext(config, runId, driver, { can: lacksTrials, prepare: true });
    for (let round = 0; round < 3; round += 1) {
      const started = performance.now();
      const next = await leaseNext(config, runId, driver, { can: lacksTrials, prepare: true });
      pollMs.push(performance.now() - started);
      polled.push(HeldSchema.parse(next).data.wait.held.length);
    }

    expect(reconciled).toEqual([1200, 1200, 1200]);
    expect(polled).toEqual([1200, 1200, 1200]);
    // The fastest of three is the least noisy estimate of what one call costs.
    expect(Math.min(...reconcileMs)).toBeLessThan(1000);
    expect(Math.min(...pollMs)).toBeLessThan(1000);
  });
});

/** One task judged by success criteria, one arm: a run whose only trial is judged by its generated correctness scorer. */
const CRITERIA_SUITE: BenchmarkSuiteFiles = {
  name: 'fix',
  suite: 'schemaVersion: v1alpha1\nname: fix\nrepo: https://github.com/fixture/app.git\ndefaults: { tool: claude }\narms: [{ name: a01 }]\nrepetitions: 1\ntimeout: 10m\n',
  tasks: { t01: "schemaVersion: v1alpha1\ntitle: Fix it\nprompt: Make the test pass.\nstartingCommit: '{{startingCommit}}'\nsuccessCriteria: The test passes.\n" },
};
const CORRECTNESS = 'teamai:correctness:t01';
const PROMPT = 'trials.r1.t01.a01.prompt';

/** A criteria run whose one trial prompt has succeeded, as Trials.report settles it. */
async function judgedTrial(): Promise<{ config: LocalConfig; runId: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-plan-'));
  dirs.push(root);
  const config = benchmarkRunConfig(root);
  const started = await startBenchmarkRun(config, CRITERIA_SUITE);
  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  const lease = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
  await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, tool: 'claude', trialReport: {} });
  return { config, runId };
}

describe('benchmark run judges', () => {
  it("waits while a trial's correctness entry is open, and ends once a label is in the store", async () => {
    const { config, runId } = await judgedTrial();

    const judging = await leaseNext(config, runId, driver, { can, prepare: true });
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    const label: ScoreLabel = {
      scorer: CORRECTNESS, rubric: { sourceHash: run.scorers?.[CORRECTNESS]?.sourceHash ?? '' }, label: 'correct', score: 1, passed: true,
      source: 'workflow', subject: { runId, step: PROMPT, pass: 1 }, judge: { kind: 'model', tool: 'claude', isolation: 'verified', access: 'read' },
      scoredAt: new Date().toISOString(),
    };
    await LabelStore.append(config, label, 'The test passes.');
    const done = await leaseNext(config, runId, driver, { can, prepare: true });

    const ended = await readRun(config, runId);
    if (typeof ended !== 'object') throw new Error(`run ${runId} is ${ended}`);
    expect(judging).toEqual({ data: { wait: { reason: expect.any(String), judging: 1 }, cancelled: [] } });
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', end: 'settled' } } });
    expect(ended.verdicts).toEqual([{ scorer: CORRECTNESS, step: PROMPT, pass: 1, outcome: { kind: 'labelled', label: 'correct', passed: true } }]);
    expect(buildEndRecord(ended, ended.driver, '').benchmark?.trials).toMatchObject([{ step: PROMPT, result: 'passed' }]);
  });

  it('ends the run failed at its timeout while it judges, and freezes the open entry unscored', async () => {
    const { config, runId } = await judgedTrial();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);

    const next = await leaseNext(config, runId, driver, { can, prepare: true });

    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
    expect(next).toMatchObject({ data: { done: { outcome: 'failed', failure: { code: 'timeout' } } } });
    expect(run.verdicts).toEqual([{ scorer: CORRECTNESS, step: PROMPT, pass: 1, outcome: { kind: 'unscored', because: 'run_ended' } }]);
    expect(buildEndRecord(run, run.driver, '').benchmark?.trials).toMatchObject([{ step: PROMPT, result: 'unscored' }]);
  });
});
