import { createHash, randomBytes } from 'node:crypto';
import { acquireLock, releaseLock } from '../update.js';
import type { LocalConfig } from '../types.js';
import { loadCachedWorkflow, workflowsRunBy } from './cache.js';
import {
  evaluateExpression, expressionPaths, isRecord, isTruthy, parseExpression, resolvePath,
  type Expression, type ExpressionPath, type ExpressionStep, type VisibleOutcome,
} from './expression.js';
import { outputMismatch } from './output.js';
import { noteRunRecord, runRecordState } from './records.js';
import {
  parseTemplate, renderStrings, renderText, stepExpressions, templatedTexts, templatePaths,
  type StepExpression, type TemplateContext, type TemplateError,
} from './template.js';
import { parseStepPath } from './step-path.js';
import { cancel, fail, lease, release, settled, skip, start, stopped, succeed, type LeasedStep, type StepState } from './step-state.js';
import { decideRound, decideStepLoop, exhaustedAtStart, firstPass, loopSettled, passesOf, previousPass, stepLoops, type StepLoops } from './loop.js';
import { generateRunId, isRunId, readRun, runLockPath, writeRun } from './store.js';
import type {
  CachedWorkflow,
  DriverIdentity,
  InlineWorkflow,
  OutputSchema,
  RunState,
  RunStatus,
  StepOutcome,
  TokenUsage,
  WorkflowDefinition,
  WorkflowEnvelope,
  WorkflowFailure,
  WorkflowStep,
} from './types.js';
import { hasAction } from './types.js';

const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 25;

/**
 * Recent settled attempt ids kept for `repeated_report`.
 * Older ids are no longer listed; revision and the active lease still reject them.
 */
export const SETTLED_ATTEMPTS_LIMIT = 32;

export interface ReportInput {
  attempt: string;
  revision: number;
  outcome: StepOutcome;
  driver: DriverIdentity;
  outputs?: unknown;
  exitCode?: number;
  message?: string;
  tool?: string;
  model?: string;
  session?: string;
  tokens?: TokenUsage;
  failure?: WorkflowFailure;
}

function error(code: string, message: string): WorkflowEnvelope {
  return { error: { code, message } };
}

function ok(value: Record<string, unknown>): WorkflowEnvelope {
  return { data: value };
}

function sameDriver(left: DriverIdentity, right: DriverIdentity): boolean {
  return left.kind === right.kind && left.machine === right.machine && left.workspace === right.workspace;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRun<T extends WorkflowEnvelope>(
  config: LocalConfig,
  runId: string,
  mutate: (run: RunState, now: string) => Promise<{ envelope: T; save: boolean }>,
): Promise<T> {
  if (!isRunId(runId)) return error('invalid_run', 'Run id must look like r followed by 8 or 16 hex digits') as T;
  const lock = runLockPath(config, runId);
  let held = false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !held; attempt += 1) {
    held = await acquireLock(lock);
    if (!held) await delay(LOCK_WAIT_MS);
  }
  if (!held) return error('busy', `Run ${runId} is locked by another process`) as T;
  try {
    const loaded = await readRun(config, runId);
    if (loaded === 'missing') return error('run_not_found', `Run ${runId} was not found`) as T;
    if (loaded === 'corrupt') return error('run_unreadable', `Run ${runId} could not be read`) as T;
    // One timestamp per operation, so a settled run's end record and its run file agree.
    const now = new Date().toISOString();
    const result = await mutate(loaded, now);
    if (result.save) {
      loaded.updatedAt = now;
      await writeRun(config, loaded);
    }
    return result.envelope;
  } finally {
    await releaseLock(lock);
  }
}

interface RenderedLease {
  prompt?: string;
  env?: Record<string, string>;
}

/** A workflow inside a run: the top-level one, or the sub-workflow a step runs. */
interface Scope {
  /** What every step path inside it starts with: '' at the top, `<workflow step path>.` inside a sub-workflow. */
  prefix: string;
  definition: WorkflowDefinition | InlineWorkflow;
  inputs: Record<string, unknown> | undefined;
  /** For an inline workflow: the enclosing workflows' steps, by id, which its own steps hide. */
  outer?: Record<string, ExpressionStep>;
  loops: StepLoops;
  /** The step that runs this workflow, which keeps its round. The top-level workflow keeps its round on the run. */
  runner?: StepState;
}

function topScope(run: RunState): Scope {
  return { prefix: '', definition: run.definition, inputs: run.inputs, loops: stepLoops(run.definition.steps) };
}

/**
 * The scope of the workflow a step runs, or undefined when the run did not keep that workflow.
 * An inline workflow reads the inputs and the steps of the workflow `scope` around it.
 */
function childScope(run: RunState, scope: Scope, states: StepState[], state: StepState, step: WorkflowStep): Scope | undefined {
  if (typeof step.workflow === 'object') {
    return {
      prefix: `${state.id}.`, definition: step.workflow, inputs: scope.inputs, outer: expressionSteps(scope, states, state),
      loops: stepLoops(step.workflow.steps), runner: state,
    };
  }
  const definition = step.workflow === undefined ? undefined : run.workflows?.[step.workflow];
  return definition && { prefix: `${state.id}.`, definition, inputs: state.inputs, loops: stepLoops(definition.steps), runner: state };
}

function workflowLabel(scope: Scope): string {
  return 'name' in scope.definition ? `workflow "${scope.definition.name}"` : `step "${scope.prefix.slice(0, -1)}" inline workflow`;
}

