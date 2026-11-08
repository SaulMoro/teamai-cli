import fs from 'node:fs/promises';
import { resolveRunMode } from '../../launch-context.js';
import type { LocalConfig } from '../../types.js';
import { log } from '../../utils/logger.js';
import type { RunStatus, WorkflowFailure } from '../types.js';
import { existingCheckout } from '../run-location.js';
import { attemptDir, AttemptIdSchema, attemptsDir, readRun, type AttemptId, type RunId, type RunLock } from '../store.js';
import { knownSecrets } from '../../env-resolution.js';
import { attemptRun, attemptRuntimePath, maskAttemptResults, readAttemptRuntime, releaseAttemptRuntime, type AttemptRuntimeRecord } from './attempt.js';
import { LOGIN_TOOLS, loginHolder, loginLockFile, releaseEndedLogins, releaseLogin, writeLoginBack } from './login.js';
import { disposeDriver, openDriver } from './sources.js';
import { retryCommand } from './step-runtime.js';
import { CANCEL_FAILED } from '@teamai/runtime-protocol';
import { stopRecordedGroup } from '../../tool-launch/process-stop.js';
import { cancelFleetAttempt } from '../fleet/owner.js';
import { offeredPool } from '../fleet/record.js';

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

  // What a killed driver of this install started for a cancelled attempt, which leads a process group of its own, and
  // what a fleet member runs for one, which only the attempt's record reaches.
  for (const attempt of cancelled) {
    await stopRecordedGroup(attemptDir(config, run, attempt));

    if (await offeredPool(config, run, attempt) === undefined) continue;
    const asked = await cancelFleetAttempt(config, run, attempt);

    if (asked.ok) log.info(asked.message);
    else log.warn(asked.message);
  }

  const left = new Set([...cancelled, ...await placesLeftOpen(config, run, leased)]);

  if (release !== undefined && !left.has(release)) log.warn(`Attempt ${release} of run ${run} holds no place on a step runtime, so there is nothing to release.`);

  const stopped: StoppedAttempts = { status: state.status, closed: [], released: [] };
  // Each runtime starts in the run's checkout, or, once that folder is gone, where this cancel runs.
  const checkout = await existingCheckout(state) ?? process.cwd();

  // What an agent wrote itself into an attempt's result file was never masked by a driver killed before it read it.
  const masks: Record<string, string> = {};

  for (const attempt of left) {
    // A step that failed because its stop was not confirmed can run again once it is.
    const lost = state.steps.find((step) => step.status === 'failed' && step.attempt === attempt && (step.failure?.code === 'runtime_lost' || step.failure?.code === CANCEL_FAILED));
    const { ended, masked } = await stopAttempt(config, run, attempt, { isReleased: attempt === release, checkout, ...(lost && { retry: { run, step: lost.id } }) });
    Object.assign(masks, masked);

    if (ended === 'running') stillRunning.add(attempt);
    else if (ended !== 'none') stopped[ended].push(attempt);
  }

  await maskAttemptResults(config, run, { ...await knownSecrets(config), ...masks });

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

/** How `stopAttempt` ended: still `running`, with why, or done; `masked` holds the values its runtime's messages are masked with. */
type Stopped = ({ ended: Exclude<AttemptStop, 'running'> } | { ended: 'running'; why: string }) & { masked?: Record<string, string> };

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
 * Stops what a killed teamai left of attempt `attempt` on the step runtime its record names, through the driver recorded
 * for it, as `teamai workflow cancel` does, and closes its place there, before a driver without that runtime runs the
 * attempt's step again, and releases the login it held once its place closed. Answers why the stop or the close is not
 * confirmed, so the place is kept, or undefined once it is closed, or when the attempt holds no place open there.
 */
export async function stopOnRecordedDriver(config: LocalConfig, run: RunId, attempt: AttemptId, { checkout }: { checkout: string }): Promise<WorkflowFailure | undefined> {
  const record = await readAttemptRuntime(config, run, attempt);
  const stopped = await stopAttempt(config, run, attempt, { isReleased: false, checkout, isQuiet: true });

  // Its login was written back as its place closed; the attempt runs again elsewhere, so it holds it no longer.
  if (stopped.ended === 'closed') for (const tool of LOGIN_TOOLS) await releaseLogin(tool, { run, attempt });

  if (stopped.ended !== 'running' || !record) return undefined;

  return {
    code: 'runtime_lost',
    message: `Attempt ${attempt} ran on step runtime "${record.runtime}" of driver "${record.driver}", which could not stop what ran there, so it may still run: ${stopped.why} Resume the run with --driver ${record.driver}.`,
  };
}

