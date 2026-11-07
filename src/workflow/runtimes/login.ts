import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import { z } from 'zod';
import { getTeamaiHomeDir } from '../../types.js';
import { errnoCode } from '../../utils/fs.js';
import { log } from '../../utils/logger.js';
import { AttemptIdSchema, RunIdSchema, type AttemptId, type RunId } from '../store.js';
import type { WorkflowFailure } from '../types.js';
import type { LaunchTool } from '../../tool-launch/tools.js';

// ─── A tool login teamai keeps for step runtimes ─────────
//
//  `credentials: { codex: login }` in a runtime's options brings a login kept in a file from a home dedicated to
//  teamai, ~/.teamai/logins/codex, never from the member's daily home: Codex rejects a refresh token used twice, so a
//  copy that refreshes logs out every other holder. One live attempt at a time uses the login, on the whole machine:
//
//    take the lock (or wait, naming its holder)  →  copy auth.json into the attempt's tool home  →  open, exec, collect
//    →  write the attempt's auth.json back, compare-and-replace, for the same account only  →  release the lock
//
//  The lock belongs to the attempt, not to a teamai process: a driver killed meanwhile leaves it held, and the
//  attempt, reattached, finishes and releases it. `teamai workflow cancel` of the holder's run releases it too.
//

/** The tools whose login a runtime option may bring from a home dedicated to teamai, `<tool>: login`. */
export const LOGIN_TOOLS = ['codex'] as const satisfies readonly LaunchTool[];

export type LoginTool = (typeof LOGIN_TOOLS)[number];

/** The login file each tool keeps in its home, and the variable that names that home. */
const LOGIN_FILES = { codex: 'auth.json' } as const satisfies Record<LoginTool, string>;

const HOME_VARIABLES = { codex: 'CODEX_HOME' } as const satisfies Record<LoginTool, string>;

const TOOL_NAMES = { codex: 'Codex' } as const satisfies Record<LoginTool, string>;

/** How a waiting attempt checks the lock again. */
const WAIT_POLL_MS = 500;

/** The file of a `tool` home that holds its login, which only `holdLogin` puts in a tool home, or undefined for a tool teamai keeps no login of. */
export function loginFileOf(tool: string): string | undefined {
  const login = LOGIN_TOOLS.find((one) => one === tool);

  return login && LOGIN_FILES[login];
}

/** The home teamai keeps `tool`'s login in, which the member fills once with the tool's own login command. */
export function loginHome(tool: LoginTool): string {
  return path.join(getTeamaiHomeDir(), 'logins', tool);
}

/** The command that fills `tool`'s dedicated home, as every message about the login names it. */
export function loginCommand(tool: LoginTool): string {
  return `${HOME_VARIABLES[tool]}=${loginHome(tool)} ${tool} login`;
}

/** The file whose presence says an attempt holds `tool`'s login. */
export function loginLockFile(tool: LoginTool): string {
  return path.join(path.dirname(loginHome(tool)), `${tool}.lock`);
}

/** Who holds a login, and the hash of the file it copied into its tool home once it did. */
export const LoginLockSchema = z.object({
  run: RunIdSchema,
  attempt: AttemptIdSchema,
  takenAt: z.string(),
  copied: z.string().optional(),
});

export type LoginLock = z.infer<typeof LoginLockSchema>;