/** The step instances directly inside a scope, in declaration order. A `for_each` item such as `build[0]` is not one. */
function statesIn(run: RunState, scope: Scope): StepState[] {
  return run.steps.filter((state) => {
    if (!state.id.startsWith(scope.prefix)) return false;
    const segments = parseStepPath(state.id.slice(scope.prefix.length));
    return segments.length === 1 && segments[0]?.index === undefined;
  });
}

/** The step id an instance has inside its own workflow. */
function localId(scope: Scope, state: StepState): string {
  const [segment] = parseStepPath(state.id.slice(scope.prefix.length));
  return segment?.id ?? state.id;
}

/** The scope and definition of the step instance at `path`, or undefined when the run file does not describe it. */
export function locateStep(run: RunState, path: string): { scope: Scope; step: WorkflowStep } | undefined {
  let scope = topScope(run);
  const segments = parseStepPath(path);
  for (const [index, segment] of segments.entries()) {
    const step = scope.definition.steps.find((item) => item.id === segment.id);
    if (!step) return undefined;
    if (index === segments.length - 1) return { scope, step };
    const instance = `${scope.prefix}${segment.id}${segment.index === undefined ? '' : `[${segment.index}]`}`;
    const state = run.steps.find((item) => item.id === instance);
    const child = state && childScope(run, scope, statesIn(run, scope), state, step);
    if (!child) return undefined;
    scope = child;
  }
  return undefined;
}

/** A step's `with` holds a template that does not parse. Pull rejects one, so the run file was changed. */
function withTemplateFailure(state: StepState, error: TemplateError): WorkflowFailure {
  return { code: 'invalid_template', message: `step "${state.id}" with template ${error.source}: ${error.message}` };
}

/**
 * Renders a step's prompt and env from its workflow's inputs and settled steps only,
 * so a repeated `next` for the same attempt renders the same text.
 * Pull rejects a template that does not parse, so a failure here means the run file was changed.
 */
function renderLease(scope: Scope, states: StepState[], state: StepState, definition: WorkflowStep): RenderedLease | WorkflowFailure {
  const context: TemplateContext = { inputs: scope.inputs, steps: expressionSteps(scope, states, state) };
  // A prompt step's `with` renders first, by the same rules as a workflow step's; its prompt reads it as `with.<name>`.
  if (definition.with !== undefined) {
    const values = renderStrings(definition.with, context);
    if (!values.ok) return withTemplateFailure(state, values.error);
    context.with = values.value;
  }
  const rendered = new Map<string, string>();
  for (const { what, text } of templatedTexts(definition)) {
    if (what.startsWith('with.')) continue;
    const parsed = parseTemplate(text);
    if (!parsed.ok) {
      const [problem] = parsed.errors;
      return { code: 'invalid_template', message: `step "${state.id}" ${what} template ${problem?.source}: ${problem?.message}` };
    }
    rendered.set(what, renderText(parsed.template, context));
  }
  const env = Object.keys(definition.env ?? {}).map((name) => [name, rendered.get(`env.${name}`) ?? ''] as const);
  return {
    ...(rendered.has('prompt') ? { prompt: rendered.get('prompt') } : {}),
    ...(definition.env ? { env: Object.fromEntries(env) } : {}),
  };
}

function leaseData(run: RunState, state: LeasedStep, definition: WorkflowStep, rendered: RenderedLease): Record<string, unknown> {
  return { lease: {
    run: run.id,
    step: state.id,
    attempt: state.lease.attempt,
    revision: state.lease.revision,
    pass: state.pass ?? 1,
    ...(definition.command !== undefined ? { command: definition.command } : {}),
    ...(rendered.env ? { env: rendered.env } : {}),
    ...(rendered.prompt !== undefined ? { prompt: rendered.prompt } : {}),
    ...(definition.agent !== undefined ? { agent: definition.agent } : {}),
    ...(definition.output ? { output: definition.output } : {}),
  } };
}

/**
 * Fails a step the engine cannot hand out, so the rest of the graph keeps settling. Like a skip, it does not bump
 * `revision`. `settledAt` is when the step became ready, so that time does not depend on when `next` ran.
 */
function failStep(step: StepState, failure: WorkflowFailure, settledAt: number): void {
  fail(step, { settledAt, message: failure.message, failure });
}

/** The status of a run, or of a workflow inside it, once it has settled. */
type FinalRunStatus = Exclude<RunStatus, 'running'>;

/**
 * How a workflow of the run settled: its outcome, the end it reached, and the outputs it returns. `settledAt` is
 * when it settled: that of its winning end, or else the latest of its steps.
 */
interface WorkflowResult {
  outcome: FinalRunStatus;
  end?: string;
  outputs?: Record<string, unknown>;
  settledAt: number;
  /** Why a workflow that reached no failed end failed, such as `loop_exhausted`. */
  failure?: WorkflowFailure;
}

/** The revision a step settled at, which orders the ends a workflow reaches; 0 for a step that has none, such as a skipped one. */
function settledAtOf(step: StepState | undefined): number {
  return step && 'settledAt' in step ? step.settledAt : 0;
}

/**
 * Ends the run. Every path that settles a run goes through here, so anything that reacts to a settled run hooks in here.
 * Returns a copy of the settled run for the end record, which publishes after the run lock is released (#1126).
 */
function settleRun(run: RunState, now: string, { outcome, end, failure }: WorkflowResult): RunState {
  run.status = outcome;
  if (end !== undefined) run.end = end;
  if (failure) run.failure = failure;
  run.updatedAt = now;
  return { ...run, steps: run.steps.map((step) => ({ ...step })) };
}

