/**
 * A fleet member's side (`teamai workflow resume --next --pool [name]`): it takes the oldest attempt its pool offers for
 * this checkout's business repository, runs it here, pushes its work to the attempt's ref, and writes how it ended. It
 * keeps no run file: only the run's lock and the attempt's directory, in its own data home. While the step runs it
 * commits and pushes what the step did so far and writes that it is still there, so the owner can tell a gone member
 * from a slow one.
 */
import path from 'node:path';
import type { HandoffOwner } from '../../snapshot.js';
import type { LocalConfig } from '../../../types.js';
import { memberTools } from '../../../tool-launch/member-tools.js';
import { attemptEnv } from '../../attempt-marker.js';
import { startGroupedCommand, type CommandExit } from '../../../tool-launch/process-stop.js';
import { JsonValueSchema } from '../../../utils/json.js';
import { launchToolFor } from './local-driver.js';
import { createLocalToolAdapter, type LocalToolRun } from './local-tool-adapter.js';
import { attemptRef, claimAttempt, finishAttempt, fleetFailure, listOffers, recordProgress, type Claimed, type FleetLease, type FleetResult } from '../../fleet.js';
import { OutputSchemaSchema } from '../../output.js';
import { commandOutputs } from '../../protocol.js';
import { attemptDir, takeRunLock } from '../../store.js';
import type { WorkflowEnvelope } from '../../types.js';
import { commitWork, git, hostGitEnv, readMemberConfig, untrustedGit, type MemberConfig } from '../../worktree.js';

/**
 * Takes and runs the oldest attempt pool `pool` offers for `repository` that another member did not claim first, from
 * checkout `root`. Answers `{ ran: { run, attempt, step, exit_code } }`, or `{ idle: { offered } }` when it took none.
 */
export async function takeFleetAttempt(config: LocalConfig, input: { pool: string; repository: string; root: string; member: HandoffOwner; secrets: Record<string, string> }): Promise<WorkflowEnvelope> {
  const { pool, repository, root, member, secrets } = input;
  const offers = (await listOffers(config, { pool, repository })).filter((offer) => offer.owner.id !== member.id);
  let moved = 0;

  for (const offer of offers) {
    const claimed = await claimAttempt(config, offer, member);

    if (!claimed.ok && claimed.error.code === 'state_moved') {
      moved += 1;
      continue;
    }

    if (!claimed.ok) return { error: fleetFailure(claimed.error) };
    const held = await takeRunLock(config, claimed.value.run, async () => runClaim(config, { claim: claimed.value, root, secrets }), { waitMs: 0 });

    if (held.kind === 'busy') return { error: held.error };

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
  const save = (message: string): Promise<{ to: string } | { error: string }> => pushWork({ work, ref, message, memberConfig });

  try {
    // Marked as the attempt's runner, as the local loop marks a step it runs; no person answers here.
    const env = { ...process.env, ...lease.env, ...attemptEnv(config, run, attempt, 'unattended') };

    const command = 'command' in lease
      ? startGroupedCommand({ command: lease.command, cwd: work, env, detached: process.platform !== 'win32', group: dir })
      : startPrompt(config, { lease, work, dir, env, secrets });

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
 * Runs prompt `lease` in `work` on this member's own tool, as `startGroupedCommand` runs a command: its outputs as the
 * stdout of a command step, and why it failed as its stderr.
 */
function startPrompt(config: LocalConfig, { lease, work, dir, env, secrets }: { lease: Extract<FleetLease, { prompt: string }>; work: string; dir: string; env: NodeJS.ProcessEnv; secrets: Record<string, string> }) {
  const stopping = new AbortController();

  const exit = (async (): Promise<CommandExit> => {
    const choice = launchToolFor({ tool: lease.tool }, config, {}, await memberTools(config));

    if (!choice.ok) return { exitCode: 1, stdout: '', stderr: choice.failure.message, output: '' };
    const input: LocalToolRun = { prompt: lease.prompt, cwd: work, resultPath: path.join(dir, 'result.json'), secrets, env, unattended: true };
    const output = lease.output === undefined ? undefined : OutputSchemaSchema.safeParse(lease.output);

    if (output?.success === false) return { exitCode: 1, stdout: '', stderr: `The attempt record holds an output this teamai cannot read: ${output.error.message}. Update teamai on this machine and claim the step again.`, output: '' };

    if (output?.success) input.output = output.data;

    if (choice.target.instance?.command !== undefined) input.command = choice.target.instance.command;
    const ran = await createLocalToolAdapter().run(choice.tool, input, stopping.signal);
    const outputs = ran.started ? JsonValueSchema.safeParse(ran.output) : undefined;

    return {
      exitCode: ran.failure === undefined ? ran.exitCode : ran.exitCode || 1,
      stdout: outputs?.success ? JSON.stringify(outputs.data) : '',
      stderr: ran.failure?.message ?? '',
      output: '',
    };
  })();

  return {
    exit,
    stop: async () => {
      stopping.abort();

      return exit;
    },
  };
}

/**
 * Commits what the step changed in `work` and pushes it to `ref`: the commit `ref` then holds. The step ran there, so
 * only the programs of `memberConfig` that its config names run.
 */
async function pushWork({ work, ref, message, memberConfig }: { work: string; ref: string; message: string; memberConfig: MemberConfig }): Promise<{ to: string } | { error: string }> {
  const workGit = untrustedGit(hostGitEnv(), undefined, memberConfig);
  const committed = await commitWork(work, message, undefined, workGit);

  if ('error' in committed) return { error: `The member could not commit the step's work: ${committed.error}` };

  if (committed.from === committed.to) return { to: committed.to };
  const pushed = await workGit(work, ['push', '--quiet', 'origin', `${committed.to}:${ref}`]);

  return pushed.code === 0 ? { to: committed.to } : { error: `The member could not push the step's work to ${ref}: ${pushed.stderr.trim()}` };
}
