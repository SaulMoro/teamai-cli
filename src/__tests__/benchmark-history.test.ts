import { describe, expect, it } from 'vitest';
import { BenchmarkHistory, type BenchmarkRunInput } from '../workflow/benchmark/history.js';
import type { TrialResult } from '../workflow/benchmark/result.js';

const NOW = new Date('2026-10-28T12:00:00Z');

type Arm = { name: string; tool: string; model?: string };
const CLAUDE: Arm = { name: 'claude', tool: 'claude', model: 'claude-opus-5-5' };
const CODEX: Arm = { name: 'codex', tool: 'codex' };

/**
 * An ended benchmark run of `suite`. `trials` lists each task's results on each arm, one per repetition, as
 * `{ task: { arm: [results] } }`; a task whose results are all absent had an invalid baseline.
 */
function run({ id, suite = 'fix-auth', version = 'v1', startedAt, username = 'alice', source = 'reported', arms = [CLAUDE, CODEX], trials, invalid = [], usage = {} }: {
  id: string;
  suite?: string;
  version?: string;
  startedAt: string;
  username?: string;
  source?: 'local' | 'reported';
  arms?: Arm[];
  trials: Record<string, Record<string, TrialResult[]>>;
  invalid?: string[];
  usage?: Record<string, { tokens: number; durationMs: number; cost?: number }>;
}): BenchmarkRunInput {
  const tasks = [...Object.keys(trials), ...invalid];
  let order = 0;
  return {
    run: id, source, username, startedAt,
    benchmark: {
      suite: { name: suite, sourceHash: version }, repetitions: 1, baselineTeamRevision: `team-${id}`, scorers: [],
      tasks: tasks.map((task) => ({ id: task, startingCommit: 'a'.repeat(40), sourceHash: `task-${task}`, baseline: invalid.includes(task) ? 'invalid' : 'valid' })),
      arms: arms.map((arm) => ({ ...arm, source: 'team', teamRevision: `team-${id}` })),
      trials: Object.entries(trials).flatMap(([task, byArm]) => Object.entries(byArm).flatMap(([arm, results]) => results.map((result, repetition) => {
        const spent = usage[arm];
        return {
          task, arm, repetition: repetition + 1, order: order++, step: `trials.r${repetition + 1}.${task}.${arm}.prompt`, result,
          ...(spent ? { tokens: { input: spent.tokens, output: 0 }, durationMs: spent.durationMs, ...(spent.cost === undefined ? {} : { cost: { amount: spent.cost, unit: 'USD' } }) } : {}),
        };
      }))),
    },
  };
}

