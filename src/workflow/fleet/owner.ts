/**
 * The owner's side of the `fleet` runtime: a `StepRuntime` whose places are this host's, as `local` makes them, and
 * whose exec of a step's command, or prompt of a prompt step, offers the step on teamai-reports. A member of the pool
 * runs it, a prompt on its own tool, model and login, and pushes its work to the attempt's ref; the owner then
 * fast-forwards the place to that work, and the exec or prompt ends as the member's did. Any other exec of the place,
 * such as the workflow's setup, runs here. The owner need not stay up: an exec goes on
 * without the teamai that sent it (`isExecReconnected`), a restarted one sends the same id again and waits on the
 * record again, and a claim whose member wrote no progress for `stale_after` is given up.
 */
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { CanSchema, ISOLATION_LEVELS, WORKSPACE_MODES, type OpId, type OpState, type RuntimeOptions } from '@teamai/runtime-protocol';
import { getRepoIdentity } from '../../session-flow/sync.js';
import { readableReportsWorktree } from '../../utils/reports-branch.js';
import type { LocalConfig } from '../../types.js';
import { log } from '../../utils/logger.js';
import { durationMs } from '../parse.js';
import { budgetLeft, leaseContext } from '../engine.js';
import { answerQuestion, attemptRef, cancelAttempt, expireClaim, isHeld, fleetFailure, lastGoneWork, leaseEnv, leaseInputs, leasePrompt, leaseValues, markOffered, offerAttempt, readAttemptRecord, readOfferedMarker, DEFAULT_FLEET_POOL, type Claimed, type FleetLease, type FleetRecord, type FleetResult } from './record.js';
import { runDefinition } from '../snapshot.js';
import { AttemptIdSchema, installOwner, readRun, RunIdSchema, type AttemptId, type RunId } from '../store.js';
import { workflowRunBy, type WorkflowFailure } from '../types.js';
import type { WholeEnd } from '../whole-workflow.js';
import type { TokenUsage } from '../../tool-launch/stdout.js';
import { isJsonObject } from '../../types.js';
import { copyGit } from '../place/place.js';
import { git } from '../worktree.js';
import { localStepRuntime } from '../runtimes/local.js';
import type { ExecAnswer, ExecEnd, ExecEvents, ExecQuestion, PromptEnd, StepRuntime } from '../runtimes/step-runtime.js';
import { LAUNCH_TOOLS } from '../../tool-launch/tools.js';
import { DRIVER_ENV_REACH, DriverEnvSchema, LabelSchema } from '../requirements.js';

/** How often the owner reads the attempt's record while a member runs it. */
const RECORD_POLL_MS = 1_000;

/** The longest an owner waits between two reads of a record that did not change: each such read doubles the wait. */
const RECORD_POLL_MAX_MS = 30_000;

const FleetOptionsSchema = z.object({
  pool: z.string().min(1).default(DEFAULT_FLEET_POOL),
  stale_after: z.string().default('30m').transform((text, ctx) => {
    const ms = durationMs(text);

    if (ms !== undefined) return ms;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a positive duration, such as 90s, 30m or 2h' });

    return z.NEVER;
  }),
  /** `env: member`: a member gives each `requires.env` its value from its own team env, so this install needs none. */
  can: CanSchema.extend({ env: DriverEnvSchema.optional() }).optional(),
  /** What the pool's machines declare in their `workflows.labels`: a step that requires them goes to this entry. */
  labels: z.array(LabelSchema).optional(),
}).strict();

/** The options of the `fleet` runtime, as `init` checks a runtime's own: its pool, `stale_after` in milliseconds, `can` and `labels`. */
export function parseFleetOptions(options: RuntimeOptions): { ok: true; value: z.infer<typeof FleetOptionsSchema> } | { ok: false; failure: { key: string; message: string } } {
  const parsed = FleetOptionsSchema.safeParse(options);

  if (parsed.success) return { ok: true, value: parsed.data };
  const [issue] = parsed.error.issues;

  return { ok: false, failure: { key: issue?.path.join('.') || 'pool', message: issue?.message ?? 'not valid' } };
}

/** The flags a step may need, which an entry that offers them takes it for. */
const NEEDED_FLAGS = ['hitl', 'network', 'tokens', 'max_turns', 'setup', 'end_turn', 'unattended', 'role'] as const;

/** A fleet entry's `can`, with its `labels`. */
type FleetCan = NonNullable<z.infer<typeof FleetOptionsSchema>['can']> & { labels?: readonly string[] };

/**
 * Whether a fleet entry that offers `earlier` takes every step one that offers `later` could take, so the later one never
 * gets a step. What cannot be ordered, the tools and the confined offers, must be the same.
 */
function coversCan(earlier: FleetCan, later: FleetCan): boolean {
  if ((later.labels ?? []).some((label) => !(earlier.labels ?? []).includes(label))) return false;

  if (NEEDED_FLAGS.some((flag) => later[flag] === true && earlier[flag] !== true)) return false;

  // A runtime runs commands unless it says it does not.
  if (later.exec !== false && earlier.exec === false) return false;

  if (ISOLATION_LEVELS.indexOf(later.isolation ?? 'none') > ISOLATION_LEVELS.indexOf(earlier.isolation ?? 'none')) return false;

  if (DRIVER_ENV_REACH.indexOf(later.env ?? false) > DRIVER_ENV_REACH.indexOf(earlier.env ?? false)) return false;

  return isDeepStrictEqual(earlier.tools, later.tools) && isDeepStrictEqual(earlier.confined, later.confined);
}

