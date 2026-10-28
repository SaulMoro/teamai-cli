/**
 * The dashboard's Benchmarks page: every ended benchmark run of a workspace, from this machine's run files and the
 * team's records, read as a history per suite. Pure over the runs' end records, so the page counts what `jq` over the
 * records counts: a pass rate is passed trials over planned trials, as the run's own table prints it.
 *
 * Runs of one suite compare only while the suite's files stay the same, so what the page pools (an arm's pass rate and
 * usage, the task by arm heatmap) covers the runs of the suite's current version, its `sourceHash` in the newest run.
 * Each run still shows as a point of its own.
 */
import type { Baseline, BenchmarkRecord } from './result.js';
import {
  benchmarkTable, deviationsOf, observedTrials, usageOf, type ArmResults, type ArmUsage, type BenchmarkTable, type BenchmarkTableInput, type ObservedTrial, type PassRate,
} from './table.js';

/** One ended benchmark run, as its end record holds it. `source`: this machine's run file, or the team's record. */
export interface BenchmarkRunInput {
  run: string;
  source: 'local' | 'reported';
  username?: string;
  startedAt: string;
  /** What each prompt ran as, which the run's table compares with its arm. */
  steps?: BenchmarkTableInput['steps'];
  benchmark: BenchmarkRecord;
}

/** The windows the page offers, in days before now, by when each run started. */
export const BENCHMARK_WINDOWS = [30, 90, 365] as const;

export interface BenchmarkHistoryQuery {
  windowDays: number;
  /** The suite to open; the suite of the newest run when absent or not run in the window. */
  suite?: string;
}

/** One run's pass rate. */
export type RunPoint = PassRate & { run: string; startedAt: string };

export interface SuiteSummary {
  suite: string;
  runs: number;
  lastRunAt: string;
  /** Of the newest run. */
  tasks: number;
  arms: number;
  /** The newest run's arm with the highest pass rate; the first in the suite's order on a tie. */
  leader?: PassRate & { arm: string };
  /** Each run's pass rate over all its trials, oldest first. */
  trend: RunPoint[];
}

/** A pass rate with its 95% Wilson score interval, which stays inside 0–1 and honest for a handful of trials. */
export type PooledRate = PassRate & { low: number; high: number; runs: number };

/** An arm over the runs of the current version, counted as each run's own table counts it. */
export type PooledArm = PooledRate & Pick<ArmResults, 'deviations' | 'notVerified'> & { usage: Omit<ArmUsage, 'arm'> };

/**
 * One arm as a configuration: its name, tool, model and effort. An arm whose model changed between runs is two series,
 * since its runs measured two things.
 */
export interface ArmSeries {
  key: string;
  arm: string;
  tool: string;
  model?: string;
  effort?: string;
  /** In the newest run of the suite. */
  isCurrent: boolean;
  /** Over the runs of the current version; absent for a configuration none of them ran. */
  pooled?: PooledArm;
  /** Each run of the configuration in the window, oldest first. */
  points: RunPoint[];
}

export interface SuiteVersion {
  sourceHash: string;
  runs: number;
  lastRunAt: string;
}

/** One task of the current version, over its runs. */
export interface TaskView {
  task: string;
  /** Each current configuration's pass rate on the task, in `arms` order; a configuration with no planned trial has none. */
  arms: Array<{ key: string } & Partial<PassRate>>;
  /** Each run of the current version, oldest first: what its baseline showed and the task's pass rate over every arm. */
  runs: Array<{ run: string; baseline: Baseline } & Partial<PassRate>>;
  /** Runs in which one arm both passed and did not pass the task: its repetitions disagreed, so one trial says little. */
  disagreedRuns: number;
  /** Runs that did not measure the task: see isMeasured. */
  unmeasuredRuns: number;
}

export interface SuiteView {
  suite: string;
  /** Newest first: the first is the current version. */
  versions: SuiteVersion[];
  /** Current configurations in the suite's order, then the others, the one run last first. */
  arms: ArmSeries[];
  /** The newest run's tasks, in its order. */
  tasks: TaskView[];
  /** Newest first. */
  runs: RunRow[];
  /** The newest run's own table, as it printed it. */
  latest: { run: string; source: BenchmarkRunInput['source']; table: BenchmarkTable };
}

/** One run of the suite. `teamRevision`: the team revision its trials installed team assets from. */
export interface RunRow extends PassRate {
  run: string;
  source: BenchmarkRunInput['source'];
  startedAt: string;
  username?: string;
  sourceHash: string;
  teamRevision: string;
  /** Tasks the run did not measure: see isMeasured. */
  unmeasuredTasks: number;
  /** Each arm of the run as a configuration, in the run's order. */
  arms: Array<{ key: string } & PassRate>;
}

export interface BenchmarkHistoryView {
  window: { from: string; to: string };
  /** Newest run first. */
  suites: SuiteSummary[];
  selected?: SuiteView;
}

