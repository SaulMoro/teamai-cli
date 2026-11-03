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
import { stdioStepRuntime } from './stdio.js';
import type { StepRuntime } from './step-runtime.js';

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

/**
 * A driver definition ready to drive: the local loop as it always ran, or the loop on a step runtime that took the
 * definition's options and said what it can. The caller disposes the runtime once the drive ends.
 */
export type OpenedDriver =
  | { kind: 'local'; driver: ResolvedDriver }
  | { kind: 'runtime'; driver: ResolvedDriver; runtime: StepRuntime; can: DriverCan };

/**
 * Opens the definition `--driver <name>` names in `config`: resolves it (`personal: false` skips the member's own),
 * finds its runtime, refuses a team runtime no one accepted here, then starts it and passes it the definition's options.
 */
export async function openDriver(config: LocalConfig, name: string, { personal, mode, canAsk }: { personal: boolean; mode: RunMode; canAsk: boolean }): Promise<{ ok: true; opened: OpenedDriver } | { ok: false; failure: WorkflowFailure }> {
  const resolved = await resolveDriver(config, name, { personal });

  if (!resolved.ok) return resolved;
  const { driver } = resolved;
  const [entry] = driver.definition.runtimes;

  if (!entry) return { ok: false, failure: { code: 'driver_invalid', message: `Driver definition ${driver.file} lists no runtime. Add one under runtimes and start again.` } };
  const located = await locateRuntime(driver, entry.use);

  if (!located.ok) return located;
  const { source } = located;

  if (source.kind === 'builtin') {
    const [key] = Object.keys(entry.options ?? {});

    if (key !== undefined) return { ok: false, failure: { code: 'bad_option', message: `Driver definition ${driver.file} passes option "${key}" to runtime local, which takes none. Remove it and start again.` } };

    return { ok: true, opened: { kind: 'local', driver } };
  }

  const accepted = await acceptRuntime(source, { mode, canAsk });

  if (!accepted.ok) return accepted;
  const runtime = stdioStepRuntime({ name: source.name, command: source.executable });
  const ready = await runtime.init({ options: entry.options ?? {}, mode });

  if (ready.ok) return { ok: true, opened: { kind: 'runtime', driver, runtime, can: ready.can } };
  await runtime.dispose();
  const { failure } = ready;

  return {
    ok: false,
    failure: failure.code === 'bad_option'
      ? { code: 'bad_option', message: `Runtime "${source.name}" of driver definition ${driver.file} refused option "${failure.key ?? '?'}": ${failure.message}. Fix the option and start again.` }
      : { code: 'runtime_failed', message: `Runtime "${source.name}" of driver "${driver.name}" did not start: ${failure.message}` },
  };
}
