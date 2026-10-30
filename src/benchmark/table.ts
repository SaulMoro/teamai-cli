/**
 * The results and usage tables and the task by arm matrix: one pure function over an end record. The `done` envelope
 * of every `next` on an ended benchmark run carries them as `benchmark: { table, text }`, and the local driver prints
 * `text` when the run ends. It reads the record, not the run, so it works with recording off (buildEndRecord is pure)
 * and on a published record after the suite left the cache.
 */
import type { AgentObservation } from '../agent-observation.js';
import { isNativeModelAlias } from '../models/aliases.js';
import type { WorkflowRunRecord } from '../workflow/records.js';
import { TRIAL_RESULTS, type Baseline, type BenchmarkRecord, type TrialResult } from './result.js';

type RecordedArm = BenchmarkRecord['arms'][number];
type RecordedTrial = BenchmarkRecord['trials'][number];
type RecordedStep = NonNullable<WorkflowRunRecord['steps']>[number];

export interface ArmResults extends Pick<RecordedArm, 'tool' | 'model' | 'effort' | 'source' | 'team'> {
  arm: string;
  planned: number;
  counts: Record<TrialResult, number>;
  /** Trials whose prompt a limit of the suite's `trial` ended; their check or judge still decided them. In `planned`. */
  stoppedByLimit: number;
  /**
   * Trials whose prompt ran as something other than the arm: another tool, team revision, or concrete model, or without a
   * limit of the suite's `trial` its driver could not enforce. In `planned`.
   */
  deviations: number;
  /** Trials whose prompt ran, but whose record lacks a value the comparison needs, such as the model the tool reported. */
  notVerified: number;
  /** Absent with no planned trials. */
  passRate?: PassRate;
}

/** `passed / planned`, printed `67% (4/6)`. */
export interface PassRate {
  passed: number;
  planned: number;
}

/** A median that leaves unknown values out, and how many values it used. */
export interface Median {
  value?: number;
  used: number;
}

/** A total of the costs the tools stated. An unknown part is never zero: it makes the total incomplete. */
export type CostTotal =
  | { kind: 'known'; amount: number; unit: string; used: number }
  | { kind: 'incomplete'; amount: number; unit: string; used: number; unknown: number }
  /** Parts in more than one unit: not added up, since costs compare only within one unit. */
  | { kind: 'mixed'; units: string[] }
  /** No trial whose prompt ran stated a cost. */
  | { kind: 'unknown' };

export interface ArmUsage {
  arm: string;
  /** Input plus output tokens of each trial's prompt; `components` names what is added. */
  tokens: Median & { components: readonly ['input', 'output'] };
  /** Milliseconds around each trial's tool launch. */
  durationMs: Median;
  cost: CostTotal;
}

export interface BenchmarkTable {
  results: ArmResults[];
  usage: ArmUsage[];
  /** Each task's pass rate on each arm, tasks and arms in record order; a cell with no planned trials has no rate. */
  matrix: Array<{ task: string; arms: Array<{ arm: string; passRate?: PassRate }> }>;
  /** The tasks whose check, tried on the starting commit, did not fail there as the task expects: none of their trials ran. */
  invalid: Array<{ task: string; baseline: Extract<Baseline, 'invalid' | 'could_not_run'> }>;
}

/** A table as the text of its cells. */
export interface TextTable {
  header: string[];
  rows: string[][];
}

/** What formatBenchmarkTable prints, as cells, so the dashboard shows the text a terminal and a CI job summary show. */
export interface BenchmarkCells {
  results: TextTable;
  usage: TextTable;
  matrix: TextTable;
  /** Absent when every task's baseline let its trials run. */
  invalid?: TextTable;
  caption: string;
}

/** The sentence under every table. */
const BENCHMARK_CAPTION = 'These results hold for these tasks, this run and this machine.';

const RESULT_COLUMNS = { passed: 'Passed', failed: 'Failed', error: 'Error', unscored: 'Unscored', not_run: 'Not run' } as const satisfies Record<TrialResult, string>;
const INVALID_REASONS = { invalid: 'invalid: check passes without changes', could_not_run: 'check could not run' } as const satisfies Record<BenchmarkTable['invalid'][number]['baseline'], string>;
const TOKEN_COMPONENTS = ['input', 'output'] as const;

