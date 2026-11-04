import { resolveRunMode } from '../../launch-context.js';
import type { LocalConfig } from '../../types.js';
import { log } from '../../utils/logger.js';
import { AttemptIdSchema, readRun, type AttemptId, type RunId, type RunLock } from '../store.js';
import { attemptRun, readAttemptRuntime } from './attempt.js';
import { loginHolder, loginLockFile, releaseEndedLogins, writeLoginBack } from './login.js';
import { disposeDriver, LOGIN_TOOLS, openDriver } from './sources.js';

// ─── What cancelled attempts left on their step runtimes ─
//
//  A driver killed while its attempt ran leaves the tool running on the step runtime, and the attempt's login held.
//  `teamai workflow cancel`, holding the run's lock so no driver of it is live, stops each such attempt the way its
//  driver would have: it cancels the exec, brings the place's work back, writes the login back, closes the place,
//  and only then releases the login. An attempt it cannot stop keeps its login, so no second copy runs beside it.
//

/**
 * Stops what each cancelled attempt of the locked run left open on its step runtime, then releases the logins of the
 * attempts that no longer run. Says what it released, and which login stays held and how to free it.
 */
export async function stopCancelledAttempts(config: LocalConfig, lock: RunLock): Promise<void> {
  const { run } = lock;
  const state = await readRun(config, run);

  if (state === 'missing' || state === 'corrupt') return;
  const stillRunning = new Set<string>();

  for (const id of state.cancelledAttempts ?? []) {
    const attempt = AttemptIdSchema.safeParse(id);

    if (attempt.success && !await stopAttempt(config, run, attempt.data)) stillRunning.add(id);
  }

  const open = new Set([...stillRunning, ...state.steps.flatMap((step) => (step.status === 'leased' ? [step.lease.attempt] : []))]);

  for (const { tool, attempt } of await releaseEndedLogins(run, open)) log.info(`Released the ${tool} login teamai keeps, which attempt ${attempt} of run ${run} held.`);

  for (const tool of LOGIN_TOOLS) {
    const holder = await loginHolder(tool);

    if (holder?.run === run && stillRunning.has(holder.attempt)) {
      log.warn(`The ${tool} login teamai keeps stays held by attempt ${holder.attempt} of run ${run}, whose tool may still run. Stop that tool on its step runtime, then delete ${loginLockFile(tool)}.`);
    }
  }
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

    if (!await placed.stopLeftOperation()) return cannot('its exec or prompt still runs after teamai asked the runtime to cancel it.');
    const notCollected = await placed.collect();

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
