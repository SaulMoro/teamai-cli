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
import { startGroupedCommand, stopRecordedGroup, type CommandExit, type GroupedCommand } from '../../tool-launch/process-stop.js';
import { attemptRun, attemptRuntimePath } from '../runtimes/attempt.js';
import { stopLeftAttempt } from '../runtimes/cancelled.js';
import type { OpenedDriver } from '../runtimes/sources.js';
import type { StepRuntime } from '../runtimes/step-runtime.js';
import { shellArgv, STOPPED_EXIT_CODE } from '../shell-command.js';
import { teamCommitReach } from '../cache.js';
import { retryCommand } from '../engine.js';
import { answerCancel, attemptRef, claimAttempt, finishAttempt, fleetFailure, leaseEnv, leasePrompt, listMemberRecords, listOffers, readAttemptRecord, recordProgress, type Cancelling, type Claimed, type FleetError, type FleetLease, type FleetResult } from './record.js';
import { definitionsOf, type Definitions } from '../handoff.js';
import { commandOutputs } from '../protocol.js';
import { parseStepPath } from '../step-path.js';
import { attemptDir, attemptResultPath, runScratchDir, takeRunLock, type AttemptId, type RunId, type RunLock } from '../store.js';
import { stepWorkflow, workflowRunBy, type WorkflowEnvelope, type WorkflowStep } from '../types.js';
import type { TurnLimits } from '../requirements.js';
import type { LoginTool } from '../runtimes/login.js';
import { runPromptStep, type StagedLease } from '../steps/prompt.js';
import { driverIdentity } from '../../driver-identity.js';
import { withRunningCli } from '../../env-exec.js';
import { resolveWorkflowEnv } from '../../env-resolution.js';
import { resolveRunMode } from '../../launch-context.js';
import { openSessionArchive } from '../../session-flow/archive.js';
import { JsonValueSchema } from '../../utils/json.js';
import { git, hostGitEnv, keptOriginUrl, pushTargets, readMemberConfig, remoteGit, untrustedGit, type MemberConfig } from '../worktree.js';

/** How often a member reads its claim's record for a cancel, when its beats come less often than that. */
const CANCEL_READ_MS = 30_000;

/** The last characters of a step's stderr a member keeps. */
const STDERR_KEPT = 4_000;

/** Where a member runs a step: here, as `--driver local` does, or on a step runtime of its own driver. */
type RuntimePlace = { kind: 'runtime'; driver: string; use: string; runtime: StepRuntime };

/** A step runtime of the member's driver that runs prompt steps, with what a prompt there needs of its offer. */
type PromptRuntimePlace = RuntimePlace & { launchesAgents: boolean; logins: readonly LoginTool[]; credentials: Record<string, string>; found: readonly string[]; defaultTool?: string; isThrough?: true };

/**
 * Where the member's driver runs each kind of step: a command step's command, and a prompt step's tool. A kind with no
 * place is one the member takes no attempt of.
 */
export type MemberPlace = { command?: { kind: 'here' } | RuntimePlace; prompt?: { kind: 'here' } | PromptRuntimePlace };

/** The kind of step a record's lease runs. */
function leaseKind(lease: FleetLease): keyof MemberPlace {
  return 'command' in lease ? 'command' : 'prompt';
}

/**
 * Where the member's driver `opened` runs each kind of step, as the local loop picks a runtime: its first runtime that
 * runs commands, and its first that runs prompts, each here when that is `local` or the member gave no driver. A fleet
 * entry of its own is passed over: the member would offer the attempt again instead of running it.
 */