/**
 * A warning for each fleet entry of `runtimes`, a driver definition's, that an earlier fleet entry shadows: the first
 * entry whose `can` fits a step takes it, so an entry whose `can` an earlier one covers never gets one. An entry whose
 * options do not parse is left to its own check.
 */
export function shadowedFleetEntries(runtimes: ReadonlyArray<{ use: string; through?: string; options?: RuntimeOptions }>): string[] {
  const seen: Array<{ pool: string; can: FleetCan }> = [];
  const warnings: string[] = [];

  for (const entry of runtimes) {
    if (entry.use !== 'fleet' || entry.through !== undefined) continue;
    // What teamai takes for itself (`engineOptions`) never reaches the runtime's own check.
    const { max_parallel: _parallel, credentials: _credentials, ...options } = entry.options ?? {};
    const parsed = parseFleetOptions(options);

    if (!parsed.ok) continue;
    const { pool, can: offered = {}, labels } = parsed.value;
    const can = labels ? { ...offered, labels } : offered;
    const earlier = seen.find((one) => coversCan(one.can, can));

    if (earlier) warnings.push(`The fleet entry for pool "${pool}" never gets a step: the fleet entry for pool "${earlier.pool}" before it offers everything it does, and takes each step first. Put the more specific entry first.`);
    seen.push({ pool, can });
  }

  return warnings;
}

/** How the owner's wait on an attempt ended: as the member's step did, cancelled, failed, or left out as this teamai stops. */
type Waited =
  | { kind: 'finished'; result: FleetResult }
  | { kind: 'cancelled'; message: string; tokens?: TokenUsage }
  | { kind: 'failed'; failure: WorkflowFailure }
  | { kind: 'left' };

/** The place of an attempt on the fleet: its handle names the run and the attempt, so a restarted teamai reads it again. */
type FleetPlace = { run: RunId; attempt: AttemptId };

function placeHandle({ run, attempt }: FleetPlace): string {
  return `fleet-${run}-${attempt}`;
}

function placeOf(handle: string): FleetPlace | undefined {
  const [, run, attempt] = /^fleet-([^-]+)-([^-]+)$/.exec(handle) ?? [];
  const parsedRun = RunIdSchema.safeParse(run);
  const parsedAttempt = AttemptIdSchema.safeParse(attempt);

  return parsedRun.success && parsedAttempt.success ? { run: parsedRun.data, attempt: parsedAttempt.data } : undefined;
}

/** The handle of the same place on `local`, which runs every exec that is not the step's command. */
function localHandle({ run, attempt }: FleetPlace): string {
  return `local-${run}-${attempt}`;
}

/** What a record says of the exec that offered it, to a teamai that did not see it end. */
function recordState(op: OpId, record: FleetRecord | 'absent'): OpState {
  if (record === 'absent') return { op, state: 'running' };

  switch (record.state) {
    case 'offered':
    case 'claimed':
    case 'asking':
    case 'answered':
      return { op, state: 'running' };
    // The member was asked to stop, and nothing of the step runs on this machine: the record ends cancelled or expired.
    case 'cancelling':
    case 'withdrawn':
      return { op, state: 'cancelled' };
    // A whole workflow ends with what its steps spent before it stopped, as the live end gives it.
    case 'cancelled':
      return record.lease.kind === 'workflow' && record.tokens ? { op, state: 'cancelled', stdout: cancelledWholeStdout(cancelledMessage(record), record.tokens) } : { op, state: 'cancelled' };
    case 'finished':
      return finishedState(op, record);

    case 'expired':
      return { op, state: 'failed', failure: { code: 'fleet_member_gone', message: `The fleet member ${record.member.user} that took step "${record.lease.step}" stopped writing progress, so the attempt was given up.` } };
    default: {
      const unhandled: never = record;

      return unhandled;
    }
  }
}

/** What a cancelled record says the member did, for the person. */
function cancelledMessage(record: Extract<FleetRecord, { state: 'cancelled' }>): string {
  return `Step "${record.lease.step}" was cancelled, and the fleet member ${record.member.user} that ran it stopped it.${record.pushed === record.start ? '' : ` Its work up to ${record.pushed} is kept.`}`;
}

/** The stdout of a whole workflow step that ended cancelled: what its steps spent before it stopped, which the budgets around the step count. */
function cancelledWholeStdout(message: string, tokens: TokenUsage): string {
  return JSON.stringify({ outcome: 'failed', failure: { code: 'cancelled', message }, tokens } satisfies WholeEnd);
}