/** What benchmarkTable reads: an end record's benchmark block, and its step entries for what each prompt ran as. */
export interface BenchmarkTableInput {
  steps?: ReadonlyArray<Pick<RecordedStep, 'step' | 'agent'>>;
  benchmark: BenchmarkRecord;
}

/** A trial, and what its prompt ran as. Absent `ranAs`: its prompt did not run, as teamai observes every prompt a driver reported. */
export interface ObservedTrial {
  trial: RecordedTrial;
  ranAs?: AgentObservation;
}

/** Each trial of `record`, in record order, with what its prompt ran as: the trial's own, or its step entry's. */
export function observedTrials(record: BenchmarkTableInput): ObservedTrial[] {
  return record.benchmark.trials.map((trial) => {
    const agent = trial.agent ?? record.steps?.findLast((entry) => entry.step === trial.step)?.agent;
    return agent && 'v' in agent ? { trial, ranAs: agent } : { trial };
  });
}

/** The usage of `trials`: medians of what their tools stated, and the cost of the trials whose prompt ran. */
export function usageOf(trials: readonly ObservedTrial[]): Omit<ArmUsage, 'arm'> {
  return {
    tokens: { ...median(trials.flatMap(({ trial: { tokens } }) => (tokens?.input !== undefined && tokens.output !== undefined ? [tokens.input + tokens.output] : []))), components: TOKEN_COMPONENTS },
    durationMs: median(trials.flatMap(({ trial: { durationMs } }) => (durationMs !== undefined ? [durationMs] : []))),
    cost: costTotal(trials.flatMap(({ trial, ranAs }) => (ranAs ? [trial.cost] : []))),
  };
}

/** How many of `arm`'s `trials` ran as something other than the arm, and how many could not be compared with it. */
export function deviationsOf(arm: RecordedArm, trials: readonly ObservedTrial[]): Pick<ArmResults, 'deviations' | 'notVerified'> {
  const compared = trials.flatMap(({ trial, ranAs }) => (ranAs ? [trial.unenforced ? 'deviation' as const : compareAgent(arm, ranAs)] : []));
  return {
    deviations: compared.filter((comparison) => comparison === 'deviation').length,
    notVerified: compared.filter((comparison) => comparison === 'not_verified').length,
  };
}

export function benchmarkTable(record: BenchmarkTableInput): BenchmarkTable {
  const { arms, trials, tasks } = record.benchmark;
  const observed = observedTrials(record);
  return {
    invalid: tasks.flatMap(({ id, baseline }) => (baseline === 'invalid' || baseline === 'could_not_run' ? [{ task: id, baseline }] : [])),
    results: arms.map((arm) => {
      const own = trials.filter((trial) => trial.arm === arm.name);
      const count = (result: TrialResult): number => own.filter((trial) => trial.result === result).length;
      const counts = { passed: count('passed'), failed: count('failed'), error: count('error'), unscored: count('unscored'), not_run: count('not_run') } satisfies Record<TrialResult, number>;
      return {
        arm: arm.name, tool: arm.tool, ...(arm.model ? { model: arm.model } : {}), ...(arm.effort ? { effort: arm.effort } : {}), source: arm.source, team: arm.team,
        planned: own.length, counts,
        stoppedByLimit: own.filter((trial) => trial.limit !== undefined).length,
        ...deviationsOf(arm, observed.filter(({ trial }) => trial.arm === arm.name)),
        ...passRateOf(own),
      };
    }),
    matrix: tasks.map(({ id }) => ({
      task: id,
      arms: arms.map(({ name }) => ({ arm: name, ...passRateOf(trials.filter((trial) => trial.task === id && trial.arm === name)) })),
    })),
    usage: arms.map(({ name }) => ({ arm: name, ...usageOf(observed.filter(({ trial }) => trial.arm === name)) })),
  };
}

