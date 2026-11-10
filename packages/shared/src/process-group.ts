// ─── Process groups ─────────────────────────────────────
//
//  How teamai and the runtimes stop what they started: a detached process group, or an attached command with its
//  descendants, through a child handle while its starter lives, or through the record it left once its starter died.
//

import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readRegularFile, readRegularFileSync } from '@teamai/shared/regular-file';

/** Runs ps with `args` in the C locale, whose `lstart` reads the same on every machine and parses as a date. */
function ps(args: string[]): string {
  return execFileSync('ps', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
}

/**
 * When a running process started. On Linux, in clock ticks since the machine booted, read from `/proc`, which a
 * container whose BusyBox `ps` prints no start time still has; elsewhere as `ps -o lstart=` prints it, to the second.
 * `at` is that time in milliseconds since the epoch.
 */
type ProcessStart = { ticks: number; at: number } | { lstart: string; at: number };

/** Whether `a` and `b` are the start of one process, read at two times. */
function isSameStart(a: ProcessStart, b: ProcessStart): boolean {
  return 'ticks' in a ? 'ticks' in b && a.ticks === b.ticks : 'lstart' in b && a.lstart === b.lstart;
}

/** A running process: its parent, and when it started. */
interface RunningProcess { ppid: number; start: ProcessStart }

/** Every running process by pid, from `/proc` on Linux and from ps elsewhere; undefined when neither can tell. */
function runningProcesses(): Map<number, RunningProcess> | undefined {
  return procProcesses() ?? psProcesses();
}

/** The fields of `/proc/<pid>/stat` this module reads: the parent (field 4) and the start in ticks (field 22). */
function statFields(stat: string): { ppid: number; ticks: number } | undefined {
  // The command name, field 2, is in parentheses and may hold spaces or parentheses itself: fields count after its last `)`.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ppid = Number(fields[1]);
  const ticks = Number(fields[19]);

  return Number.isInteger(ppid) && Number.isInteger(ticks) ? { ppid, ticks } : undefined;
}

/** The clock ticks per second `/proc` counts in (USER_HZ), 100 on every architecture Linux exposes to Node. */
const USER_HZ = 100;

/** When the machine booted, in milliseconds since the epoch, as `/proc/stat` tells it (to the second). */
function bootTime(stat: string): number | undefined {
  const boot = Number(/^btime (\d+)$/m.exec(stat)?.[1]);

  return Number.isInteger(boot) ? boot * 1000 : undefined;
}

/** The start of a process that started `ticks` after a boot at `boot`. */
function tickStart(ticks: number, boot: number): ProcessStart {
  return { ticks, at: boot + (ticks * 1000) / USER_HZ };
}

/** Every running process, read from `/proc`; undefined off Linux or when `/proc` cannot be read. */
function procProcesses(): Map<number, RunningProcess> | undefined {
  if (process.platform !== 'linux') return undefined;
  let boot: number | undefined;
  let names: string[];

  try {
    boot = bootTime(readRegularFileSync('/proc/stat', 'utf8'));
    names = fs.readdirSync('/proc');
  } catch {
    return undefined;
  }

  if (boot === undefined) return undefined;
  const running = new Map<number, RunningProcess>();

  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let fields: { ppid: number; ticks: number } | undefined;

    try {
      fields = statFields(readRegularFileSync(`/proc/${name}/stat`, 'utf8'));
    } catch {
      // The process exited while the folder was read.
      continue;
    }

    if (fields !== undefined) running.set(Number(name), { ppid: fields.ppid, start: tickStart(fields.ticks, boot) });
  }

  return running;
}

const PROCESSES_ARGS = ['-A', '-o', 'pid=,ppid=,lstart='];

/** Every running process, as ps lists it; undefined when ps cannot run or prints no start time. */
function psProcesses(): Map<number, RunningProcess> | undefined {
  try {
    return processesOf(ps(PROCESSES_ARGS));
  } catch {
    return undefined;
  }
}

function processesOf(stdout: string): Map<number, RunningProcess> {
  const running = new Map<number, RunningProcess>();

  for (const line of stdout.trim().split('\n')) {
    const [pid, ppid, ...start] = line.trim().split(/\s+/);
    const lstart = start.join(' ');

    if (pid && ppid && lstart) running.set(Number(pid), { ppid: Number(ppid), start: { lstart, at: Date.parse(lstart) } });
  }

  return running;
}

/**
 * What a record says of when process `pid` started, read without holding the event loop: one `/proc` read on Linux,
 * else ps off the event loop. Undefined when no process has the pid or neither can tell.
 */
async function recordedStartOf(pid: number): Promise<{ startTicks: number; pidNamespace?: string } | { start: string } | undefined> {
  const [startTicks, pidNamespace] = await Promise.all([processStartTicks(pid), ownPidNamespace()]);

  if (startTicks !== undefined) return { startTicks, ...(pidNamespace !== undefined && { pidNamespace }) };

  return new Promise((resolve) => {
    execFile('ps', PROCESSES_ARGS, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
      const start = error ? undefined : processesOf(stdout).get(pid)?.start;

      resolve(start !== undefined && 'lstart' in start ? { start: start.lstart } : undefined);
    });
  });
}