/** What a finished record says of the exec that offered it: a command or a whole workflow exited, a prompt finished or failed. */
function finishedState(op: OpId, { lease, result, attempt }: Extract<FleetRecord, { state: 'finished' }>): OpState {
  switch (lease.kind) {
    case 'command': return { op, state: 'exited', code: result.exitCode, stdout: result.outputs === undefined ? '' : JSON.stringify(result.outputs) };
    case 'workflow': return { op, state: 'exited', code: result.exitCode, stdout: JSON.stringify(wholeEnd(result)) };
    case 'prompt': {
      const ended = promptEnded(result, attempt);

      return ended.kind === 'finished' ? { op, state: 'finished', session: ended.session, result: ended.result, ...(ended.usage && { usage: ended.usage }) } : { op, state: 'failed', failure: ended.failure };
    }

    default: {
      const unhandled: never = lease;

      return unhandled;
    }
  }
}

/** How a whole workflow a member finished ended, as the fleet's exec answers it on stdout. */
function wholeEnd(result: FleetResult): WholeEnd {
  const outputs = result.outputs !== undefined && isJsonObject(result.outputs) ? result.outputs : undefined;

  return {
    outcome: result.exitCode === 0 && result.failure === undefined ? 'succeeded' : 'failed',
    ...(result.end !== undefined && { end: result.end }), ...(outputs !== undefined && { outputs }), ...(result.failure && { failure: result.failure }),
    ...(result.tokens !== undefined && { tokens: result.tokens }),
  };
}

/**
 * How a prompt a member finished ends for the owner: with the tool it picked and the result and usage it wrote, or, when
 * it launched no tool, as the failure that stopped it. Its session is the one the member pushed to the team session
 * archive; a member that named none leaves `attempt` in its place, which no later step finds to continue.
 */
function promptEnded(result: FleetResult, attempt: AttemptId): Extract<PromptEnd, { kind: 'finished' | 'failed' }> {
  if (result.tool === undefined) return { kind: 'failed', failure: result.failure ?? { code: 'tool_failed', message: result.stderr || 'The fleet member launched no tool for the prompt step.' } };

  return {
    kind: 'finished', session: { tool: result.tool, id: result.session ?? attempt },
    result: { ...(result.outputs !== undefined && { output: result.outputs }), ...(result.failure && { failure: result.failure }) },
    ...(result.tokens && { usage: result.tokens }),
  };
}

/**
 * The `fleet` runtime of this install: each step's command or prompt it takes is offered to the members of its pool. `masks`
 * holds the values an offer may not carry, which the drive adds to as it resolves the team's secrets.
 */