function doneData(run: RunState): Record<string, unknown> {
  return { done: { run: run.id, outcome: run.status, ...(run.end !== undefined ? { end: run.end } : {}), ...(run.failure ? { failure: run.failure } : {}) } };
}

/** A step with `end` and no action only ends the workflow; the engine settles it without a lease. */
function endsOnly(step: WorkflowStep | undefined): boolean {
  return step?.end !== undefined && !hasAction(step);
}

/** The step ids these paths read. */
function stepsRead(paths: ExpressionPath[]): Set<string> {
  return new Set(paths.flatMap((path) => (path.root === 'steps' ? [path.step] : [])));
}

/**
 * The step ids a step reads in its expressions and templates, and, when it runs an inline workflow, the ids that
 * workflow's steps read outside it, at any depth. A `loop.while` or `break` that reads its own step reads it after it
 * ran, so the step is left out. An expression or template that does not parse reads nothing here; settling its own
 * workflow reports it.
 */
function readsOf(step: WorkflowStep): Set<string> {
  const paths = [
    ...stepExpressions(step).flatMap(({ source }) => {
      const parsed = parseExpression(source);
      return parsed.ok ? expressionPaths(parsed.expression) : [];
    }),
    ...templatedTexts(step).flatMap(({ text }) => {
      const template = parseTemplate(text);
      return template.ok ? templatePaths(template.template) : [];
    }),
  ];
  const ids = stepsRead(paths);
  if (typeof step.workflow === 'object') {
    const own = new Set(step.workflow.steps.map((item) => item.id));
    for (const item of step.workflow.steps) for (const id of readsOf(item)) if (!own.has(id)) ids.add(id);
  }
  ids.delete(step.id);
  return ids;
}

interface RunReads {
  /** Each step's parsed `if`. */
  conditions: Map<string, Expression>;
  /** Each loop owner's parsed `loop.while`. */
  whiles: Map<string, Expression>;
  /** Each step's parsed `break`. */
  breaks: Map<string, Expression>;
  /** The step ids each step's `if` and templates read. */
  reads: Map<string, Set<string>>;
  /** The loop owners each step waits for besides what it needs and reads. */
  waits: Map<string, string[]>;
  /** The path each declared output reads. */
  outputs: Map<string, ExpressionPath>;
  /** The workflow's own parsed `loop.while`. */
  loopWhile?: Expression;
}

/** Parses every `if` and template in a workflow of the run. A run file whose `if` does not parse cannot settle; the message names the step. */
function parseReads(run: RunState, scope: Scope): RunReads | string {
  const conditions = new Map<string, Expression>();
  const whiles = new Map<string, Expression>();
  const breaks = new Map<string, Expression>();
  const reads = new Map<string, Set<string>>();
  const waits = new Map<string, string[]>();
  const parsedInto: Record<StepExpression['what'], Map<string, Expression>> = { if: conditions, 'loop.while': whiles, break: breaks };
  const own = new Set(scope.definition.steps.map((step) => step.id));
  for (const step of scope.definition.steps) {
    for (const { what, source } of stepExpressions(step)) {
      const parsed = parseExpression(source);
      if (!parsed.ok) return `Run ${run.id} step "${scope.prefix}${step.id}" has ${what === 'if' ? 'an' : 'a'} ${what} that does not parse: ${parsed.message}`;
      parsedInto[what].set(step.id, parsed.expression);
    }
    // A template that does not parse reads nothing; the step fails when it would be leased.
    // An inline workflow's reads of enclosing steps settled before it started, so only its own steps are waited for.
    // A read of a step's previous pass never waits.
    const previous = scope.loops.previous(step.id);
    const read = new Set([...readsOf(step)].filter((id) => (!scope.outer || own.has(id)) && !previous.has(id)));
    reads.set(step.id, read);
    waits.set(step.id, scope.loops.waitsFor(step.id, read));
  }
  let loopWhile: Expression | undefined;
  if (scope.definition.loop?.while !== undefined) {
    const parsed = parseExpression(scope.definition.loop.while);
    if (!parsed.ok) return `Run ${run.id} ${workflowLabel(scope)} has a loop.while that does not parse: ${parsed.message}`;
    loopWhile = parsed.expression;
  }
  const outputs = new Map<string, ExpressionPath>();
  for (const [name, source] of Object.entries(scope.definition.outputs ?? {})) {
    const parsed = parseExpression(source);
    if (!parsed.ok || parsed.expression.kind !== 'path') return `Run ${run.id} ${workflowLabel(scope)} output "${name}" is not a path`;
    outputs.set(name, parsed.expression.path);
  }
  return { conditions, whiles, breaks, reads, waits, outputs, ...(loopWhile ? { loopWhile } : {}) };
}

const VISIBLE_OUTCOMES: Partial<Record<StepState['status'], VisibleOutcome>> ={ succeeded: 'success', failed: 'failed', skipped: 'skipped', cancelled: 'cancelled' };

/**
 * What expressions in a workflow read as `steps.<id>`: its own step instances, by their id in that workflow,
 * and, in an inline workflow, the enclosing steps its own steps do not hide. For `reader`, a step it reads in the
 * previous pass is that pass.
 */
function expressionSteps(scope: Scope, states: StepState[], reader?: StepState): Record<string, ExpressionStep> {
  const previous = reader ? scope.loops.previous(localId(scope, reader)) : new Set<string>();
  return { ...scope.outer, ...Object.fromEntries(states.map((step) => [localId(scope, step), previous.has(localId(scope, step)) ? previousPass(step) : {
    ...(VISIBLE_OUTCOMES[step.status] ? { outcome: VISIBLE_OUTCOMES[step.status] } : {}),
    ...('end' in step && step.end !== undefined ? { end: step.end } : {}),
    ...('outputs' in step && step.outputs !== undefined ? { outputs: step.outputs } : {}),
    passes: passesOf(step),
  }])) };
}

