/**
 * The owner's side of the `fleet` runtime: a `StepRuntime` whose places are this host's, as `local` makes them, and
 * whose exec of a step's command offers it on teamai-reports. A member of the pool runs it and pushes its work to the
 * attempt's ref; the owner then fast-forwards the place to that work, and the exec ends as the member's command did.
 * Any other exec of the place, such as the workflow's setup, runs here. The owner need not stay up: an exec goes on
 * without the teamai that sent it (`isExecReconnected`), a restarted one sends the same id again and waits on the
 * record again, and a claim whose member wrote no progress for `stale_after` is given up.
 */
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { CanSchema, WORKSPACE_MODES, type OpId, type OpState, type RuntimeOptions } from '@teamai/runtime-protocol';
import { getRepoIdentity } from '../../session-flow/sync.js';
import { readableReportsWorktree } from '../../utils/reports-branch.js';
import type { LocalConfig } from '../../types.js';
import { log } from '../../utils/logger.js';
import { durationMs } from '../parse.js';
import { leaseContext } from '../engine.js';
import { attemptRef, cancelAttempt, expireClaim, fleetFailure, lastGoneWork, leaseEnv, leaseValues, markOffered, offerAttempt, readAttemptRecord, readOfferedMarker, DEFAULT_FLEET_POOL, type Claimed, type FleetRecord } from './record.js';
import { runDefinition } from '../snapshot.js';
import { AttemptIdSchema, installOwner, readRun, RunIdSchema, type AttemptId, type RunId } from '../store.js';
import type { WorkflowFailure } from '../types.js';
import { copyGit } from '../place/place.js';
import { git } from '../worktree.js';
import { shellArgv } from '../shell-command.js';
import { localStepRuntime } from '../runtimes/local.js';
import type { ExecEnd, ExecEvents, StepRuntime } from '../runtimes/step-runtime.js';

/** How often the owner reads the attempt's record while a member runs it. */
const RECORD_POLL_MS = 1_000;

const FleetOptionsSchema = z.object({
  pool: z.string().min(1).default(DEFAULT_FLEET_POOL),
  stale_after: z.string().default('30m').transform((text, ctx) => {
    const ms = durationMs(text);

    if (ms !== undefined) return ms;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a positive duration, such as 90s, 30m or 2h' });

    return z.NEVER;
  }),
  can: CanSchema.optional(),
}).strict();

/** The options of the `fleet` runtime, as `init` checks a runtime's own: its pool, `stale_after` in milliseconds, and `can`. */
export function parseFleetOptions(options: RuntimeOptions): { ok: true; value: z.infer<typeof FleetOptionsSchema> } | { ok: false; failure: { key: string; message: string } } {
  const parsed = FleetOptionsSchema.safeParse(options);

  if (parsed.success) return { ok: true, value: parsed.data };
  const [issue] = parsed.error.issues;

  return { ok: false, failure: { key: issue?.path.join('.') || 'pool', message: issue?.message ?? 'not valid' } };
}

/** How the owner's wait on an attempt ended: as the member's command did, cancelled, failed, or left out as this teamai stops. */
type Waited =
  | { kind: 'exited'; code: number; stdout: string; stderr: string }
  | { kind: 'cancelled'; message: string }
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
      return { op, state: 'running' };
    // The member was asked to stop, and nothing of the step runs on this machine: the record ends cancelled or expired.
    case 'cancelling':
    case 'cancelled':
    case 'withdrawn':
      return { op, state: 'cancelled' };
    case 'finished':
      return { op, state: 'exited', code: record.result.exitCode, stdout: record.result.outputs === undefined ? '' : JSON.stringify(record.result.outputs) };
    case 'expired':
      return { op, state: 'failed', failure: { code: 'fleet_member_gone', message: `The fleet member ${record.member.user} that took step "${record.lease.step}" stopped writing progress, so the attempt was given up.` } };
    default: {
      const unhandled: never = record;

      return unhandled;
    }
  }
}

/**
 * The `fleet` runtime of this install: each step's command it takes is offered to the members of its pool. `masks`
 * holds the values an offer may not carry, which the drive adds to as it resolves the team's secrets.
 */
