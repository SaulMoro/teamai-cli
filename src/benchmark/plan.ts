/**
 * The frozen benchmark and the workflow it runs as. Pure, with zod and terms.ts as its only runtime imports, so
 * store.ts can parse `run.benchmark` with `BenchmarkPlanSchema` without pulling in the start shell.
 *
 * `freezePlan` turns a parsed suite and what start resolved into the `BenchmarkPlan` the run keeps in `run.benchmark`.
 * `compilePlan` turns the plan into an ordinary `WorkflowDefinition` the run keeps in `run.definition`, plus the generated
 * correctness scorers it keeps in `run.scorers`. Trials are generated steps, so limits, records, snapshot rules, scoring
 * and the dashboard read them as they read any step.
 *
 * The plan is the measurement (hashes, commits, arms, the ordered trial list). The definition is how it executes
 * (prompts, commands, the step graph). Neither restates the other.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isLabelShaped, isNameShaped } from '../agent-observation.js';
import type { PinnedScorer } from '../scorers/pin.js';
import type { WorkflowDefinition, WorkflowStep } from '../workflow/types.js';
import type { Suite, Task, TaskJudge } from './suite.js';
import type { CommittedSuite } from './trial.js';
import { CommitSchema, TeamSelectionSchema, type CloneTeam, type TeamSelection } from '../workflow/clone.js';
import { ArmTeamSchema, BenchmarkNameSchema, TRIAL_WITHHELD_ENV, TrialLimitsSchema, type Added, type ArmTeam, type PromptTerms, type TrialLimits } from './terms.js';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const PlannedArmSchema = z.object({
  name: BenchmarkNameSchema,
  /** Shaped like the names a record publishes, as start checks, so a run file that holds anything else reads as corrupt. */
  tool: z.string().refine(isLabelShaped),
  /** The model name the arm's alias resolved to at start, or its model name as written; absent: the tool's default. */
  model: z.string().refine(isNameShaped).optional(),
  /** The alias the suite named, when the model came from one: what arms on different tools share. */
  alias: z.string().refine(isNameShaped).optional(),
  effort: z.string().refine(isLabelShaped).optional(),
  /** Whose aliases resolved the model: the team's, or the member's with `--member-aliases`. */
  source: z.enum(['team', 'member']),
  /** The team assets the arm's trials get. */
  team: ArmTeamSchema,
}).strict();
export type PlannedArm = z.infer<typeof PlannedArmSchema>;

const PlannedTaskSchema = z.object({
  id: BenchmarkNameSchema,
  sourceHash: Sha256,
  startingCommit: CommitSchema,
  judge: z.enum(['check', 'criteria']),
}).strict();
export type PlannedTask = z.infer<typeof PlannedTaskSchema>;

const PlannedTrialSchema = z.object({
  order: z.number().int().positive(),
  repetition: z.number().int().positive(),
  task: BenchmarkNameSchema,
  arm: BenchmarkNameSchema,
  /** The trial's prompt step, `trials.r<repetition>.<task>.<arm>.prompt`: the record's step entry. */
  step: z.string().min(1),
}).strict();
export type PlannedTrial = z.infer<typeof PlannedTrialSchema>;

/**
 * What a run freezes at start. In PINNED (store.ts) so masking never rewrites it, parsed by RunProgressSchema so a
 * malformed plan makes the run corrupt rather than unplanned, and `drop` in RUN_RULES (snapshot.ts) because benchmark
 * runs are never published. No prompt, command, credential URL or local path: the record copies from it.
 */
export const BenchmarkPlanSchema = z.object({
  suite: z.object({ name: BenchmarkNameSchema, sourceHash: Sha256, repo: z.string().url() }).strict(),
  baselineTeamRevision: CommitSchema,
  selection: TeamSelectionSchema,
  /** The names every trial step withholds from setup, the tool and the check. */
  withhold: z.array(z.string()),
  repetitions: z.number().int().min(1).max(10),
  /** The suite's `trial`: the limits of every trial's prompt. */
  limits: TrialLimitsSchema.optional(),
  tasks: z.array(PlannedTaskSchema).nonempty(),
  arms: z.array(PlannedArmSchema).nonempty(),
  /** Every scorer that judges a trial, the generated correctness scorers included, with the rubric hash it was pinned with. */
  scorers: z.array(z.object({ name: z.string().min(1), rubric: z.object({ sourceHash: z.string().min(1) }).strict() }).strict()),
  trials: z.array(PlannedTrialSchema),
}).strict();
export type BenchmarkPlan = z.infer<typeof BenchmarkPlanSchema>;

/**
 * One trial per task x arm x repetition, ordered by repetition, then task in file-name order, then arm, with the arms
 * of repetition r rotated by r - 1 (A B C, B C A, C A B). The order is not a dependency: trials never need each other.
 */
