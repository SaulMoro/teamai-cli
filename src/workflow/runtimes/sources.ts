import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import type { RunMode } from '../../launch-context.js';
import { getKnowledgeDir, getTeamaiHomeDir, type LocalConfig } from '../../types.js';
import { resolveCliPath } from '../../utils/cli-path.js';
import { writeJsonAtomic } from '../../utils/fs.js';
import type { DriverCan } from '../requirements.js';
import type { WorkflowFailure } from '../types.js';
import { personalDir, resolveDriver, teamItem, type ResolvedDriver } from './definitions.js';
import { localStepRuntime } from './local.js';
import { stdioStepRuntime } from './stdio.js';
import type { RuntimeOptions, StepRuntime } from './step-runtime.js';
import type { LaunchTool } from '../../tool-launch/tools.js';

// ─── Where a step runtime comes from ─────────────────────
//
//  `local` is built in. Any other runtime is an external program, found first in the member's own
//  ~/.teamai/runtimes/<name>/, then in the team repo's runtimes/<name>/ (and runtimes/<namespace>/<name>/ for each
//  active namespace), then as `teamai-runtime-<name>` on PATH. A runtime directory holds an executable named `runtime`.
//  A team runtime is code a teammate pushed, so before its first spawn at a revision a person accepts that revision:
//  an attended run asks, and an unattended one refuses.
//

/** The file in a runtime directory that teamai spawns. */
export const RUNTIME_ENTRY = 'runtime';

export type RuntimeSource =
  | { kind: 'builtin'; name: 'local' }
  | { kind: 'personal' | 'path'; name: string; executable: string }
  | { kind: 'team'; name: string; executable: string; dir: string; relative: string };

async function isFile(at: string): Promise<boolean> {
  return (await fs.lstat(at).catch(() => undefined))?.isFile() === true;
}

/** The runtime `use` names for `driver`, or why there is none. */
export async function locateRuntime(driver: ResolvedDriver, use: string): Promise<{ ok: true; source: RuntimeSource } | { ok: false; failure: WorkflowFailure }> {
  if (use === 'local') return { ok: true, source: { kind: 'builtin', name: 'local' } };

  if (use === 'skill' || use === 'fleet') {
    return { ok: false, failure: { code: 'runtime_not_found', message: `Driver "${driver.name}" uses runtime "${use}", which this version of teamai does not run from a definition. Use local, or a runtime of your own or of the team.` } };
  }

  const personal = path.join(personalDir('runtimes'), use, RUNTIME_ENTRY);

  if (await isFile(personal)) return { ok: true, source: { kind: 'personal', name: use, executable: personal } };
  const root = path.join(getKnowledgeDir(driver.config), 'runtimes');
  const team = await teamItem(driver.config, root, use, '');

  if (team.kind === 'conflict') {
    return { ok: false, failure: { code: 'runtime_namespace_conflict', message: `Runtime "${use}" is defined in two active namespaces (${team.first} and ${team.second}). Keep it in one namespace, push it, run teamai pull, and start again.` } };
  }

  if (team.kind === 'found' && await isFile(path.join(team.at, RUNTIME_ENTRY))) {
    return { ok: true, source: { kind: 'team', name: use, executable: path.join(team.at, RUNTIME_ENTRY), dir: team.at, relative: path.relative(getKnowledgeDir(driver.config), team.at) } };
  }

  const onPath = resolveCliPath(`teamai-runtime-${use}`);

  if (onPath) return { ok: true, source: { kind: 'path', name: use, executable: onPath } };

  return {
    ok: false,
    failure: {
      code: 'runtime_not_found',
      message: `Driver "${driver.name}" uses runtime "${use}", and none is installed: no ~/.teamai/runtimes/${use}/${RUNTIME_ENTRY}, no runtimes/${use}/${RUNTIME_ENTRY} in the team repo, and no teamai-runtime-${use} on PATH.`,
    },
  };
}

/**
 * A team runtime's revision: a hash of every file under its directory, by relative path, executable bit and content,
 * with a link hashed as its target. Any change a teammate pushes there is a new revision.
 */
export async function runtimeRevision(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const entries = (await fs.readdir(dir, { recursive: true })).sort();

  for (const relative of entries) {
    const at = path.join(dir, relative);
    const stat = await fs.lstat(at);

    if (stat.isDirectory()) continue;
    const body = stat.isSymbolicLink() ? `link:${await fs.readlink(at)}` : await fs.readFile(at);
    hash.update(`${relative.split(path.sep).join('/')}\0${stat.mode & 0o111 ? 'x' : '-'}\0`).update(body).update('\0');
  }

  return hash.digest('hex');
}