export function fleetStepRuntime({ config, masks }: { config: LocalConfig; masks: Record<string, string> }): StepRuntime {
  const local = localStepRuntime();
  const disposing = new AbortController();
  // The wait of each exec this teamai sent, by its id, so a repeated id reconnects to it and a cancel reaches it.
  const waits = new Map<OpId, { place: FleetPlace; cancel: AbortController; end: Promise<Waited> }>();
  // The exec of each place a restarted teamai read, so a cancel of it with no wait here reaches its record.
  const seen = new Map<OpId, FleetPlace>();
  let settings: { pool: string; staleAfterMs: number; root: string } | undefined;

  const ended = (waited: Waited, events: ExecEvents): ExecEnd => {
    switch (waited.kind) {
      case 'exited':
        if (waited.stderr !== '') events.onOutput?.('stderr', waited.stderr);

        return { kind: 'exited', code: waited.code, stdout: waited.stdout };
      case 'cancelled':
        events.onOutput?.('stderr', waited.message);

        return { kind: 'cancelled' };
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

  return {
    name: 'fleet',
    isExecReconnected: true,

    async init({ options, checkout }) {
      const parsed = parseFleetOptions(options);

      if (!parsed.ok) return { ok: false, failure: { code: 'bad_option', ...parsed.failure } };
      const { pool, stale_after: staleAfterMs, can = {} } = parsed.value;
      settings = { pool, staleAfterMs, root: checkout ?? process.cwd() };

      // A step's place is this host's, so the fleet offers the workspaces this machine does.
      return { ok: true, can: { ...can, prompt: false, remote: true, workspace: [...WORKSPACE_MODES] }, launchesAgents: false };
    },

    async open(request, onAccepted) {
      const handle = placeHandle({ run: RunIdSchema.parse(request.run), attempt: AttemptIdSchema.parse(request.attempt) });
      await onAccepted(handle);

      return { kind: 'ready', handle };
    },

    async exec(request, events) {
      const place = placeOf(request.handle);

      if (!place || !settings) return { kind: 'failed', failure: { code: 'runtime_protocol', message: `The fleet runtime has no place ${request.handle}${settings ? '' : ', or was not initialized'}.` } };
      const live = waits.get(request.op);

      if (live) {
        events.onAccepted?.({});

        return ended(await live.end, events);
      }

      const leased = await leasedCommand(config, place);

      // Setup, or any exec besides the step's command, runs in the place on this host.
      if ('error' in leased || !isDeepStrictEqual(request.argv, shellArgv(leased.command))) {
        if ('error' in leased && leased.isFatal) return { kind: 'failed', failure: { code: 'run_unreadable', message: leased.error } };

        return local.exec({ ...request, handle: localHandle(place) }, events);
      }

      const cancel = new AbortController();
      const end = offerAndWait({ config, ...place, ...settings, ...leased, dir: request.cwd, secrets: masks, op: request.op }, { cancel: cancel.signal, leave: disposing.signal });
      waits.set(request.op, { place, cancel, end });
      events.onAccepted?.({});

      try {
        return ended(await end, events);
      } finally {
        waits.delete(request.op);
      }
    },

    async prompt() {
      return { kind: 'failed', failure: { code: 'runtime_protocol', message: 'The fleet runtime takes command steps only.' } };
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
 * The command and env of the step leased with attempt `attempt`, as a member renders them from the offer's values, or
 * why there is none: `isFatal` when the run cannot be read at all.
 */
async function leasedCommand(config: LocalConfig, { run, attempt }: FleetPlace): Promise<{ step: string; command: string; env: Record<string, string> } | { error: string; isFatal: boolean }> {
  const state = await readRun(config, run);

  if (state === 'missing' || state === 'corrupt') return { error: `Run ${run} is ${state} here, so its step was not offered to the fleet.`, isFatal: true };
  const step = state.steps.find((item) => item.status === 'leased' && item.lease.attempt === attempt);
  const leased = step && leaseContext(state, step.id);
  const command = leased?.step.command;

  if (!step || !leased || command === undefined) return { error: `Attempt ${attempt} of run ${run} leases no command step.`, isFatal: false };
  const values = leaseValues(leased.step, leased.context);

  if ('error' in values) return { error: values.error, isFatal: true };
  const env = leaseEnv(leased.step, values.values, run);

  if ('error' in env) return { error: env.error, isFatal: true };

  return { step: step.id, command, env: env.env };
}

/** The id of the exec that offered the attempt at `place` from this install, recorded with its pool. */
async function offeredExec(config: LocalConfig, place: FleetPlace): Promise<OpId | undefined> {
  return (await readOfferedMarker(config, place.run, place.attempt))?.op;
}

type WaitInput = {
  config: LocalConfig; run: RunId; attempt: AttemptId; pool: string; staleAfterMs: number; step: string; command: string; env: Record<string, string>; root: string; dir: string;
  secrets: Record<string, string>; op: OpId;
};

/**
 * Offers the step's command of attempt `attempt` to pool `pool`, from the place `dir`, a copy of checkout `root`, unless
 * an earlier drive offered it, and settles once a member finished it: with the member's exit code, the JSON its stdout
 * held as stdout, and the start of its stderr, after the place took the commits the member pushed. `secrets` are the
 * values the offer may not carry. `cancel`: the run cancelled the step, which the owner writes into the record and waits
 * for the member to answer. `leave`: this teamai stops, and the attempt stays out for a later `workflow resume <run>`.
 */
async function offerAndWait(input: WaitInput, { cancel, leave }: { cancel: AbortSignal; leave: AbortSignal }): Promise<Waited> {
  const { config, run, attempt, pool, staleAfterMs, step, command, env, root, dir, secrets, op } = input;
  const failed = (failure: WorkflowFailure): Waited => ({ kind: 'failed', failure });
  const lease = { step, command, env };
  const ref = attemptRef(run, attempt);
  const earlier = await readAttemptRecord(config, run, attempt);

  if (!earlier.ok) return failed(fleetFailure(earlier.error));

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
    await markOffered(config, run, attempt, pool, op);
    const offered = await offerAttempt(config, { run, attempt, pool, repository, owner: await installOwner(config), start, staleAfterMs, lease, definition: runDefinition(state), values: values.values, secrets });

    if (!offered.ok) return failed(fleetFailure(offered.error));
  }

  // Staleness counts on this machine's clock, from when it last saw the record change: a member's clock may be off. A
  // cancel goes through the record, and waits for the member's answer as long as for its progress.
  let lastSeen: { write: string; at: number } | undefined;
  let isCancelWritten = false;
  const woken = AbortSignal.any([cancel, leave]);

  for (;;) {
    if (leave.aborted) return { kind: 'left' };
    const read = await readAttemptRecord(config, run, attempt);

    if (!read.ok && read.error.code === 'fleet_record_unreadable') return failed(fleetFailure(read.error));
    const record = read.ok && read.value !== 'absent' ? read.value : undefined;

    if (record?.state === 'finished') {
      const { result } = record;
      const taken = result.to === undefined ? undefined : await takeWork({ config, run, root, dir, ref, to: result.to, step });

      if (taken) return failed(taken);

      return { kind: 'exited', code: result.exitCode, stdout: result.outputs === undefined ? '' : JSON.stringify(result.outputs), stderr: result.stderr };
    }

    if (record?.state === 'expired') return failed(await gone(record, { config, run, root, dir, ref, staleAfterMs }));

    if (record?.state === 'withdrawn') return { kind: 'cancelled', message: `Step "${step}" was cancelled before a member of fleet pool ${pool} took it.` };

    if (record?.state === 'cancelled') {
      const taken = record.pushed === record.start ? undefined : await takeWork({ config, run, root, dir, ref, to: record.pushed, step });

      if (taken) return failed(taken);

      return { kind: 'cancelled', message: `Step "${step}" was cancelled, and the fleet member ${record.member.user} that ran it stopped it.${record.pushed === record.start ? '' : ` Its work up to ${record.pushed} is kept.`}` };
    }

    if (record !== undefined && record.write !== lastSeen?.write) lastSeen = { write: record.write, at: Date.now() };

    if ((record?.state === 'claimed' || record?.state === 'cancelling') && lastSeen !== undefined && Date.now() - lastSeen.at > staleAfterMs) {
      const expired = await expireClaim(config, record);

      // The member wrote meanwhile: it is still there.
      if (expired.ok) return failed(await gone(expired.value, { config, run, root, dir, ref, staleAfterMs }));

      if (expired.error.code !== 'state_moved') return failed(fleetFailure(expired.error));
      continue;
    }

    if (cancel.aborted && !isCancelWritten) {
      if (record === undefined) return failed({ code: 'runtime_interrupted', message: `Step "${step}" was cancelled, and the record of its attempt on fleet pool ${pool} could not be read, so no member was asked to stop it.${read.ok ? '' : ` ${read.error.message}`}` });

      if (record.state === 'offered' || record.state === 'claimed') {
        const written = await cancelAttempt(config, record);

        if (!written.ok && written.error.code !== 'state_moved') return failed(fleetFailure(written.error));
        // Another write landed first, such as the member's progress: the cancel is written over what is read next.
        isCancelWritten = written.ok;
        continue;
      }
    }

    await sleep(RECORD_POLL_MS, undefined, cancel.aborted ? { signal: leave } : { signal: woken }).catch(() => undefined);
  }
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

    if (record === 'absent' || (record.state !== 'offered' && record.state !== 'claimed')) return { ok: true, message: `Attempt ${attempt} of run ${run} was out on the fleet, and its record already says it is ${record === 'absent' ? 'not offered' : record.state}.` };
    const cancel = await cancelAttempt(config, record);

    if (cancel.ok) {
      return { ok: true, message: record.state === 'offered'
        ? `Withdrew attempt ${attempt} of run ${run}, which no fleet member had taken.`
        : `Asked the fleet member ${record.member.user} that runs attempt ${attempt} of run ${run} to stop it: it stops the step at its next read of the attempt's record and pushes its work, which a retry goes on from.` };
    }

    if (cancel.error.code !== 'state_moved') return { ok: false, message: `Attempt ${attempt} of run ${run} is out on the fleet, and its cancel could not be written: ${cancel.error.message} Run teamai workflow cancel ${run} again.` };
  }
}