export function fleetStepRuntime({ config, masks }: { config: LocalConfig; masks: Record<string, string> }): StepRuntime {
  const local = localStepRuntime();
  const disposing = new AbortController();
  // The wait of each exec this teamai sent, by its id, so a repeated id reconnects to it and a cancel reaches it.
  const waits = new Map<OpId, { place: FleetPlace; cancel: AbortController; end: Promise<Waited>; isWhole: boolean }>();
  // The exec of each place a restarted teamai read, so a cancel of it with no wait here reaches its record.
  const seen = new Map<OpId, FleetPlace>();
  let settings: { pool: string; staleAfterMs: number; root: string } | undefined;

  // A whole workflow's exec answers how its nested run ended on stdout (`WholeEndSchema`).
  const ended = (waited: Waited, events: ExecEvents, isWhole = false): ExecEnd => {
    switch (waited.kind) {
      case 'finished': {
        const { result } = waited;

        if (result.stderr !== '') events.onOutput?.('stderr', result.stderr);

        if (isWhole) return { kind: 'exited', code: result.exitCode, stdout: JSON.stringify(wholeEnd(result)) };

        return { kind: 'exited', code: result.exitCode, stdout: result.outputs === undefined ? '' : JSON.stringify(result.outputs) };
      }

      case 'cancelled':
        events.onOutput?.('stderr', waited.message);

        // What a whole workflow's steps spent before it stopped, which the budgets around the step count.
        return isWhole && waited.tokens ? { kind: 'cancelled', stdout: cancelledWholeStdout(waited.message, waited.tokens) } : { kind: 'cancelled' };
      case 'failed':
        return { kind: 'failed', failure: waited.failure, isStepOutcome: true };
      // Only a disposed runtime ends a wait this way, once its teamai no longer reads the exec.
      case 'left':
        return { kind: 'failed', failure: { code: 'runtime_interrupted', message: 'teamai stopped while the step waited on a fleet member; the attempt stays out for a later teamai workflow resume.' } };
      default: {
        const unhandled: never = waited;

        return unhandled;
      }
    }
  };

  const promptEnd = (waited: Waited, attempt: AttemptId): PromptEnd => {
    if (waited.kind === 'finished') return promptEnded(waited.result, attempt);
    const end = ended(waited, {});

    return end.kind === 'exited' ? { kind: 'failed', failure: { code: 'runtime_protocol', message: 'The fleet ended a prompt as a command.' } } : end;
  };

  /** Offers step `lease` of `place` from the place `dir` under id `op`, and waits for the member that takes it. */
  const offerLease = async ({ place, lease, dir, op, ask }: { place: FleetPlace; lease: FleetLease; dir: string; op: OpId; ask?: ExecEvents['ask'] }, onAccepted: () => void): Promise<Waited> => {
    if (!settings) return { kind: 'failed', failure: { code: 'runtime_protocol', message: 'The fleet runtime was not initialized.' } };
    const cancel = new AbortController();
    const end = offerAndWait({ config, ...place, ...settings, lease, dir, secrets: masks, op, ask }, { cancel: cancel.signal, leave: disposing.signal });
    waits.set(op, { place, cancel, end, isWhole: lease.kind === 'workflow' });
    onAccepted();

    try {
      return await end;
    } finally {
      waits.delete(op);
    }
  };

  return {
    name: 'fleet',
    isExecReconnected: true,
    isToolPickedThere: true,

    async init({ options, checkout }) {
      const parsed = parseFleetOptions(options);

      if (!parsed.ok) return { ok: false, failure: { code: 'bad_option', ...parsed.failure } };
      // No person sits at a member's tool, whatever the entry promises, so no interactive step goes to the fleet.
      const { pool, stale_after: staleAfterMs, can: { hitl: _hitl, ...can } = {}, labels } = parsed.value;
      settings = { pool, staleAfterMs, root: checkout ?? process.cwd() };

      // A step's place is this host's, so the fleet offers the workspaces this machine does. A member runs a prompt on a
      // tool of its own, so the fleet takes a prompt step on any tool unless its entry names the tools its pool has. A
      // member drives a whole workflow's steps itself, so the fleet takes a workflow step whole when its steps fit.
      return { ok: true, can: { ...can, tools: can.tools ?? [...LAUNCH_TOOLS], remote: true, workspace: [...WORKSPACE_MODES], workflow: true, ...(labels && { labels }) }, launchesAgents: true };
    },

    async open(request, onAccepted) {
      const handle = placeHandle({ run: RunIdSchema.parse(request.run), attempt: AttemptIdSchema.parse(request.attempt) });
      await onAccepted(handle);

      return { kind: 'ready', handle };
    },

    async exec(request, events, kind) {
      const place = placeOf(request.handle);

      if (!place || !settings) return { kind: 'failed', failure: { code: 'runtime_protocol', message: `The fleet runtime has no place ${request.handle}${settings ? '' : ', or was not initialized'}.` } };
      const accepted = (): void => events.onAccepted?.({});

      const live = waits.get(request.op);

      if (live) {
        accepted();

        return ended(await live.end, events, live.isWhole);
      }

      // Setup, or any exec besides the step's command or a whole workflow, runs in the place on this host.
      if (kind !== 'command' && kind !== 'workflow') return local.exec({ ...request, handle: localHandle(place) }, events, kind);
      const leased = await leasedStep(config, place);

      if ('error' in leased) return { kind: 'failed', failure: { code: leased.isFatal ? 'run_unreadable' : 'runtime_protocol', message: leased.error } };
      const isWhole = leased.kind === 'workflow';

      if (leased.kind !== kind) return { kind: 'failed', failure: { code: 'runtime_protocol', message: `Attempt ${place.attempt} of run ${place.run} leases no ${kind === 'workflow' ? 'whole workflow' : 'command step'}.` } };

      return ended(await offerLease({ place, lease: leased, dir: request.cwd, op: request.op, ask: events.ask }, accepted), events, isWhole);
    },

    // The member picks the tool, model and login and renders the prompt itself: what the request names of them is this
    // host's, and is not sent.
    async prompt(request, events) {
      const place = placeOf(request.handle);

      if (!place || !settings) return { kind: 'failed', failure: { code: 'runtime_protocol', message: `The fleet runtime has no place ${request.handle}${settings ? '' : ', or was not initialized'}.` } };
      const accepted = (): void => events.onAccepted?.({});
      const live = waits.get(request.op);

      if (live) {
        accepted();

        return promptEnd(await live.end, place.attempt);
      }

      const leased = await leasedStep(config, place);

      if ('error' in leased) return { kind: 'failed', failure: { code: leased.isFatal ? 'run_unreadable' : 'runtime_protocol', message: leased.error } };

      if (leased.kind !== 'prompt') return { kind: 'failed', failure: { code: 'runtime_protocol', message: `Attempt ${place.attempt} of run ${place.run} leases no prompt step.` } };

      return promptEnd(await offerLease({ place, lease: leased, dir: request.cwd, op: request.op }, accepted), place.attempt);
    },

    async cancel(op) {
      const live = waits.get(op);

      if (live) {
        live.cancel.abort();
        await live.end;

        return;
      }

      const place = seen.get(op);

      if (!place) {
        await local.cancel(op);

        return;
      }

      // A teamai before this one offered it: only the attempt's record reaches its member.
      const asked = await cancelFleetAttempt(config, place.run, place.attempt);

      if (asked.ok) log.info(asked.message);
      else log.warn(asked.message);
    },

    async collect(handle) {
      const place = placeOf(handle);

      return place ? local.collect(localHandle(place)) : { ok: true };
    },

    async reattach(handle) {
      const place = placeOf(handle);

      if (!place) return { kind: 'gone' };
      const offered = await offeredExec(config, place);

      if (offered === undefined) return { kind: 'alive', ops: [] };
      seen.set(offered, place);
      const read = await readAttemptRecord(config, place.run, place.attempt);

      if (!read.ok) return { kind: 'failed', failure: { code: read.error.code, message: read.error.message } };

      return { kind: 'alive', ops: [recordState(offered, read.value)] };
    },

    async close(handle) {
      const place = placeOf(handle);

      return place ? local.close(localHandle(place)) : { ok: true };
    },

    async dispose() {
      disposing.abort();
      await Promise.all([...waits.values()].map(async (wait) => wait.end));
      await local.dispose();
    },
  };
}

