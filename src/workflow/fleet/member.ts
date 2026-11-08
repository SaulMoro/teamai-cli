/**
 * A fleet member's side (`teamai workflow resume --next --pool [name]`): it takes the oldest attempt its pool offers for
 * this checkout's business repository, runs it here, pushes its work to the attempt's ref, and writes how it ended. It
 * keeps no run file: only the run's lock and the attempt's directory, in its own data home. While the step runs it
 * commits and pushes what the step did so far and writes that it is still there, so the owner can tell a gone member
 * from a slow one.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HandoffOwner } from '../snapshot.js';
import type { LocalConfig } from '../../types.js';
import { log } from '../../utils/logger.js';
import { startGroupedCommand, stopRecordedGroup } from '../../tool-launch/process-stop.js';
import { teamCommitReach } from '../cache.js';
import { retryCommand } from '../engine.js';
import { answerCancel, attemptRef, claimAttempt, finishAttempt, fleetFailure, leaseEnv, listMemberRecords, listOffers, readAttemptRecord, recordProgress, type Cancelling, type Claimed, type FleetError, type FleetResult } from './record.js';
import { definitionsOf, type Definitions } from '../handoff.js';
import { commandOutputs } from '../protocol.js';
import { parseStepPath } from '../step-path.js';
import { attemptDir, takeRunLock } from '../store.js';
import { workflowRunBy, type WorkflowEnvelope, type WorkflowStep } from '../types.js';
import { git, hostGitEnv, keptOrigin, readMemberConfig, remoteGit, untrustedGit, type MemberConfig } from '../worktree.js';

/** How often a member reads its claim's record for a cancel, when its beats come less often than that. */
const CANCEL_READ_MS = 30_000;

/**
 * Takes and runs the oldest attempt pool `pool` offers for `repository` that another member did not claim first, from
 * checkout `root`. A member that starts first stops the commands its earlier runs left running, then finishes a claim it
 * still holds, as a member killed mid-step leaves one. Answers `{ ran: { run, attempt, step, exit_code } }`,
 * `{ cancelled: { run, attempt, step } }` when the owner cancelled the attempt meanwhile, or `{ idle: { offered } }`
 * when it took none.
 */