export function trialsOf(tasks: readonly Pick<Task, 'id'>[], arms: readonly Pick<PlannedArm, 'name'>[], repetitions: number): PlannedTrial[] {
  const trials: PlannedTrial[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const shift = (repetition - 1) % arms.length;
    const rotated = [...arms.slice(shift), ...arms.slice(0, shift)];
    for (const task of tasks) {
      for (const arm of rotated) {
        trials.push({ order: trials.length + 1, repetition, task: task.id, arm: arm.name, step: stepOf({ repetition, task: task.id, arm: arm.name, kind: 'prompt' }) });
      }
    }
  }
  return trials;
}

/** `trials.r<repetition>.<task>.<arm>.<kind>`: real nested inline-workflow scopes, so locateStep walks them. */
export function stepOf({ repetition, task, arm, kind }: { repetition: number; task: string; arm: string; kind: 'prompt' | 'check' }): string {
  return `${trialCopyOf({ repetition, task, arm })}.${kind}`;
}

/** `baselines.<task>`: the step that tries a check task's check on its clean starting commit. */
export function baselineStepOf(task: string): string {
  return `${BASELINES}.${task}`;
}

/** `trials.r<repetition>.<task>.<arm>`: the step that opens the clone a trial's prompt and check share. */
export function trialCopyOf({ repetition, task, arm }: { repetition: number; task: string; arm: string }): string {
  return `${TRIALS}.r${repetition}.${task}.${arm}`;
}

export function freezePlan(input: {
  suite: Suite;
  baselineTeamRevision: string;
  selection: TeamSelection;
  arms: [PlannedArm, ...PlannedArm[]];
  /** The team scorers the suite lists, as start pinned them. */
  scorers: Record<string, PinnedScorer>;
}): BenchmarkPlan {
  const { suite } = input;
  const [first, ...rest] = suite.tasks;
  return {
    suite: { name: suite.name, sourceHash: suite.sourceHash, repo: suite.repo },
    baselineTeamRevision: input.baselineTeamRevision,
    selection: input.selection,
    withhold: [...TRIAL_WITHHELD_ENV],
    repetitions: suite.repetitions,
    ...(suite.trial ? { limits: suite.trial } : {}),
    tasks: [planned(first), ...rest.map(planned)],
    arms: input.arms,
    scorers: Object.entries({ ...input.scorers, ...correctnessScorers(suite) }).map(([name, pin]) => ({ name, rubric: { sourceHash: pin.sourceHash } })),
    trials: trialsOf(suite.tasks, input.arms, suite.repetitions),
  };
}

function planned(task: Task): PlannedTask {
  return { id: task.id, sourceHash: task.sourceHash, startingCommit: task.startingCommit, judge: task.judge.kind };
}

/**
 * The run's `sourceHash`: over the suite file's hash and each task file's, so editing any of them changes it. A plan
 * and a record's benchmark block give the same hash.
 */
export function runSourceHash({ suite, tasks }: { suite: Pick<BenchmarkPlan['suite'], 'sourceHash'>; tasks: ReadonlyArray<Pick<BenchmarkPlan['tasks'][number], 'id' | 'sourceHash'>> }): string {
  return createHash('sha256').update(JSON.stringify([suite.sourceHash, ...tasks.map((task) => [task.id, task.sourceHash])])).digest('hex');
}

const TRIALS = 'trials';
const BASELINES = 'baselines';

/** What a baseline outputs when its check ran to the end: `fails` lets its task's trials run, `passes` makes it invalid. */
export const BASELINE_OUTPUTS = ['passes', 'fails'] as const;

/** The end the generated workflow reaches once every trial step settled, whatever the trials' results. */
const SETTLED_END = 'settled';