/** The results, the usage, the task by arm matrix, then the invalid tasks. A median or a total says in parentheses how many values it used. */
export function benchmarkCells(table: BenchmarkTable): BenchmarkCells {
  // Every arm on the pulled revision, as most suites run: the column would repeat one commit on every row.
  const namesTeam = table.results.some(({ team }) => team.kind !== 'pulled');
  return {
    results: {
      header: ['Arm', 'Tool', 'Model (source)', ...(namesTeam ? ['Team'] : []), 'Planned', ...TRIAL_RESULTS.map((result) => RESULT_COLUMNS[result]), 'Stopped by a limit', 'Deviations', 'Not verified', 'Pass rate'],
      rows: table.results.map((arm) => [
        arm.arm, arm.tool, `${arm.model ? [arm.model, ...(arm.effort ? [arm.effort] : [])].join(' ') : 'tool default'} (${arm.source})`, ...(namesTeam ? [formatTeam(arm.team)] : []), String(arm.planned),
        ...TRIAL_RESULTS.map((result) => String(arm.counts[result])), String(arm.stoppedByLimit), String(arm.deviations), String(arm.notVerified), formatPassRate(arm.passRate),
      ]),
    },
    usage: {
      header: ['Arm', `Median tokens (${TOKEN_COMPONENTS.join(' + ')})`, 'Median duration', 'Cost'],
      rows: table.usage.map(({ arm, tokens, durationMs, cost }) => [
        arm, formatMedian(tokens, (value) => String(Math.round(value))), formatMedian(durationMs, (value) => `${(value / 1000).toFixed(1)} s`), formatCost(cost),
      ]),
    },
    matrix: {
      header: ['Task', ...table.results.map(({ arm }) => arm)],
      rows: table.matrix.map(({ task, arms }) => [task, ...arms.map(({ passRate }) => formatPassRate(passRate))]),
    },
    ...(table.invalid.length > 0 ? { invalid: { header: ['Task', 'Baseline'], rows: table.invalid.map(({ task, baseline }) => [task, INVALID_REASONS[baseline]]) } } : {}),
    caption: BENCHMARK_CAPTION,
  };
}

