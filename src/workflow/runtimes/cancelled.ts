import fs from 'node:fs/promises';
import { resolveRunMode } from '../../launch-context.js';
import type { LocalConfig } from '../../types.js';
import { log } from '../../utils/logger.js';
import { AttemptIdSchema, attemptsDir, readRun, type AttemptId, type RunId, type RunLock } from '../store.js';
import { attemptRun, readAttemptRuntime } from './attempt.js';
import { loginHolder, loginLockFile, releaseEndedLogins, writeLoginBack } from './login.js';
import { disposeDriver, LOGIN_TOOLS, openDriver } from './sources.js';

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
 * no longer run. Says what it released, and which login stays held and how to free it.
 */
export async function stopCancelledAttempts(config: LocalConfig, lock: RunLock): Promise<void> {
  const { run } = lock;
  const state = await readRun(config, run);

  if (state === 'missing' || state === 'corrupt') return;
  const leased = new Set(state.steps.flatMap((step) => (step.status === 'leased' ? [step.lease.attempt] : [])));
  const stillRunning = new Set<string>();

  const cancelled = (state.cancelledAttempts ?? []).flatMap((id) => {
    const attempt = AttemptIdSchema.safeParse(id);

    return attempt.success ? [attempt.data] : [];
  });

  for (const attempt of new Set([...cancelled, ...await placesLeftOpen(config, run, leased)])) {
    if (!await stopAttempt(config, run, attempt)) stillRunning.add(attempt);
  }

  const open = new Set([...stillRunning, ...leased]);

  for (const { tool, attempt } of await releaseEndedLogins(run, open)) log.info(`Released the ${tool} login teamai keeps, which attempt ${attempt} of run ${run} held.`);

  for (const tool of LOGIN_TOOLS) {
    const holder = await loginHolder(tool);

    if (holder?.run === run && stillRunning.has(holder.attempt)) {
      log.warn(`The ${tool} login teamai keeps stays held by attempt ${holder.attempt} of run ${run}, whose tool may still run. Stop that tool on its step runtime, then delete ${loginLockFile(tool)}.`);
    }
  }
}

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

/** Stops attempt `attempt` on the step runtime its record names, or says why it could not and answers false. */
async function stopAttempt(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<boolean> {
  const record = await readAttemptRuntime(config, run, attempt);

  if (!record || record.phase === 'closed') return true;

  const cannot = (why: string): false => {
    log.warn(`Could not stop attempt ${attempt} of run ${run} on step runtime "${record.runtime}" of driver "${record.driver}": ${why}`);

    return false;
  };

  const opened = await openDriver(config, record.driver, { personal: true, mode: resolveRunMode(process.env), canAsk: false, purpose: 'stop' });

  if (!opened.ok) return cannot(opened.failure.message);

  try {
    const entry = opened.opened.runtimes.find((one) => one.kind === 'external' && one.use === record.runtime);

    if (entry?.kind !== 'external') return cannot(`driver "${record.driver}" no longer uses that runtime.`);
    const placed = attemptRun({ config, run, attempt, runtime: entry.runtime, driver: record.driver });

    const notStopped = await placed.stopLeftOperation();

    // Nothing is brought back or closed while what ran may still write the place.
    if (notStopped) return cannot(`its exec or prompt may still run, since the runtime did not confirm it stopped (${notStopped.code}): ${notStopped.message}`);
    // A place whose work already came back is not brought back again.
    const notCollected = record.phase === 'collected' ? undefined : await placed.collect();

    if (notCollected) log.warn(notCollected.message);
    const tool = LOGIN_TOOLS.find((one) => one === record.toolHome?.tool);
    const holder = tool && await loginHolder(tool);

    if (tool && record.toolHome && holder?.run === run && holder.attempt === attempt) {
      const notBack = await writeLoginBack({ tool, run, attempt, toolHome: record.toolHome.dir, collected: notCollected === undefined });

      if (notBack) log.warn(notBack.message);
    }

    const notClosed = await placed.close();

    return notClosed ? cannot(notClosed.message) : true;
  } catch (error) {
    return cannot(error instanceof Error ? error.message : String(error));
  } finally {
    await disposeDriver(opened.opened);
  }
}