/** What `tool`'s lock file says: no attempt holds the login, this one does, or the file is not a lock teamai can read. */
async function readLock(tool: LoginTool): Promise<{ kind: 'free' } | { kind: 'held'; lock: LoginLock } | { kind: 'unreadable' }> {
  let body: string;

  try {
    body = await fs.readFile(loginLockFile(tool), 'utf8');
  } catch (error) {
    return errnoCode(error) === 'ENOENT' ? { kind: 'free' } : { kind: 'unreadable' };
  }

  try {
    return { kind: 'held', lock: LoginLockSchema.parse(JSON.parse(body)) };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** The attempt that holds `tool`'s login, or undefined when none does or its lock cannot be read. */
export async function loginHolder(tool: LoginTool): Promise<LoginLock | undefined> {
  const read = await readLock(tool);

  return read.kind === 'held' ? read.lock : undefined;
}

/** Writes `lock` to a file of its own, then links or renames it into place, so a reader never sees half of it. */
async function placeLock(tool: LoginTool, lock: LoginLock, { replace }: { replace: boolean }): Promise<boolean> {
  const file = loginLockFile(tool);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Its own name per call: two attempts of one process that ask at once never link each other's identity.
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(lock), { mode: 0o600, flag: 'wx' });

  try {
    if (replace) await fs.rename(temporary, file);
    else await fs.link(temporary, file);

    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

async function readRegular(file: string): Promise<Buffer | undefined> {
  const stat = await fs.lstat(file).catch(() => undefined);

  return stat?.isFile() ? fs.readFile(file) : undefined;
}

/** The account a Codex login file is for, or undefined when it does not parse as one. */
const CodexAuthSchema = z.object({ tokens: z.object({ account_id: z.string().min(1) }) });

function accountOf(body: Buffer): string | undefined {
  try {
    return CodexAuthSchema.parse(JSON.parse(body.toString('utf8'))).tokens.account_id;
  } catch {
    return undefined;
  }
}

/** Where an attempt that waits for a login says which attempt holds it, for `workflow` views to show. */
export function loginWaitFile(attemptDirectory: string): string {
  return path.join(attemptDirectory, 'login-wait.json');
}

export const LoginWaitSchema = z.object({ tool: z.enum(LOGIN_TOOLS), holder: z.object({ run: z.string(), attempt: z.string() }) });

/** What an attempt waiting for a login shows while it waits. */
export type LoginWait = z.infer<typeof LoginWaitSchema>;

/**
 * Takes `tool`'s login for attempt `attempt` of run `run` and copies its file into `toolHome`, waiting while another
 * attempt holds it (`onWait` is told who, once per holder). An attempt that already holds it, as after a restart,
 * keeps it and copies nothing it copied before. Fails when the dedicated home holds no login, or `signal` stops the wait.
 */
export async function holdLogin({ tool, run, attempt, toolHome, signal, onWait }: {
  tool: LoginTool;
  run: RunId;
  attempt: AttemptId;
  toolHome: string;
  signal: AbortSignal;
  onWait: (wait: LoginWait | undefined) => Promise<void>;
}): Promise<{ ok: true } | { ok: false; failure: WorkflowFailure }> {
  const source = path.join(loginHome(tool), LOGIN_FILES[tool]);
  let told: string | undefined;

  for (;;) {
    const read = await readLock(tool);

    // teamai never replaces a lock it cannot read: it may be another version's, held by an attempt that still runs.
    if (read.kind === 'unreadable') {
      if (told !== undefined) await onWait(undefined);

      return { ok: false, failure: { code: 'login_held', message: `teamai cannot read the ${tool} login lock ${loginLockFile(tool)}, so it cannot tell which attempt holds the login. If no step uses that login now, delete ${loginLockFile(tool)}, then retry the step.` } };
    }

    const holder = read.kind === 'held' ? read.lock : undefined;
    const mine = holder?.run === run && holder.attempt === attempt;

    if (!holder || mine) {
      const lock: LoginLock = holder ?? { run, attempt, takenAt: new Date().toISOString() };

      if (!holder && !await placeLock(tool, lock, { replace: false })) continue;

      if (told !== undefined) await onWait(undefined);

      if (lock.copied !== undefined) return { ok: true };
      const body = await readRegular(source);

      if (body === undefined) {
        await releaseLogin(tool, { run, attempt });

        return { ok: false, failure: { code: 'login_missing', message: `Step runtime credentials name ${tool}: login, and ${source} holds no login. Create it once with ${loginCommand(tool)}, then retry the step.` } };
      }

      await fs.mkdir(toolHome, { recursive: true });
      await fs.writeFile(path.join(toolHome, LOGIN_FILES[tool]), body, { mode: 0o600 });
      await placeLock(tool, { ...lock, copied: sha256(body) }, { replace: true });

      return { ok: true };
    }

    const key = `${holder.run}/${holder.attempt}`;

    if (told !== key) {
      told = key;
      await onWait({ tool, holder: { run: holder.run, attempt: holder.attempt } });
    }

    if (signal.aborted) return { ok: false, failure: { code: 'login_held', message: `Stopped while waiting for the ${tool} login teamai keeps, which run ${holder.run} holds.` } };
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
}

/**
 * Makes sure `tool`'s dedicated home holds a login before the step that brings it (`step`) opens its place. Attended at
 * a terminal (`canAsk`), it says why in one line and runs the tool's own login command there for the member, once;
 * otherwise it fails `credential_missing`, naming that command and the retry to run after it.
 */
export async function ensureLogin(tool: LoginTool, { step, canAsk }: { step: { run: string; id: string }; canAsk: boolean }): Promise<WorkflowFailure | undefined> {
  const file = path.join(loginHome(tool), LOGIN_FILES[tool]);

  if (await readRegular(file)) return undefined;
  const why = `Step "${step.id}" signs ${TOOL_NAMES[tool]} in on the login teamai keeps apart from your daily one, and ${loginHome(tool)} has no ${TOOL_NAMES[tool]} login yet.`;
  const retry = `teamai workflow retry ${step.run} ${step.id}`;

  if (!canAsk) {
    return { code: 'credential_missing', message: `${why} An unattended run does not sign in for you. Create it once with ${loginCommand(tool)}, then run: ${retry}` };
  }

  log.info(`${why} Running ${loginCommand(tool)} once to create it.`);
  await fs.mkdir(loginHome(tool), { recursive: true });

  const ended = await new Promise<{ code: number } | { error: string }>((resolve) => {
    const child = crossSpawn(tool, ['login'], { env: { ...process.env, [HOME_VARIABLES[tool]]: loginHome(tool) }, stdio: 'inherit' });
    child.on('error', (error) => resolve({ error: error.message }));
    child.on('close', (exit, signal) => resolve({ code: exit ?? (signal ? 128 : 1) }));
  });

  if ('error' in ended) {
    return { code: 'credential_missing', message: `${loginCommand(tool)} could not start (${ended.error}), so the step did not run. Make ${tool} runnable here, run it once, then run: ${retry}` };
  }

  if (ended.code === 0 && await readRegular(file)) return undefined;

  return { code: 'credential_missing', message: `${loginCommand(tool)} ended with status ${ended.code} and left no login in ${file}, so the step did not run. Run it again, then run: ${retry}` };
}

/** Releases `tool`'s login if attempt `attempt` of run `run` holds it. */
export async function releaseLogin(tool: LoginTool, { run, attempt }: { run: RunId; attempt: AttemptId }): Promise<void> {
  const holder = await loginHolder(tool);

  if (holder?.run === run && holder.attempt === attempt) await fs.rm(loginLockFile(tool), { force: true });
}

/**
 * Releases each login an attempt of run `run` holds that is no longer one of its `open` attempts, as `teamai workflow
 * cancel` does once it stopped them. Says which it released.
 */
export async function releaseEndedLogins(run: RunId, open: ReadonlySet<string>): Promise<Array<{ tool: LoginTool; attempt: AttemptId }>> {
  const released: Array<{ tool: LoginTool; attempt: AttemptId }> = [];

  for (const tool of LOGIN_TOOLS) {
    const holder = await loginHolder(tool);

    if (holder?.run !== run || open.has(holder.attempt)) continue;
    await fs.rm(loginLockFile(tool), { force: true });
    released.push({ tool, attempt: holder.attempt });
  }

  return released;
}

/**
 * Writes the login file the attempt's tool left in `toolHome` back to the dedicated home, while the attempt holds the
 * lock: only a regular file that parses as a login of the same account, and only over the file the attempt copied, so
 * a login made meanwhile stays. It keeps the dedicated file's permissions. A file the tool did not change writes
 * nothing. Otherwise it keeps the dedicated file and says why, `login_not_written_back`.
 */
export async function writeLoginBack({ tool, run, attempt, toolHome, collected }: { tool: LoginTool; run: RunId; attempt: AttemptId; toolHome: string; collected: boolean }): Promise<WorkflowFailure | undefined> {
  const target = path.join(loginHome(tool), LOGIN_FILES[tool]);
  const holder = await loginHolder(tool);

  const kept = (why: string): WorkflowFailure => ({
    code: 'login_not_written_back',
    message: `The ${tool} login the step used was not written back to ${target}: ${why}. The login there is unchanged; if ${tool} refreshed its token, log in again with ${loginCommand(tool)}, then retry the step.`,
  });

  if (holder?.run !== run || holder.attempt !== attempt || holder.copied === undefined) return kept('this attempt no longer holds the login');

  if (!collected) return kept('its runtime could not bring the attempt\'s tool home back');
  const written = await readRegular(path.join(toolHome, LOGIN_FILES[tool]));

  if (written === undefined) return kept(`the step left no regular ${LOGIN_FILES[tool]} in its tool home`);

  if (sha256(written) === holder.copied) return undefined;
  const current = await readRegular(target);

  // Written back already, by a driver killed before it released the lock.
  if (current !== undefined && sha256(current) === sha256(written)) return undefined;

  if (current === undefined || sha256(current) !== holder.copied) return kept('the login there changed while the step ran');
  const account = accountOf(written);

  if (account === undefined) return kept(`the step's ${LOGIN_FILES[tool]} is not a ${tool} login`);

  if (account !== accountOf(current)) return kept(`the step's ${LOGIN_FILES[tool]} is for another account`);
  const { mode } = await fs.stat(target);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, written, { mode: mode & 0o777 });
  await fs.chmod(temporary, mode & 0o777);
  await fs.rename(temporary, target);

  return undefined;
}