describe('BenchmarkHistory', () => {
  it('lists each suite run in the window, newest run first, with its leading arm and its pass rate per run', () => {
    const runs = [
      run({ id: 'r1', startedAt: '2026-10-01T09:00:00Z', trials: { login: { claude: ['passed', 'failed'], codex: ['failed', 'failed'] } } }),
      run({ id: 'r2', startedAt: '2026-10-20T09:00:00Z', trials: { login: { claude: ['passed', 'passed'], codex: ['passed', 'failed'] } } }),
      run({ id: 'r3', suite: 'migrate-db', startedAt: '2026-10-25T09:00:00Z', arms: [CODEX], trials: { schema: { codex: ['passed'] }, seed: { codex: ['error'] } } }),
      run({ id: 'r0', startedAt: '2026-06-01T09:00:00Z', trials: { login: { claude: ['failed'], codex: ['failed'] } } }),
    ];

    const view = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW });

    expect(view.window).toEqual({ days: 90, from: '2026-07-30T12:00:00.000Z', to: '2026-10-28T12:00:00.000Z' });
    expect(view.suites).toEqual([
      { suite: 'migrate-db', runs: 1, lastRunAt: '2026-10-25T09:00:00Z', tasks: 2, arms: 1, leader: { arm: 'codex', passed: 1, planned: 2 }, trend: [{ run: 'r3', startedAt: '2026-10-25T09:00:00Z', passed: 1, planned: 2 }] },
      {
        suite: 'fix-auth', runs: 2, lastRunAt: '2026-10-20T09:00:00Z', tasks: 1, arms: 2, leader: { arm: 'claude', passed: 2, planned: 2 },
        trend: [{ run: 'r1', startedAt: '2026-10-01T09:00:00Z', passed: 1, planned: 4 }, { run: 'r2', startedAt: '2026-10-20T09:00:00Z', passed: 3, planned: 4 }],
      },
    ]);
  });

  // r1 ran suite version v1 with claude on another model; r2 and r3 ran v2, the current version.
  const history = [
    run({ id: 'r1', version: 'v1', startedAt: '2026-10-01T09:00:00Z', arms: [{ ...CLAUDE, model: 'claude-sonnet-5-5' }, CODEX], trials: { login: { claude: ['failed'], codex: ['failed'] } } }),
    run({
      id: 'r2', version: 'v2', startedAt: '2026-10-10T09:00:00Z', username: 'bob',
      trials: { login: { claude: ['passed', 'passed'], codex: ['passed', 'failed'] }, logout: { claude: ['passed'], codex: ['failed'] } },
      usage: { claude: { tokens: 1000, durationMs: 60_000, cost: 0.5 }, codex: { tokens: 400, durationMs: 30_000, cost: 0.1 } },
    }),
    run({
      id: 'r3', version: 'v2', startedAt: '2026-10-20T09:00:00Z', source: 'local',
      trials: { login: { claude: ['passed', 'failed'], codex: ['passed', 'passed'] }, logout: { claude: ['passed'], codex: ['failed'] } },
      usage: { claude: { tokens: 3000, durationMs: 120_000, cost: 1.5 }, codex: { tokens: 600, durationMs: 50_000, cost: 0.3 } },
    }),
  ];

  it("pools each arm of the suite's current version over its runs, with a 95% interval, and keeps every run of each arm as a point", () => {
    const view = BenchmarkHistory.of({ runs: history, query: { windowDays: 90 }, now: NOW });

    expect(view.selected?.suite).toBe('fix-auth');
    expect(view.selected?.versions).toEqual([
      { sourceHash: 'v2', runs: 2, firstRunAt: '2026-10-10T09:00:00Z', lastRunAt: '2026-10-20T09:00:00Z' },
      { sourceHash: 'v1', runs: 1, firstRunAt: '2026-10-01T09:00:00Z', lastRunAt: '2026-10-01T09:00:00Z' },
    ]);
    const arms = view.selected?.arms ?? [];
    expect(arms.map(({ arm, model, isCurrent, pooled, points }) => ({ arm, model, isCurrent, pooled: pooled && { passed: pooled.passed, planned: pooled.planned, runs: pooled.runs }, points: points.map(({ run: id, passed, planned }) => `${id} ${passed}/${planned}`) }))).toEqual([
      { arm: 'claude', model: 'claude-opus-5-5', isCurrent: true, pooled: { passed: 5, planned: 6, runs: 2 }, points: ['r2 3/3', 'r3 2/3'] },
      { arm: 'codex', model: undefined, isCurrent: true, pooled: { passed: 3, planned: 6, runs: 2 }, points: ['r1 0/1', 'r2 1/3', 'r3 2/3'] },
      { arm: 'claude', model: 'claude-sonnet-5-5', isCurrent: false, pooled: undefined, points: ['r1 0/1'] },
    ]);
    // Wilson score intervals: 5/6 is 43.6%–97.0%, 3/6 is 18.8%–81.2%.
    expect(arms[0]?.pooled?.low).toBeCloseTo(0.436, 3);
    expect(arms[0]?.pooled?.high).toBeCloseTo(0.970, 3);
    expect(arms[1]?.pooled?.low).toBeCloseTo(0.188, 3);
    expect(arms[1]?.pooled?.high).toBeCloseTo(0.812, 3);
    // Medians over every trial of the current version: claude ran three trials at 1000 tokens and three at 3000.
    expect(arms[0]?.usage).toEqual({
      tokens: { value: 2000, used: 6, components: ['input', 'output'] },
      durationMs: { value: 90_000, used: 6 },
      cost: { kind: 'known', amount: 6, unit: 'USD', used: 6 },
    });
  });

  it("gives each task of the current version its pass rate on each arm and in each run, and counts the runs where an arm's repetitions disagreed", () => {
    const view = BenchmarkHistory.of({ runs: history, query: { windowDays: 90 }, now: NOW });
    const [claude, codex] = view.selected?.arms ?? [];

    expect(view.selected?.tasks).toEqual([
      {
        task: 'login', disagreedRuns: 2, invalidRuns: 0,
        arms: [{ key: claude?.key, passed: 3, planned: 4 }, { key: codex?.key, passed: 3, planned: 4 }],
        runs: [{ run: 'r2', baseline: 'valid', passed: 3, planned: 4 }, { run: 'r3', baseline: 'valid', passed: 3, planned: 4 }],
      },
      {
        task: 'logout', disagreedRuns: 0, invalidRuns: 0,
        arms: [{ key: claude?.key, passed: 2, planned: 2 }, { key: codex?.key, passed: 0, planned: 2 }],
        runs: [{ run: 'r2', baseline: 'valid', passed: 1, planned: 2 }, { run: 'r3', baseline: 'valid', passed: 1, planned: 2 }],
      },
    ]);
  });

  it('counts the runs where a task could not be measured, since its check passed before any change', () => {
    const runs = [
      run({ id: 'r1', startedAt: '2026-10-10T09:00:00Z', trials: { login: { claude: ['passed'], codex: ['passed'] } }, invalid: ['old-bug'] }),
      run({ id: 'r2', startedAt: '2026-10-20T09:00:00Z', trials: { login: { claude: ['passed'], codex: ['failed'] }, 'old-bug': { claude: ['passed'], codex: ['passed'] } } }),
    ];

    const tasks = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected?.tasks ?? [];

    expect(tasks.map(({ task, invalidRuns, runs: perRun }) => ({ task, invalidRuns, runs: perRun.map(({ run: id, baseline }) => `${id} ${baseline}`) }))).toEqual([
      { task: 'login', invalidRuns: 0, runs: ['r1 valid', 'r2 valid'] },
      { task: 'old-bug', invalidRuns: 1, runs: ['r1 invalid', 'r2 valid'] },
    ]);
  });

  it('lists every run of the suite newest first, with who ran it, its version and team revision, and each arm in it, and the table of the newest', () => {
    const view = BenchmarkHistory.of({ runs: history, query: { windowDays: 90 }, now: NOW });
    const [claude, codex, sonnet] = view.selected?.arms ?? [];

    expect(view.selected?.runs).toEqual([
      { run: 'r3', source: 'local', startedAt: '2026-10-20T09:00:00Z', username: 'alice', sourceHash: 'v2', teamRevision: 'team-r3', passed: 4, planned: 6, invalidTasks: 0, arms: [{ key: claude?.key, passed: 2, planned: 3 }, { key: codex?.key, passed: 2, planned: 3 }] },
      { run: 'r2', source: 'reported', startedAt: '2026-10-10T09:00:00Z', username: 'bob', sourceHash: 'v2', teamRevision: 'team-r2', passed: 4, planned: 6, invalidTasks: 0, arms: [{ key: claude?.key, passed: 3, planned: 3 }, { key: codex?.key, passed: 1, planned: 3 }] },
      { run: 'r1', source: 'reported', startedAt: '2026-10-01T09:00:00Z', username: 'alice', sourceHash: 'v1', teamRevision: 'team-r1', passed: 0, planned: 2, invalidTasks: 0, arms: [{ key: sonnet?.key, passed: 0, planned: 1 }, { key: codex?.key, passed: 0, planned: 1 }] },
    ]);
    expect(view.selected?.latest.run).toBe('r3');
    expect(view.selected?.latest.table.matrix).toEqual([
      { task: 'login', arms: [{ arm: 'claude', passRate: { passed: 1, planned: 2 } }, { arm: 'codex', passRate: { passed: 2, planned: 2 } }] },
      { task: 'logout', arms: [{ arm: 'claude', passRate: { passed: 1, planned: 1 } }, { arm: 'codex', passRate: { passed: 0, planned: 1 } }] },
    ]);
  });

  it('opens the suite the query names, and the suite of the newest run otherwise', () => {
    const runs = [...history, run({ id: 'm1', suite: 'migrate-db', startedAt: '2026-10-25T09:00:00Z', arms: [CODEX], trials: { schema: { codex: ['passed'] } } })];

    expect(BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected?.suite).toBe('migrate-db');
    expect(BenchmarkHistory.of({ runs, query: { windowDays: 90, suite: 'fix-auth' }, now: NOW }).selected?.suite).toBe('fix-auth');
    expect(BenchmarkHistory.of({ runs, query: { windowDays: 30, suite: 'gone' }, now: NOW }).selected?.suite).toBe('migrate-db');
    expect(BenchmarkHistory.of({ runs: [], query: { windowDays: 30 }, now: NOW })).toEqual({ window: expect.any(Object), suites: [] });
  });
});