const TrustFileSchema = z.object({ accepted: z.array(z.object({ dir: z.string(), revision: z.string(), acceptedAt: z.string() })) });

function trustFile(): string {
  return path.join(getTeamaiHomeDir(), 'trust', 'runtimes.json');
}

async function readTrust(): Promise<z.infer<typeof TrustFileSchema>> {
  try {
    return TrustFileSchema.parse(JSON.parse(await fs.readFile(trustFile(), 'utf8')));
  } catch {
    return { accepted: [] };
  }
}

/** Asks the person at this terminal; anything but yes declines. */
export async function askAtTerminal(question: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });

  try {
    return /^y(es)?$/i.test((await terminal.question(question)).trim());
  } finally {
    terminal.close();
  }
}

/**
 * Whether `source` may be spawned on this machine. Only a team runtime needs it: its revision must be one a person
 * accepted here. `mode` attended with a person at the terminal (`canAsk`) asks and records a yes; otherwise an
 * unaccepted revision is refused, naming what to run.
 */
export async function acceptRuntime(source: RuntimeSource, { mode, canAsk, ask = askAtTerminal }: { mode: RunMode; canAsk: boolean; ask?: (question: string) => Promise<boolean> }): Promise<{ ok: true } | { ok: false; failure: WorkflowFailure }> {
  if (source.kind !== 'team') return { ok: true };
  const revision = await runtimeRevision(source.dir);
  const trust = await readTrust();

  if (trust.accepted.some((entry) => entry.dir === source.dir && entry.revision === revision)) return { ok: true };
  const short = revision.slice(0, 12);
  const files = (await fs.readdir(source.dir, { recursive: true })).sort();

  if (mode === 'attended' && canAsk) {
    const question = `Step runtime "${source.name}" comes from the team repo (${source.relative}) at revision ${short}, which you have not accepted on this machine. `
      + `It runs as you, with your files. Review ${source.dir} (${files.join(', ')}) before you accept it.\nRun it? [y/N] `;

    if (await ask(question)) {
      await writeJsonAtomic(trustFile(), { accepted: [...trust.accepted, { dir: source.dir, revision, acceptedAt: new Date().toISOString() }] });

      return { ok: true };
    }

    return { ok: false, failure: { code: 'runtime_not_accepted', message: `Step runtime "${source.name}" at revision ${short} was not accepted, so it did not run. Nothing of the run changed.` } };
  }

  return {
    ok: false,
    failure: {
      code: 'runtime_not_accepted',
      message: `Step runtime "${source.name}" comes from the team repo (${source.relative}) at revision ${short}, which no one has accepted on this machine, and an unattended run does not ask. `
        + 'Run the same command once in a terminal, attended, to review and accept that revision, then run it unattended again.',
    },
  };
}

/** The tools whose login a runtime option may bring from a home dedicated to teamai, `<tool>: login`. */
export const LOGIN_TOOLS = ['codex'] as const satisfies readonly LaunchTool[];

export type LoginTool = (typeof LOGIN_TOOLS)[number];

/**
 * What teamai itself reads of a runtime entry's options; every other key goes to the runtime at `init`, which
 * validates it. `max_parallel` caps the runtime's own open attempts; `credentials` names the file logins it brings.
 */
const EngineOptionsSchema = z.object({
  max_parallel: z.number().int().min(1, 'max_parallel is a whole number of attempts, 1 or more').optional(),
  credentials: z.partialRecord(z.enum(LOGIN_TOOLS), z.literal('login')).optional(),
});

export interface EngineOptions {
  maxParallel?: number;
  logins: LoginTool[];
}

/** Splits `options` into what teamai reads and what the runtime gets, or names the first key teamai refuses. */
export function engineOptions(options: RuntimeOptions): { ok: true; engine: EngineOptions; runtime: RuntimeOptions } | { ok: false; key: string; message: string } {
  const parsed = EngineOptionsSchema.safeParse(options);

  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const key = issue?.path.join('.') || 'credentials';
    const message = key.startsWith('credentials') ? `credentials take ${LOGIN_TOOLS.map((known) => `${known}: login`).join(', ')}, the login teamai keeps for that tool` : issue?.message ?? 'not valid';

    return { ok: false, key, message };
  }

  const { max_parallel: maxParallel, credentials, ...runtime } = { ...options, ...parsed.data };
  const engine: EngineOptions = { logins: LOGIN_TOOLS.filter((tool) => credentials?.[tool] === 'login') };

  if (maxParallel !== undefined) engine.maxParallel = maxParallel;

  return { ok: true, engine, runtime };
}

