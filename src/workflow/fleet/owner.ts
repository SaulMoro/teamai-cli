/**
 * The owner's side of a command step on the `fleet` runtime: the step's place is prepared here as for any lease, its
 * start commit goes to the attempt's ref, and the step is offered on teamai-reports. A member of the pool runs it and
 * pushes its work to that ref; the owner then fast-forwards the place to that work, and the loop reports and finishes
 * the step as it does a command it ran itself. The owner need not stay up: a restarted one finds the offer by its
 * attempt and waits on it again, and gives up a claim whose member wrote no progress for `stale_after`.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { getRepoIdentity } from '../../session-flow/sync.js';
import { readableReportsWorktree } from '../../utils/reports-branch.js';
import type { LocalConfig } from '../../types.js';
import { leaseContext } from '../engine.js';
import { attemptRef, cancelAttempt, expireClaim, fleetFailure, lastGoneWork, leaseValues, markOffered, offerAttempt, readAttemptRecord, type Claimed, type FleetLease } from './record.js';
import { runDefinition } from '../snapshot.js';
import { installOwner, readRun, type AttemptId, type RunId } from '../store.js';
import type { WorkflowFailure } from '../types.js';
import { copyGit } from '../place/place.js';
import { git } from '../worktree.js';
import type { StartedCommand } from '../drivers/local/runtime-steps.js';

/** How often the owner reads the attempt's record while a member runs it. */
const RECORD_POLL_MS = 1_000;

type FleetInput = {
  config: LocalConfig; run: RunId; attempt: AttemptId; pool: string; staleAfterMs: number; lease: FleetLease; root: string; dir: string; secrets: Record<string, string>;
};

/**
 * Offers command `lease` of attempt `attempt` to pool `pool`, from the place `dir`, a copy of checkout `root`, unless an
 * earlier drive offered it, and settles once a member finished it: with the member's exit code, the JSON its stdout held
 * as stdout, and the start of its stderr, after the place took the commits the member pushed. `secrets` are the values
 * the offer may not carry.
 */
export function fleetCommand(input: FleetInput): StartedCommand {
  const stopping = new AbortController();
  const exit = offerAndWait(input, stopping.signal);

  return {
    exit,
    stop: async () => {
      stopping.abort();

      return exit;
    },
  };
}