/**
 * The generated workflow:
 *
 *   baselines                     inline (check tasks only); outputs { <task>: its baseline's output }
 *     <task>                      command check.run; workspace: a clone of the starting commit with team none;
 *                                 trial.kind baseline; output { baseline: passes | fails };
 *                                 trial.add: the files check.add writes before the check, from the fix and from the
 *                                 commit start made of the suite directory's files (`CommittedSuite`)
 *   trials                        inline; needs [baselines] and an `if` that reads it, when there are baselines
 *     r<rep>                      inline, one per repetition
 *       <task>                    inline; a check task's: if steps.baselines.outputs.<task> == 'fails'
 *         <arm>                   inline, needs [], workspace: a clone of the starting commit with the arm's team (opens
 *                                 the trial's clone), arms in rotated order
 *           prompt                workspace continue; tool and exact model: the arm's; trial.kind prompt;
 *                                 scorers { the suite's and the task's correctness scorer, required: true }
 *           check                 needs [prompt]; command check.run; workspace continue; trial.kind check (check tasks only)
 *   settled                       needs every scope above; an `if` that reads them; end: settled
 *   ends: { settled: succeeded }  timeout: suite.timeoutMs; setup: suite.setup
 *
 * Why it holds, in engine terms:
 * - A trial's stopped step stops only its own `<arm>` scope. Siblings have no `needs` on each other, so a failed trial
 *   never skips another.
 * - `trials` needs `baselines`, so it starts once every baseline settled, and its `if` reads it, so a failed baseline
 *   does not skip it. A baseline that passes, or could not run and so has no output, makes its task's `if` false: that
 *   task's trials are skipped, which reads `not_run`.
 * - `settled` is end-only, never leased. Its `if` reads its needs, so a stopped scope does not skip it, and its end
 *   maps to `succeeded`. Timeout, limits and cancel still end the run as they end any run.
 * - `<arm>` needs nothing, so its copy grows from no step, where an omitted `needs` would grow it from the baselines.
 * - `<arm>` opens the clone, so prompt and check share it by ancestry, and copy ownership keeps the check on the driver
 *   that ran the prompt.
 * - The prompt carries the arm's `tool` and its exact `model`, so a trial never goes through alias resolution.
 */
export function compilePlan(plan: BenchmarkPlan, { suite, files }: CommittedSuite): { definition: WorkflowDefinition; scorers: Record<string, PinnedScorer> } {
  const tasks = new Map(suite.tasks.map((task) => [task.id, task]));
  const baselines = suite.tasks.flatMap((task): WorkflowStep[] => (task.judge.kind === 'check'
    ? [{
      id: task.id, command: task.judge.run, workspace: { clone: { commit: task.startingCommit, repo: suite.repo, team: { treatment: 'none' } } },
      output: { type: 'object', fields: { baseline: { type: 'enum', values: [...BASELINE_OUTPUTS] } } },
      trial: { kind: 'baseline', task: task.id, ...addTerm(task.judge, files.get(task.id)) },
    }]
    : []));
  const arms = new Map(plan.arms.map((arm) => [arm.name, arm]));
  const repetitions = [...new Set(plan.trials.map((trial) => trial.repetition))].map((repetition): WorkflowStep => {
    const ofRepetition = plan.trials.filter((trial) => trial.repetition === repetition);
    const taskSteps = [...new Set(ofRepetition.map((trial) => trial.task))].flatMap((id): WorkflowStep[] => {
      const task = tasks.get(id);
      if (!task) return [];
      const armSteps = ofRepetition.filter((trial) => trial.task === id).flatMap((trial): WorkflowStep[] => {
        const arm = arms.get(trial.arm);
        return arm ? [{
          id: arm.name, needs: [], workspace: { clone: { commit: task.startingCommit, repo: suite.repo, team: cloneTeamOf(arm.team, plan.selection) } },
          workflow: { steps: trialSteps(plan, suite, trial, arm, task, files.get(task.id)) },
        }] : [];
      });
      return [{ id, ...(task.judge.kind === 'check' ? { if: `steps.${BASELINES}.outputs.${id} == 'fails'` } : {}), workflow: { steps: armSteps } }];
    });
    return { id: `r${repetition}`, workflow: { steps: taskSteps } };
  });
  const tried = baselines.length > 0;
  const scopes: WorkflowStep[] = [
    ...(tried ? [{ id: BASELINES, workflow: { outputs: Object.fromEntries(baselines.map(({ id }) => [id, `steps.${id}.outputs.baseline`])), steps: baselines } }] : []),
    { id: TRIALS, ...(tried ? { needs: [BASELINES], if: `steps.${BASELINES}.outcome != null` } : {}), workflow: { steps: repetitions } },
  ];
  const needs = scopes.map(({ id }) => id);
  return {
    definition: {
      schemaVersion: 'v1alpha1',
      name: suite.name,
      description: suite.description ?? `Benchmark suite ${suite.name}`,
      // `start --benchmark` checks no agent evidence, so a resume does not either: an agent continues a run it may start.
      invoke: 'allow',
      timeout: suite.timeoutMs,
      ...(suite.setup ? { setup: suite.setup } : {}),
      ends: { [SETTLED_END]: 'succeeded' },
      steps: [...scopes, { id: SETTLED_END, needs, if: needs.map((id) => `steps.${id}.outcome != null`).join(' && '), end: SETTLED_END }],
    },
    scorers: correctnessScorers(suite),
  };
}

/** What check.add writes before a check of `judge`: its fix's files, then `checkFiles`, the suite directory's as committed. */
export function addedOf(judge: Extract<TaskJudge, { kind: 'check' }>, checkFiles: Added | undefined): Added[] {
  return [...(judge.add ? [{ kind: 'fix' as const, ...judge.add }] : []), ...(checkFiles ? [checkFiles] : [])];
}