/**
 * Marks every pending step of a workflow that can no longer run as `skipped`, until nothing changes:
 * the skip rule in `mustSkip`, and a ready step whose `if` is false. A step that waits for a loop is neither skipped
 * nor ready until that loop is settled.
 * Returns whether a step is ready: everything it needs and everything its `if` and templates read has settled.
 */
function skipUnreachable(scope: Scope, states: StepState[], { conditions, reads, waits }: RunReads): (step: StepState) => boolean {
  const byId = new Map(states.map((step) => [localId(scope, step), step]));
  const declared = new Map(scope.definition.steps.map((step) => [step.id, step.needs ?? []]));
  const needs = (step: StepState): Array<StepState | undefined> => (declared.get(localId(scope, step)) ?? []).map((id) => byId.get(id));
  const waiting = (step: StepState): boolean => (waits.get(localId(scope, step)) ?? []).some((owner) => !loopSettled(byId.get(owner)));
  const ready = (step: StepState): boolean => !waiting(step) && needs(step).every(settled)
    && [...reads.get(localId(scope, step)) ?? []].every((id) => settled(byId.get(id)));
  for (let changed = true; changed;) {
    changed = false;
    for (const step of states) {
      if (step.status !== 'pending' || waiting(step)) continue;
      const condition = conditions.get(localId(scope, step));
      const conditionFalse = (): boolean => !!condition && ready(step)
        && !isTruthy(evaluateExpression(condition, { inputs: scope.inputs, steps: expressionSteps(scope, states, step) }));
      if (!mustSkip(needs(step), condition, (need) => localId(scope, need)) && !conditionFalse()) continue;
      skip(step);
      changed = true;
    }
  }
  return ready;
}

/**
 * A step is skipped when a step it needs stopped and its `if` does not read that step,
 * or when every step it needs was skipped. An `if` that reads every stopped dependency is a recovery step.
 */
function mustSkip(needs: Array<StepState | undefined>, condition: Expression | undefined, id: (need: StepState) => string): boolean {
  const read = stepsRead(condition ? expressionPaths(condition) : []);
  if (needs.some((need) => need && stopped(need) && !read.has(id(need)))) return true;
  return needs.length > 0 && needs.every((need) => need?.status === 'skipped');
}

/**
 * How settling a workflow of the run ended: a step to lease, the workflow's outcome, nothing to do until an open
 * lease is reported, or a run file that cannot settle.
 */
type Settled =
  | { lease: StepState; definition: WorkflowStep; rendered: RenderedLease }
  | WorkflowResult
  | { inProgress: true }
  | { unreadable: string };

/**
 * Starts the workflow a step runs with the values its `with` renders to in the step's own workflow.
 * Its steps join the run right after the step, which is `running` until they settle.
 */
function startWorkflowStep(run: RunState, scope: Scope, states: StepState[], state: StepState, step: WorkflowStep, child: Scope): WorkflowFailure | undefined {
  // An inline workflow takes no `with`: it already reads the enclosing inputs.
  let inputs: Record<string, unknown> | undefined;
  if ('name' in child.definition) {
    const rendered = renderStrings(step.with ?? {}, { inputs: scope.inputs, steps: expressionSteps(scope, states, state) });
    if (!rendered.ok) return withTemplateFailure(state, rendered.error);
    const mismatch = inputsMismatch(child.definition.name, child.definition.inputs, rendered.value);
    if (mismatch) return { code: 'invalid_inputs', message: `step "${state.id}" with does not fit workflow "${child.definition.name}": ${mismatch}` };
    if (child.definition.inputs) {
      inputs = rendered.value as Record<string, unknown>;
      child.inputs = inputs;
    }
  }
  start(state, inputs);
  const steps = child.definition.steps.map((step): StepState => {
    const id = `${child.prefix}${step.id}`;
    const pass = firstPass(run, id);
    return { id, status: 'pending', ...(pass > 1 ? { pass } : {}) };
  });
  run.steps.splice(run.steps.indexOf(state) + 1, 0, ...steps);
  return undefined;
}

/**
 * An end or break reached in a workflow stops everything under it that has not settled, in its sub-workflows too: a
 * leased step is cancelled and its attempt kept in `cancelledAttempts`, a running workflow step is cancelled, and a
 * pending step is skipped. `reached` names the end or break.
 */
function stopUnder(run: RunState, scope: Scope, reached: string): void {
  const failure = { code: 'end_reached', message: `Cancelled: ${workflowLabel(scope)} reached ${reached}` };
  for (const state of run.steps) {
    if (!state.id.startsWith(scope.prefix)) continue;
    if (state.status === 'pending') skip(state);
    else if (state.status === 'running') cancel(state, failure);
    else if (state.status === 'leased') {
      (run.cancelledAttempts ??= []).push(state.attempt);
      cancel(state, failure);
    }
  }
}

/** A workflow step takes the outcome, the end, and the outputs of the workflow it ran. */
function finishWorkflowStep(state: StepState, result: WorkflowResult): void {
  const settlement = {
    settledAt: result.settledAt,
    ...(result.end !== undefined ? { end: result.end } : {}),
    ...(result.outputs !== undefined ? { outputs: result.outputs } : {}),
  };
  if (result.outcome === 'succeeded') succeed(state, settlement);
  else fail(state, { ...settlement, ...(result.failure ? { message: result.failure.message, failure: result.failure } : {}) });
}

