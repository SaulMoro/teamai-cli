import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as envExec from '../env-exec.js';
import { resolveWorkflowEnv } from '../env-resolution.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { Trials } from '../benchmark/trial.js';
import { leaseNext, reportAttempt } from '../workflow/engine.js';
import { runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import type { DriverCan } from '../workflow/requirements.js';
import { cancelRun } from '../workflow/run-controls.js';
import { AttemptIdSchema, readRun, runsDir } from '../workflow/store.js';
import { inProcessClient } from '../workflow/protocol.js';
import type { DriverIdentity } from '../workflow/types.js';
import { benchmarkRunConfig, FIX_SUITE, fixTask, RUN_START, settleBaselines, startBenchmarkRun } from './helpers/benchmark-fixture.js';

const driver: DriverIdentity = { kind: 'external', machine: 'ci', workspace: '/work' };
const can: DriverCan = { workspace: ['read-only', 'new', 'continue'], isolation: 'sandbox', trials: ['claude'] };
const LeaseSchema = z.object({ data: z.object({ lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number(), workspace: z.object({ branch: z.string() }) }) }) });
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A run of the one-task check suite by a member of a single-repo team, which a trial cannot pin, with no user scope. */
async function startOnSelfTeam(): Promise<{ config: LocalConfig; runId: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-trials-'));
  dirs.push(root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  const config: LocalConfig = { ...benchmarkRunConfig(root), repo: { localPath: path.join(root, 'team'), remote: '.', kind: 'self' } };
  const started = await startBenchmarkRun(config, { name: 'fix', suite: FIX_SUITE, tasks: { fix: fixTask('{{startingCommit}}') } });
  if ('error' in started) throw new Error(started.error.message);
  return { config, runId: String(started.data.run) };
}

/**
 * A run of the one-task check suite whose baseline failed as the task expects, and the lease of its prompt as the engine
 * grants it, before any preparation.
 */
async function leasedPrompt(): Promise<{ config: LocalConfig; runId: string; lease: z.infer<typeof LeaseSchema>['data']['lease'] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-trials-'));
  dirs.push(root);
  const config = benchmarkRunConfig(root);
  const started = await startBenchmarkRun(config, { name: 'fix', suite: FIX_SUITE, tasks: { fix: fixTask('{{startingCommit}}') } });
  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  await settleBaselines(config, runId, driver, can);
  return { config, runId, lease: LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease };
}

describe('Trials.report', () => {
  it.each([
    ['changes', { changes: { branch: 'b', base: RUN_START, from: RUN_START, to: 'c'.repeat(40), commits: [] } }],
    ['read', { read: { branch: 'b', base: RUN_START, commit: RUN_START } }],
    ['exitCode', { exitCode: 0 }],
  ])('refuses a trial report that carries %s, which teamai fills itself, and keeps the trial leased', async (field, fields) => {
    const { config, runId, lease } = await leasedPrompt();

    const answer = await Trials.report(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, tool: 'claude', ...fields }, {});

    expect(answer).toEqual({ error: { code: 'invalid_report', message: `Prepared trial reports fill changes/read/exitCode automatically; omit ${field}` } });
    const run = await readRun(config, runId);
    expect(typeof run === 'object' && run.steps.find((step) => step.id === lease.step)).toMatchObject({ status: 'leased', attempt: lease.attempt });
  });

  it('refuses a trial report that names no tool', async () => {
    const { config, runId, lease } = await leasedPrompt();

    const answer = await Trials.report(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver }, {});

    expect(answer).toEqual({ error: { code: 'invalid_report', message: 'The report of trial step "trials.r1.fix.claude.prompt" names no tool. Send tool with the tool the driver launched: claude for this trial.' } });
  });

  it('refuses a limit its suite does not set, and keeps the trial leased', async () => {
    const { config, runId, lease } = await leasedPrompt();

    const answer = await Trials.report(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, tool: 'claude', limit: 'timeout' }, {});

    const run = await readRun(config, runId);
    expect(answer).toEqual({ error: { code: 'invalid_report', message: 'The report of trial step "trials.r1.fix.claude.prompt" names limit timeout, which its suite\'s trial does not set. Send limit only for a limit in the lease\'s trial.limits that stopped the tool.' } });
    expect(typeof run === 'object' && run.steps.find((step) => step.id === lease.step)).toMatchObject({ status: 'leased', attempt: lease.attempt });
  });

  it("refuses a driver's report of a check, which teamai runs itself", async () => {
    const { config, runId, lease } = await leasedPrompt();
    await reportAttempt(config, runId, {
      attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, trialReport: {},
      changes: { branch: lease.workspace.branch, base: RUN_START, from: RUN_START, to: 'c'.repeat(40), commits: [] },
    });
    const check = LeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;

    const answer = await Trials.report(config, runId, { attempt: check.attempt, revision: check.revision, outcome: 'success', driver, tool: 'claude' }, {});

    expect(check.step).toBe('trials.r1.fix.claude.check');
    expect(answer).toEqual({ error: { code: 'invalid_report', message: 'Step "trials.r1.fix.claude.check" is a benchmark check, which teamai runs itself inside teamai workflow next --prepare. Report only the prompt leases next --prepare gives this driver.' } });
  });
});

