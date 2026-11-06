import fs from 'node:fs/promises';
import { resolveRunMode } from '../../launch-context.js';
import type { LocalConfig } from '../../types.js';
import { log } from '../../utils/logger.js';
import type { RunStatus } from '../types.js';
import { existingCheckout } from '../run-location.js';
import { AttemptIdSchema, attemptsDir, readRun, type AttemptId, type RunId, type RunLock } from '../store.js';
import { attemptRun, readAttemptRuntime, releaseAttemptRuntime, type AttemptRuntimeRecord } from './attempt.js';
import { LOGIN_TOOLS, loginHolder, loginLockFile, releaseEndedLogins, writeLoginBack } from './login.js';
import { disposeDriver, openDriver } from './sources.js';
import { retryCommand } from './step-runtime.js';
import { CANCEL_FAILED } from '@teamai/runtime-protocol';

// ─── What cancelled attempts left on their step runtimes ─
//
//  A driver killed while its attempt ran leaves the tool running on the step runtime, and the attempt's login held.
//  `teamai workflow cancel`, holding the run's lock so no driver of it is live, stops each such attempt the way its
//  driver would have: it cancels the exec, brings the place's work back, writes the login back, closes the place,
//  and only then releases the login. An attempt it cannot stop keeps its place, its records and its login, so no
//  second copy runs beside it, and the next `teamai workflow cancel` of the run tries again. Each runtime is opened
//  in `recover` mode for this, and for new work only when it refuses that mode (sources.ts).
//

/**
 * Stops what each cancelled attempt of the locked run left open on its step runtime, and each other attempt whose place
 * a runtime still holds, such as one whose stop or close failed before, then releases the logins of the attempts that
 * no longer run. Says what it released, and which login stays held and how to free it. Attempt `release` goes through
 * the same stop, and what its runtime cannot confirm, such as a close it can never clear, does not hold it: the person
 * checked that nothing of it still runs, so teamai writes its login back and lets it go. Answers the run's status and
 * the attempts whose place it closed or let go.
 */
export async function stopCancelledAttempts(config: LocalConfig, lock: RunLock, release?: AttemptId): Promise<StoppedAttempts | undefined> {
  const { run } = lock;
  const state = await readRun(config, run);

  if (state === 'missing' || state === 'corrupt') return undefined;
  const leased = new Set(state.steps.flatMap((step) => (step.status === 'leased' ? [step.lease.attempt] : [])));
  const stillRunning = new Set<string>();

  const cancelled = (state.cancelledAttempts ?? []).flatMap((id) => {
    const attempt = AttemptIdSchema.safeParse(id);

    return attempt.success ? [attempt.data] : [];
  });

  const left = new Set([...cancelled, ...await placesLeftOpen(config, run, leased)]);

  if (release !== undefined && !left.has(release)) log.warn(`Attempt ${release} of run ${run} holds no place on a step runtime, so there is nothing to release.`);

  const stopped: StoppedAttempts = { status: state.status, closed: [], released: [] };
  // Each runtime starts in the run's checkout, or, once that folder is gone, where this cancel runs.
  const checkout = await existingCheckout(state) ?? process.cwd();

  for (const attempt of left) {
    // A step that failed because its stop was not confirmed can run again once it is.
    const lost = state.steps.find((step) => step.status === 'failed' && step.attempt === attempt && (step.failure?.code === 'runtime_lost' || step.failure?.code === CANCEL_FAILED));
    const ended = await stopAttempt(config, run, attempt, { isReleased: attempt === release, checkout, ...(lost && { retry: { run, step: lost.id } }) });

    if (ended === 'running') stillRunning.add(attempt);
    else if (ended !== 'none') stopped[ended].push(attempt);
  }

  const open = new Set([...stillRunning, ...leased]);

  for (const { tool, attempt } of await releaseEndedLogins(run, open)) log.info(`Released the ${tool} login teamai keeps, which attempt ${attempt} of run ${run} held.`);

  for (const tool of LOGIN_TOOLS) {
    const holder = await loginHolder(tool);

    if (holder?.run === run && stillRunning.has(holder.attempt)) {
      log.warn(`The ${tool} login teamai keeps stays held by attempt ${holder.attempt} of run ${run}, whose tool may still run. Stop that tool on its step runtime, then delete ${loginLockFile(tool)}.`);
    }
  }

  return stopped;
}

/** What a cancel stopped of a run: its status, and the attempts whose place it closed, or let go as the person asked. */
export interface StoppedAttempts {
  status: RunStatus;
  closed: AttemptId[];
  released: AttemptId[];
}

/** How a stop of an attempt ended: its place closed or let go, nothing left to stop, or its work may still run. */
type AttemptStop = 'closed' | 'released' | 'none' | 'running';