/** The values a workflow returns, read from its own steps; a skipped step reads null. */
function workflowOutputs(scope: Scope, states: StepState[], paths: Map<string, ExpressionPath>): Record<string, unknown> | undefined {
  if (!scope.definition.outputs) return undefined;
  const context = { inputs: scope.inputs, steps: expressionSteps(scope, states) };
  return Object.fromEntries([...paths].map(([name, path]) => [name, resolvePath(path, context)]));
}

/**
 * Settles one workflow of the run to a fixpoint, and any change starts it over. First, what needs no driver:
 * skips, end-only steps, and the running workflow steps whose own workflow has a result. Then the reached end, if
 * any. Only when `advancing`, the first ready step in declaration order is started or returned to lease; a running
 * workflow step stands there for its own steps and is passed over while they have nothing to lease.
 */
function settleScope(run: RunState, scope: Scope, advancing: boolean): Settled {
  const reads = parseReads(run, scope);
  if (typeof reads === 'string') return { unreadable: reads };
  const states = statesIn(run, scope);
  const defined = new Map(scope.definition.steps.map((item) => [item.id, item]));
  const definitionOf = (state: StepState): WorkflowStep | undefined => defined.get(localId(scope, state));
  const byId = new Map(states.map((state) => [localId(scope, state), state]));
  // A step is ready when the last of the steps it needs and reads settles, which is when an end-only step is reached.
  const reachedAt = (state: StepState): number => Math.max(
    0,
    ...[...definitionOf(state)?.needs ?? [], ...reads.reads.get(localId(scope, state)) ?? []].map((id) => settledAtOf(byId.get(id))),
  );
  const childOf = (state: StepState): { definition: WorkflowStep; child: Scope } | { unreadable: string } => {
    const definition = definitionOf(state);
    if (!definition) return { unreadable: `Run ${run.id} has no definition for step "${state.id}"` };
    const child = childScope(run, scope, states, state, definition);
    if (!child) return { unreadable: `Run ${run.id} step "${state.id}" runs workflow "${definition.workflow}", which the run did not keep` };
    return { definition, child };
  };
  for (;;) {
    let changed = false;
    // A succeeded loop owner's loop is decided once per run, before anything reads what follows it.
    for (const state of states) {
      const loop = definitionOf(state)?.loop;
      if (!loop || state.status !== 'succeeded' || state.loopFinal) continue;
      const condition = reads.whiles.get(localId(scope, state));
      const holds = !condition || isTruthy(evaluateExpression(condition, { inputs: scope.inputs, steps: expressionSteps(scope, states, state) }));
      const range = scope.loops.ranges.get(localId(scope, state)) ?? new Set();
      decideStepLoop(run, state, loop, holds, states.filter((item) => range.has(localId(scope, item))));
      changed = true;
    }
    if (changed) continue;
    const canRun = skipUnreachable(scope, states, reads);
    const ready = (item: StepState): boolean => item.status === 'pending' && canRun(item);
    for (const state of states) {
      if (ready(state) && endsOnly(definitionOf(state))) {
        succeed(state, { settledAt: reachedAt(state) });
        changed = true;
      } else if (state.status === 'running') {
        const located = childOf(state);
        if ('unreadable' in located) return located;
        const result = settleScope(run, located.child, false);
        if ('unreadable' in result) return result;
        if (!('outcome' in result)) continue;
        finishWorkflowStep(state, result);
        changed = true;
      }
    }
    if (changed) continue;
    // A break that holds is a nameless succeeded end. The end reached first wins, whatever order its step is declared
    // in; a tie goes to the step declared first.
    const breaks = (state: StepState): boolean => {
      const condition = reads.breaks.get(localId(scope, state));
      return !!condition && isTruthy(evaluateExpression(condition, { inputs: scope.inputs, steps: expressionSteps(scope, states, state) }));
    };
    const reached = states
      .filter((item) => item.status === 'succeeded' && (definitionOf(item)?.end !== undefined || breaks(item)))
      .sort((left, right) => settledAtOf(left) - settledAtOf(right))[0];
    if (reached) {
      const end = definitionOf(reached)?.end;
      stopUnder(run, scope, end === undefined ? `the break of step "${reached.id}"` : `end "${end}"`);
      const result = { outputs: workflowOutputs(scope, states, reads.outputs), settledAt: settledAtOf(reached) };
      return end === undefined ? { outcome: 'succeeded', ...result } : { outcome: scope.definition.ends?.[end] ?? 'failed', end, ...result };
    }
    if (states.every(settled)) {
      const result: WorkflowResult = {
        outcome: states.some(stopped) ? 'failed' : 'succeeded',
        outputs: workflowOutputs(scope, states, reads.outputs),
        settledAt: Math.max(0, ...states.map(settledAtOf)),
      };
      const { loop } = scope.definition;
      if (!loop) return result;
      const holds = !reads.loopWhile || isTruthy(evaluateExpression(reads.loopWhile, { inputs: scope.inputs, steps: expressionSteps(scope, states) }));
      const decided = decideRound(run, scope.runner, loop, holds, workflowLabel(scope), states);
      if (decided === 'again') continue;
      return decided === 'ended' ? result : { ...result, outcome: 'failed', failure: decided };
    }
    if (!advancing) return { inProgress: true };
    for (const state of states) {
      if (state.status !== 'running' && !ready(state)) continue;
      const definition = definitionOf(state);
      if (!definition) return { unreadable: `Run ${run.id} has no definition for step "${state.id}"` };
      if (state.status === 'pending' && definition.loop && exhaustedAtStart(state, definition.loop, reachedAt(state))) {
        changed = true;
        break;
      }
      if (definition.workflow === undefined) {
        const rendered = renderLease(scope, states, state, definition);
        if (!('code' in rendered)) return { lease: state, definition, rendered };
        failStep(state, rendered, reachedAt(state));
      } else {
        const located = childOf(state);
        if ('unreadable' in located) return located;
        if (state.status === 'pending') {
          const failure = startWorkflowStep(run, scope, states, state, definition, located.child);
          if (failure) failStep(state, failure, reachedAt(state));
        } else {
          const result = settleScope(run, located.child, true);
          if ('inProgress' in result) continue;
          if (!('outcome' in result)) return result;
          finishWorkflowStep(state, result);
        }
      }
      changed = true;
      break;
    }
    if (changed) continue;
    if (states.some((item) => item.status === 'leased' || item.status === 'running')) return { inProgress: true };
    return { unreadable: `Run ${run.id} has pending steps whose needs cannot be met` };
  }
}

