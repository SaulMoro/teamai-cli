/**
 * A fleet member's side (`teamai workflow resume --next --pool [name]`): it takes the oldest attempt its pool offers for
 * this checkout's business repository, runs it here, pushes its work to the attempt's ref, and writes how it ended. It
 * keeps no run file: only the run's lock and the attempt's directory, in its own data home. While the step runs it
 * commits and pushes what the step did so far and writes that it is still there, so the owner can tell a gone member
 * from a slow one.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HandoffOwner } from '../../snapshot.js';
import type { LocalConfig } from '../../../types.js';
import { log } from '../../../utils/logger.js';
import { startGroupedCommand } from '../../../tool-launch/process-stop.js';
import { attemptRef, claimAttempt, finishAttempt, fleetFailure, listOffers, recordProgress, type Claimed, type FleetResult } from '../../fleet.js';
import { commandOutputs } from '../../protocol.js';
import { attemptDir, takeRunLock } from '../../store.js';
import type { WorkflowEnvelope } from '../../types.js';
import { git, hostGitEnv, keptOrigin, readMemberConfig, remoteGit, untrustedGit, type MemberConfig } from '../../worktree.js';

/**
 * Takes and runs the oldest attempt pool `pool` offers for `repository` that another member did not claim first, from
 * checkout `root`. Answers `{ ran: { run, attempt, step, exit_code } }`, or `{ idle: { offered } }` when it took none.
 */
export async function takeFleetAttempt(config: LocalConfig, input: { pool: string; repository: string; root: string; member: HandoffOwner; secrets: Record<string, string> }): Promise<WorkflowEnvelope> {
  const { pool, repository, root, member, secrets } = input;
  const offers = (await listOffers(config, { pool, repository })).filter((offer) => offer.owner.id !== member.id);
  let moved = 0;

  for (const offer of offers) {
    // The run's lock comes first: a claim this machine could not run at once would wait for nobody until stale_after.
    const held = await takeRunLock(config, offer.run, async (): Promise<WorkflowEnvelope | 'moved'> => {
      const claimed = await claimAttempt(config, offer, member);

      if (claimed.ok) return runClaim(config, { claim: claimed.value, root, secrets });

      return claimed.error.code === 'state_moved' ? 'moved' : { error: fleetFailure(claimed.error) };
    }, { waitMs: 0 });

    if (held.kind === 'busy') {
      log.info(`Left attempt ${offer.attempt} of run ${offer.run} for another member: ${held.error.message}`);
      continue;
    }

    if (held.value === 'moved') {
      moved += 1;
      continue;
    }

    return held.value;
  }

  return { data: { idle: { offered: offers.length - moved } } };
}