export function memberPlace(opened: OpenedDriver | undefined): MemberPlace | { refused: string } {
  if (opened === undefined) return { command: { kind: 'here' }, prompt: { kind: 'here' } };
  const place: MemberPlace = {};

  for (const entry of opened.runtimes) {
    if (entry.kind === 'local') {
      place.command ??= { kind: 'here' };
      place.prompt ??= { kind: 'here' };
      break;
    }

    if (entry.use === 'fleet') continue;
    const runtime: RuntimePlace = { kind: 'runtime', driver: opened.driver.name, use: entry.use, runtime: entry.runtime };

    // A runtime runs commands, and prompts, unless it says it does not.
    if (entry.can.exec !== false) place.command ??= runtime;

    if (entry.can.prompt !== false) {
      place.prompt ??= {
        ...runtime, launchesAgents: entry.launchesAgents, logins: entry.engine.logins, credentials: entry.credentials, found: entry.found,
        ...(entry.can.default_tool !== undefined && { defaultTool: entry.can.default_tool }), ...(entry.isThrough && { isThrough: true }),
      };
    }
  }

  if (place.command === undefined && place.prompt === undefined) return { refused: `Driver ${opened.asked} has no runtime that runs command or prompt steps, so this member can take no attempt on it. Use a driver with one, such as --driver local.` };

  return place;
}

/**
 * Takes and runs the oldest attempt pool `pool` offers for `repository` that another member did not claim first, from
 * checkout `root`. A member that starts first stops the commands its earlier runs left running, then finishes a claim it
 * still holds, as a member killed mid-step leaves one. Answers `{ ran: { run, attempt, step, exit_code } }`,
 * `{ cancelled: { run, attempt, step } }` when the owner cancelled the attempt meanwhile, or `{ idle: { offered } }`
 * when it took none.
 */