/** Why `inputs` do not fit what the workflow declares, naming the field, or null when they fit. Every declared input is required. */
function inputsMismatch(name: string, declared: Record<string, OutputSchema> | undefined, inputs: unknown): string | null {
  if (!isRecord(inputs)) return 'inputs must be a JSON object';
  const mismatch = outputMismatch({ type: 'object', fields: declared ?? {} }, inputs, 'inputs');
  if (mismatch) return mismatch;
  // The shorthand allows extra object keys, so an undeclared input is checked here.
  const extra = Object.keys(inputs).find((key) => !declared || !Object.hasOwn(declared, key));
  return extra === undefined ? null : `inputs.${extra} is not an input workflow "${name}" declares`;
}

/** Every workflow `cached` runs through its steps, directly or not, from the cache, and one hash over all of their sources. */
async function loadWorkflows(
  config: LocalConfig,
  cached: CachedWorkflow,
): Promise<{ workflows: Record<string, WorkflowDefinition>; sourceHash: string } | { failed: WorkflowEnvelope }> {
  const workflows: Record<string, WorkflowDefinition> = {};
  const hashes: Array<[string, string]> = [];
  const visit = async (definition: WorkflowDefinition, through: string[]): Promise<WorkflowEnvelope | undefined> => {
    for (const { step, workflow } of workflowsRunBy(definition)) {
      if (through.includes(workflow)) {
        const cycle = [...through.slice(through.indexOf(workflow)), workflow].join(' -> ');
        return error('workflow_recursion', `Workflow "${cached.definition.name}" cannot start: its sub-workflows run in a cycle: ${cycle}`);
      }
      if (Object.hasOwn(workflows, workflow)) continue;
      const child = await loadCachedWorkflow(config, workflow);
      if (!child) {
        return error('workflow_not_found', `Workflow "${definition.name}" step "${step}" runs workflow "${workflow}", which has no runnable version. Check workflows/${workflow}.yaml and pull again.`);
      }
      workflows[workflow] = child.definition;
      hashes.push([workflow, child.sourceHash]);
      const failed = await visit(child.definition, [...through, workflow]);
      if (failed) return failed;
    }
    return undefined;
  };
  const failed = await visit(cached.definition, [cached.definition.name]);
  if (failed) return { failed };
  if (hashes.length === 0) return { workflows, sourceHash: cached.sourceHash };
  const hash = createHash('sha256').update(cached.sourceHash);
  for (const [name, sourceHash] of hashes.sort(([left], [right]) => left.localeCompare(right))) {
    hash.update('\0').update(name).update('\0').update(sourceHash);
  }
  return { workflows, sourceHash: hash.digest('hex') };
}