/**
 * What a record names: a detached process group, or with `tree`, an attached command, which shares its starter's group
 * and is reached as the process and its descendants. On Linux `startTicks` is when that process started, in clock ticks
 * since boot, and `pidNamespace` the pid namespace its pid belongs to; elsewhere `start` is when it started, as ps
 * prints it. A record written before either was read has `spawnedAt` instead, the time in milliseconds its starter
 * spawned it.
 */
const RecordedSchema = z.union([
  z.object({ pid: z.number().int().positive(), startTicks: z.number().int().nonnegative(), pidNamespace: z.string().min(1).optional(), tree: z.literal(true).optional() }),
  z.object({ pid: z.number().int().positive(), start: z.string().min(1), tree: z.literal(true).optional() }),
  z.object({ pid: z.number().int().positive(), spawnedAt: z.number().int().nonnegative(), tree: z.literal(true).optional() }),
]);

type Recorded = z.infer<typeof RecordedSchema>;

/** How long before its starter read the clock a spawned process may have started: the spawn, which load slows. */
const SPAWN_LEEWAY_MS = 10_000;

/**
 * Whether `recorded` names a process in the pid namespace `namespace`, this process's: a pid recorded in another one
 * (a container and its host sharing a home) names another process here.
 */
function isOwnNamespace(recorded: Recorded, namespace: string | undefined): boolean {
  return !('startTicks' in recorded) || recorded.pidNamespace === namespace;
}

/** Whether `live`, when the recorded pid's process started, names the process `recorded` names. */
function isRecordedStart(recorded: Recorded, live: ProcessStart | undefined): boolean {
  if (live === undefined) return false;

  if ('startTicks' in recorded) return 'ticks' in live && live.ticks === recorded.startTicks;

  // A record an earlier teamai wrote where ps tells the start, read here from `/proc`: both count whole seconds from boot.
  if ('start' in recorded) return 'lstart' in live ? live.lstart === recorded.start : Math.floor(live.at / 1000) * 1000 === Date.parse(recorded.start);

  // ps prints the start to the second, `/proc` counts from a boot time to the second, and the starter read the clock
  // once the spawn returned.
  return live.at <= recorded.spawnedAt && recorded.spawnedAt - live.at < SPAWN_LEEWAY_MS;
}

/** The file a teamai before #1523 wrote in a directory: the last process group started there. */
const LEGACY_GROUP_FILE = 'group.json';

/** The prefix of the files that record a process group started in a directory, one file per group. */
const GROUP_PREFIX = 'group-';

/** The name of the file that records one process group, by its pid. */
const GROUP_FILE = /^group-\d+\.json$/;

/** The ps reads still to finish for records in a directory, by its resolved path, which a stop there waits for first. */
const pendingStarts = new Map<string, Promise<void>>();

/**
 * Records in `dir` the process group `child` leads, or with `isAttached`, `child` itself, which shares its starter's
 * group, for `stopRecordedGroup` to stop once whatever started it is gone. The first record is written before this
 * returns: a starter killed right after the spawn still leaves it, which an await would widen.
 *
 * One file per group: a setup and the command of one attempt each start a group in the same directory, and the second
 * must not displace the first, or a stop of the attempt leaves the first running (#1523).
 */
