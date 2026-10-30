/**
 * How a trial's steps become its result, and the benchmark record. Pure over an ended run: the step states
 * the engine keeps, with the result each check step output, the frozen plan, and the judge verdicts the run froze when
 * it ended (`run.verdicts`). It classifies nothing: `teamai benchmark check` did that once, when the check ran.
 *
 * Results are never failure codes, and no value here enters record `status` or `steps[].outcome`: an older dashboard
 * drops a whole record on an enum value it does not know.
 */
import path from 'node:path';
import { z } from 'zod';
import { AgentObservationSchema } from '../agent-observation.js';
import { RunOriginSchema } from '../default-workflows.js';
import type { EntryVerdict } from '../scorers/entry.js';
import type { StepState } from '../workflow/step-state.js';
import { LimitSchema } from '../workflow/requirements.js';
import type { RunState } from '../workflow/types.js';
import { CheckOutputSchema, type CheckResult } from './check.js';
import { baselineStepOf, correctnessScorerName, stepOf, type BenchmarkPlan, type PlannedTask, type PlannedTrial } from './plan.js';
import type { RunPlan } from './run-plan.js';
import { ArmTeamSchema, TrialLimitsSchema } from './terms.js';

export const TRIAL_RESULTS = ['passed', 'failed', 'error', 'unscored', 'not_run'] as const;
export type TrialResult = (typeof TRIAL_RESULTS)[number];

/** What trying a task's check on its clean starting commit showed. Only `valid` lets its trials run. */
const BASELINES = ['valid', 'invalid', 'could_not_run', 'not_run', 'not_needed'] as const;
export type Baseline = (typeof BASELINES)[number];

/** The not enforced requirements of a trial's prompt that the record keeps: those of the suite's limits. */
const UNENFORCED_LIMITS = ['max_turns', 'budget', 'on_limit'] as const;

/**
 * A benchmark's plan and trial results. A reader rebuilds the comparison from the record alone, after the suite left the
 * cache. No prompts, commands, credential URLs or local paths.
 */
export const BenchmarkRecordSchema = z.object({
  suite: z.object({ name: z.string(), sourceHash: z.string() }),
  repetitions: z.number().int(),
  /** The limits every trial's prompt ran under; absent when the suite set none. */
  limits: TrialLimitsSchema.optional(),
  baselineTeamRevision: z.string(),
  scorers: z.array(z.object({ name: z.string(), rubric: z.object({ sourceHash: z.string() }) })),
  tasks: z.array(z.object({ id: z.string(), startingCommit: z.string(), sourceHash: z.string(), baseline: z.enum(BASELINES) })),
  arms: z.array(z.object({
    name: z.string(), tool: z.string(), model: z.string().optional(), alias: z.string().optional(), effort: z.string().optional(),
    source: z.enum(['team', 'member']), team: ArmTeamSchema,
  })),
  trials: z.array(z.object({
    task: z.string(), arm: z.string(), repetition: z.number().int(), order: z.number().int(), step: z.string(),
    result: z.enum(TRIAL_RESULTS),
    /** The suite limit that ended the prompt; the check or judge still decided `result`. */
    limit: LimitSchema.optional(),
    /**
     * The suite limits the prompt's driver did not enforce, which make the trial a deviation: `on_limit` when the driver
     * could not end the turn at them at all.
     */
    unenforced: z.array(z.enum(UNENFORCED_LIMITS)).optional(),
    /** The prompt's, as its driver measured them around the tool launch and the tool stated them. */
    durationMs: z.number().int().nonnegative().optional(),
    /** `complete: false` when a pass of the trial stated none. */
    tokens: z.object({ input: z.number().optional(), output: z.number().optional(), cachedInput: z.number().optional(), complete: z.boolean() }).optional(),
    /** What the tool stated the prompt cost; absent when it stated none, never zero. `complete: false` when a pass of the trial stated none. */
    cost: z.object({ amount: z.number().nonnegative(), unit: z.string().min(1), complete: z.boolean() }).optional(),
    /** What the trial's prompt ran as, as teamai observed it; absent for a prompt that never reported. */
    agent: AgentObservationSchema.optional(),
    /** The team skills the trial loaded, each `loaded`, or `unknown` when a pass that did not load it went unobserved. */
    used: z.record(z.string().min(1), z.enum(['loaded', 'unknown'])).optional(),
    /** What this install's judge attempts on the trial stated they cost, failed ones included; `complete: false` when one stated none. */
    scoringCost: z.object({ amount: z.number().nonnegative(), unit: z.string().min(1), complete: z.boolean() }).optional(),
  })),
});
export type BenchmarkRecord = z.infer<typeof BenchmarkRecordSchema>;