/** Creates a run. `inputs` are checked against the declared inputs before the run file exists. */
export async function startRun(
  config: LocalConfig,
  name: string,
  inputs: unknown = {},
  options: { driver?: DriverIdentity } = {},
): Promise<WorkflowEnvelope> {
  const cached = await loadCachedWorkflow(config, name);
  if (!cached) {
    return error('workflow_not_found', `Workflow "${name}" has no runnable version. Check workflows/${name}.yaml and pull again.`);
  }
  const mismatch = inputsMismatch(cached.definition.name, cached.definition.inputs, inputs);
  if (mismatch) return error('invalid_inputs', mismatch);
  const tree = await loadWorkflows(config, cached);
  if ('failed' in tree) return tree.failed;
  const now = new Date().toISOString();
  const run: RunState = {
    schemaVersion: 'v1alpha1',
    id: generateRunId(),
    name: cached.definition.name,
    revision: 1,
    status: 'running',
    ...(cached.definition.inputs ? { inputs: inputs as Record<string, unknown> } : {}),
    sourceHash: tree.sourceHash,
    definition: cached.definition,
    ...(Object.keys(tree.workflows).length > 0 ? { workflows: tree.workflows } : {}),
    steps: cached.definition.steps.map((step) => ({ id: step.id, status: 'pending' })),
    settledAttempts: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeRun(config, run);
  // #1083: publish the start record; a failed publication is queued locally
  // and retried on the next pull — it never fails the run itself.
  const record = await noteRunRecord(config, run, options.driver, 'start');
  return ok({ run: run.id, name: run.name, status: run.status, revision: run.revision, ...(record ? { record } : {}) });
}

/** A run started before `needs` existed ran its steps in order; settling it as a graph would run every such step as a root. */
function missingNeeds(run: RunState): string | undefined {
  for (const definition of [run.definition, ...Object.values(run.workflows ?? {})]) {
    const step = definition.steps.slice(1).find((item) => item.needs === undefined);
    if (step) return `Run ${run.id} was started by an older teamai: step "${step.id}" in workflow "${definition.name}" has no needs. Start a new run.`;
  }
  return undefined;
}

/** What a driver tells `next` besides who it is. */
export interface NextOptions {
  /** The attempts of its open leases the driver is still running. An open lease it does not list is handed back to it. */
  running?: string[];
  /** False to only settle: `next` then answers `done`, an unlisted lease, or `wait`, and starts nothing new. */
  canTakeLease?: boolean;
}

export async function leaseNext(config: LocalConfig, runId: string, driver: DriverIdentity, options: NextOptions = {}): Promise<WorkflowEnvelope> {
  const running = new Set(options.running);
  // The end record publishes AFTER withRun releases the run lock (#1126 P3):
  // publication does a reports-branch push, and no network I/O may hold the
  // lock other engine operations wait on.
  let settledRun: RunState | undefined;
  let alreadySettled = false;
  const envelope = await withRun(config, runId, async (run, now) => {
    const before = JSON.stringify(run);
    // Whatever settling changed is saved. `cancelled` is derived after settling: the attempts the driver runs that
    // are no longer its open leases.
    const answer = (data: Record<string, unknown>): { save: boolean; envelope: WorkflowEnvelope } => ({
      save: JSON.stringify(run) !== before,
      envelope: ok({
        ...data,
        cancelled: [...running].filter((attempt) => !run.steps.some((step) => step.status === 'leased'
          && step.lease.attempt === attempt && sameDriver(step.lease.driver, driver))),
      }),
    });
    const done = (result: WorkflowResult): { save: boolean; envelope: WorkflowEnvelope } => {
      settledRun = settleRun(run, now, result);
      return answer(doneData(run));
    };
    const wait = (open = run.steps.find((step) => step.status === 'leased')): { save: boolean; envelope: WorkflowEnvelope } => (
      answer({ wait: { reason: open ? `${open.id} is leased` : 'canTakeLease is false' } })
    );
    if (run.status !== 'running') {
      // Settled by an earlier next, which published the end record; the
      // done envelope still reports the queue-derived record state.
      alreadySettled = true;
      return answer(doneData(run));
    }
    const older = missingNeeds(run);
    if (older) return { save: false, envelope: error('run_unreadable', older) };
    const other = run.steps.find((step): step is LeasedStep => step.status === 'leased' && !sameDriver(step.lease.driver, driver));
    if (other) return wait(other);
    for (;;) {
      // Ends reached through reports apply before an open lease is handed back, so a restarted driver does not run
      // again what an end already stopped.
      const result = settleScope(run, topScope(run), false);
      if ('unreadable' in result) return { save: false, envelope: error('run_unreadable', result.unreadable) };
      if ('outcome' in result) return done(result);
      // An open lease the driver does not list is handed back before anything new starts, as a restarted driver expects.
      const leased = run.steps.find((step): step is LeasedStep => step.status === 'leased' && !running.has(step.lease.attempt));
      if (!leased) break;
      const located = locateStep(run, leased.id);
      if (!located) return { save: false, envelope: error('run_unreadable', `Run ${run.id} has no definition for step "${leased.id}"`) };
      const rendered = renderLease(located.scope, statesIn(run, located.scope), leased, located.step);
      if (!('code' in rendered)) return answer(leaseData(run, leased, located.step, rendered));
      failStep(leased, rendered, leased.lease.revision);
    }
    if (options.canTakeLease === false) return wait();
    const result = settleScope(run, topScope(run), true);
    if ('unreadable' in result) return { save: false, envelope: error('run_unreadable', result.unreadable) };
    if ('outcome' in result) return done(result);
    if ('inProgress' in result) return wait();
    const step = lease(result.lease, { attempt: `a${randomBytes(4).toString('hex')}`, revision: run.revision, driver });
    return answer(leaseData(run, step, result.definition, result.rendered));
  });
  if (settledRun || alreadySettled) {
    const record = settledRun
      ? await noteRunRecord(config, settledRun, driver, 'end')
      : await runRecordState(config, runId);
    const done = (envelope as { data?: { done?: Record<string, unknown> } }).data?.done;
    if (done && record) done.record = record;
  }
  return envelope;
}

function driverFrom(value: unknown): DriverIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const driver = value as DriverIdentity;
  if (typeof driver.kind !== 'string' || driver.kind === '') return undefined;
  if (typeof driver.machine !== 'string' || driver.machine === '') return undefined;
  if (typeof driver.workspace !== 'string' || driver.workspace === '') return undefined;
  return { kind: driver.kind, machine: driver.machine, workspace: driver.workspace };
}