async function offerAndWait(input: FleetInput, signal: AbortSignal): Promise<Awaited<StartedCommand['exit']>> {
  const { config, run, attempt, pool, staleAfterMs, lease, root, dir, secrets } = input;
  const ref = attemptRef(run, attempt);
  const earlier = await readAttemptRecord(config, run, attempt);

  if (!earlier.ok) return fleetFailure(earlier.error);

  if (earlier.value === 'absent') {
    const repository = getRepoIdentity(root);

    if (repository === null) return { code: 'origin_unavailable', message: `${root} has no origin, so no fleet member can take step "${lease.step}". Add origin, or run the step on another runtime.` };
    // A member renders the step itself from the run's definitions and these values; the lease it is checked against.
    const state = await readRun(config, run);
    const leased = state === 'missing' || state === 'corrupt' ? undefined : leaseContext(state, lease.step);

    if (state === 'missing' || state === 'corrupt' || leased === undefined) return { code: 'run_unreadable', message: `Run ${run} has no definition for step "${lease.step}" here, so it was not offered to the fleet.` };
    const values = leaseValues(leased.step, leased.context);

    if ('error' in values) return { code: 'invalid_template', message: values.error };
    const resumed = await goOnFromGoneWork({ config, run, root, dir, step: lease.step });

    if (resumed) return resumed;
    const start = (await git(dir, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
    // The checkout's own git pushes: the copy shares its objects, and a step may have written the copy's config.
    const pushed = await git(root, ['push', '--quiet', 'origin', `${start}:${ref}`]);

    if (pushed.code !== 0) return { code: 'push_failed', message: `Step "${lease.step}" could not push its start commit to ${ref} on origin, so no fleet member can take it: ${pushed.stderr.trim()}` };
    await markOffered(config, run, attempt, pool);
    const offered = await offerAttempt(config, { run, attempt, pool, repository, owner: await installOwner(config), start, staleAfterMs, lease, definition: runDefinition(state), values: values.values, secrets });

    if (!offered.ok) return fleetFailure(offered.error);
  }

  // Staleness counts on this machine's clock, from when it last saw the record change: a member's clock may be off. A
  // stop cancels the attempt through its record, and waits for the member's answer as long as for its progress.
  let seen: { write: string; at: number } | undefined;
  let isCancelWritten = false;

  for (;;) {
    const read = await readAttemptRecord(config, run, attempt);

    if (!read.ok && read.error.code === 'fleet_record_unreadable') return fleetFailure(read.error);
    const record = read.ok && read.value !== 'absent' ? read.value : undefined;

    if (record?.state === 'finished') {
      const { result } = record;
      const taken = result.to === undefined ? undefined : await takeWork({ config, run, root, dir, ref, to: result.to, step: lease.step });

      if (taken) return taken;

      return { exitCode: result.exitCode, stdout: result.outputs === undefined ? '' : JSON.stringify(result.outputs), stderr: result.stderr, output: '' };
    }

    if (record?.state === 'expired') return gone(record, { config, run, root, dir, ref, staleAfterMs });

    if (record?.state === 'withdrawn') return cancelled(`Step "${lease.step}" was cancelled before a member of fleet pool ${pool} took it.`);

    if (record?.state === 'cancelled') {
      const taken = record.pushed === record.start ? undefined : await takeWork({ config, run, root, dir, ref, to: record.pushed, step: lease.step });

      if (taken) return taken;

      return cancelled(`Step "${lease.step}" was cancelled, and the fleet member ${record.member.user} that ran it stopped it.${record.pushed === record.start ? '' : ` Its work up to ${record.pushed} is kept.`}`);
    }

    if (record !== undefined && record.write !== seen?.write) seen = { write: record.write, at: Date.now() };

    if ((record?.state === 'claimed' || record?.state === 'cancelling') && seen !== undefined && Date.now() - seen.at > staleAfterMs) {
      const expired = await expireClaim(config, record);

      // The member wrote meanwhile: it is still there.
      if (expired.ok) return gone(expired.value, { config, run, root, dir, ref, staleAfterMs });

      if (expired.error.code !== 'state_moved') return fleetFailure(expired.error);
      continue;
    }

    if (signal.aborted && !isCancelWritten && (record?.state === 'offered' || record?.state === 'claimed')) {
      const cancel = await cancelAttempt(config, record);

      if (!cancel.ok && cancel.error.code !== 'state_moved') return fleetFailure(cancel.error);
      // Another write landed first, such as the member's progress: the cancel is written over what is read next.
      isCancelWritten = cancel.ok;
      continue;
    }

    await sleep(RECORD_POLL_MS, undefined, signal.aborted ? {} : { signal }).catch(() => undefined);
  }
}

/** How a cancelled attempt ends for the loop: as a command it stopped itself. */
function cancelled(message: string): Awaited<StartedCommand['exit']> {
  return { exitCode: 130, stdout: '', stderr: message, output: '' };
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

  const earlier = await lastGoneWork(config, { run, step, owner: await installOwner(config) });

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
export async function cancelOffer(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<string> {
  for (;;) {
    const read = await readAttemptRecord(config, run, attempt);

    if (!read.ok) return `Attempt ${attempt} of run ${run} is out on the fleet, and its record could not be read, so its member was not asked to stop: ${read.error.message} Run teamai workflow cancel ${run} again.`;
    const record = read.value;

    if (record === 'absent' || (record.state !== 'offered' && record.state !== 'claimed')) return `Attempt ${attempt} of run ${run} was out on the fleet, and its record already says it is ${record === 'absent' ? 'not offered' : record.state}.`;
    const cancel = await cancelAttempt(config, record);

    if (cancel.ok) {
      return record.state === 'offered'
        ? `Withdrew attempt ${attempt} of run ${run}, which no fleet member had taken.`
        : `Asked the fleet member ${record.member.user} that runs attempt ${attempt} of run ${run} to stop it: it stops the step at its next read of the attempt's record and pushes its work, which a retry goes on from.`;
    }

    if (cancel.error.code !== 'state_moved') return `Attempt ${attempt} of run ${run} is out on the fleet, and its cancel could not be written: ${cancel.error.message} Run teamai workflow cancel ${run} again.`;
  }
}