/** A benchmark run's record: its plan's trials, classified, with the run they ran in. No prompt, command, URL or path. */
export const BenchmarkRunRecordSchema = BenchmarkRecordSchema.extend({
  schemaVersion: z.literal(1),
  run: z.string().min(1),
  /** How the run's steps ended, before its `finally` steps ran. */
  outcome: z.enum(['succeeded', 'failed', 'cancelled']),
  teamaiVersion: z.string().min(1),
  startedAt: z.string(),
  /** When the run's steps ended. */
  finishedAt: z.string(),
  username: z.string().optional(),
  /** The workflow the run ran: the team's `benchmark`, or teamai's default, by the hash of its bytes. */
  workflow: z.object({ name: z.string(), origin: RunOriginSchema, sourceHash: z.string() }),
});
export type BenchmarkRunRecord = z.infer<typeof BenchmarkRunRecordSchema>;

/** `runs/<run>/benchmark.json`: where a run's benchmark record is kept on this machine. */
export function benchmarkRecordFile(runsRoot: string, run: string): string {
  return path.join(runsRoot, run, 'benchmark.json');
}

/**
 * The block buildEndRecord adds for a benchmark run that has ended. Pure, so the `done` envelope and a run with
 * recording off get the same block a published record holds.
 */
export function benchmarkRecord(run: RunState, { plan, prefix }: RunPlan): BenchmarkRecord {
  const stateOf = (step: string): StepState | undefined => run.steps.find((state) => state.id === `${prefix}${step}`);
  const verdictsOf = (trial: PlannedTrial): EntryVerdict[] => {
    const pass = stateOf(trial.step)?.pass ?? 1;
    return (run.verdicts ?? []).filter((verdict) => verdict.step === `${prefix}${trial.step}` && verdict.pass === pass);
  };
  return {
    suite: { name: plan.suite.name, sourceHash: plan.suite.sourceHash },
    repetitions: plan.repetitions,
    ...(plan.limits ? { limits: plan.limits } : {}),
    baselineTeamRevision: plan.baselineTeamRevision,
    scorers: plan.scorers,
    tasks: plan.tasks.map((task) => ({ id: task.id, startingCommit: task.startingCommit, sourceHash: task.sourceHash, baseline: baselineOf(stateOf(baselineStepOf(task.id)), task) })),
    arms: plan.arms,
    trials: plan.trials.map((trial) => {
      const verdicts = verdictsOf(trial);
      const scoringCost = scoringCostOf(verdicts);
      const prompt = stateOf(trial.step);
      const result = trialResultOf({ prompt, check: stateOf(stepOf({ ...trial, kind: 'check' })), verdicts }, plan, trial);
      return { ...trial, step: `${prefix}${trial.step}`, result, ...promptEntryOf(prompt), ...(scoringCost ? { scoringCost } : {}) };
    }),
  };
}

/** The trial's judge costs in the unit the first one stated: incomplete when one stated none or another unit. */
function scoringCostOf(verdicts: readonly EntryVerdict[]): BenchmarkRecord['trials'][number]['scoringCost'] {
  const [first] = verdicts.flatMap(({ scoringCost }) => scoringCost ?? []);
  if (!first) return undefined;
  const inUnit = verdicts.flatMap(({ scoringCost }) => (scoringCost?.unit === first.unit ? [scoringCost] : []));
  return {
    amount: inUnit.reduce((sum, cost) => sum + cost.amount, 0),
    unit: first.unit,
    complete: inUnit.length === verdicts.length && inUnit.every((cost) => cost.complete),
  };
}

/** What a trial's prompt reported it spent, and the limits that ended or did not hold it: absent for a prompt that never settled a report. */
function promptEntryOf(prompt: StepState | undefined): Pick<BenchmarkRecord['trials'][number], 'limit' | 'unenforced' | 'durationMs' | 'tokens' | 'cost' | 'agent' | 'used'> {
  switch (prompt?.status) {
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'delivering': {
      const unenforced = (prompt.unenforced ?? []).flatMap(({ requirement }) => UNENFORCED_LIMITS.filter((limit) => limit === requirement));
      return {
        ...(prompt.limit ? { limit: prompt.limit } : {}),
        ...(unenforced.length > 0 ? { unenforced } : {}),
        ...(prompt.durationMs !== undefined ? { durationMs: prompt.durationMs } : {}),
        ...(prompt.tokens ? { tokens: { ...prompt.tokens, complete: true } } : {}),
        ...(prompt.cost ? { cost: { ...prompt.cost, complete: true } } : {}),
        ...(prompt.agent ? { agent: prompt.agent } : {}),
        ...(prompt.used ? { used: Object.fromEntries(prompt.used.skills.map((skill) => [skill, 'loaded' as const])) } : {}),
      };
    }
    case undefined:
    case 'pending':
    case 'waiting':
    case 'leased':
    case 'running':
    case 'skipped':
      return {};
    default: {
      const unhandled: never = prompt;
      return unhandled;
    }
  }
}

