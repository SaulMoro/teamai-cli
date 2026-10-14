import { randomBytes } from 'node:crypto';
import { acquireLock, releaseLock } from '../update.js';
import type { LocalConfig } from '../types.js';
import { loadCachedWorkflow } from './cache.js';
import { evaluateExpression, expressionPaths, isTruthy, parseExpression, type Expression, type ExpressionStep } from './expression.js';
import { outputMismatch } from './output.js';
import { isRunId, readRun, runLockPath, writeRun } from './store.js';
import type {
  DriverIdentity,
  RunState,
  RunStatus,
  StepOutcome,
  StepState,
  TokenUsage,
  WorkflowEnvelope,
  WorkflowFailure,
  WorkflowStep,
} from './types.js';

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
  mutate: (run: RunState) => Promise<{ envelope: T; save: boolean }>,
): Promise<T> {
  if (!isRunId(runId)) return error('invalid_run', 'Run id must look like r followed by 8 hex digits') as T;
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
    const result = await mutate(loaded);
    if (result.save) {
      loaded.updatedAt = new Date().toISOString();
      await writeRun(config, loaded);
    }
    return result.envelope;
  } finally {
    await releaseLock(lock);
  }
}

function leasePayload(run: RunState, step: StepState): Record<string, unknown> {
  const definition = run.definition.steps.find((item) => item.id === step.id);
  return {
    run: run.id,
    step: step.id,
    attempt: step.lease?.attempt,
    revision: step.lease?.revision,
    ...(definition?.command !== undefined ? { command: definition.command } : {}),
    ...(definition?.prompt !== undefined ? { prompt: definition.prompt } : {}),
    ...(definition?.agent !== undefined ? { agent: definition.agent } : {}),
    ...(definition?.output ? { output: definition.output } : {}),
  };
}

/** Ends the run. Every path that settles a run goes through here, so anything that reacts to a settled run hooks in here. */
function settleRun(run: RunState, outcome: Exclude<RunStatus, 'running'>, end?: string): void {
  run.status = outcome;
  if (end !== undefined) run.end = end;
  run.updatedAt = new Date().toISOString();
}

function doneEnvelope(run: RunState): WorkflowEnvelope {
  return ok({ done: { run: run.id, outcome: run.status, ...(run.end !== undefined ? { end: run.end } : {}) } });
}

/** A step with `end` and no action only ends the workflow; the engine settles it without a lease. */
function endsOnly(step: WorkflowStep | undefined): boolean {
  return step?.end !== undefined && step.command === undefined && step.prompt === undefined;
}

/** A step that ran and did not succeed. Later issues add `timeout` and `cancelled`. */
function stopped(step: StepState): boolean {
  return step.status === 'failed';
}

function settled(step: StepState | undefined): boolean {
  return step?.status === 'succeeded' || step?.status === 'failed' || step?.status === 'skipped';
}

/** The step ids an `if` reads. */
function stepsRead(condition: Expression | undefined): Set<string> {
  return new Set((condition ? expressionPaths(condition) : []).flatMap((path) => (path.root === 'steps' ? [path.step] : [])));
}

/** Parses every `if` in the run. A run file whose `if` does not parse cannot settle; the message names the step. */
function parseConditions(run: RunState): Map<string, Expression> | string {
  const conditions = new Map<string, Expression>();
  for (const step of run.definition.steps) {
    if (step.if === undefined) continue;
    const parsed = parseExpression(step.if);
    if (!parsed.ok) return `Run ${run.id} step "${step.id}" has an if that does not parse: ${parsed.message}`;
    conditions.set(step.id, parsed.expression);
  }
  return conditions;
}

const VISIBLE_OUTCOMES: Partial<Record<StepState['status'], string>> = { succeeded: 'success', failed: 'failed', skipped: 'skipped' };

function expressionSteps(run: RunState): Record<string, ExpressionStep> {
  return Object.fromEntries(run.steps.map((step) => [step.id, {
    ...(VISIBLE_OUTCOMES[step.status] ? { outcome: VISIBLE_OUTCOMES[step.status] } : {}),
    ...(step.outputs !== undefined ? { outputs: step.outputs } : {}),
  }]));
}

/**
 * Marks every pending step that can no longer run as `skipped`, until nothing changes:
 * the skip rule in `mustSkip`, and a ready step whose `if` is false.
 * Returns whether a step is ready: everything it needs and everything its `if` reads has settled.
 */
function skipUnreachable(run: RunState, conditions: Map<string, Expression>): (step: StepState) => boolean {
  const states = new Map(run.steps.map((step) => [step.id, step]));
  const declared = new Map(run.definition.steps.map((step) => [step.id, step.needs ?? []]));
  const needs = (step: StepState): Array<StepState | undefined> => (declared.get(step.id) ?? []).map((id) => states.get(id));
  const ready = (step: StepState): boolean => needs(step).every(settled)
    && [...stepsRead(conditions.get(step.id))].every((id) => settled(states.get(id)));
  for (let changed = true; changed;) {
    changed = false;
    for (const step of run.steps) {
      if (step.status !== 'pending') continue;
      const condition = conditions.get(step.id);
      const conditionFalse = (): boolean => !!condition && ready(step)
        && !isTruthy(evaluateExpression(condition, { steps: expressionSteps(run) }));
      if (!mustSkip(needs(step), condition) && !conditionFalse()) continue;
      step.status = 'skipped';
      changed = true;
    }
  }
  return ready;
}