/**
 * The step leased with attempt `attempt` as the fleet offers it: its command, or the prompt and the limits it was
 * granted, with its env, as a member renders them from the offer's values. Or why there is none: `isFatal` when the run
 * cannot be read at all.
 */
async function leasedStep(config: LocalConfig, { run, attempt }: FleetPlace): Promise<FleetLease | { error: string; isFatal: boolean }> {
  const state = await readRun(config, run);

  if (state === 'missing' || state === 'corrupt') return { error: `Run ${run} is ${state} here, so its step was not offered to the fleet.`, isFatal: true };
  const step = state.steps.find((item) => item.status === 'leased' && item.lease.attempt === attempt);
  const leased = step?.status === 'leased' ? leaseContext(state, step.id) : undefined;

  if (!step || step.status !== 'leased' || !leased || (leased.step.command === undefined && leased.step.workflow === undefined && (leased.step.prompt === undefined || leased.step.answer !== undefined))) {
    return { error: `Attempt ${attempt} of run ${run} leases no command, prompt or workflow step.`, isFatal: false };
  }

  const values = leaseValues(leased.step, leased.context);

  if ('error' in values) return { error: values.error, isFatal: true };

  if (leased.step.workflow !== undefined) {
    const child = workflowRunBy(state, leased.step, '');

    if (child === undefined) return { error: `Run ${run} step "${step.id}" runs a workflow this run did not keep.`, isFatal: true };
    const inputs = leaseInputs(leased.step, child, values.values, run);

    if ('error' in inputs) return { error: `Step "${step.id}" ${inputs.error}`, isFatal: true };
    const tokens = budgetLeft(state, step.id);

    return { kind: 'workflow', step: step.id, inputs: inputs.inputs, env: {}, ...(tokens !== undefined && { budget: { tokens } }) };
  }

  const env = leaseEnv(leased.step, values.values, run);

  if ('error' in env) return { error: env.error, isFatal: true };

  if (leased.step.command !== undefined) return { kind: 'command', step: step.id, command: leased.step.command, env: env.env };
  const texts = leasePrompt(leased.step, values.values, run);

  if ('error' in texts) return { error: texts.error, isFatal: true };
  const { limits } = step.lease;

  return { kind: 'prompt', step: step.id, prompt: texts.prompt, env: env.env, ...(limits !== undefined && { limits }) };
}

/** The id of the exec that offered the attempt at `place` from this install, recorded with its pool. */
async function offeredExec(config: LocalConfig, place: FleetPlace): Promise<OpId | undefined> {
  return (await readOfferedMarker(config, place.run, place.attempt))?.op;
}

type WaitInput = {
  config: LocalConfig; run: RunId; attempt: AttemptId; pool: string; staleAfterMs: number; lease: FleetLease; root: string; dir: string;
  secrets: Record<string, string>; op: OpId;
  /** Asks this driver's person a gate the member's whole workflow reached. Absent: nobody answers here. */
  ask?: ExecEvents['ask'];
};

/**
 * Offers step `lease` of attempt `attempt` to pool `pool`, from the place `dir`, a copy of checkout `root`, unless
 * an earlier drive offered it, and settles once a member finished it, with the result it wrote, after the place took the
 * commits the member pushed. `secrets` are the
 * values the offer may not carry. `cancel`: the run cancelled the step, which the owner writes into the record and waits
 * for the member to answer. `leave`: this teamai stops, and the attempt stays out for a later `workflow resume <run>`.
 */
