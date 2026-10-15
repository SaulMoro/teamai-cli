import { z } from 'zod';
import type { DriverIdentity, StepLease, TokenUsage, WorkflowFailure } from './types.js';

const TokenUsageSchema: z.ZodType<TokenUsage> = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cachedInput: z.number().optional(),
});

const FailureSchema: z.ZodType<WorkflowFailure> = z.object({ code: z.string(), message: z.string() });

const DriverSchema: z.ZodType<DriverIdentity> = z.object({ kind: z.string(), machine: z.string(), workspace: z.string() });

const LeaseSchema: z.ZodType<StepLease> = z.object({ attempt: z.string(), revision: z.number(), driver: DriverSchema });

/** What a driver reports about the attempt that settled a step. */
const report = {
  exitCode: z.number().optional(),
  message: z.string().optional(),
  tool: z.string().optional(),
  model: z.string().optional(),
  session: z.string().optional(),
  tokens: TokenUsageSchema.optional(),
};

const ResultsSchema = z.array(z.object({
  item: z.unknown(),
  outcome: z.enum(['success', 'failed', 'skipped', 'cancelled']),
  outputs: z.unknown().optional(),
}));

/** One earlier pass of a step instance that a loop ran again. */
export const StepPassSchema = z.object({
  pass: z.number().int(),
  attempt: z.string().optional(),
  outcome: z.enum(['success', 'failed', 'skipped', 'cancelled']),
  outputs: z.unknown().optional(),
  end: z.string().optional(),
  results: ResultsSchema.optional(),
  failure: FailureSchema.optional(),
  ...report,
});
export type StepPass = z.infer<typeof StepPassSchema>;

/** A pass of a child or item instance that a loop removed from the run; `step` is its full path. */
export const ArchivedPassSchema = StepPassSchema.extend({ step: z.string() });
export type ArchivedPass = z.infer<typeof ArchivedPassSchema>;

/**
 * What every step instance has. `id` is its path: a top-level step id, `<workflow step path>.<child step id>`
 * for a step inside a sub-workflow, such as `check.classify`, or `<id>[<n>]` for an item of a `for_each` step.
 */
const StepBaseSchema = z.object({
  id: z.string(),
  pass: z.number().int().optional(),
  passes: z.array(StepPassSchema).optional(),
  item: z.unknown().optional(),
  /** The values `with` passed to the workflow this step runs, kept when that workflow declares inputs. */
  inputs: z.record(z.unknown()).optional(),
  iteration: z.number().int().optional(),
  round: z.number().int().optional(),
});
type StepBase = z.infer<typeof StepBaseSchema>;

/**
 * What a step that ran keeps. A file written before `settledAt` existed reads it as 0. `end` is the end the workflow
 * this step runs reached.
 */
const settledFields = {
  outputs: z.unknown().optional(),
  end: z.string().optional(),
  results: ResultsSchema.optional(),
  settledAt: z.number().int().default(0),
  attempt: z.string().optional(),
  ...report,
};

/**
 * One step instance. Unknown keys are dropped when a run file is read, so a step a 0.22.0 report released
 * reads as a clean `pending` step. That version wrote no `outcome` on a step the engine settled; it reads from `status`.
 * `running`: a workflow step whose child steps are in the run and not all settled.
 */
export const StepStateSchema = z.discriminatedUnion('status', [
  StepBaseSchema.extend({ status: z.literal('pending') }),
  StepBaseSchema.extend({ status: z.literal('leased'), attempt: z.string(), lease: LeaseSchema }),
  StepBaseSchema.extend({ status: z.literal('running') }),
  StepBaseSchema.extend({
    status: z.literal('succeeded'), outcome: z.literal('success').default('success'), ...settledFields, loopFinal: z.boolean().optional(),
  }),
  StepBaseSchema.extend({ status: z.literal('failed'), outcome: z.literal('failed').default('failed'), ...settledFields, failure: FailureSchema.optional() }),
  StepBaseSchema.extend({ status: z.literal('skipped') }),
  StepBaseSchema.extend({ status: z.literal('cancelled'), attempt: z.string().optional(), failure: FailureSchema }),
]);
export type StepState = z.infer<typeof StepStateSchema>;
type StepStatus = StepState['status'];

type StepIn<S extends StepStatus> = Extract<StepState, { status: S }>;
type PendingStep = StepIn<'pending'>;
export type LeasedStep = StepIn<'leased'>;
type RunningStep = StepIn<'running'>;
type SucceededStep = StepIn<'succeeded'>;
type FailedStep = StepIn<'failed'>;
type SkippedStep = StepIn<'skipped'>;

type Settlement<T extends StepState> = Omit<T, keyof StepBase | 'status' | 'outcome'>;

const BASE_KEYS = Object.keys(StepBaseSchema.shape) as Array<keyof StepBase>;

/**
 * Replaces a step's fields in place with `next`, keeping the fields every step has, and returns it as its new variant.
 * In place, because `run.steps` holds the instance and the engine finds positions in it by identity.
 */
function become<T extends StepState>(state: StepState, next: Omit<T, keyof StepBase>): T {
  const fields = state as Record<string, unknown>;
  const kept = Object.fromEntries(BASE_KEYS.filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]]));
  for (const key of Object.keys(fields)) delete fields[key];
  return Object.assign(fields, kept, next) as T;
}

export function skip(state: StepState): SkippedStep {
  return become<SkippedStep>(state, { status: 'skipped' });
}

/** A released lease returns the step to `pending` with nothing from the attempt. */
export function release(state: LeasedStep): PendingStep {
  return become<PendingStep>(state, { status: 'pending' });
}

export function lease(state: StepState, held: StepLease): LeasedStep {
  return become<LeasedStep>(state, { status: 'leased', attempt: held.attempt, lease: held });
}

/** A workflow step starts; `inputs` are the values its `with` passed, when that workflow declares inputs. */
export function start(state: StepState, inputs?: Record<string, unknown>): RunningStep {
  const running = become<RunningStep>(state, { status: 'running' });
  if (inputs) running.inputs = inputs;
  return running;
}

export function succeed(state: StepState, settlement: Settlement<SucceededStep>): SucceededStep {
  return become<SucceededStep>(state, { status: 'succeeded', outcome: 'success', ...settlement });
}

export function fail(state: StepState, settlement: Settlement<FailedStep>): FailedStep {
  return become<FailedStep>(state, { status: 'failed', outcome: 'failed', ...settlement });
}

/** A step that ran and did not succeed. */
export function stopped(step: StepState): boolean {
  switch (step.status) {
    case 'failed':
    case 'cancelled':
      return true;
    case 'pending':
    case 'leased':
    case 'running':
    case 'succeeded':
    case 'skipped':
      return false;
    default: {
      const unknown: never = step;
      return unknown;
    }
  }
}

/** A step that will not run again in this pass, so steps that need or read it can go on. */
export function settled(step: StepState | undefined): boolean {
  if (!step) return false;
  switch (step.status) {
    case 'succeeded':
    case 'failed':
    case 'skipped':
    case 'cancelled':
      return true;
    case 'pending':
    case 'leased':
    case 'running':
      return false;
    default: {
      const unknown: never = step;
      return unknown;
    }
  }
}
