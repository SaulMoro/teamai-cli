/**
 * Conformance scenarios for benchmark trials at the protocol level: which driver is leased a trial, and how a run whose
 * trials no driver took ends. What a prepared trial does on disk is the driver-contract e2e's.
 */
import { DRIVER_PROFILES, type BenchmarkScenario, type BenchmarkSuiteFiles } from '../workflow/conformance-interpreter.js';
import type { DriverCan } from '../workflow/requirements.js';

/** One check task `fix`, one repetition, and two arms: `claude` from the defaults, and `codex`. */
function twoArms(timeout: string): BenchmarkSuiteFiles {
  return {
    name: 'fix',
    suite: `schemaVersion: v1alpha1
name: fix
description: Fix the answer with two tools.
repo: https://github.com/fixture/app.git
defaults:
  tool: claude
arms:
  - name: claude
  - name: codex
    tool: codex
repetitions: 1
timeout: ${timeout}
`,
    tasks: {
      fix: `schemaVersion: v1alpha1
title: Fix the answer
prompt: Make node test.js pass.
startingCommit: '{{startingCommit}}'
check:
  run: node test.js
  protect: [test.js]
`,
    },
  };
}

const external: DriverCan = { workspace: [...DRIVER_PROFILES.external.can.workspace] };
const SANDBOX_CLAUDE: DriverCan = { ...external, isolation: 'sandbox', env: true, tools: ['claude'], trials: ['claude'] };
/** The baseline of task `fix`: the first step of the run, which every driver must be able to take before any trial runs. */
const BASELINE = 'baselines.fix';

export const benchmarkConformanceScenarios: BenchmarkScenario[] = [
  {
    name: 'a driver that lists no can.trials is held, not leased, the task baseline that runs before any trial',
    benchmark: twoArms('10m'),
    operations: [{ kind: 'next', saveAs: 'held', as: 'external', prepare: true, can: { ...external, isolation: 'sandbox' },
      expect: { data: { wait: { held: [{ step: BASELINE, missing: ['trials'] }] } } } }],
  },
  {
    name: 'a driver that does not declare a sandbox is held, not leased, the task baseline that runs before any trial',
    benchmark: twoArms('10m'),
    operations: [{ kind: 'next', saveAs: 'held', as: 'external', prepare: true, can: { ...external, trials: ['claude'] },
      expect: { data: { wait: { held: [{ step: BASELINE, missing: ['isolation'] }] } } } }],
  },
  {
    name: 'a driver that provides clones but does not ask next --prepare is held, not leased, the task baseline that runs before any trial',
    benchmark: twoArms('10m'),
    operations: [{ kind: 'next', saveAs: 'held', as: 'external', can: { ...SANDBOX_CLAUDE, workspace: [...DRIVER_PROFILES.external.can.workspace, 'clone'] },
      expect: { data: { wait: { held: [{ step: BASELINE, missing: ['prepare'] }] } } } }],
  },
  {
    name: 'the suite timeout settles the trials no driver took as not_run, and done carries the results table',
    benchmark: twoArms('2s'),
    operations: [
      { kind: 'advance', ms: 3000 },
      { kind: 'next', saveAs: 'done', as: 'external', prepare: true, can: SANDBOX_CLAUDE,
        expect: { data: { done: { outcome: 'failed', failure: { code: 'timeout' }, benchmark: { table: { results: [
          { arm: 'claude', tool: 'claude', planned: 1, counts: { not_run: 1 } },
          { arm: 'codex', tool: 'codex', planned: 1, counts: { not_run: 1 } },
        ] } } } } } },
    ],
    expectRecord: { benchmark: {
      tasks: [{ id: 'fix', baseline: 'not_run' }],
      trials: [{ order: 1, arm: 'claude', result: 'not_run' }, { order: 2, arm: 'codex', result: 'not_run' }],
    } },
  },
];