type Trial = BenchmarkRecord['trials'][number];
type Arm = BenchmarkRecord['arms'][number];

const DAY_MS = 24 * 60 * 60 * 1000;
/** The normal quantile of a two-sided 95% interval. */
const Z = 1.96;

function passRate(trials: readonly Trial[]): PassRate {
  return { passed: trials.filter(({ result }) => result === 'passed').length, planned: trials.length };
}

/**
 * Whether a run measured a task: its baseline let the task's trials run. Otherwise its check passed before any change or
 * could not run, or the run ended before its baseline.
 */
function isMeasured(baseline: Baseline): boolean {
  return baseline === 'valid' || baseline === 'not_needed';
}

/** `left` beats `right` on pass rate, compared without division so 2/3 and 4/6 tie. */
function beats(left: PassRate, right: PassRate): boolean {
  return left.passed * right.planned > right.passed * left.planned;
}

/** The Wilson score interval of `passed` out of `planned`, planned above 0. */
function wilson({ passed, planned }: PassRate): { low: number; high: number } {
  const p = passed / planned;
  const z2 = Z * Z;
  const denominator = 1 + z2 / planned;
  const center = (p + z2 / (2 * planned)) / denominator;
  const margin = (Z * Math.sqrt((p * (1 - p)) / planned + z2 / (4 * planned * planned))) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function armKey({ name, tool, model, effort }: Pick<Arm, 'name' | 'tool' | 'model' | 'effort'>): string {
  return JSON.stringify([name, tool, model ?? null, effort ?? null]);
}

function leaderOf({ arms, trials }: BenchmarkRecord): SuiteSummary['leader'] {
  let leader: SuiteSummary['leader'];
  for (const { name } of arms) {
    const rate = passRate(trials.filter(({ arm }) => arm === name));
    if (rate.planned > 0 && (!leader || beats(rate, leader))) leader = { arm: name, ...rate };
  }
  return leader;
}

function summaryOf(suite: string, runs: readonly BenchmarkRunInput[], newest: BenchmarkRunInput): SuiteSummary {
  const leader = leaderOf(newest.benchmark);
  return {
    suite,
    runs: runs.length,
    lastRunAt: newest.startedAt,
    tasks: newest.benchmark.tasks.length,
    arms: newest.benchmark.arms.length,
    ...(leader ? { leader } : {}),
    trend: runs.map(({ run, startedAt, benchmark }) => ({ run, startedAt, ...passRate(benchmark.trials) })),
  };
}

function versionsOf(runs: readonly BenchmarkRunInput[]): SuiteVersion[] {
  const versions = new Map<string, SuiteVersion>();
  for (const { startedAt, benchmark } of runs) {
    const { sourceHash } = benchmark.suite;
    const seen = versions.get(sourceHash);
    versions.set(sourceHash, { sourceHash, runs: (seen?.runs ?? 0) + 1, lastRunAt: startedAt });
  }
  return [...versions.values()].sort((left, right) => right.lastRunAt.localeCompare(left.lastRunAt));
}

/** The runs of one suite in the window, oldest first: those of its current version, and the newest. */
interface SuiteRuns {
  runs: readonly BenchmarkRunInput[];
  current: readonly BenchmarkRunInput[];
  newest: BenchmarkRunInput;
}

function armsOf({ runs, current, newest }: SuiteRuns): ArmSeries[] {
  const configs = new Map<string, { arm: Arm; points: RunPoint[]; pooledTrials: ObservedTrial[]; pooledRuns: number; deviations: number; notVerified: number }>();
  for (const input of runs) {
    const isPooled = current.includes(input);
    const observed = isPooled ? observedTrials(input) : [];
    for (const arm of input.benchmark.arms) {
      const key = armKey(arm);
      const config = configs.get(key) ?? { arm, points: [], pooledTrials: [], pooledRuns: 0, deviations: 0, notVerified: 0 };
      config.points.push({ run: input.run, startedAt: input.startedAt, ...passRate(input.benchmark.trials.filter((trial) => trial.arm === arm.name)) });
      if (isPooled) {
        // Each run's arm is compared on its own team revision, as that run's table compares it.
        const own = observed.filter(({ trial }) => trial.arm === arm.name);
        const { deviations, notVerified } = deviationsOf(arm, own);
        config.pooledTrials.push(...own);
        config.pooledRuns += 1;
        config.deviations += deviations;
        config.notVerified += notVerified;
      }
      configs.set(key, config);
    }
  }
  const order = newest.benchmark.arms.map(armKey);
  const rank = (key: string, points: readonly RunPoint[]): [number, string] => {
    const index = order.indexOf(key);
    return [index < 0 ? order.length : index, index < 0 ? points.at(-1)?.startedAt ?? '' : ''];
  };
  return [...configs].sort(([leftKey, left], [rightKey, right]) => {
    const [leftRank, leftLast] = rank(leftKey, left.points);
    const [rightRank, rightLast] = rank(rightKey, right.points);
    return leftRank - rightRank || rightLast.localeCompare(leftLast);
  }).map(([key, { arm, points, pooledTrials, pooledRuns, deviations, notVerified }]) => {
    const pooled = passRate(pooledTrials.map(({ trial }) => trial));
    return {
      key, arm: arm.name, tool: arm.tool, ...(arm.model ? { model: arm.model } : {}), ...(arm.effort ? { effort: arm.effort } : {}),
      isCurrent: order.includes(key),
      ...(pooled.planned > 0 ? { pooled: { ...pooled, ...wilson(pooled), runs: pooledRuns, deviations, notVerified, usage: usageOf(pooledTrials) } } : {}),
      points,
    };
  });
}

/** `rate` as optional fields, absent when nothing was planned. */
function rateFields(rate: PassRate): Partial<PassRate> {
  return rate.planned > 0 ? rate : {};
}

function tasksOf({ current, newest }: SuiteRuns): TaskView[] {
  return newest.benchmark.tasks.map(({ id }) => {
    const trialsIn = (input: BenchmarkRunInput) => input.benchmark.trials.filter((trial) => trial.task === id);
    const runs = current.flatMap((input) => {
      const baseline = input.benchmark.tasks.find((task) => task.id === id)?.baseline;
      return baseline ? [{ input, baseline, trials: trialsIn(input) }] : [];
    });
    const disagreedRuns = runs.filter(({ input, trials }) => input.benchmark.arms.some(({ name }) => {
      const results = new Set(trials.filter((trial) => trial.arm === name).map(({ result }) => result));
      return results.has('passed') && (results.has('failed') || results.has('error'));
    })).length;
    return {
      task: id,
      arms: newest.benchmark.arms.map((arm) => ({
        key: armKey(arm),
        ...rateFields(passRate(runs.flatMap(({ input, trials }) => (input.benchmark.arms.some((ran) => armKey(ran) === armKey(arm)) ? trials.filter((trial) => trial.arm === arm.name) : [])))),
      })),
      runs: runs.map(({ input, baseline, trials }) => ({ run: input.run, baseline, ...rateFields(passRate(trials)) })),
      disagreedRuns,
      unmeasuredRuns: runs.filter(({ baseline }) => !isMeasured(baseline)).length,
    };
  });
}

function runRow({ run, source, startedAt, username, benchmark }: BenchmarkRunInput): RunRow {
  return {
    run, source, startedAt, ...(username ? { username } : {}),
    sourceHash: benchmark.suite.sourceHash,
    teamRevision: benchmark.baselineTeamRevision,
    ...passRate(benchmark.trials),
    unmeasuredTasks: benchmark.tasks.filter(({ baseline }) => !isMeasured(baseline)).length,
    arms: benchmark.arms.map((arm) => ({ key: armKey(arm), ...passRate(benchmark.trials.filter((trial) => trial.arm === arm.name)) })),
  };
}

export const BenchmarkHistory = {
  of({ runs, query, now }: { runs: readonly BenchmarkRunInput[]; query: BenchmarkHistoryQuery; now: Date }): BenchmarkHistoryView {
    const window = { from: new Date(now.getTime() - query.windowDays * DAY_MS).toISOString(), to: now.toISOString() };
    const inWindow = runs.filter(({ startedAt }) => startedAt >= window.from && startedAt <= window.to)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const bySuite = new Map<string, BenchmarkRunInput[]>();
    for (const input of inWindow) bySuite.set(input.benchmark.suite.name, [...bySuite.get(input.benchmark.suite.name) ?? [], input]);
    const suites = [...bySuite].flatMap(([suite, own]) => {
      const newest = own.at(-1);
      return newest ? [summaryOf(suite, own, newest)] : [];
    }).sort((left, right) => right.lastRunAt.localeCompare(left.lastRunAt));
    const chosen = suites.find(({ suite }) => suite === query.suite) ?? suites[0];
    const own = chosen ? bySuite.get(chosen.suite) ?? [] : [];
    const newest = own.at(-1);
    if (!chosen || !newest) return { window, suites };
    const suiteRuns = { runs: own, current: own.filter(({ benchmark }) => benchmark.suite.sourceHash === newest.benchmark.suite.sourceHash), newest };
    return {
      window,
      suites,
      selected: {
        suite: chosen.suite,
        versions: versionsOf(own),
        arms: armsOf(suiteRuns),
        tasks: tasksOf(suiteRuns),
        runs: own.map(runRow).toReversed(),
        latest: { run: newest.run, source: newest.source, table: benchmarkTable({ ...(newest.steps ? { steps: newest.steps } : {}), benchmark: newest.benchmark }) },
      },
    };
  },
} as const;
