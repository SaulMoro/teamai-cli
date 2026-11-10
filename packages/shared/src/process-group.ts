// ─── Process groups ─────────────────────────────────────
//
//  How teamai and the runtimes stop what they started: a detached process group, or an attached command with its
//  descendants, through a child handle while its starter lives, or through the record it left once its starter died.
//

import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readRegularFile } from '@teamai/shared/regular-file';

/** Runs ps with `args` in the C locale, whose `lstart` reads the same on every machine and parses as a date. */
function ps(args: string[]): string {
  return execFileSync('ps', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
}

/** The start time of every process, as `ps -o lstart=` prints it, by pid; undefined when ps cannot run. */
export function processStarts(): Map<number, string> | undefined {
  let stdout: string;

  try {
    stdout = ps(['-A', '-o', 'pid=,lstart=']);
  } catch {
    return undefined;
  }

  return new Map(stdout.trim().split('\n').map((line) => {
    const [pid, ...start] = line.trim().split(/\s+/);

    return [Number(pid), start.join(' ')];
  }));
}

/**
 * What a record names: a detached process group, or with `tree`, an attached command, which shares its starter's group
 * and is reached as the process and its descendants. `start` is when that process started, as ps prints it; a record
 * written before ps answered has `spawnedAt` instead, the time in milliseconds its starter spawned it.
 */
const RecordedSchema = z.union([
  z.object({ pid: z.number().int().positive(), start: z.string().min(1), tree: z.literal(true).optional() }),
  z.object({ pid: z.number().int().positive(), spawnedAt: z.number().int().nonnegative(), tree: z.literal(true).optional() }),
]);

type Recorded = z.infer<typeof RecordedSchema>;

/** How long before its starter read the clock a spawned process may have started: the spawn, which load slows. */
const SPAWN_LEEWAY_MS = 10_000;

/** Whether `psStart`, when ps says the recorded pid's process started, names the process `recorded` names. */
function isRecordedStart(recorded: Recorded, psStart: string | undefined): boolean {
  if (psStart === undefined) return false;

  if ('start' in recorded) return psStart === recorded.start;
  const started = Date.parse(psStart);

  // ps prints the start to the second, and the starter read the clock once the spawn returned.
  return started <= recorded.spawnedAt && recorded.spawnedAt - started < SPAWN_LEEWAY_MS;
}

/** The file a teamai before #1523 wrote in a directory: the last process group started there. */
const LEGACY_GROUP_FILE = 'group.json';

/** The prefix of the files that record a process group started in a directory, one file per group. */
const GROUP_PREFIX = 'group-';

/** The name of the file that records one process group, by its pid. */
const GROUP_FILE = /^group-\d+\.json$/;

/**
 * Records in `dir` the process group `child` leads, or with `isAttached`, `child` itself, which shares its starter's
 * group, for `stopRecordedGroup` to stop once whatever started it is gone. Synchronous on purpose: a starter killed
 * right after the spawn still leaves the record, which an await would widen.
 *
 * One file per group: a setup and the command of one attempt each start a group in the same directory, and the second
 * must not displace the first, or a stop of the attempt leaves the first running (#1523).
 */
export function recordGroup(child: ChildProcess, dir: string, { isAttached = false }: { isAttached?: boolean } = {}): void {
  if (child.pid === undefined) return;
  const file = path.join(dir, `${GROUP_PREFIX}${child.pid}.json`);

  // Recorded before ps answers, which takes long enough for the command to start working and its starter to be killed:
  // until then the spawn time stands for the start. A teamai that reads only `start` stops nothing from it, as when
  // nothing was recorded.
  writeGroup(file, JSON.stringify({ pid: child.pid, spawnedAt: Date.now(), ...(isAttached && { tree: true }) }));
  const start = processStarts()?.get(child.pid);

  if (start === undefined) return;
  // A teamai that reads no `tree` signals a group led by this pid, which an attached command never leads: it stops nothing.
  const body = JSON.stringify({ pid: child.pid, start, ...(isAttached && { tree: true }) });
  writeGroup(file, body);
  // A teamai before #1523 reads only `group.json`, so the latest group is written there as well: a release that
  // predates the per-group files then stops one group rather than none. It reads the same group twice here, which
  // stops nothing twice.
  writeGroup(path.join(dir, LEGACY_GROUP_FILE), body);
}

/** Writes the record of one process group, so a reader never sees half of it. */
function writeGroup(file: string, body: string): void {
  const temporary = `${file}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(temporary, body);
    fs.renameSync(temporary, file);
  } catch {
    // The starter still stops its child itself; only a starter killed with it would leave the group running.
  }
}

/**
 * Stops every process group, and every attached command with its descendants, recorded in `dir`, and removes the
 * records. A setup and the command of one attempt each start one there, and a stop of the attempt has to reach both.
 */
export async function stopRecordedGroup(dir: string): Promise<void> {
  for (const file of await recordedGroups(dir)) {
    const recorded = await readGroup(file);

    if (recorded?.tree) await stopTree(recorded);
    else if (recorded !== undefined) await stopGroup(recorded);
    await fs.promises.rm(file, { force: true });
  }
}

/** The files in `dir` that record a process group: one per group, and the one a teamai before #1523 wrote. */
async function recordedGroups(dir: string): Promise<string[]> {
  let names: string[];

  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }

  return names
    .filter((name) => GROUP_FILE.test(name) || name === LEGACY_GROUP_FILE)
    .map((name) => path.join(dir, name));
}

/** What the file `file` records, undefined when it records nothing readable. */
async function readGroup(file: string): Promise<Recorded | undefined> {
  try {
    return RecordedSchema.parse(JSON.parse(await readRegularFile(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/** Whether a signal reached any process of group `pid`. */
function signalGroup(pid: number, name: NodeJS.Signals | 0): boolean {
  try {
    return process.kill(-pid, name);
  } catch {
    return false;
  }
}

/**
 * Stops `group`, a detached process group no child handle of this process reaches, with a five-second grace period
 * before SIGKILL. A group that is gone, or whose pid now leads another process, is left alone: while any process of a
 * group lives, POSIX reuses no pid equal to its id, so a group whose leader is gone is still the one recorded. Whether
 * it signalled the group. POSIX only: Windows has no process groups to reach.
 */
export async function stopGroup(group: Recorded): Promise<boolean> {
  if (process.platform === 'win32' || !signalGroup(group.pid, 0)) return false;
  const starts = processStarts();
  const leader = starts?.get(group.pid);

  // Without current identities, a pid reused since cannot be told apart, so the group is left alone.
  if (!starts || (leader !== undefined && !isRecordedStart(group, leader))) return false;
  signalGroup(group.pid, 'SIGTERM');

  // Counted rather than timed, so a faked clock cannot stretch the grace period.
  for (let probe = 0; signalGroup(group.pid, 0); probe += 1) {
    if (probe === 100) {
      signalGroup(group.pid, 'SIGKILL');
      break;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  return true;
}

/**
 * Each descendant of process `pid`, deepest first, with when it started, as `ps` lists them now; none when ps cannot
 * run. A process that daemonized away from the tree is not among them.
 */
function descendantsOf(pid: number): { pid: number; start: string }[] {
  let stdout = '';

  try {
    stdout = ps(['-A', '-o', 'pid=,ppid=,lstart=']);
  } catch {
    return [];
  }

  const children = new Map<number, { pid: number; start: string }[]>();

  for (const line of stdout.trim().split('\n')) {
    const [child, parent, ...start] = line.trim().split(/\s+/);

    if (!child || !parent || start.length === 0) continue;
    const siblings = children.get(Number(parent)) ?? [];
    siblings.push({ pid: Number(child), start: start.join(' ') });
    children.set(Number(parent), siblings);
  }

  const found: { pid: number; start: string }[] = [];
  const pending = [...children.get(pid) ?? []];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    found.push(next);
    pending.push(...children.get(next.pid) ?? []);
  }

  return found.toReversed();
}

/**
 * Stops `recorded`, an attached command no child handle of this process reaches, and each process it started, with a
 * five-second grace period before SIGKILL. A command whose pid now names a process started at another time is left
 * alone, as `stopGroup` leaves a group. POSIX only.
 */
async function stopTree(recorded: Recorded): Promise<void> {
  const rootStart = processStarts()?.get(recorded.pid);

  if (process.platform === 'win32' || rootStart === undefined || !isRecordedStart(recorded, rootStart)) return;
  const tree = [...descendantsOf(recorded.pid), { pid: recorded.pid, start: rootStart }];

  /** Signals each process of the tree that is still the one recorded; whether any was reached. */
  const signal = (name: NodeJS.Signals | 0): boolean => {
    const now = processStarts() ?? new Map<number, string>();

    return tree.filter(({ pid, start }) => now.get(pid) === start).reduce((reached, { pid }) => {
      try {
        return process.kill(pid, name) || reached;
      } catch {
        return reached;
      }
    }, false);
  };

  signal('SIGTERM');

  // Counted rather than timed, so a faked clock cannot stretch the grace period.
  for (let probe = 0; signal(0); probe += 1) {
    if (probe === 100) {
      signal('SIGKILL');
      break;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/** Stops a detached process group or an attached process tree, with a five-second grace period before SIGKILL. */
export function stopProcess<T>(child: ChildProcess, exit: Promise<T>, detached: boolean): (signal?: NodeJS.Signals) => Promise<T> {
  let stopping: Promise<T> | undefined;
  let descendants: { pid: number; start: string }[] = [];

  /** Whether the signal reached any process in the group or tree. */
  const signal = (name: NodeJS.Signals | 0): boolean => {
    try {
      if (detached && child.pid !== undefined) return process.kill(-child.pid, name);
      let targets = descendants;

      if ((name === 0 || name === 'SIGKILL') && descendants.length > 0) {
        // Without current identities, stop only the shell.
        const starts = processStarts() ?? new Map<number, string>();
        // lstart has one-second resolution and the check is not atomic with kill, so this narrows the window but does not close it.
        targets = descendants.filter(({ pid, start }) => starts.get(pid) === start);
      }

      let reached = false;

      for (const { pid } of targets) {
        try { reached = process.kill(pid, name) || reached; } catch { /* Already exited. */ }
      }

      return child.kill(name) || reached;
    } catch {
      return false;
    }
  };

  const stop = async (initial: NodeJS.Signals): Promise<T> => {
    if (process.platform === 'win32' && child.pid !== undefined) {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});

      return exit;
    }

    if (!detached && child.pid !== undefined) descendants = descendantsOf(child.pid);

    signal(initial);
    let timer: NodeJS.Timeout | undefined;
    let escalated = false;

    const killed = new Promise<void>((resolve) => {
      timer = setTimeout(() => { escalated = true; signal('SIGKILL'); resolve(); }, 5000);
    });

    const result = await exit;

    // A process with its own output can ignore SIGTERM and outlive the shell. Keep SIGKILL while any captured
    // descendant or process in the detached group remains.
    // Descendants may still be exiting when the shell closes. Recheck instead
    // of waiting the whole grace period after that first successful probe.
    // `escalated` flips inside the setTimeout closure registered above, which the linter can't see.
    // oxlint-disable-next-line no-unmodified-loop-condition
    while (!escalated && signal(0)) {
      await Promise.race([killed, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
    }

    clearTimeout(timer);

    return result;
  };

  return (initial = 'SIGTERM') => (stopping ??= stop(initial));
}
