import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compileBundle, type BenchmarkPlan } from '../benchmark/plan.js';
import { planOfRun } from '../benchmark/run-plan.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import type { BenchmarkSuiteFiles } from '../workflow/conformance-interpreter.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { stepDefinitions } from '../workflow/scope.js';
import { readRun } from '../workflow/store.js';
import type { DriverIdentity, RunState } from '../workflow/types.js';
import { benchmarkRunConfig, frozenBenchmark } from './helpers/benchmark-fixture.js';

const driver: DriverIdentity = { kind: 'local', machine: 'a', workspace: '/work' };
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The shipped benchmark workflow's plan and trials steps, without its report. */
const PLANNED = `schemaVersion: v1alpha1
name: planned
description: Plan a benchmark, then run it.
steps:
  - id: plan
    command: teamai benchmark plan fix
    output: { definition: workflow, plan: json }
  - id: trials
    needs: [plan]
    workflow: { from: plan }
`;

/** A suite of check tasks t01.. and claude arms a01.., the second and later on model m<i>. */
function suiteOf({ tasks = 1, arms = 1, repetitions = 1 } = {}): BenchmarkSuiteFiles {
  const names = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`);
  return {
    name: 'fix',
    suite: `schemaVersion: v1alpha1\nname: fix\nrepo: https://github.com/fixture/app.git\ndefaults: { tool: claude }\narms: [${names('a', arms).map((name, index) => `{ name: ${name}${index > 0 ? `, model: m${index + 1}` : ''} }`).join(', ')}]\nrepetitions: ${repetitions}\ntimeout: 10m\n`,
    tasks: Object.fromEntries(names('t', tasks).map((name) => [name,
      "schemaVersion: v1alpha1\ntitle: Fix it\nprompt: Make the test pass.\nstartingCommit: '{{startingCommit}}'\ncheck: { run: node test.js, protect: [test.js] }\n"])),
  };
}

const LeaseSchema = z.object({ data: z.object({ lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number() }) }) });

/**
 * A run of the planned workflow whose plan step printed the bundle `compileBundle` makes of `files`, with its plan, or
 * with `plan` in its place. Answers the run as it stands once the plan step's report settled.
 */
async function plannedRun(files: BenchmarkSuiteFiles, replace?: (plan: BenchmarkPlan) => unknown): Promise<{ run: RunState; plan: BenchmarkPlan }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-bundle-'));
  dirs.push(root);
  const config: LocalConfig = benchmarkRunConfig(root);
  const frozen = await frozenBenchmark(config, files);
  if (!('plan' in frozen)) throw new Error(JSON.stringify(frozen));
  const { definition, scorers } = compileBundle(frozen.plan, frozen.committed);
  fs.mkdirSync(path.join(config.repo.localPath, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'planned.yaml'), PLANNED);
  await syncWorkflowDefinitions(config);
  const started = await startRun(config, 'planned', {}, { secrets: {} });
  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  const { lease } = LeaseSchema.parse(await leaseNext(config, runId, driver)).data;
  // As the step prints them, JSON on its stdout, without the team revision, which this config has no team repo to pin at.
  const outputs: unknown = JSON.parse(JSON.stringify({ definition: { definition, workflows: {}, scorers }, plan: replace ? replace(frozen.plan) : frozen.plan }));
  await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, outputs });
  const run = await readRun(config, runId);
  if (typeof run !== 'object') throw new Error(`run ${runId} cannot be read`);
  return { run, plan: frozen.plan };
}

describe('the workflow a benchmark plan prints', () => {
  it('is admitted for a suite of two tasks and two repetitions, and its plan is read from beneath the step that runs it', async () => {
    const { run, plan } = await plannedRun(suiteOf({ tasks: 2, arms: 2, repetitions: 2 }));

    expect(run.steps.find((step) => step.id === 'plan')).toMatchObject({ status: 'succeeded' });
    expect(planOfRun(run, 'trials.r2.t02.a01.prompt')).toEqual({ found: { plan, prefix: 'trials.' } });
    expect(plan.trials.map((trial) => trial.step)).toContain('r2.t02.a02.prompt');
    for (const step of ['trials.baselines.t01', 'trials.baselines.t02', 'trials.r2.t02.a02.prompt', 'trials.r2.t02.a02.check', 'trials.settled']) {
      expect(stepDefinitions(run)(step), step).toBeDefined();
    }
  });

  it('is refused by report and check once its plan is of a schemaVersion this teamai does not read', async () => {
    const { run } = await plannedRun(suiteOf(), (plan) => ({ ...plan, schemaVersion: 2 }));

    expect(planOfRun(run, 'trials.r1.t01.a01.check')).toEqual({ failure: {
      code: 'run_unreadable',
      message: `Step "plan" of run ${run.id} printed a benchmark plan of schemaVersion 2, and this teamai reads only schemaVersion 1. Run the benchmark with the teamai that planned it, or start it again.`,
    } });
  });
});