/**
 * A step is skipped when a step it needs stopped and its `if` does not read that step,
 * or when every step it needs was skipped. An `if` that reads every stopped dependency is a recovery step.
 */
function mustSkip(needs: Array<StepState | undefined>, condition: Expression | undefined): boolean {
  const read = stepsRead(condition);
  if (needs.some((need) => need && stopped(need) && !read.has(need.id))) return true;
  return needs.length > 0 && needs.every((need) => need?.status === 'skipped');
}

export async function startRun(config: LocalConfig, name: string): Promise<WorkflowEnvelope> {
  const cached = await loadCachedWorkflow(config, name);
  if (!cached) {
    return error('workflow_not_found', `Workflow "${name}" has no runnable version. Check workflows/${name}.yaml and pull again.`);
  }
  const now = new Date().toISOString();
  const run: RunState = {
    schemaVersion: 'v1alpha1',
    id: `r${randomBytes(4).toString('hex')}`,
    name: cached.definition.name,
    revision: 1,
    status: 'running',
    sourceHash: cached.sourceHash,
    definition: cached.definition,
    steps: cached.definition.steps.map((step) => ({ id: step.id, status: 'pending' })),
    settledAttempts: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeRun(config, run);
  return ok({ run: run.id, name: run.name, status: run.status, revision: run.revision });
}

export async function leaseNext(config: LocalConfig, runId: string, driver: DriverIdentity): Promise<WorkflowEnvelope> {
  return withRun(config, runId, async (run) => {
    if (run.status !== 'running') return { save: false, envelope: doneEnvelope(run) };
    const leased = run.steps.find((step) => step.status === 'leased');
    if (leased?.lease) {
      if (sameDriver(leased.lease.driver, driver)) {
        return { save: false, envelope: ok({ lease: leasePayload(run, leased) }) };
      }
      return { save: false, envelope: ok({ wait: { reason: `${leased.id} is leased` } }) };
    }
    const conditions = parseConditions(run);
    if (typeof conditions === 'string') return { save: false, envelope: error('run_unreadable', conditions) };
    // Settle the graph here, while no lease is open, so a later report still matches its lease revision.
    const canRun = skipUnreachable(run, conditions);
    const ready = (item: StepState): boolean => item.status === 'pending' && canRun(item);
    const defined = new Map(run.definition.steps.map((item) => [item.id, item]));
    const ending = run.steps.find((item) => ready(item) && endsOnly(defined.get(item.id)));
    if (ending) ending.status = 'succeeded';
    const reached = run.steps.find((item) => item.status === 'succeeded' && defined.get(item.id)?.end !== undefined);
    const end = reached ? defined.get(reached.id)?.end : undefined;
    if (end !== undefined) {
      for (const item of run.steps) if (item.status === 'pending') item.status = 'skipped';
      settleRun(run, run.definition.ends?.[end] ?? 'failed', end);
      return { save: true, envelope: doneEnvelope(run) };
    }
    const step = run.steps.find(ready);
    if (!step) {
      if (run.steps.some((item) => item.status === 'pending')) {
        return { save: false, envelope: error('run_unreadable', `Run ${run.id} has pending steps whose needs cannot be met`) };
      }
      const outcome = run.steps.some(stopped) ? 'failed' : 'succeeded';
      settleRun(run, outcome);
      return { save: true, envelope: doneEnvelope(run) };
    }
    const attempt = `a${randomBytes(4).toString('hex')}`;
    step.status = 'leased';
    step.attempt = attempt;
    step.outcome = undefined;
    step.lease = { attempt, revision: run.revision, driver };
    return { save: true, envelope: ok({ lease: leasePayload(run, step) }) };
  });
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

export function parseDriverPayload(value: unknown): DriverIdentity | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'next payload must be a JSON object';
  const driver = driverFrom((value as { driver?: unknown }).driver);
  return driver ?? 'driver must include kind, machine, and workspace';
}

function rememberSettledAttempt(run: RunState, attempt: string): void {
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
    if (report.revision !== run.revision) {
      return { save: false, envelope: error('stale_revision', `Revision ${report.revision} is stale; the run is at ${run.revision}`) };
    }
    const step = run.steps.find((item) => item.status === 'leased' && item.lease?.attempt === report.attempt);
    if (!step?.lease) {
      return { save: false, envelope: error('wrong_attempt', `Attempt ${report.attempt} is not the leased attempt`) };
    }
    if (!sameDriver(step.lease.driver, report.driver)) {
      return { save: false, envelope: error('wrong_driver', 'This lease belongs to a different driver') };
    }

    const defined = run.definition.steps.find((item) => item.id === step.id);
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

    step.lease = undefined;
    step.attempt = undefined;
    step.exitCode = report.exitCode;
    step.message = message;
    step.tool = report.tool;
    step.model = report.model;
    step.session = report.session;
    step.tokens = report.tokens;
    step.failure = failure;
    step.outcome = outcome;
    if (outcome === 'released') {
      step.status = 'pending';
    } else if (outcome === 'success') {
      step.status = 'succeeded';
      if (report.outputs !== undefined) step.outputs = report.outputs;
    } else {
      step.status = 'failed';
    }
    rememberSettledAttempt(run, report.attempt);
    run.revision += 1;
    return {
      save: true,
      envelope: ok({
        accepted: true,
        revision: run.revision,
        step: { id: step.id, status: step.status, outcome },
      }),
    };
  });
}