describe('next --prepare on a benchmark run', () => {
  it('refuses --attempt, since teamai prepares trial attempts itself, and keeps the trial leased', async () => {
    const { config, runId, lease } = await leasedPrompt();
    const client = inProcessClient({ config, env: await resolveWorkflowEnv(config) });

    const answer = await client.next(runId, { driver: { ...driver, can }, running: [] }, { prepare: { attempt: AttemptIdSchema.parse(lease.attempt) } });

    expect(answer).toEqual({ error: { code: 'invalid_arguments', message: `Run ${runId} is a benchmark run, whose trial attempts teamai prepares itself, so --attempt and --adopt do not apply. Call next --prepare without them.` } });
    const run = await readRun(config, runId);
    expect(typeof run === 'object' && run.steps.find((step) => step.id === lease.step)).toMatchObject({ status: 'leased', attempt: lease.attempt });
  });
});

describe('Trials.next where the team cannot be pinned', () => {
  const SELF = "--team-ref does not apply in single-repo mode: the project's own commit decides which team assets it has.";

  it('answers team_ref_blocked and leases nothing, not even a baseline, so another machine can take the run', async () => {
    const { config, runId } = await startOnSelfTeam();

    const answer = await Trials.next(config, runId, driver, { can });

    const run = await readRun(config, runId);
    expect(answer).toEqual({ error: { code: 'team_ref_blocked', message: SELF } });
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'baselines.fix')).toMatchObject({ status: 'pending' });
  });

  it("settles every trial not_run for the run's only driver, so the run ends", async () => {
    const { config, runId } = await startOnSelfTeam();

    const answer = await Trials.next(config, runId, driver, { can, alone: true });

    expect(answer).toMatchObject({ data: { done: { outcome: 'succeeded', benchmark: { table: { results: [{ arm: 'claude', planned: 1, counts: { not_run: 1 } }] } } } } });
  });
});