export function parseReport(value: unknown): ReportInput | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'report must be a JSON object';
  const record = value as Record<string, unknown>;
  if (typeof record.attempt !== 'string' || record.attempt === '') return 'attempt must be a string';
  if (typeof record.revision !== 'number' || !Number.isInteger(record.revision)) return 'revision must be an integer';
  if (record.outcome !== 'success' && record.outcome !== 'failed' && record.outcome !== 'released') {
    return 'outcome must be success, failed, or released';
  }
  const driver = driverFrom(record.driver);
  if (!driver) return 'driver must include kind, machine, and workspace';
  const report: ReportInput = { attempt: record.attempt, revision: record.revision, outcome: record.outcome, driver };
  if ('outputs' in record) report.outputs = record.outputs;
  if (record.exitCode !== undefined) {
    if (typeof record.exitCode !== 'number' || !Number.isInteger(record.exitCode)) return 'exitCode must be an integer';
    report.exitCode = record.exitCode;
  }
  if (record.message !== undefined) {
    if (typeof record.message !== 'string') return 'message must be a string';
    report.message = record.message;
  }
  for (const field of ['tool', 'model', 'session'] as const) {
    if (record[field] === undefined) continue;
    if (typeof record[field] !== 'string') return `${field} must be a string`;
    report[field] = record[field];
  }
  if (record.tokens !== undefined) {
    if (!record.tokens || typeof record.tokens !== 'object' || Array.isArray(record.tokens)) return 'tokens must be an object';
    const value = record.tokens as Record<string, unknown>;
    const tokens: TokenUsage = {};
    for (const field of ['input', 'output', 'cachedInput'] as const) {
      if (value[field] === undefined) continue;
      if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) return `tokens.${field} must be a finite number`;
      tokens[field] = value[field];
    }
    report.tokens = tokens;
  }
  if (record.failure !== undefined) {
    if (!record.failure || typeof record.failure !== 'object' || Array.isArray(record.failure)) return 'failure must be an object';
    const value = record.failure as Record<string, unknown>;
    if (typeof value.code !== 'string') return 'failure.code must be a string';
    if (typeof value.message !== 'string') return 'failure.message must be a string';
    report.failure = { code: value.code, message: value.message };
  }
  return report;
}

/** A `next` payload: who the driver is, and what else it tells `next`. */
export interface NextRequest extends NextOptions {
  driver: DriverIdentity;
}

export function parseNextPayload(value: unknown): NextRequest | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'next payload must be a JSON object';
  const record = value as Record<string, unknown>;
  const driver = driverFrom(record.driver);
  if (!driver) return 'driver must include kind, machine, and workspace';
  const request: NextRequest = { driver };
  if (record.running !== undefined) {
    if (!Array.isArray(record.running) || !record.running.every((attempt): attempt is string => typeof attempt === 'string')) {
      return 'running must be an array of attempt ids';
    }
    request.running = record.running;
  }
  if (record.canTakeLease !== undefined) {
    if (typeof record.canTakeLease !== 'boolean') return 'canTakeLease must be a boolean';
    request.canTakeLease = record.canTakeLease;
  }
  return request;
}

function rememberSettledAttempt(run: RunState, attempt: string): void {
  // settledAttempts is a bounded dedup history; the cumulative count feeds the
  // run record's iterations field, which must not cap at SETTLED_ATTEMPTS_LIMIT.
  // A run file from before settledCount starts from its history.
  run.settledCount = (run.settledCount ?? run.settledAttempts.length) + 1;
  run.settledAttempts.push(attempt);
  const extra = run.settledAttempts.length - SETTLED_ATTEMPTS_LIMIT;
  if (extra > 0) run.settledAttempts.splice(0, extra);
}

export async function reportAttempt(config: LocalConfig, runId: string, report: ReportInput): Promise<WorkflowEnvelope> {
  return withRun(config, runId, async (run) => {
    // Settled membership wins. An old revision of a settled attempt is still repeated_report.
    if (run.settledAttempts.includes(report.attempt)) {
      return { save: false, envelope: error('repeated_report', `Attempt ${report.attempt} was already reported`) };
    }
    // Before the driver check, so any driver learns that the attempt was cancelled.
    if (run.cancelledAttempts?.includes(report.attempt)) {
      return { save: false, envelope: error('lease_cancelled', `Attempt ${report.attempt} was cancelled; its report is not recorded`) };
    }
    const step = run.steps.find((item): item is LeasedStep => item.status === 'leased' && item.lease.attempt === report.attempt);
    if (!step) {
      if (report.revision !== run.revision) {
        return { save: false, envelope: error('stale_revision', `Revision ${report.revision} is stale; the run is at ${run.revision}`) };
      }
      return { save: false, envelope: error('wrong_attempt', `Attempt ${report.attempt} is not the leased attempt`) };
    }
    // A lease is checked against the revision it was handed out at, so a report of a parallel lease does not make it stale.
    if (report.revision !== step.lease.revision) {
      return { save: false, envelope: error('stale_revision', `Revision ${report.revision} is stale; attempt ${report.attempt} was leased at ${step.lease.revision}`) };
    }
    if (!sameDriver(step.lease.driver, report.driver)) {
      return { save: false, envelope: error('wrong_driver', 'This lease belongs to a different driver') };
    }

    const defined = locateStep(run, step.id)?.step;
    let outcome = report.outcome;
    let message = report.message;
    let failure = report.failure;
    if (outcome === 'success' && defined?.output) {
      const mismatch = outputMismatch(defined.output, report.outputs);
      if (mismatch) {
        outcome = 'failed';
        message = `stdout JSON does not match output: ${mismatch}`;
        failure = { code: 'invalid_output', message };
      }
    }

    rememberSettledAttempt(run, report.attempt);
    run.revision += 1;
    const settlement = {
      settledAt: run.revision,
      attempt: report.attempt,
      exitCode: report.exitCode,
      message,
      tool: report.tool,
      model: report.model,
      session: report.session,
      tokens: report.tokens,
    };
    const settledStep = outcome === 'released' ? release(step)
      : outcome === 'success' ? succeed(step, { ...settlement, ...(report.outputs !== undefined ? { outputs: report.outputs } : {}) })
        : fail(step, { ...settlement, failure });
    return {
      save: true,
      envelope: ok({
        accepted: true,
        revision: run.revision,
        step: { id: settledStep.id, status: settledStep.status, outcome },
      }),
    };
  });
}