/** The attempts of `run` that no lease runs, whose record says a step runtime still holds their place. */
async function placesLeftOpen(config: LocalConfig, run: RunId, leased: ReadonlySet<string>): Promise<AttemptId[]> {
  const names = await fs.readdir(attemptsDir(config, run)).catch(() => []);
  const open: AttemptId[] = [];

  for (const name of names.sort()) {
    const attempt = AttemptIdSchema.safeParse(name);

    if (!attempt.success || leased.has(attempt.data)) continue;
    const record = await readAttemptRuntime(config, run, attempt.data);

    if (record && record.phase !== 'closed') open.push(attempt.data);
  }

  return open;
}

/** How a close tells the runtime the person let the attempt go. */
const RELEASE = { release: true } as const;

/**
 * Stops attempt `attempt` on the step runtime its record names, or says why it could not and answers false. A released
 * attempt the runtime cannot stop or close is let go instead, as the person asked.
 */
async function stopAttempt(config: LocalConfig, run: RunId, attempt: AttemptId, { isReleased, checkout, retry }: { isReleased: boolean; checkout: string; retry?: { run: string; step: string } }): Promise<AttemptStop> {
  const record = await readAttemptRuntime(config, run, attempt);

  if (!record || record.phase === 'closed') return 'none';

  const cannot = async (why: string): Promise<AttemptStop> => {
    if (isReleased) return releaseAttempt(config, run, attempt, why, record);
    log.warn(`Could not stop attempt ${attempt} of run ${run} on step runtime "${record.runtime}" of driver "${record.driver}": ${why}`);

    return 'running';
  };

  const opened = await openDriver(config, record.driver, { personal: true, mode: resolveRunMode(process.env), canAsk: false, purpose: 'stop', checkout });

  if (!opened.ok) return cannot(opened.failure.message);

  try {
    const entry = opened.opened.runtimes.find((one) => one.kind === 'external' && one.use === record.runtime);

    if (entry?.kind !== 'external') return cannot(`driver "${record.driver}" no longer uses that runtime.`);
    const placed = attemptRun({ config, run, attempt, runtime: entry.runtime, driver: record.driver });

    const notStopped = await placed.stopLeftOperation();

    // Nothing is brought back or closed while what ran may still write the place. A person who released the attempt
    // checked that nothing of it runs, so the runtime is still told to forget the place before teamai lets it go.
    if (notStopped && isReleased) await placed.close(RELEASE);

    if (notStopped) return cannot(`its exec or prompt may still run, since the runtime did not confirm it stopped (${notStopped.code}): ${notStopped.message}`);
    // A place whose work already came back is not brought back again.
    const notCollected = record.phase === 'collected' ? undefined : await placed.collect();

    if (notCollected) log.warn(notCollected.message);
    await writeHeldLoginBack(run, attempt, record, { isCollected: notCollected === undefined });
    const notClosed = await placed.close(isReleased ? RELEASE : undefined);

    if (!notClosed) {
      const then = retry ? ` Then run: ${retryCommand(retry)}` : '';

      if (record.closeFailed) log.info(`Closed the place of attempt ${attempt} of run ${run} on step runtime "${record.runtime}", which an earlier close had kept.${then}`);
      else log.info(`Stopped attempt ${attempt} of run ${run} on step runtime "${record.runtime}" and closed its place.${then}`);

      return 'closed';
    }

    return isReleased ? releaseAttempt(config, run, attempt, notClosed.message, record) : cannot(`${notClosed.message} Once you checked that nothing of it still runs there, run teamai workflow cancel ${run} --release ${attempt}.`);
  } catch (error) {
    return cannot(error instanceof Error ? error.message : String(error));
  } finally {
    await disposeDriver(opened.opened);
  }
}

/** Writes back the login attempt `attempt` holds, when it holds one; `isCollected` says its tool home came back. */
async function writeHeldLoginBack(run: RunId, attempt: AttemptId, record: AttemptRuntimeRecord, { isCollected }: { isCollected: boolean }): Promise<void> {
  const tool = LOGIN_TOOLS.find((one) => one === record.toolHome?.tool);
  const holder = tool && await loginHolder(tool);

  if (tool && record.toolHome && holder?.run === run && holder.attempt === attempt) {
    const notBack = await writeLoginBack({ tool, run, attempt, toolHome: record.toolHome.dir, collected: isCollected });

    if (notBack) log.warn(notBack.message);
  }
}

/**
 * Lets attempt `attempt` go though its runtime could not confirm its stop or close (`why`), as the person asked: writes
 * back the login it holds when its tool home came back, and records its place as no longer teamai's to close.
 * `before` is its record as the cancel found it open; the release's own close may have closed it since.
 */
async function releaseAttempt(config: LocalConfig, run: RunId, attempt: AttemptId, why: string, before: AttemptRuntimeRecord): Promise<'released'> {
  const record = await readAttemptRuntime(config, run, attempt) ?? before;
  await writeHeldLoginBack(run, attempt, record, { isCollected: record.phase === 'collected' });

  if (record.phase !== 'closed') await releaseAttemptRuntime(config, run, attempt, record);
  log.info(`Released attempt ${attempt} of run ${run} on step runtime "${record.runtime}" without its confirmation, as asked. That runtime may still keep the place: ${why}`);

  return 'released';
}