/** One runtime of an opened definition: `local` in teamai's process, or an external one that took its options. */
export type OpenedRuntime =
  | { kind: 'local'; use: 'local'; engine: EngineOptions }
  | { kind: 'external'; use: string; runtime: StepRuntime; can: DriverCan; engine: EngineOptions };

/** A driver definition ready to drive: each of its runtimes, in definition order. The caller disposes them once the drive ends. */
export interface OpenedDriver {
  driver: ResolvedDriver;
  runtimes: [OpenedRuntime, ...OpenedRuntime[]];
}

/** Ends the connection to each external runtime of `opened`. */
export async function disposeDriver(opened: OpenedDriver): Promise<void> {
  await Promise.all(opened.runtimes.map((entry) => (entry.kind === 'external' ? entry.runtime.dispose() : undefined)));
}

/**
 * The options the definition gives runtime `use`, with the member's `workflows.drivers.<driver>.runtimes.<use>` from
 * user and workspace config over them, key by key.
 */
function entryOptions(driver: ResolvedDriver, use: string, given: RuntimeOptions | undefined): RuntimeOptions {
  return { ...given, ...driver.config.workflows?.drivers?.[driver.name]?.runtimes?.[use] };
}

function badOption(driver: ResolvedDriver, use: string, key: string, message: string): WorkflowFailure {
  return { code: 'bad_option', message: `Runtime "${use}" of driver definition ${driver.file} refused option "${key}": ${message}. Fix the option and start again.` };
}

/** Opens one runtime of `driver`: finds it, refuses a team runtime no one accepted here, starts it and passes its options. */
async function openRuntime(driver: ResolvedDriver, use: string, options: RuntimeOptions, { mode, canAsk }: { mode: RunMode; canAsk: boolean }): Promise<{ ok: true; opened: OpenedRuntime } | { ok: false; failure: WorkflowFailure }> {
  const split = engineOptions(options);

  if (!split.ok) return { ok: false, failure: badOption(driver, use, split.key, split.message) };
  const located = await locateRuntime(driver, use);

  if (!located.ok) return located;
  const { source } = located;

  if (source.kind === 'builtin') {
    const checked = await localStepRuntime().init({ options: split.runtime, mode });

    if (!checked.ok) return { ok: false, failure: badOption(driver, use, checked.failure.key ?? '?', checked.failure.message) };

    if (split.engine.logins.length > 0) return { ok: false, failure: badOption(driver, use, 'credentials', 'local runs each tool in the member\'s own home, so it brings no login') };

    return { ok: true, opened: { kind: 'local', use: 'local', engine: split.engine } };
  }

  const accepted = await acceptRuntime(source, { mode, canAsk });

  if (!accepted.ok) return accepted;
  const runtime = stdioStepRuntime({ name: source.name, command: source.executable });
  const ready = await runtime.init({ options: split.runtime, mode });

  if (ready.ok) return { ok: true, opened: { kind: 'external', use, runtime, can: ready.can, engine: split.engine } };
  await runtime.dispose();
  const { failure } = ready;

  return {
    ok: false,
    failure: failure.code === 'bad_option'
      ? badOption(driver, use, failure.key ?? '?', failure.message)
      : { code: 'runtime_failed', message: `Runtime "${source.name}" of driver "${driver.name}" did not start: ${failure.message}` },
  };
}

/**
 * Opens the definition `--driver <name>` names in `config`: resolves it (`personal: false` skips the member's own),
 * then opens each of its runtimes in order, so a bad option of any fails before a step runs.
 */
export async function openDriver(config: LocalConfig, name: string, { personal, mode, canAsk }: { personal: boolean; mode: RunMode; canAsk: boolean }): Promise<{ ok: true; opened: OpenedDriver } | { ok: false; failure: WorkflowFailure }> {
  const resolved = await resolveDriver(config, name, { personal });

  if (!resolved.ok) return resolved;
  const { driver } = resolved;
  const opened: OpenedRuntime[] = [];

  for (const entry of driver.definition.runtimes) {
    const one = await openRuntime(driver, entry.use, entryOptions(driver, entry.use, entry.options), { mode, canAsk });

    if (!one.ok) {
      await Promise.all(opened.map((done) => (done.kind === 'external' ? done.runtime.dispose() : undefined)));

      return one;
    }

    opened.push(one.opened);
  }

  const [first, ...rest] = opened;

  if (!first) return { ok: false, failure: { code: 'driver_invalid', message: `Driver definition ${driver.file} lists no runtime. Add one under runtimes and start again.` } };

  return { ok: true, opened: { driver, runtimes: [first, ...rest] } };
}