export async function takeFleetAttempt(config: LocalConfig, input: { pool: string; repository: string; root: string; member: HandoffOwner; secrets: Record<string, string> }): Promise<WorkflowEnvelope> {
  const { pool, repository, root, member, secrets } = input;
  const finished = await finishLeftClaims(config, { repository, root, member, secrets });

  if (finished) return finished;
  const offers = (await listOffers(config, { pool, repository })).filter((offer) => offer.owner.id !== member.id);
  let moved = 0;

  for (const offer of offers) {
    // The run's lock comes first: a claim this machine could not run at once would wait for nobody until stale_after.
    const held = await takeRunLock(config, offer.run, async (): Promise<WorkflowEnvelope | 'moved'> => {
      const claimed = await claimAttempt(config, offer, member);

      if (claimed.ok) return runClaim(config, { claim: claimed.value, root, secrets, member });

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

/**
 * What an earlier run of this member left: each command it started that may still run, which it stops, and the claim it
 * still holds, which it finishes from the work it pushed, or, when the owner cancelled it meanwhile, answers. A run of
 * this install that is still live holds the run's lock, so what it runs is left alone. Undefined when it held no claim.
 */
async function finishLeftClaims(config: LocalConfig, { repository, root, member, secrets }: { repository: string; root: string; member: HandoffOwner; secrets: Record<string, string> }): Promise<WorkflowEnvelope | undefined> {
  for (const record of await listMemberRecords(config, { member, repository })) {
    const held = await takeRunLock(config, record.run, async (): Promise<WorkflowEnvelope | undefined> => {
      // A member killed mid-step leaves its command's process group running: nothing else stops it.
      await stopRecordedGroup(attemptDir(config, record.run, record.attempt));

      if (record.state !== 'claimed' && record.state !== 'cancelling') return undefined;
      const ref = attemptRef(record.run, record.attempt);
      const fetched = await git(root, ['fetch', '--quiet', 'origin', ref]);

      if (fetched.code !== 0) return { error: { code: 'fetch_failed', message: `The member could not fetch ${ref}, where the claim it holds keeps its work: ${fetched.stderr.trim()}` } };
      // Only this member pushes to the attempt's ref, so its tip is the last work it saved.
      const saved = (await git(root, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).stdout.trim();

      if (record.state === 'cancelling') return answered(config, record, saved);
      log.info(`Finishing attempt ${record.attempt} of run ${record.run}, which this member claimed and left: step "${record.lease.step}" runs again from the work it pushed.`);

      return runClaim(config, { claim: record, root, secrets, member, from: saved });
    }, { waitMs: 0 });

    if (held.kind === 'held' && held.value) return held.value;
  }

  return undefined;
}

/** Answers the cancel of claim `cancelling` with the work up to `pushed`: the step stopped. */
async function answered(config: LocalConfig, cancelling: Cancelling, pushed: string): Promise<WorkflowEnvelope> {
  const written = await answerCancel(config, cancelling, pushed);
  const { run, attempt, lease } = cancelling;

  if (!written.ok) return { error: fleetFailure(written.error) };

  return { data: { cancelled: { run, attempt, step: lease.step } } };
}

/**
 * Runs claim `claim` in a worktree of `root` at `from`, the attempt's start commit unless a restarted member goes on from
 * the work it pushed, then pushes its work and writes how it ended. A cancel of the claim stops the step: its work is
 * pushed, and the member answers the cancel.
 */
async function runClaim(config: LocalConfig, { claim, root, secrets, member, from = claim.start }: { claim: Claimed; root: string; secrets: Record<string, string>; member: HandoffOwner; from?: string }): Promise<WorkflowEnvelope> {
  const { run, attempt, lease } = claim;
  const ref = attemptRef(run, attempt);
  const dir = attemptDir(config, run, attempt);
  const work = path.join(dir, 'work');
  let latest = claim;

  const finish = async (result: FleetResult): Promise<WorkflowEnvelope> => {
    const written = await finishAttempt(config, latest, result, secrets);

    // The owner cancelled the claim as the step ended: the member answers the cancel with the work it pushed.
    if (!written.ok && written.error.code === 'state_moved') {
      const now = await readAttemptRecord(config, run, attempt);

      if (now.ok && now.value !== 'absent' && now.value.state === 'cancelling' && now.value.member.id === member.id) return answered(config, now.value, result.to ?? latest.pushed);
    }

    if (!written.ok) return { error: fleetFailure(written.error) };
    const ended = written.value.state === 'finished' ? written.value.result : result;

    return { data: { ran: { run, attempt, step: lease.step, exit_code: ended.exitCode } } };
  };

  const trusted = await trustedLease(config, claim);

  if ('refused' in trusted) {
    return finish({ exitCode: 1, stderr: `The member did not run step "${lease.step}": ${trusted.refused} Once the owner ran teamai pull, ${retryCommand(run, lease.step)} offers it again.` });
  }

  const fetched = await git(root, ['fetch', '--quiet', 'origin', ref]);

  if (fetched.code !== 0) return finish({ exitCode: 1, stderr: `The member could not fetch ${ref}: ${fetched.stderr.trim()}` });
  // Read before the step runs: the worktree shares this checkout's config, which the step may then write.
  const read = await readMemberConfig(root);

  if ('error' in read) return finish({ exitCode: 1, stderr: `The member could not read the git config of its checkout: ${read.error}` });
  const memberConfig: MemberConfig = new Set(read);
  await git(root, ['worktree', 'remove', '--force', work]);
  const added = await git(root, ['worktree', 'add', '--quiet', '--detach', work, from]);

  if (added.code !== 0) return finish({ exitCode: 1, stderr: `The member could not check out ${from}: ${added.stderr.trim()}` });
  // Each save is a commit on the one before, so the ref only moves forward.
  let tip = from;

  const save = async (message: string): Promise<{ to: string } | { error: string }> => {
    const saved = await pushWork({ work, ref, message, memberConfig, parent: tip, index: path.join(dir, 'snapshot.index') });

    if ('to' in saved) tip = saved.to;

    return saved;
  };

  try {
    const env = { ...process.env, ...trusted.env };

    const command = startGroupedCommand({ command: trusted.command, cwd: work, env, detached: process.platform !== 'win32', group: dir });
    let gone: string | undefined;
    let cancelling: Cancelling | undefined;
    let beating: Promise<void> | undefined;

    // A write of the claim that answered state_moved: the owner cancelled it, which the member answers once the step
    // stopped, or gave it up, after which nothing the member does counts. Either way the step stops.
    const moved = async (error: FleetError): Promise<void> => {
      if (gone !== undefined || cancelling !== undefined) return;
      const now = await readAttemptRecord(config, run, attempt);

      if (now.ok && now.value !== 'absent' && now.value.state === 'cancelling' && now.value.member.id === member.id) cancelling = now.value;
      else gone = error.message;
      await command.stop();
    };

    // Progress comes three times per `stale_after`, so one late write does not make the member look gone. A beat still
    // writing skips the next, and the result waits for it, so each write replaces the one before. Between beats further
    // apart than CANCEL_READ_MS, the member reads the record for a cancel.
    const beatMs = Math.max(1_000, Math.floor(claim.staleAfterMs / 3));
    const tickMs = Math.min(beatMs, CANCEL_READ_MS);
    let sinceBeat = 0;

    const beat = setInterval(() => {
      if (beating) return;
      sinceBeat += tickMs;
      const isBeat = sinceBeat >= beatMs;

      if (isBeat) sinceBeat = 0;
      beating = (async () => {
        if (!isBeat) {
          const now = await readAttemptRecord(config, run, attempt);

          if (now.ok && now.value !== 'absent' && now.value.write !== latest.write) await moved({ code: 'state_moved', message: `Attempt ${attempt} of run ${run} changed on teamai-reports meanwhile.` });

          return;
        }

        const saved = await save(`[teamai] ${lease.step} so far (run ${run}, attempt ${attempt})`);
        const progressed = await recordProgress(config, latest, 'to' in saved ? saved.to : latest.pushed);

        if (progressed.ok) {
          latest = progressed.value;

          return;
        }

        if (progressed.error.code === 'state_moved') await moved(progressed.error);
      })().finally(() => {
        beating = undefined;
      });
    }, tickMs);

    const exited = await command.exit.finally(() => clearInterval(beat));
    await beating;

    if (gone !== undefined) return { error: { code: 'state_moved', message: `The owner of run ${run} gave up attempt ${attempt} of step "${lease.step}" while this member ran it, so its result was not written. ${gone}` } };
    const outputs = commandOutputs(exited.stdout);
    const ran: FleetResult = { exitCode: exited.exitCode, stderr: exited.stderr.trim().slice(0, 400), ...(outputs !== undefined && { outputs }) };
    const saved = await save(`[teamai] ${lease.step} (run ${run}, attempt ${attempt})`);

    if (cancelling) return answered(config, cancelling, 'to' in saved ? saved.to : latest.pushed);

    if ('error' in saved) return finish({ ...ran, exitCode: ran.exitCode === 0 ? 1 : ran.exitCode, stderr: saved.error });

    return finish(saved.to === from ? ran : { ...ran, to: saved.to });
  } finally {
    await git(root, ['worktree', 'remove', '--force', work]);
  }
}

/**
 * The command and env the team's workflow defines for the step `claim` offers, its env rendered from the offer's values,
 * or why this member does not run it. Anyone who can write to teamai-reports can write a record, so the member runs
 * only what the definitions the run executes say, read from its own team repository, as a claimer of a published run
 * does; a lease that says otherwise is refused, not corrected.
 */
async function trustedLease(config: LocalConfig, claim: Claimed): Promise<{ command: string; env: Record<string, string> } | { refused: string }> {
  const { run, lease, definition, values } = claim;
  const { teamRevision, ...named } = definition;
  // A team commit the member would not run itself names no definitions: without it, only its own copy can match.
  const isTrusted = teamRevision !== undefined && await teamCommitReach(config, teamRevision) === 'member';
  const found = await definitionsOf(config, { run, ...named, ...(isTrusted && { teamRevision }) });

  if (!found.ok && teamRevision !== undefined && !isTrusted) {
    return { refused: `workflow "${definition.name}" comes from team commit ${teamRevision}, which neither this member's team checkout nor the team's default branch holds, and this member's copy of it differs. Merge it to the default branch.` };
  }

  if (!found.ok) return { refused: found.error.message };
  const step = definedStep(found.value, lease.step);

  if (step?.command === undefined) return { refused: `workflow "${definition.name}" has no command step at ${lease.step}.` };

  if (step.command !== lease.command) return { refused: `the offer's command differs from the one workflow "${definition.name}" defines for it.` };
  const rendered = leaseEnv(step, values, run);

  if ('error' in rendered) return { refused: `workflow "${definition.name}" ${rendered.error}.` };
  const names = [...new Set([...Object.keys(rendered.env), ...Object.keys(lease.env)])];
  const differs = names.filter((name) => rendered.env[name] !== lease.env[name]).sort();

  if (differs.length > 0) return { refused: `the offer's env ${differs.join(', ')} differs from what workflow "${definition.name}" renders from the offer's values.` };

  return { command: step.command, env: rendered.env };
}

/**
 * The step at instance path `stepPath` in `definitions`, as `locateStep` finds it in a run: a `finally` step at the top, and
 * nested workflows inline or by name. A workflow a `from` step admitted is in no definition, so it finds none there.
 */
function definedStep({ definition, workflows }: Definitions, stepPath: string): WorkflowStep | undefined {
  const segments = parseStepPath(stepPath);
  let steps = definition.finally?.some((step) => step.id === segments[0]?.id) ? definition.finally : definition.steps;

  for (const [index, segment] of segments.entries()) {
    const step = steps.find((item) => item.id === segment.id);

    if (!step || index === segments.length - 1) return step;
    const child = workflowRunBy({ workflows }, step, '');

    if (!child) return undefined;
    steps = child.steps;
  }

  return undefined;
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