/**
 * A task's baseline, from the result its step output, first match wins:
 *   criteria task                                   -> not_needed: it has no check to try
 *   result failed                                   -> valid
 *   result passed                                   -> invalid: the check passes without changes
 *   result could_not_run, or failed without one     -> could_not_run: its clone or setup failed, or the check did not run
 *   cancelled once leased, without a result         -> could_not_run: the run ended while it ran, such as at its timeout
 *   no result otherwise                             -> not_run: no driver took it before the run ended
 * Its trials need no rule of their own: a task whose baseline is not valid skips them, and a skipped prompt is not_run.
 */
function baselineOf(state: StepState | undefined, task: PlannedTask): Baseline {
  switch (task.judge.kind) {
    case 'criteria':
      return 'not_needed';
    case 'check':
      break;
    default: {
      const unhandled: never = task.judge;
      return unhandled;
    }
  }
  const result = checkResultOf(state);
  switch (result) {
    case 'failed':
      return 'valid';
    case 'passed':
      return 'invalid';
    case 'could_not_run':
      return 'could_not_run';
    case undefined:
      return state?.status === 'failed' || (state?.status === 'cancelled' && state.attempt !== undefined) ? 'could_not_run' : 'not_run';
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}

/**
 * The result of one planned trial, first match wins:
 *   prompt never leased: absent, pending, skipped, or cancelled without an attempt  -> not_run
 *   prompt failed tool_unavailable: the run's only driver cannot launch its tool    -> not_run
 *   prompt cancelled after its lease, or failed                                     -> error
 *   check task: the result its check output: passed -> passed, failed -> failed, could_not_run -> error;
 *               no result (the check never ran to one)                              -> error
 *   criteria task: its correctness verdict: labelled passing -> passed, labelled not passing -> failed;
 *               unscored, or none                                                   -> unscored, never passed
 */
function trialResultOf({ prompt, check, verdicts }: { prompt: StepState | undefined; check: StepState | undefined; verdicts: readonly EntryVerdict[] }, plan: BenchmarkPlan, trial: PlannedTrial): TrialResult {
  switch (prompt?.status) {
    case undefined:
    case 'pending':
    case 'waiting':
    case 'skipped':
      return 'not_run';
    case 'cancelled':
      return prompt.attempt === undefined ? 'not_run' : 'error';
    case 'failed':
      return prompt.failure?.code === 'tool_unavailable' && prompt.attempt === undefined ? 'not_run' : 'error';
    case 'leased':
    case 'running':
    case 'delivering':
      return 'error';
    case 'succeeded':
      break;
    default: {
      const unhandled: never = prompt;
      return unhandled;
    }
  }
  const judge = plan.tasks.find((task) => task.id === trial.task)?.judge;
  switch (judge?.kind) {
    case 'check':
      return checkResult(check);
    case 'criteria':
      return criteriaResult(verdicts.find((verdict) => verdict.scorer === correctnessScorerName(trial.task)));
    case undefined:
      return 'unscored';
    default: {
      const unhandled: never = judge;
      return unhandled;
    }
  }
}

function criteriaResult(verdict: EntryVerdict | undefined): TrialResult {
  if (!verdict) return 'unscored';
  const { outcome } = verdict;
  switch (outcome.kind) {
    case 'labelled':
      return outcome.passed ? 'passed' : 'failed';
    case 'unscored':
      return 'unscored';
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

function checkResult(check: StepState | undefined): TrialResult {
  const result = checkResultOf(check);
  switch (result) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'could_not_run':
    case undefined:
      return 'error';
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}

/** The result a check step output; undefined when it output none, as one that never ran to a verdict. */
function checkResultOf(state: StepState | undefined): CheckResult | undefined {
  const output = CheckOutputSchema.safeParse(state && 'outputs' in state ? state.outputs : undefined);
  return output.success ? output.data.result : undefined;
}