/** A check step's `add` term, absent when check.add writes nothing. */
function addTerm(judge: Extract<TaskJudge, { kind: 'check' }>, checkFiles: Added | undefined): { add?: [Added, ...Added[]] } {
  const [first, ...rest] = addedOf(judge, checkFiles);
  return first ? { add: [first, ...rest] } : {};
}

function trialSteps(plan: BenchmarkPlan, suite: Suite, trial: PlannedTrial, arm: PlannedArm, task: Task, checkFiles: Added | undefined): WorkflowStep[] {
  const names = [...suite.scorers, ...(task.judge.kind === 'criteria' ? [correctnessScorerName(task.id)] : [])];
  const prompt: WorkflowStep = {
    id: 'prompt', prompt: task.prompt, workspace: 'continue', tool: arm.tool,
    ...(arm.model ? { model: { name: arm.model, ...(arm.effort ? { effort: arm.effort } : {}) } } : {}),
    trial: promptTerms(trial, arm, task),
    ...turnLimitsOf(plan.limits),
    ...(names.length > 0 ? { scorers: { names, required: true } } : {}),
  };
  switch (task.judge.kind) {
    case 'check':
      return [prompt, {
        id: 'check', needs: ['prompt'], command: task.judge.run, workspace: 'continue',
        trial: {
          kind: 'check', task: task.id, startingCommit: task.startingCommit, arm: arm.name, repetition: trial.repetition, order: trial.order, protect: task.judge.protect,
          ...addTerm(task.judge, checkFiles),
        },
      }];
    case 'criteria':
      return [prompt];
    default: {
      const unhandled: never = task.judge;
      return unhandled;
    }
  }
}

function promptTerms(trial: PlannedTrial, arm: PlannedArm, task: Task): PromptTerms {
  return { kind: 'prompt', task: task.id, arm: arm.name, repetition: trial.repetition, order: trial.order };
}

/** A trial prompt's limits, the suite's `trial`: each ends the agent's turn, and the trial's check or judge decides it. */
function turnLimitsOf(limits: TrialLimits | undefined): Pick<WorkflowStep, 'timeout' | 'maxTurns' | 'budget' | 'onLimit'> {
  if (!limits) return {};
  return {
    ...(limits.timeoutMs !== undefined ? { timeout: limits.timeoutMs } : {}),
    ...(limits.maxTurns !== undefined ? { maxTurns: limits.maxTurns } : {}),
    ...(limits.tokens !== undefined ? { budget: { tokens: limits.tokens } } : {}),
    onLimit: 'end_turn',
  };
}

/** The team a trial's clone installs: the arm's, with the run's asset selection. */
function cloneTeamOf(team: ArmTeam, selection: TeamSelection): CloneTeam {
  switch (team.kind) {
    case 'none':
      return { treatment: 'none' };
    case 'pulled':
      return { revision: team.revision, selection, treatment: 'pulled' };
    case 'ref':
      return { revision: team.revision, selection, treatment: team.ref };
    case 'without':
      return { revision: team.revision, selection, treatment: { without: team.skills } };
    default: {
      const unhandled: never = team;
      return unhandled;
    }
  }
}

/**
 * The scorer that labels a task judged by success criteria `correct` or `incorrect` on each of its trials. Its name has a
 * ":", which no scorer file name may have, so no team scorer can take it, and one per task keeps one pin per name.
 */
export function correctnessScorerName(task: string): string {
  return `teamai:correctness:${task}`;
}

/**
 * The correctness scorer of each task judged by success criteria, as the run pins it: `generated`, so it is read as
 * `scorers/correctness.md` and named by its key, and `relativePath` is the task file, so a message names a file that
 * exists. Its hash covers the task's prompt and success criteria. No `model`: the judge tool's default model runs it.
 */
function correctnessScorers(suite: Suite): Record<string, PinnedScorer> {
  return Object.fromEntries(suite.tasks.flatMap((task) => (task.judge.kind === 'criteria' ? [[correctnessScorerName(task.id), correctnessPin(task, task.judge.successCriteria)]] : [])));
}

function correctnessPin(task: Task, successCriteria: string): PinnedScorer {
  const content = [
    '---',
    'labels:',
    '  - { value: correct, score: 1, description: The change meets every success criterion. }',
    '  - { value: incorrect, score: 0, description: The change misses at least one success criterion. }',
    'passingScore: 1',
    'samplingRate: 100',
    '---',
    'Judge whether the change made from the starting commit, commits included, meets the success criteria.',
    'Read the task to understand the intent. Decide only on the success criteria.',
    '',
    '## Task',
    '',
    task.prompt,
    '',
    '## Success criteria',
    '',
    successCriteria,
    '',
  ].join('\n');
  return { sourceHash: createHash('sha256').update(content).digest('hex'), relativePath: task.relativePath, content, generated: true };
}