export function recordGroup(child: ChildProcess, dir: string, { isAttached = false }: { isAttached?: boolean } = {}): void {
  if (child.pid === undefined) return;
  const { pid } = child;
  const file = path.join(dir, `${GROUP_PREFIX}${pid}.json`);

  // Recorded before its start is read, which through ps takes long enough for the command to start working and its
  // starter to be killed: until then the spawn time stands for the start. A teamai that reads only `start` stops nothing
  // from it, as when nothing was recorded. ps then runs off the event loop, so a step's command and its output are not
  // held while it does.
  writeGroup(file, JSON.stringify({ pid, spawnedAt: Date.now(), ...(isAttached && { tree: true }) }));
  const recordsDir = path.resolve(dir);

  // The start is read at once; it is written after the records begun before it in `dir`, so `group.json` stays the latest.
  const settled: Promise<void> = Promise.all([recordedStartOf(pid), pendingStarts.get(recordsDir)]).then(([start]) => {
    if (pendingStarts.get(recordsDir) === settled) pendingStarts.delete(recordsDir);

    // Once this process reaped the child, its pid may name another process. A stop in another process may have removed
    // the record meanwhile: it is not written again.
    if (start === undefined || child.exitCode !== null || child.signalCode !== null || !fs.existsSync(file)) return;
    // A teamai that reads no `tree` signals a group led by this pid, which an attached command never leads: it stops nothing.
    const body = JSON.stringify({ pid, ...start, ...(isAttached && { tree: true }) });
    writeGroup(file, body);
    // A teamai before #1523 reads only `group.json`, so the latest group is written there as well: a release that
    // predates the per-group files then stops one group rather than none. It reads the same group twice here, which
    // stops nothing twice.
    writeGroup(path.join(dir, LEGACY_GROUP_FILE), body);
  });

  pendingStarts.set(recordsDir, settled);
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
  // A record this process is still completing is finished first, so the stop removes it rather than racing its write.
  await pendingStarts.get(path.resolve(dir));
  const namespace = await ownPidNamespace();

  for (const file of await recordedGroups(dir)) {
    const recorded = await readGroup(file);

    if (recorded === undefined || !isOwnNamespace(recorded, namespace)) {
      // Nothing here to stop: a pid recorded in another pid namespace names another process here.
    } else if (recorded.tree) await stopTree(recorded);
    else await stopGroup(recorded);
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
  const running = runningProcesses();
  const leader = running?.get(group.pid);

  // Without current identities, a pid reused since cannot be told apart, so the group is left alone.
  if (!running || (leader !== undefined && !isRecordedStart(group, leader.start))) return false;
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

/** A process found running, and when it started, which tells it from a later process given its pid. */
interface FoundProcess { pid: number; start: ProcessStart }

/** Whether `found` is still running in `now`: its pid names a process that started when it did. */
function isStillRunning(now: Map<number, RunningProcess>, found: FoundProcess): boolean {
  const running = now.get(found.pid);

  return running !== undefined && isSameStart(running.start, found.start);
}

/**
 * Each descendant of process `pid`, deepest first, with when it started, as they run now; none when that cannot be
 * read. A process that daemonized away from the tree is not among them.
 */
function descendantsOf(pid: number): FoundProcess[] {
  const children = new Map<number, FoundProcess[]>();

  for (const [child, { ppid, start }] of runningProcesses() ?? []) {
    const siblings = children.get(ppid) ?? [];
    siblings.push({ pid: child, start });
    children.set(ppid, siblings);
  }

  const found: FoundProcess[] = [];
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
  const rootStart = runningProcesses()?.get(recorded.pid)?.start;

  if (process.platform === 'win32' || rootStart === undefined || !isRecordedStart(recorded, rootStart)) return;
  const tree = [...descendantsOf(recorded.pid), { pid: recorded.pid, start: rootStart }];

  /** Signals each process of the tree that is still the one recorded; whether any was reached. */
  const signal = (name: NodeJS.Signals | 0): boolean => {
    const now = runningProcesses() ?? new Map<number, RunningProcess>();

    return tree.filter(({ pid, start }) => isStillRunning(now, { pid, start })).reduce((reached, { pid }) => {
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
  let descendants: FoundProcess[] = [];

  /** Whether the signal reached any process in the group or tree. */
  const signal = (name: NodeJS.Signals | 0): boolean => {
    try {
      if (detached && child.pid !== undefined) return process.kill(-child.pid, name);
      let targets = descendants;

      if ((name === 0 || name === 'SIGKILL') && descendants.length > 0) {
        // Without current identities, stop only the shell.
        const now = runningProcesses() ?? new Map<number, RunningProcess>();
        // ps's lstart has one-second resolution and the check is not atomic with kill, so this narrows the window but does not close it.
        targets = descendants.filter((found) => isStillRunning(now, found));
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

/**
 * When the process `pid` started, in clock ticks since the machine booted (field 22 of `/proc/<pid>/stat`): a value no
 * change of the wall clock moves. Only Linux has it; undefined elsewhere, or when no process has the pid.
 */
export async function processStartTicks(pid: number): Promise<number | undefined> {
  if (process.platform !== 'linux') return undefined;

  try {
    return statFields(await readRegularFile(`/proc/${pid}/stat`, 'utf8'))?.ticks;
  } catch {
    return undefined;
  }
}

/**
 * The pid namespace of this process, as `/proc/self/ns/pid` links it (`pid:[4026531836]`): a pid names a process only
 * inside it, so a container and its host each read the other's pids as their own. Only Linux has it.
 */
export async function ownPidNamespace(): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;

  try {
    return await fs.promises.readlink('/proc/self/ns/pid');
  } catch {
    return undefined;
  }
}

/**
 * When the process `pid` started, in milliseconds since the epoch: on Linux from `/proc`, which a container without a
 * full `ps` still has, elsewhere as `ps -o lstart=` prints it, to the second. Undefined when no process has the pid or
 * neither can tell.
 */
export async function processStartedAt(pid: number): Promise<number | undefined> {
  const ticks = await processStartTicks(pid);

  if (ticks !== undefined) {
    try {
      const boot = bootTime(await readRegularFile('/proc/stat', 'utf8'));

      if (boot !== undefined) return tickStart(ticks, boot).at;
    } catch {
      // No /proc/stat: ps may still tell.
    }
  }

  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 5_000 }, (error, stdout) => {
      const started = Date.parse(stdout.trim());

      resolve(error || Number.isNaN(started) ? undefined : started);
    });
  });
}