/** benchmarkCells as Markdown pipe tables, so the same text reads in a terminal and renders in a CI job summary. */
export function formatBenchmarkTable(table: BenchmarkTable): string {
  const { results, usage, matrix, invalid, caption } = benchmarkCells(table);
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  const markdown = ({ header, rows }: TextTable): string => [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
  return [...[results, usage, matrix, ...(invalid ? [invalid] : [])].map(markdown), caption].join('\n\n');
}

function passRateOf(trials: readonly RecordedTrial[]): { passRate?: PassRate } {
  return trials.length > 0 ? { passRate: { passed: trials.filter(({ result }) => result === 'passed').length, planned: trials.length } } : {};
}

/** An arm's team assets: `pulled 62432de`, `main 1a2b3c4`, `62432de without fixer` or `none`. */
function formatTeam(team: RecordedArm['team']): string {
  switch (team.kind) {
    case 'pulled':
      return `pulled ${team.revision.slice(0, 7)}`;
    case 'ref':
      return `${team.ref} ${team.revision.slice(0, 7)}`;
    case 'without':
      return `${team.revision.slice(0, 7)} without ${team.skills.join(', ')}`;
    case 'none':
      return 'none';
    default: {
      const unhandled: never = team;
      return unhandled;
    }
  }
}

/** Divides before it multiplies, as the documented `jq` command does, so both round an exact half the same way. */
function formatPassRate(rate: PassRate | undefined): string {
  return rate ? `${Math.round((rate.passed / rate.planned) * 100)}% (${rate.passed}/${rate.planned})` : '-';
}

type Comparison = 'match' | 'deviation' | 'not_verified';

/**
 * How a trial's prompt ran against its arm, on the values that can be compared: the tool, the team revision, and the
 * model when the arm names a concrete model id. A value the record lacks is not verified; a deviation outweighs it. A
 * tool's own model selector such as `opus`, or the tool's default model, is not compared with the model id it reports.
 */
function compareAgent(arm: RecordedArm, observed: AgentObservation): Comparison {
  const compare = (intended: string, recorded: string | undefined, same = (left: string, right: string): boolean => left === right): Comparison => {
    if (recorded === undefined) return 'not_verified';
    return same(intended, recorded) ? 'match' : 'deviation';
  };
  const comparisons = new Set([
    compare(arm.tool, observed.tool.name),
    compareTeam(arm.team, observed.team),
    ...(arm.model !== undefined && !isNativeModelAlias(arm.model) ? [compare(arm.model, observed.model?.reported, sameModel)] : []),
  ]);
  if (comparisons.has('deviation')) return 'deviation';
  return comparisons.has('not_verified') ? 'not_verified' : 'match';
}

/**
 * Whether the prompt ran on its arm's team assets: the arm's revision, with the skills it runs without left out, or no
 * team assets at all. A trial of a team arm whose record names no team is not verified; one of an arm without team
 * assets that names one ran on them.
 */
function compareTeam(intended: RecordedArm['team'], recorded: AgentObservation['team']): Comparison {
  if (intended.kind === 'none') return recorded === undefined ? 'match' : 'deviation';
  if (recorded === undefined) return 'not_verified';
  if (recorded.revision !== intended.revision) return 'deviation';
  if (intended.kind !== 'without') return 'match';
  if (!recorded.selection) return 'not_verified';
  const excluded = new Set(recorded.selection.excludedSkills ?? []);
  return intended.skills.every((skill) => excluded.has(skill)) ? 'match' : 'deviation';
}

/**
 * A reported model id is the requested one, also with a provider in front of either or a release date after: `a/m`,
 * `m-20250805`, `m@2025-08-05`. Two ids that both name a provider name the same one.
 */
function sameModel(requested: string, reported: string): boolean {
  if (requested === reported) return true;
  const split = (model: string): { provider?: string; id: string } => {
    const slash = model.lastIndexOf('/');
    return slash < 0 ? { id: model } : { provider: model.slice(0, slash), id: model.slice(slash + 1) };
  };
  const asked = split(requested);
  const ran = split(reported);
  if (asked.provider !== undefined && ran.provider !== undefined && asked.provider !== ran.provider) return false;
  return ran.id === asked.id || (ran.id.startsWith(asked.id) && /^[-@]\d{4}-?\d{2}-?\d{2}$/.test(ran.id.slice(asked.id.length)));
}

function median(values: readonly number[]): Median {
  const sorted = [...values].sort((left, right) => left - right);
  const lower = sorted[Math.ceil(sorted.length / 2) - 1];
  const upper = sorted[Math.floor(sorted.length / 2)];
  return lower === undefined || upper === undefined ? { used: 0 } : { value: (lower + upper) / 2, used: sorted.length };
}

/** The total of `parts`, one per trial whose prompt ran: the cost it stated, or undefined when it stated none. */
function costTotal(parts: ReadonlyArray<RecordedTrial['cost']>): CostTotal {
  const known = parts.flatMap((part) => (part ? [part] : []));
  const units = [...new Set(known.map(({ unit }) => unit))].sort();
  const [unit, ...others] = units;
  if (unit === undefined) return { kind: 'unknown' };
  if (others.length > 0) return { kind: 'mixed', units };
  const amount = known.reduce((sum, part) => sum + part.amount, 0);
  const unknown = parts.length - known.length;
  return unknown > 0 ? { kind: 'incomplete', amount, unit, used: known.length, unknown } : { kind: 'known', amount, unit, used: known.length };
}

function formatMedian({ value, used }: Median, format: (value: number) => string): string {
  return value === undefined ? 'unknown (0)' : `${format(value)} (${used})`;
}

function formatCost(cost: CostTotal): string {
  const amount = (value: number): string => String(Math.round(value * 10_000) / 10_000);
  switch (cost.kind) {
    case 'known':
      return `${amount(cost.amount)} ${cost.unit} (${cost.used})`;
    case 'incomplete':
      return `${amount(cost.amount)} ${cost.unit} (${cost.used}), incomplete: ${cost.unknown} unknown`;
    case 'mixed':
      return `mixed units: ${cost.units.join(', ')}`;
    case 'unknown':
      return 'unknown (0)';
    default: {
      const unhandled: never = cost;
      return unhandled;
    }
  }
}
