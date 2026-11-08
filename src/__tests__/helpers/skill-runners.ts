import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { processStarts } from '../../tool-launch/process-stop.js';

// A runner notices a reported or cancelled attempt at its next check, every RUNNER_POLL_MS (10 s), given twice that
// for a check a busy machine slows. A test may not import the skill driver's tick (teamai/workflow-boundaries); a
// longer poll fails teardowns here, never passes them.
const EXIT_MS = 20_000;
const KILL_MS = 5_000;
const POLL_MS = 100;
// Clocks a test's fake timers cannot freeze, or the wait would never end.
const now = performance.now.bind(performance);

/**
 * The skill driver's runners under `root` that outlived their test, by pid. Each runner is a detached `teamai workflow
 * report <run> --driver skill --attempt <a>` that leads a process group of its own, keeps its pid in its attempt's
 * `runner.lock`, and ends at its next check once its attempt is reported or stopped. Waits that long for the runners
 * still alive, then stops the process group of each one left. A teardown calls it before it removes `root`, where the
 * locks are, and before `waitForDetachedChildren`, which would wait on a runner without stopping it; it expects none.
 * Synchronous, so a fixture's synchronous `remove` can call it. `exitMs`: how long the runners get to end on their own.
 * On Windows a runner leads no process group, so nothing is checked there.
 */
export function stopLeftSkillRunners(root: string, exitMs = EXIT_MS): number[] {
  const deadline = now() + exitMs;
  let alive = liveRunners(root);
  while (alive.length > 0 && now() < deadline) {
    pause(POLL_MS);
    alive = liveRunners(root);
  }
  const pids = alive.map(({ pid }) => pid);
  for (const pid of pids) signalGroup(pid, 'SIGTERM');
  const killAt = now() + KILL_MS;
  while (pids.some(groupAlive) && now() < killAt) pause(POLL_MS);
  for (const pid of pids.filter(groupAlive)) signalGroup(pid, 'SIGKILL');
  // A runner starts its step's setup and command in groups of their own, recorded beside its lock, which outlive it.
  for (const { dir } of alive) stopRecordedGroups(dir);
  return pids;
}

/** The message a teardown fails with when `left`, the pids `stopLeftSkillRunners` stopped, is not empty. */
export function leftSkillRunners(left: readonly number[]): string {
  return `Skill runners outlived the test and were stopped: ${left.join(', ')}. Report or cancel every attempt the test offers before it ends.`;
}

/** Each runner whose `runner.lock` under `root` a live skill runner still holds: its pid, and its attempt's directory. */
function liveRunners(root: string): Array<{ pid: number; dir: string }> {
  if (process.platform === 'win32' || !fs.existsSync(root)) return [];
  const locks = fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => path.basename(file) === 'runner.lock');
  return locks.flatMap((lock) => {
    const pid = lockPid(path.join(root, lock));
    return pid !== undefined && isSkillRunner(pid) ? [{ pid, dir: path.dirname(path.join(root, lock)) }] : [];
  });
}

/** Kills each process group recorded in `dir` (`recordGroup`) whose leader is still the process that started it. */
function stopRecordedGroups(dir: string): void {
  const starts = processStarts();
  for (const name of fs.readdirSync(dir).filter((file) => /^group-\d+\.json$/.test(file))) {
    try {
      const recorded: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (typeof recorded !== 'object' || recorded === null || !('pid' in recorded) || !('start' in recorded)) continue;
      if (typeof recorded.pid === 'number' && starts?.get(recorded.pid) === recorded.start) signalGroup(recorded.pid, 'SIGKILL');
    } catch {
      // Not written whole: the runner was stopped before it recorded the group.
    }
  }
}

function lockPid(lock: string): number | undefined {
  try {
    const held: unknown = JSON.parse(fs.readFileSync(lock, 'utf8'));
    return typeof held === 'object' && held !== null && 'pid' in held && typeof held.pid === 'number' ? held.pid : undefined;
  } catch {
    // Released between the listing and the read, or not written whole yet: no runner holds it.
    return undefined;
  }
}

/** Whether `pid` is a live skill runner, so a pid the system gave to another process since is never signalled. */
function isSkillRunner(pid: number): boolean {
  const listed = spawnSync('ps', ['-o', 'stat=,command=', '-p', String(pid)], { encoding: 'utf8' }).stdout?.trim() ?? '';
  return !listed.startsWith('Z') && / workflow report \S+ --driver skill --attempt /.test(listed);
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group ended on its own meanwhile.
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