export async function takeFleetAttempt(config: LocalConfig, input: { pool: string; repository: string; root: string; member: HandoffOwner; secrets: Record<string, string>; place: MemberPlace }): Promise<WorkflowEnvelope> {
  const { pool, repository, root, member, secrets, place } = input;
  const finished = await finishLeftClaims(config, { repository, root, member, secrets, place });

  if (finished) return finished;
  const labels = config.workflows?.labels ?? [];

  // An offer of a kind of step this member's driver does not run, or that needs a label this machine does not declare,
  // is another member's to take.
  const offers = (await listOffers(config, { pool, repository })).filter((offer) => {
    if (offer.owner.id === member.id || place[leaseKind(offer.lease)] === undefined) return false;
    const lacked = (offer.labels ?? []).filter((label) => !labels.includes(label));

    if (lacked.length > 0) log.info(`Left attempt ${offer.attempt} of run ${offer.run} for another member: its step requires labels ${lacked.join(', ')}, which workflows.labels on this machine does not declare.`);

    return lacked.length === 0;
  });

  let moved = 0;

  for (const offer of offers) {
    // The run's lock comes first: a claim this machine could not run at once would wait for nobody until stale_after.
    const held = await takeRunLock(config, offer.run, async (lock): Promise<WorkflowEnvelope | 'moved'> => {
      const claimed = await claimAttempt(config, offer, member);

      if (claimed.ok) return runClaim(config, { lock, claim: claimed.value, root, secrets, member, place });

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
async function finishLeftClaims(config: LocalConfig, { repository, root, member, secrets, place }: { repository: string; root: string; member: HandoffOwner; secrets: Record<string, string>; place: MemberPlace }): Promise<WorkflowEnvelope | undefined> {
  for (const record of await listMemberRecords(config, { member, repository })) {
    const held = await takeRunLock(config, record.run, async (lock): Promise<WorkflowEnvelope | undefined> => {
      // A member killed mid-step leaves its command's process group running, or its exec on a step runtime: nothing
      // else stops either. One that may still run keeps the claim, so no second copy of the step runs beside it.
      await stopRecordedGroup(attemptDir(config, record.run, record.attempt));
      const stillRuns = await stopLeftAttempt(config, record.run, record.attempt, root);

      if (stillRuns !== undefined) return { error: { code: 'runtime_lost', message: `The step it ran on a step runtime may still run there: ${stillRuns}` } };
      // Its place there is closed: a run of the attempt starts again with a place and an exec of its own.
      await fs.rm(attemptRuntimePath(config, record.run, record.attempt), { force: true });

      if (record.state !== 'claimed' && record.state !== 'cancelling') return undefined;
      const ref = attemptRef(record.run, record.attempt);
      // Only this member pushes to the attempt's ref, so its tip is the last work it saved. Another member process in this
      // checkout may fetch meanwhile, so the tip comes from origin's listing, never from FETCH_HEAD.
      const listed = await git(root, ['ls-remote', '--quiet', 'origin', ref]);
      const saved = listed.stdout.split('\t')[0]?.trim() ?? '';
      const fetched = listed.code === 0 && saved !== '' ? await git(root, ['fetch', '--quiet', 'origin', ref]) : listed;
      const isFetched = fetched.code === 0 && (await git(root, ['cat-file', '-e', `${saved}^{commit}`])).code === 0;

      if (!isFetched) return { error: { code: 'fetch_failed', message: `The member could not fetch ${ref}, where the claim it holds keeps its work: ${fetched.stderr.trim() || 'origin does not hold it'}` } };

      if (record.state === 'cancelling') return answered(config, record, saved);
      log.info(`Finishing attempt ${record.attempt} of run ${record.run}, which this member claimed and left: step "${record.lease.step}" runs again from the work it pushed.`);

      return runClaim(config, { lock, claim: record, root, secrets, member, place, from: saved });
    }, { waitMs: 0 });

    if (held.kind !== 'held' || !held.value) continue;

    // A claim it cannot finish, such as one whose ref is gone, keeps the member from no other work: the owner gives
    // it up after stale_after.
    if ('error' in held.value) {
      log.warn(`Left attempt ${record.attempt} of run ${record.run}, which this member claimed before: ${held.value.error.message}`);
      continue;
    }

    return held.value;
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
 * Runs claim `claim` in a clone of `root` at `from`, the attempt's start commit unless a restarted member goes on from
 * the work it pushed, then pushes its work and writes how it ended. A cancel of the claim stops the step: its work is
 * pushed, and the member answers the cancel.
 */
async function runClaim(config: LocalConfig, { lock, claim, root, secrets, member, place, from = claim.start }: { lock: RunLock; claim: Claimed; root: string; secrets: Record<string, string>; member: HandoffOwner; place: MemberPlace; from?: string }): Promise<WorkflowEnvelope> {
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
    const next = trusted.next ?? `Once the owner ran teamai pull, ${retryCommand(run, lease.step)} offers it again.`;

    return finish({ exitCode: 1, stderr: `The member did not run step "${lease.step}": ${trusted.refused} ${next}` });
  }

  const runsHere = trusted.kind === 'command' ? place.command : place.prompt;

  if (runsHere === undefined) return finish({ exitCode: 1, stderr: `The member did not run step "${lease.step}": its driver runs no ${trusted.kind} step. ${retryCommand(run, lease.step)} offers it again.` });

  const fetched = await git(root, ['fetch', '--quiet', 'origin', ref]);

  if (fetched.code !== 0) return finish({ exitCode: 1, stderr: `The member could not fetch ${ref}: ${fetched.stderr.trim()}` });
  const read = await readMemberConfig(root);

  if ('error' in read) return finish({ exitCode: 1, stderr: `The member could not read the git config of its checkout: ${read.error}` });
  const memberConfig: MemberConfig = new Set(read);
  // The step runs in a clone of its own, which shares the checkout's objects but not its config: a worktree would let the
  // step write the checkout's .git/config, which every later git command there reads. No git runs in the checkout once
  // the step started.
  await fs.rm(work, { recursive: true, force: true });
  const cloned = await git(root, ['clone', '--quiet', '--shared', '--no-checkout', root, work]);
  // The clone's origin is the checkout; the step sees the origin the checkout names, as it would there.
  const originUrl = keptOriginUrl(memberConfig);
  const named = cloned.code === 0 && originUrl !== undefined ? await git(work, ['remote', 'set-url', 'origin', originUrl]) : cloned;
  const added = named.code === 0 ? await git(work, ['checkout', '--quiet', '--detach', from]) : named;

  if (added.code !== 0) return finish({ exitCode: 1, stderr: `The member could not check out ${from}: ${added.stderr.trim()}` });
  // Each save is a commit on the one before, so the ref only moves forward.
  let tip = from;

  const save = async (message: string): Promise<{ to: string } | { error: string }> => {
    const saved = await pushWork({ work, ref, message, memberConfig, parent: tip, index: path.join(dir, 'snapshot.index') });

    // A commit one push URL took is where the next save goes on from, so every URL still takes it fast-forward.
    if ('to' in saved) tip = saved.to;
    else if (saved.taken !== undefined) tip = saved.taken;

    return saved;
  };

  try {
    const command = trusted.kind === 'prompt'
      ? promptRun(config, { lock, claim, trusted, place: place.prompt ?? { kind: 'here' }, work, root, secrets })
      : commandRun(place.command?.kind === 'runtime'
        ? runtimeCommand(config, { run, attempt, place: place.command, work, command: trusted.command, env: trusted.env })
        : startGroupedCommand({ command: trusted.command, cwd: work, env: { ...process.env, ...trusted.env }, detached: process.platform !== 'win32', group: dir }));

    let gone: string | undefined;
    let cancelling: Cancelling | undefined;
    let beating: Promise<void> | undefined;

    // A write of the claim that answered state_moved: the owner cancelled it, which the member answers once the step
    // stopped, or gave it up, after which nothing the member does counts. Either way the step stops.
    // A claimed record naming this member is a write of its own that landed though it could not tell, as when origin
    // took the push and its answer was lost: only the claim's member writes a claimed record over a claim.
    const moved = async (error: FleetError): Promise<void> => {
      if (gone !== undefined || cancelling !== undefined) return;
      const now = await readAttemptRecord(config, run, attempt);
      const record = now.ok && now.value !== 'absent' && 'member' in now.value && now.value.member.id === member.id ? now.value : undefined;

      if (record?.state === 'claimed') {
        latest = record;

        return;
      }

      if (record?.state === 'cancelling') cancelling = record;
      else gone = error.message;
      await command.stop();
    };

    // Progress comes three times per `stale_after`, so one late write does not make the member look gone. A beat still
    // writing skips the next, and the result waits for it, so each write replaces the one before. Between beats further
    // apart than CANCEL_READ_MS, the member reads the record for a cancel.
    const beatMs = Math.max(1_000, Math.floor(claim.staleAfterMs / 3));
    // Ticks divide a beat evenly, so beats come every beatMs, not at the next whole tick after it.
    const tickMs = Math.ceil(beatMs / Math.ceil(beatMs / CANCEL_READ_MS));
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

    const ran = await command.exit.finally(() => clearInterval(beat));
    await beating;

    if (gone !== undefined) return { error: { code: 'state_moved', message: `The owner of run ${run} gave up attempt ${attempt} of step "${lease.step}" while this member ran it, so its result was not written. ${gone}` } };
    const saved = await save(`[teamai] ${lease.step} (run ${run}, attempt ${attempt})`);

    if (cancelling) return answered(config, cancelling, 'to' in saved ? saved.to : latest.pushed);

    // A prompt's owner reads its end from `failure`, not the exit code.
    if ('error' in saved) return finish({ ...ran, exitCode: ran.exitCode === 0 ? 1 : ran.exitCode, stderr: saved.error, failure: { code: 'push_failed', message: saved.error } });

    // A restarted member goes on from work its killed run pushed, which is the step's work even when this run adds none.
    return finish(saved.to === claim.start ? ran : { ...ran, to: saved.to });
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** A step the member runs: how it ended, as the record writes it, and how to stop it. */
type StepRun = { exit: Promise<FleetResult>; stop: () => Promise<void> };

/** A command the member runs, ending as the local loop reports a command: its exit code, the JSON its stdout held, and the start of its stderr. */
function commandRun(command: GroupedCommand): StepRun {
  const exit = command.exit.then((exited): FleetResult => {
    const outputs = commandOutputs(exited.stdout);

    return { exitCode: exited.exitCode, stderr: exited.stderr.trim().slice(0, 400), ...(outputs !== undefined && { outputs }) };
  });

  return {
    exit,
    stop: async () => {
      await command.stop();
    },
  };
}

/**
 * Prompt step `trusted` of claim `claim`, run in clone `work` as this member runs a prompt step itself: its own tool,
 * model and login, here or on the step runtime `place` of its own driver, on a lease rebuilt from its own definitions.
 * It ends as the member's report says: success or failure, the output, the tool and its usage.
 */
function promptRun(config: LocalConfig, { lock, claim, trusted, place, work, root, secrets }: {
  lock: RunLock; claim: Claimed; trusted: Extract<Trusted, { kind: 'prompt' }>; place: NonNullable<MemberPlace['prompt']>; work: string; root: string; secrets: Record<string, string>;
}): StepRun {
  const { run, attempt } = claim;
  const { step } = trusted;
  const stopping = new AbortController();
  const running = place.kind === 'runtime' ? attemptRun({ config, run, attempt, runtime: place.runtime, driver: place.driver }) : undefined;

  const exit = (async (): Promise<FleetResult> => {
    await fs.mkdir(path.dirname(attemptResultPath(config, run, attempt)), { recursive: true });
    const teamEnv = await resolveWorkflowEnv(config);

    // The lease the engine would have sent this member, from its own copy of the step: the record names only its values.
    const lease: StagedLease = {
      attempt, revision: 0, step: claim.lease.step, prompt: trusted.prompt, env: trusted.env, cwd: work, processEnv: withRunningCli(process.env),
      ...(step.agent !== undefined && { agent: step.agent }),
      ...(step.tool !== undefined && { tool: step.tool }),
      ...(step.permissions === 'unattended' && { permissions: 'unattended' as const }),
      ...(step.model instanceof Object ? { model: step.model } : trusted.model !== undefined && { model: trusted.model }),
      ...(trusted.defaultModel !== undefined && { defaultModel: trusted.defaultModel }),
      ...(step.output !== undefined && { output: step.output }),
      ...(trusted.limits !== undefined && { limits: trusted.limits }),
    };

    const body = await runPromptStep({
      config, lock, driver: driverIdentity('local', root), lease, archive: openSessionArchive(config), signal: stopping.signal, mode: resolveRunMode(process.env),
      secrets: { ...teamEnv.secrets, ...secrets },
      ...(running && place.kind === 'runtime' && { onRuntime: {
        run: running, logins: place.logins, launchesAgents: place.launchesAgents, credentials: place.credentials, found: place.found, teamEnv,
        ...(place.defaultTool !== undefined && { defaultTool: place.defaultTool }), ...(place.isThrough && { isThrough: true as const }),
      } }),
    });

    const unclosed = await running?.close();

    if (unclosed) log.warn(unclosed.message);
    const outputs = JsonValueSchema.safeParse(body.outputs);

    return {
      exitCode: body.exitCode ?? (body.outcome === 'success' ? 0 : 1), stderr: (body.message ?? '').slice(0, 400),
      ...(body.outputs !== undefined && outputs.success && { outputs: outputs.data }),
      ...(body.tool !== undefined && { tool: body.tool }),
      ...(body.model !== undefined && { model: body.model }),
      ...(body.tokens !== undefined && { tokens: body.tokens }),
      ...(body.failure !== undefined && { failure: { code: body.failure.code, message: body.failure.message } }),
    };
  })();

  return {
    exit,
    stop: async () => {
      stopping.abort();
      await exit;
    },
  };
}

/**
 * Command `command` in clone `work` on the member's step runtime `place`: open a place on `work`, one exec of the shell,
 * bring the place's work back into `work`, close it. The runtime gets the step's env alone, never this process's. A
 * failure of the runtime ends it as a failed command whose stderr says why, so the member writes it as the step's end.
 */
function runtimeCommand(config: LocalConfig, { run, attempt, place, work, command, env }: { run: RunId; attempt: AttemptId; place: RuntimePlace; work: string; command: string; env: Record<string, string> }): GroupedCommand {
  const running = attemptRun({ config, run, attempt, runtime: place.runtime, driver: place.driver });
  let output = '';
  let stderr = '';
  // A stop while the place opens finds no exec to cancel, so the exec is not sent.
  let isStopRequested = false;
  const failed = (message: string): CommandExit => ({ exitCode: 1, stdout: '', stderr: `${stderr}${message} (step runtime "${place.use}")`, output });

  const exit = (async (): Promise<CommandExit> => {
    const result = path.dirname(attemptResultPath(config, run, attempt));
    const runDir = runScratchDir(config, run);
    await Promise.all([fs.mkdir(result, { recursive: true }), fs.mkdir(runDir, { recursive: true })]);
    const opened = await running.open({ worktree: work, readonly: [path.join(work, '.git')], result, runDir, toolHome: {} });

    if (!opened.ok) return failed(opened.failure.message);

    if (isStopRequested) {
      const unclosed = await running.close();

      if (unclosed) log.warn(unclosed.message);

      return { exitCode: STOPPED_EXIT_CODE, stdout: '', stderr, output };
    }

    // A command runs no tool, so it gets none of the runtime's credentials.
    const end = await running.exec({ argv: shellArgv(command), env, unset: [], credentials: {}, cwd: work }, {
      onOutput: (stream, data) => {
        output += data;

        if (stream === 'stderr') stderr = `${stderr}${data}`.slice(-STDERR_KEPT);
      },
    }, 'command');

    const uncollected = await running.collect();
    const unclosed = await running.close();

    if (uncollected) return failed(uncollected.message);

    if (unclosed) log.warn(unclosed.message);

    switch (end.kind) {
      case 'exited': return { exitCode: end.code, stdout: end.stdout, stderr, output: output || end.stdout };
      case 'cancelled': return { exitCode: STOPPED_EXIT_CODE, stdout: '', stderr, output };
      case 'failed':
      case 'lost': return failed(end.failure.message);
      case 'interrupted':
      case 'left': return failed('teamai stopped while the step ran.');
      default: {
        const unhandled: never = end;

        return unhandled;
      }
    }
  })();

  let stopping: Promise<CommandExit> | undefined;

  return {
    exit,
    stop: () => {
      isStopRequested = true;
      stopping ??= running.cancel().then(() => exit);

      return stopping;
    },
  };
}

/** What a member runs for a claim, as its own copy of the team's workflow defines it: a command, or a prompt step. */
type Trusted =
  | { kind: 'command'; command: string; env: Record<string, string> }
  | { kind: 'prompt'; step: WorkflowStep; prompt: string; model?: string; defaultModel?: string; env: Record<string, string>; limits?: TurnLimits };

/**
 * What the team's workflow defines for the step `claim` offers, its texts rendered from the offer's values, or why this
 * member does not run it. Anyone who can write to teamai-reports can write a record, so the member runs only what the
 * definitions the run executes say, read from its own team repository, as a claimer of a published run does; a lease
 * that says otherwise is refused, not corrected. Every team commit the record names counts only when this member would
 * run that commit itself: `definition.teamRevision` is the only one a record carries.
 */
async function trustedLease(config: LocalConfig, claim: Claimed): Promise<Trusted | { refused: string; next?: string }> {
  const { run, lease, definition, values } = claim;
  const { teamRevision, ...named } = definition;
  // A team commit the member would not run itself names no definitions: without it, only its own copy can match.
  const isTrusted = teamRevision !== undefined && await teamCommitReach(config, teamRevision) === 'member';
  const found = await definitionsOf(config, { run, ...named, ...(isTrusted && { teamRevision }) });

  if (!found.ok && teamRevision !== undefined && !isTrusted) {
    return { refused: `workflow "${definition.name}" comes from team commit ${teamRevision}, which neither this member's team checkout nor the team's default branch holds, and this member's copy of it differs. Merge it to the default branch.` };
  }

  if (!found.ok) return { refused: found.error.message };
  const kind = 'command' in lease ? 'command' : 'prompt';
  const defined = definedStep(found.value, lease.step);

  switch (defined.kind) {
    case 'step': break;
    case 'admitted':
      return {
        refused: `in workflow "${definition.name}", step "${defined.by}" runs the workflow step "${defined.from}" wrote, which no workflow of the team defines, so a member cannot check what it runs.`,
        next: `Route the steps of that workflow to a runtime besides the fleet.`,
      };
    case 'none': return { refused: `workflow "${definition.name}" has no ${kind} step at ${lease.step}.` };
    default: {
      const unhandled: never = defined;

      return unhandled;
    }
  }

  const { step, defaultModel } = defined;
  const rendered = leaseEnv(step, values, run);

  if ('error' in rendered) return { refused: `workflow "${definition.name}" ${rendered.error}.` };
  const names = [...new Set([...Object.keys(rendered.env), ...Object.keys(lease.env)])];
  const differs = names.filter((name) => rendered.env[name] !== lease.env[name]).sort();

  if (differs.length > 0) return { refused: `the offer's env ${differs.join(', ')} differs from what workflow "${definition.name}" renders from the offer's values.` };

  if ('command' in lease) {
    if (step.command === undefined) return { refused: `workflow "${definition.name}" has no command step at ${lease.step}.` };

    if (step.command !== lease.command) return { refused: `the offer's command differs from the one workflow "${definition.name}" defines for it.` };

    return { kind: 'command', command: step.command, env: rendered.env };
  }

  if (step.prompt === undefined || step.answer !== undefined) return { refused: `workflow "${definition.name}" has no prompt step at ${lease.step}.` };
  const texts = leasePrompt(step, values, run);

  if ('error' in texts) return { refused: `workflow "${definition.name}" ${texts.error}.` };

  if (texts.prompt !== lease.prompt) return { refused: `the offer's prompt differs from what workflow "${definition.name}" renders from the offer's values.` };

  return {
    kind: 'prompt', step, prompt: texts.prompt, env: rendered.env,
    ...(texts.model !== undefined && texts.model !== '' && { model: texts.model }),
    // A model that rendered empty asks for the tool's default, so the defaults' model does not stand in for it.
    ...(defaultModel !== undefined && texts.model !== '' && { defaultModel }),
    ...(lease.limits !== undefined && { limits: lease.limits }),
  };
}

/**
 * The step at instance path `stepPath` in `definitions`, as `locateStep` finds it in a run: a `finally` step at the top, and
 * nested workflows inline or by name. A workflow a `from` step admitted is in no definition: `admitted` names the step
 * `by` that runs it and the step `from` that wrote it.
 */
function definedStep({ definition, workflows }: Definitions, stepPath: string):
  | { kind: 'step'; step: WorkflowStep; defaultModel?: string } | { kind: 'admitted'; by: string; from: string } | { kind: 'none' } {
  const segments = parseStepPath(stepPath);
  let steps = definition.finally?.some((step) => step.id === segments[0]?.id) ? definition.finally : definition.steps;
  // The `defaults.model` in effect, a nested workflow's over the one it runs in, as the engine's scope keeps it.
  let defaultModel = definition.defaults?.model;

  for (const [index, segment] of segments.entries()) {
    const step = steps.find((item) => item.id === segment.id);

    if (!step) return { kind: 'none' };

    if (index === segments.length - 1) return { kind: 'step', step, ...(defaultModel !== undefined && { defaultModel }) };
    const runs = stepWorkflow(step);

    if (runs?.kind === 'from') return { kind: 'admitted', by: step.id, from: runs.step };
    const child = workflowRunBy({ workflows }, step, '');

    if (!child) return { kind: 'none' };
    steps = child.steps;
    defaultModel = ('defaults' in child ? child.defaults?.model : undefined) ?? defaultModel;
  }

  return { kind: 'none' };
}

/**
 * Snapshots what the step has in `work` as a commit on `parent` and pushes it to `ref`: the commit `ref` then holds. It
 * stages into `index`, a file of its own, so the step's own HEAD and index stay as the step left them while it still
 * runs. The step ran there, so only the programs of `memberConfig` that its config names run.
 */
async function pushWork({ work, ref, message, memberConfig, parent, index }: { work: string; ref: string; message: string; memberConfig: MemberConfig; parent: string; index: string }): Promise<{ to: string } | { error: string; taken?: string }> {
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
  const targets = pushTargets(memberConfig);

  if (targets.length === 0) return { error: `The member could not push the step's work to ${ref}: its checkout names no origin.` };

  const failed: string[] = [];

  for (const target of targets) {
    const pushed = await remoteGit(work, { kept: target.kept, env: hostGitEnv() }, ['push', '--quiet', target.url, `${to}:${ref}`], snapshotGit);

    if (pushed.code !== 0) failed.push(pushed.stderr.trim());
  }

  if (failed.length === 0) return { to };
  const error = `The member could not push the step's work to ${ref}: ${failed.join('; ')}`;

  // Saved only once every push URL holds it, as the owner fetches from its own origin.
  return failed.length < targets.length ? { error, taken: to } : { error };
}