/** Runs claim `claim` in a worktree of `root` at the attempt's start commit, then pushes its work and writes how it ended. */
async function runClaim(config: LocalConfig, { claim, root, secrets }: { claim: Claimed; root: string; secrets: Record<string, string> }): Promise<WorkflowEnvelope> {
  const { run, attempt, lease, start } = claim;
  const ref = attemptRef(run, attempt);
  const dir = attemptDir(config, run, attempt);
  const work = path.join(dir, 'work');
  let latest = claim;

  const finish = async (result: FleetResult): Promise<WorkflowEnvelope> => {
    const written = await finishAttempt(config, latest, result, secrets);

    if (!written.ok) return { error: fleetFailure(written.error) };
    const ended = written.value.state === 'finished' ? written.value.result : result;

    return { data: { ran: { run, attempt, step: lease.step, exit_code: ended.exitCode } } };
  };

  const fetched = await git(root, ['fetch', '--quiet', 'origin', ref]);

  if (fetched.code !== 0) return finish({ exitCode: 1, stderr: `The member could not fetch ${ref}: ${fetched.stderr.trim()}` });
  // Read before the step runs: the worktree shares this checkout's config, which the step may then write.
  const read = await readMemberConfig(root);

  if ('error' in read) return finish({ exitCode: 1, stderr: `The member could not read the git config of its checkout: ${read.error}` });
  const memberConfig: MemberConfig = new Set(read);
  await git(root, ['worktree', 'remove', '--force', work]);
  const added = await git(root, ['worktree', 'add', '--quiet', '--detach', work, start]);

  if (added.code !== 0) return finish({ exitCode: 1, stderr: `The member could not check out ${start}: ${added.stderr.trim()}` });
  // Each save is a commit on the one before, so the ref only moves forward.
  let tip = start;

  const save = async (message: string): Promise<{ to: string } | { error: string }> => {
    const saved = await pushWork({ work, ref, message, memberConfig, parent: tip, index: path.join(dir, 'snapshot.index') });

    if ('to' in saved) tip = saved.to;

    return saved;
  };

  try {
    const env = { ...process.env, ...lease.env };

    const command = startGroupedCommand({ command: lease.command, cwd: work, env, detached: process.platform !== 'win32', group: dir });
    let gone: string | undefined;
    let beating: Promise<void> | undefined;

    // Progress comes three times per `stale_after`, so one late write does not make the member look gone. A beat still
    // writing skips the next, and the result waits for it, so each write replaces the one before.
    const beat = setInterval(() => {
      if (beating) return;
      beating = (async () => {
        const saved = await save(`[teamai] ${lease.step} so far (run ${run}, attempt ${attempt})`);
        const progressed = await recordProgress(config, latest, 'to' in saved ? saved.to : latest.pushed);

        if (progressed.ok) {
          latest = progressed.value;

          return;
        }

        // The owner gave the claim up: whatever this member does now counts for nothing.
        if (progressed.error.code === 'state_moved' && gone === undefined) {
          gone = progressed.error.message;
          await command.stop();
        }
      })().finally(() => {
        beating = undefined;
      });
    }, Math.max(1_000, Math.floor(claim.staleAfterMs / 3)));

    const exited = await command.exit.finally(() => clearInterval(beat));
    await beating;

    if (gone !== undefined) return { error: { code: 'state_moved', message: `The owner of run ${run} gave up attempt ${attempt} of step "${lease.step}" while this member ran it, so its result was not written. ${gone}` } };
    const outputs = commandOutputs(exited.stdout);
    const ran: FleetResult = { exitCode: exited.exitCode, stderr: exited.stderr.trim().slice(0, 400), ...(outputs !== undefined && { outputs }) };
    const saved = await save(`[teamai] ${lease.step} (run ${run}, attempt ${attempt})`);

    if ('error' in saved) return finish({ ...ran, exitCode: ran.exitCode === 0 ? 1 : ran.exitCode, stderr: saved.error });

    return finish(saved.to === start ? ran : { ...ran, to: saved.to });
  } finally {
    await git(root, ['worktree', 'remove', '--force', work]);
  }
}

/**
 * Snapshots what the step has in `work` as a commit on `parent` and pushes it to `ref`: the commit `ref` then holds. It
 * stages into `index`, a file of its own, so the step's own HEAD and index stay as the step left them while it still
 * runs. The step ran there, so only the programs of `memberConfig` that its config names run.
 */
async function pushWork({ work, ref, message, memberConfig, parent, index }: { work: string; ref: string; message: string; memberConfig: MemberConfig; parent: string; index: string }): Promise<{ to: string } | { error: string }> {
  await fs.rm(index, { force: true });
  const snapshotGit = untrustedGit({ ...hostGitEnv(), GIT_INDEX_FILE: index }, undefined, memberConfig);
  const read = await snapshotGit(work, ['read-tree', parent]);
  const added = read.code === 0 ? await snapshotGit(work, ['add', '-A']) : read;
  const tree = added.code === 0 ? await snapshotGit(work, ['write-tree']) : added;

  if (tree.code !== 0) return { error: `The member could not commit the step's work: ${tree.stderr.trim()}` };
  const unchanged = await snapshotGit(work, ['diff-tree', '--quiet', parent, tree.stdout.trim()]);

  if (unchanged.code === 0) return { to: parent };
  const committed = await snapshotGit(work, ['-c', 'user.name=TeamAI', '-c', 'user.email=teamai@localhost', 'commit-tree', tree.stdout.trim(), '-p', parent, '-m', message]);

  if (committed.code !== 0) return { error: `The member could not commit the step's work: ${committed.stderr.trim()}` };
  const to = committed.stdout.trim();
  // The origin this checkout named before the step, never the one the step's copy names now.
  const url = keptOrigin(memberConfig);

  if (url === undefined) return { error: `The member could not push the step's work to ${ref}: its checkout names no origin.` };
  const pushed = await remoteGit(work, { kept: memberConfig, env: hostGitEnv() }, ['push', '--quiet', url, `${to}:${ref}`], snapshotGit);

  return pushed.code === 0 ? { to } : { error: `The member could not push the step's work to ${ref}: ${pushed.stderr.trim()}` };
}