async function offerAndWait(input: WaitInput, { cancel, leave }: { cancel: AbortSignal; leave: AbortSignal }): Promise<Waited> {
  const { config, run, attempt, lease, root, dir, secrets, op, ask } = input;
  const { step } = lease;
  const failed = (failure: WorkflowFailure): Waited => ({ kind: 'failed', failure });
  const ref = attemptRef(run, attempt);
  const earlier = await readAttemptRecord(config, run, attempt);

  if (!earlier.ok) return failed(fleetFailure(earlier.error));
  // An attempt offered before waits on the pool and stale_after its offer named, and one this exec noted but a killed
  // teamai never wrote is offered as noted, whatever fleet entry reached it now.
  const noted = earlier.value === 'absent' ? await readOfferedMarker(config, run, attempt) : undefined;
  const { pool, staleAfterMs } = earlier.value !== 'absent' ? earlier.value : noted?.op === op ? { pool: noted.pool, staleAfterMs: noted.staleAfterMs ?? input.staleAfterMs } : input;

  if (earlier.value === 'absent') {
    const repository = getRepoIdentity(root);

    if (repository === null) return failed({ code: 'origin_unavailable', message: `${root} has no origin, so no fleet member can take step "${step}". Add origin, or run the step on another runtime.` });
    // A member renders the step itself from the run's definitions and these values; the lease it is checked against.
    const state = await readRun(config, run);
    const leased = state === 'missing' || state === 'corrupt' ? undefined : leaseContext(state, step);

    if (state === 'missing' || state === 'corrupt' || leased === undefined) return failed({ code: 'run_unreadable', message: `Run ${run} has no definition for step "${step}" here, so it was not offered to the fleet.` });
    const values = leaseValues(leased.step, leased.context);

    if ('error' in values) return failed({ code: 'invalid_template', message: values.error });
    const resumed = await goOnFromGoneWork({ config, run, root, dir, step });

    if (resumed) return failed(resumed);
    const start = (await git(dir, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
    // The checkout's own git pushes: the copy shares its objects, and a step may have written the copy's config.
    const pushed = await git(root, ['push', '--quiet', 'origin', `${start}:${ref}`]);

    if (pushed.code !== 0) return failed({ code: 'push_failed', message: `Step "${step}" could not push its start commit to ${ref} on origin, so no fleet member can take it: ${pushed.stderr.trim()}` });
    await markOffered(config, run, attempt, pool, { op, staleAfterMs });
    // A member reads the step's labels from its own copy of the workflow, so the record carries none.
    const offered = await offerAttempt(config, { run, attempt, pool, repository, owner: await installOwner(config), start, staleAfterMs, lease, definition: runDefinition(state), values: values.values, secrets });

    if (!offered.ok) return failed(fleetFailure(offered.error));
  }

  // Staleness counts on this machine's clock, from when it last saw the record change: a member's clock may be off. A
  // cancel goes through the record, and waits for the member's answer as long as for its progress.
  let lastSeen: { write: string; at: number } | undefined;
  let isCancelWritten = false;
  // When this wait first saw the cancel, on this machine's clock.
  let cancelledAt: number | undefined;
  // The gate the member asks, put to this driver's person once: `answer` once the person answered.
  let asked: Asked | undefined;
  // Each reason a member gave on the offer for leaving it, shown once, by member and reason.
  const shownLeft = new Set<string>();
  // A record that does not change is read less often, down to a third of stale_after, so a staleness is seen in time.
  const slowestPollMs = Math.min(RECORD_POLL_MAX_MS, Math.max(RECORD_POLL_MS, Math.floor(staleAfterMs / 3)));
  let pollMs = RECORD_POLL_MS;

  for (;;) {
    if (leave.aborted) return { kind: 'left' };
    const read = await readAttemptRecord(config, run, attempt);

    if (!read.ok && (read.error.code === 'fleet_record_unreadable' || read.error.code === 'fleet_record_newer')) return failed(fleetFailure(read.error));
    const record = read.ok && read.value !== 'absent' ? read.value : undefined;

    if (record?.state === 'finished') {
      const { result } = record;
      const taken = result.to === undefined ? undefined : await takeWork({ config, run, root, dir, ref, to: result.to, step });

      if (taken) return failed(taken);

      return { kind: 'finished', result };
    }

    if (record?.state === 'expired') return failed(await gone(record, { config, run, root, dir, ref, staleAfterMs }));

    if (record?.state === 'withdrawn') return { kind: 'cancelled', message: `Step "${step}" was cancelled before a member of fleet pool ${pool} took it.` };

    if (record?.state === 'cancelled') {
      const taken = record.pushed === record.start ? undefined : await takeWork({ config, run, root, dir, ref, to: record.pushed, step });

      if (taken) return failed(taken);

      return { kind: 'cancelled', message: cancelledMessage(record), ...(record.tokens && { tokens: record.tokens }) };
    }

    for (const { member, why } of record?.state === 'offered' ? record.left ?? [] : []) {
      const key = `${member.id}\u0000${why}`;

      if (shownLeft.has(key)) continue;
      shownLeft.add(key);
      log.warn(`Fleet member ${member.user} left step "${step}" of run ${run} for another member of pool ${pool}: ${why}. The step waits for a member that can run it; to stop waiting, run teamai workflow cancel ${run}.`);
    }

    if (record !== undefined && record.write !== lastSeen?.write) {
      lastSeen = { write: record.write, at: Date.now() };
      pollMs = RECORD_POLL_MS;
    }

    // A question closes once a read shows the record no longer asks it: the member read the answer, or the claim ended.
    // A read that failed shows nothing, and the person's answer, given or on its way, is kept for the next.
    if (asked !== undefined && read.ok && (record === undefined || (record.state !== 'asking' && record.state !== 'answered') || JSON.stringify(record.question) !== asked.question)) {
      asked.closed.abort();
      asked = undefined;
    }

    if (record?.state === 'asking' && asked === undefined) asked = askPerson(record.question, ask, { step, member: record.member.user });

    // The answer goes over what the record holds now, which still asks it: the member's progress may have landed meanwhile.
    if (record?.state === 'asking' && asked?.answer !== undefined) {
      const written = await answerQuestion(config, record, asked.answer, secrets);

      // Once written, the answer is spent: the member asking the same again, as when its run did not take the answer,
      // asks the person again.
      if (written.ok) {
        asked = undefined;
        continue;
      }

      const { error } = written;

      switch (error.code) {
        // The member's progress landed first: the answer goes over the record read next.
        case 'state_moved':
          continue;
        // teamai-reports was busy or out of reach: the answer is kept and written at the next poll, while the member waits.
        case 'reports_failed':
        case 'reports_unreachable':
          break;
        // The person's note holds a secret or a local path, which teamai-reports must not: the person answers again.
        case 'fleet_unpublishable':
          log.warn(`${error.message} Answer the question of step "${step}" again, with no secret or local path in the note.`);
          asked.closed.abort();
          asked = undefined;
          continue;
        case 'fleet_record_unreadable':
        case 'fleet_record_newer':
          return failed(fleetFailure(error));
        default: {
          const unhandled: never = error;

          return unhandled;
        }
      }
    }

    if ((record !== undefined && (isHeld(record) || record.state === 'cancelling')) && lastSeen !== undefined && Date.now() - lastSeen.at > staleAfterMs) {
      const expired = await expireClaim(config, record);

      // The member wrote meanwhile: it is still there.
      if (expired.ok) return failed(await gone(expired.value, { config, run, root, dir, ref, staleAfterMs }));

      if (expired.error.code !== 'state_moved') return failed(fleetFailure(expired.error));
      continue;
    }

    if (cancel.aborted && !isCancelWritten) {
      cancelledAt ??= Date.now();

      // A read that failed shows nothing: the cancel is written once a read shows the record again, for as long as a
      // member's answer is waited on, so the offer does not stay out for a member to take.
      if (record === undefined) {
        if (read.ok) return failed({ code: 'runtime_interrupted', message: `Step "${step}" was cancelled, and its attempt has no record on fleet pool ${pool}, so no member was asked to stop it.` });

        if (Date.now() - cancelledAt > staleAfterMs) return failed({ code: 'runtime_interrupted', message: `Step "${step}" was cancelled, and the record of its attempt on fleet pool ${pool} could not be read for ${staleAfterMs / 1_000} s, so no member was asked to stop it, and a member may still take its offer. ${read.error.message}` });
      } else if (record.state === 'offered' || isHeld(record)) {
        const written = await cancelAttempt(config, record);

        if (written.ok) {
          isCancelWritten = true;
          continue;
        }

        const { error } = written;

        switch (error.code) {
          // Another write landed first, such as the member's progress: the cancel is written over what is read next.
          case 'state_moved': continue;
          // teamai-reports is busy, as with this install's own publish, or out of reach: the cancel is written at the
          // next poll, so the offer does not stay out for a member to take.
          case 'reports_failed':
          case 'reports_unreachable': break;
          case 'fleet_unpublishable':
          case 'fleet_record_unreadable':
          case 'fleet_record_newer': return failed(fleetFailure(error));
          default: {
            const unhandled: never = error;

            return unhandled;
          }
        }
      }
    }

    // An answer kept from a failed write waits for the next poll, not for the person.
    const woken = AbortSignal.any([cancel, leave, ...(asked !== undefined && asked.answer === undefined ? [asked.answered.signal] : [])]);
    await sleep(pollMs, undefined, cancel.aborted ? { signal: leave } : { signal: woken }).catch(() => undefined);
    pollMs = Math.min(pollMs * 2, slowestPollMs);
  }
}

/** A gate put to this driver's person: the question as the record holds it, closed once the record no longer asks it, and the answer once given. */
type Asked = { question: string; closed: AbortController; answered: AbortController; answer?: ExecAnswer };

/**
 * Puts `question`, a gate the whole workflow of step `step` reached on fleet member `member`, to this driver's person
 * through `ask`, until the answer is a choice the gate offers or none comes. Without `ask`, nobody answers here.
 */
function askPerson(question: ExecQuestion, ask: ExecEvents['ask'], { step, member }: { step: string; member: string }): Asked {
  const closed = new AbortController();
  const answered = new AbortController();
  const asked: Asked = { question: JSON.stringify(question), closed, answered };
  const nobody = `Step "${question.step}" of the workflow step "${step}", on fleet member ${member}, needs an answer, and nobody answers it where the run is driven. Resume the run from a terminal where a person answers, in an attended run.`;

  void (async () => {
    for (;;) {
      const answer = ask === undefined ? { refused: nobody } : await ask(question, closed.signal).catch(() => ({ refused: `The driver where the run is driven could not ask its person step "${question.step}".` }));

      if (closed.signal.aborted) return;

      if ('choice' in answer && !question.options.includes(answer.choice)) {
        log.warn(`"${answer.choice}" is not a choice of step "${question.step}": answer one of ${question.options.join(', ')}.`);
        continue;
      }

      asked.answer = answer;
      answered.abort();

      return;
    }
  })();

  return asked;
}

/**
 * Takes into place `dir` the work a member of an earlier attempt of `step` pushed before its claim was given up, so a
 * retry goes on from it.
 */
async function goOnFromGoneWork({ config, run, root, dir, step }: { config: LocalConfig; run: RunId; root: string; dir: string; step: string }): Promise<WorkflowFailure | undefined> {
  try {
    await readableReportsWorktree(config);
  } catch (error) {
    return { code: 'reports_unreachable', message: `teamai-reports could not be read, so step "${step}" was not offered to the fleet: ${error instanceof Error ? error.message : String(error)}` };
  }

  const earlier = await lastGoneWork(config, { run, step });

  if (earlier === undefined) return undefined;
  const ref = attemptRef(run, earlier.attempt);
  const fetched = await git(root, ['fetch', '--quiet', 'origin', ref]);

  if (fetched.code !== 0) return { code: 'fetch_failed', message: `Step "${step}" goes on from the work attempt ${earlier.attempt} pushed to ${ref}, which could not be fetched: ${fetched.stderr.trim()}` };
  // A step ran in the copy before, so its config may name programs.
  const merged = await (await copyGit(config, { run, root }))(dir, ['merge', '--no-edit', '--quiet', earlier.pushed]);

  if (merged.code !== 0) return { code: 'workspace_base', message: `Step "${step}" goes on from the work attempt ${earlier.attempt} pushed (${earlier.pushed}), which its place could not take: ${merged.stderr.trim()}` };

  return undefined;
}

/** Fails a claim given up as stale, once the place took the last commit its member pushed, which a retry goes on from. */
async function gone(claim: Pick<Claimed, 'member' | 'progressAt' | 'pushed' | 'start' | 'lease'> & { cancelAt?: string }, place: PlaceOf & { staleAfterMs: number }): Promise<WorkflowFailure> {
  const { member, progressAt, pushed, start, lease, cancelAt } = claim;
  const { staleAfterMs } = place;
  const taken = pushed === start ? undefined : await takeWork({ ...place, to: pushed, step: lease.step });
  const kept = pushed === start ? 'It pushed no work.' : `Its work up to ${pushed} is kept, and a retry goes on from it.`;
  const silent = cancelAt === undefined ? `wrote no progress since ${progressAt}` : `did not answer the cancel written at ${cancelAt}`;
  const message = `The fleet member ${member.user} that took step "${lease.step}" ${silent}, longer than ${staleAfterMs / 1_000} s, so the attempt was given up. ${kept}`;

  return taken ? { ...taken, message: `${message} ${taken.message}` } : { code: 'fleet_member_gone', message };
}

/** The owner's place of an attempt: `dir`, a copy of checkout `root` for run `run`, and the attempt's ref. */
type PlaceOf = { config: LocalConfig; run: RunId; root: string; dir: string; ref: string };

/** Fast-forwards place `dir` to `to`, a commit a member pushed to `ref`. */
async function takeWork({ config, run, root, dir, ref, to, step }: PlaceOf & { to: string; step: string }): Promise<WorkflowFailure | undefined> {
  // A step with no workspace runs in the checkout, whose branch only the person moves.
  if (dir === root) return { code: 'read_only_dirty', message: `Step "${step}" has no workspace, and the fleet member that ran it changed files (${to} on ${ref}), which teamai does not take into ${root}. Give the step a workspace, such as workspace: new, to keep its work.` };
  const fetched = await git(root, ['fetch', '--quiet', 'origin', ref]);

  if (fetched.code !== 0) return { code: 'fetch_failed', message: `Step "${step}" ran on a fleet member, and its work could not be fetched from ${ref}: ${fetched.stderr.trim()}` };
  // A step ran in the copy before, so its config may name programs.
  const merged = await (await copyGit(config, { run, root }))(dir, ['merge', '--ff-only', '--quiet', to]);

  if (merged.code !== 0) return { code: 'workspace_base', message: `Step "${step}" ran on a fleet member, and its place could not take the member's commit ${to}: ${merged.stderr.trim()}` };

  return undefined;
}

/**
 * Cancels attempt `attempt` of run `run` through its record, for `teamai workflow cancel` with no live driver of the run:
 * an offer is withdrawn, and a claim's member is asked to stop, which it answers at its next read of the record. Answers
 * what it did, for the person.
 */
export async function cancelFleetAttempt(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<{ ok: boolean; message: string }> {
  for (;;) {
    const read = await readAttemptRecord(config, run, attempt);

    if (!read.ok) return { ok: false, message: `Attempt ${attempt} of run ${run} is out on the fleet, and its record could not be read, so its member was not asked to stop: ${read.error.message} Run teamai workflow cancel ${run} again.` };
    const record = read.value;

    if (record === 'absent' || (record.state !== 'offered' && !isHeld(record))) return { ok: true, message: `Attempt ${attempt} of run ${run} was out on the fleet, and its record already says it is ${record === 'absent' ? 'not offered' : record.state}.` };
    const cancel = await cancelAttempt(config, record);

    if (cancel.ok) {
      return { ok: true, message: record.state === 'offered'
        ? `Withdrew attempt ${attempt} of run ${run}, which no fleet member had taken.`
        : `Asked the fleet member ${record.member.user} that runs attempt ${attempt} of run ${run} to stop it: it stops the step at its next read of the attempt's record and pushes its work, which a retry goes on from.` };
    }

    if (cancel.error.code !== 'state_moved') return { ok: false, message: `Attempt ${attempt} of run ${run} is out on the fleet, and its cancel could not be written: ${cancel.error.message} Run teamai workflow cancel ${run} again.` };
  }
}