/**
 * Stops attempt `attempt` on the step runtime its record names, or says why it could not (`running`, with `why`). A
 * released attempt the runtime cannot stop or close is let go instead, as the person asked. `isQuiet` leaves the warning
 * to the caller, which reports `why` itself.
 */
async function stopAttempt(config: LocalConfig, run: RunId, attempt: AttemptId, { isReleased, checkout, retry, isQuiet = false }: { isReleased: boolean; checkout: string; retry?: { run: string; step: string }; isQuiet?: boolean }): Promise<Stopped> {
  const record = await readAttemptRuntime(config, run, attempt);

  if (!record || record.phase === 'closed') return { ended: 'none' };

  const cannot = async (why: string): Promise<Stopped> => {
    if (isReleased) return { ended: await releaseAttempt(config, run, attempt, why, record) };

    if (!isQuiet) log.warn(`Could not stop attempt ${attempt} of run ${run} on step runtime "${record.runtime}" of driver "${record.driver}": ${why}`);

    return { ended: 'running', why };
  };

  const opened = await openDriver(config, record.driver, { personal: true, mode: resolveRunMode(process.env), canAsk: false, purpose: 'stop', checkout });

  if (!opened.ok) return cannot(opened.failure.message);

  try {
    const entry = opened.opened.runtimes.find((one) => one.kind === 'external' && one.use === record.runtime);

    if (entry?.kind !== 'external') return cannot(`driver "${record.driver}" no longer uses that runtime.`);
    const masked = entry.masks;
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

      return { ended: 'closed', masked };
    }

    return isReleased ? { ended: await releaseAttempt(config, run, attempt, notClosed.message, record), masked } : cannot(`${notClosed.message} Once you checked that nothing of it still runs there, run teamai workflow cancel ${run} --release ${attempt}.`);
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
  log.info(`Released attempt ${attempt} of run ${run} on step runtime "${record.runtime}" without its confirmation, as asked. What ran in its place may still be there, since the runtime did not confirm its end: ${why}`);

  return 'released';
}

/**
 * Closes again one place each step runtime closed for each run of `runs`, whose clone or team folder teamai removed
 * outside the drive that ran it, such as at the start of a later drive: the runtime sees the folder gone at a close,
 * the verb it cleans up at (T3 removes a project it added there). A close of a handle already closed answers `closed`.
 * Each definition is opened in `recover` mode, as a cancel opens it; what fails is only logged.
 */
export async function closeAfterSweep(config: LocalConfig, runs: readonly RunId[]): Promise<void> {
  for (const run of runs) {
    const state = await readRun(config, run);
    // The place each runtime of each definition closed last, by definition: the record written last.
    const closed = new Map<string, Map<string, { handle: string; at: number }>>();

    for (const name of await fs.readdir(attemptsDir(config, run)).catch((): string[] => [])) {
      const attempt = AttemptIdSchema.safeParse(name);
      const record = attempt.success ? await readAttemptRuntime(config, run, attempt.data) : undefined;

      if (!attempt.success || record?.phase !== 'closed' || record.open.handle === undefined) continue;
      const at = (await fs.stat(attemptRuntimePath(config, run, attempt.data))).mtimeMs;
      const byRuntime = closed.get(record.driver) ?? new Map<string, { handle: string; at: number }>();

      if ((byRuntime.get(record.runtime)?.at ?? -1) < at) byRuntime.set(record.runtime, { handle: record.open.handle, at });
      closed.set(record.driver, byRuntime);
    }

    const checkout = (state === 'missing' ? undefined : await existingCheckout(state)) ?? process.cwd();

    for (const [driver, handles] of closed) {
      const opened = await openDriver(config, driver, { personal: true, mode: resolveRunMode(process.env), canAsk: false, purpose: 'stop', checkout });

      if (!opened.ok) {
        log.debug(`Driver "${driver}" did not open to close again the places of run ${run} after teamai removed its clone: ${opened.failure.message}`);
        continue;
      }

      try {
        for (const entry of opened.opened.runtimes) {
          const handle = entry.kind === 'external' ? handles.get(entry.use)?.handle : undefined;
          const again = entry.kind === 'external' && handle !== undefined ? await entry.runtime.close(handle) : undefined;

          if (again && !again.ok) log.debug(`Runtime ${entry.use} did not close ${handle} again after teamai removed a clone of run ${run}: ${again.failure.message}`);
        }
      } finally {
        await disposeDriver(opened.opened);
      }
    }
  }
}