describe('a stop while teamai prepares or checks a trial', () => {
  /** A run of the one-task check suite by a member of a git team, with no user scope and a `claude` on PATH. */
  async function startOnGitTeam(): Promise<{ config: LocalConfig; runId: string; root: string }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-trials-'));
    dirs.push(root);
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    fs.mkdirSync(path.join(root, 'bin'));
    // Only found on PATH, never launched: the stop comes first.
    fs.writeFileSync(path.join(root, 'bin', process.platform === 'win32' ? 'claude.cmd' : 'claude'), '', { mode: 0o755 });
    vi.stubEnv('PATH', `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`);
    const config = benchmarkRunConfig(root);
    const started = await startBenchmarkRun(config, { name: 'fix', suite: FIX_SUITE, tasks: { fix: fixTask('{{startingCommit}}') } });
    if ('error' in started) throw new Error(started.error.message);
    return { config, runId: String(started.data.run), root };
  }

  it('keeps the step leased and tells an external driver to call next --prepare again, which runs it again', async () => {
    const { config, runId } = await startOnGitTeam();
    const stop = new AbortController();
    stop.abort('SIGTERM');

    const stopped = await Trials.next(config, runId, driver, { can, signal: stop.signal });
    const held = await readRun(config, runId);
    const again = await Trials.next(config, runId, driver, { can });

    expect(stopped).toEqual({ error: { code: 'interrupted', message: `Stopped while step "baselines.fix" was prepared or checked. It stays leased to this driver: call teamai workflow next ${runId} --prepare again, and teamai prepares it from the start.` } });
    expect(typeof held === 'object' && held.steps.find((step) => step.id === 'baselines.fix')).toMatchObject({ status: 'leased' });
    expect(again).toMatchObject({ data: { done: { benchmark: { table: { invalid: [{ task: 'fix', baseline: 'could_not_run' }] } } } } });
  });

  it('tells the local driver to resume the run, with --sandbox when the process declared it', async () => {
    const { config, runId, root } = await startOnGitTeam();
    vi.spyOn(envExec, 'exitLike').mockImplementation(() => {});
    const before = new Set(process.listeners('SIGTERM'));
    const next = Trials.next;
    vi.spyOn(Trials, 'next').mockImplementation(async (...args) => {
      for (const handler of process.listeners('SIGTERM')) if (!before.has(handler)) handler('SIGTERM');
      return next(...args);
    });

    const answer = await runLocalDriver(config, runId, root, { sandbox: true });

    expect(answer).toEqual({ error: { code: 'interrupted', message: `Stopped while a trial step was prepared or checked. It stays leased: continue with teamai workflow resume ${runId} --sandbox.` } });
  });
});

describe('Trials.sweep', () => {
  /**
   * A receipt as preparation writes it before anything under its root exists, and the paths preparation made before the
   * driver died. The receipt is the durable file a later teamai reads, so the test writes it as one.
   */
  function crashedTrial(config: LocalConfig, runId: string, made: readonly string[]): { receipt: string; root: string } {
    const root = path.join(path.dirname(getDataHome(config)), 'trial-root');
    const receipt = path.join(runsDir(config), runId, 'trials', 'trials.r1.fix.claude.json');
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify({ v: 1, copy: 'trials.r1.fix.claude', root, state: { kind: 'preparing', attempt: 'a1' } }));
    for (const dir of made) fs.mkdirSync(path.join(root, dir), { recursive: true });
    return { receipt, root };
  }

  it.each([
    ['before its root existed', []],
    ['after the clone', ['r']],
    ['after the team revision was copied', ['r', 'team.git']],
    ['after the trial team clone', ['r', 'team.git', 'h/.teamai/projects/p/team-repo']],
    ['after the agent files were saved', ['r', 'team.git', 'h/.teamai/projects/p/team-repo', 'saved']],
  ])('removes exactly the root and the receipt of a trial whose driver died %s, once its run is cancelled', async (_stage, made) => {
    const { config, runId } = await leasedPrompt();
    const { receipt, root } = crashedTrial(config, runId, made);
    const sibling = path.join(path.dirname(root), 'sibling');
    fs.mkdirSync(sibling);
    await cancelRun(config, runId, {});

    await Trials.sweep(config);

    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(receipt)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
  });

  it('keeps the root of a trial whose prompt is still leased', async () => {
    const { config, runId } = await leasedPrompt();
    const { receipt, root } = crashedTrial(config, runId, ['r']);

    await Trials.sweep(config, runId);

    expect(fs.existsSync(path.join(root, 'r'))).toBe(true);
    expect(fs.existsSync(receipt)).toBe(true);
  });
});
