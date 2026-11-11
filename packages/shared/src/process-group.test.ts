import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { identityOf, isSameProcess, recordGroup, stopGroup, stopProcess, stopRecordedGroup } from './process-group.js';

/** Whether this platform tells start times through ps rather than `/proc`, so a fake ps on PATH is what is read. */
const READS_PS = process.platform !== 'win32' && process.platform !== 'linux';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it('stops an attached child through child.kill without probing other PIDs', async () => {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 2147483647 });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(false);
  const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(await stopProcess(child, Promise.resolve('closed'), false)()).toBe('closed');
  expect(kill.mock.calls).toEqual([['SIGTERM'], [0]]);
  expect(processKill).not.toHaveBeenCalled();
});

it('gives an attached child five seconds before SIGKILL and waits for its exit', async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 2147483647 });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  let finish = (): void => {};
  const exit = new Promise<void>((resolve) => { finish = resolve; });
  const stop = stopProcess(child, exit, false);
  const stopping = stop();
  expect(stop()).toBe(stopping);
  await vi.advanceTimersByTimeAsync(4999);
  expect(kill.mock.calls).toEqual([['SIGTERM']]);
  await vi.advanceTimersByTimeAsync(1);
  expect(kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  finish();
  await stopping;
});

it('finishes promptly when a signalled group disappears shortly after the shell exits', async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 2147483647 });
  let probes = 0;
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0 && ++probes > 1) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  let ended = false;
  const stopping = stopProcess(child, Promise.resolve('closed'), true)().then(() => { ended = true; });
  try {
    await vi.advanceTimersByTimeAsync(100);
    expect(ended).toBe(true);
  } finally { await vi.runAllTimersAsync(); await stopping; }
});

it('stops a detached group that outlives its child', async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 2147483647 });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const stopping = stopProcess(child, Promise.resolve('closed'), true)();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await stopping).toBe('closed');
  expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[-2147483647, 'SIGTERM'], [-2147483647, 'SIGKILL']]);
  expect(kill).toHaveBeenCalledWith(-2147483647, 0);
});

it.skipIf(process.platform === 'win32')('stops an attached command when ps is unavailable', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const exit = new Promise<NodeJS.Signals | null>((resolve) => {
    child.once('close', (_code, signal) => resolve(signal));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    vi.stubEnv('PATH', '');
    expect(await stopProcess(child, exit, false)()).toBe('SIGTERM');
  } finally {
    child.kill('SIGKILL');
    await exit;
  }
});

it.runIf(READS_PS)('only escalates captured descendants with the same start time, including reparented survivors', async () => {
  vi.useFakeTimers();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-'));
  const snapshot = path.join(directory, 'snapshot');
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 424242 });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(false);
  const processKill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 'SIGTERM') {
      fs.writeFileSync(snapshot, '424243 1 Sun Oct 18 10:00:01 2026\n424244 424242 Sun Oct 18 10:00:00 2026\n424245 1 Sun Oct 18 10:00:00 2026\n');
    }
    return true;
  });
  try {
    fs.writeFileSync(snapshot, '424243 424242 Sun Oct 18 10:00:00 2026\n424244 424242 Sun Oct 18 10:00:00 2026\n424245 424244 Sun Oct 18 10:00:00 2026\n');
    fs.writeFileSync(path.join(directory, 'ps'), `#!/bin/sh
case "$3" in
  pid=,ppid=*) /bin/cat "${snapshot}" ;;
  pid=,lstart=) while read -r pid parent start; do echo "$pid $start"; done < "${snapshot}" ;;
esac
`, { mode: 0o755 });
    vi.stubEnv('PATH', directory);
    const stopping = stopProcess(child, Promise.resolve('closed'), false)();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await stopping).toBe('closed');
    for (const pid of [424243, 424244, 424245]) expect(processKill).toHaveBeenCalledWith(pid, 'SIGTERM');
    expect(processKill).not.toHaveBeenCalledWith(424243, 0);
    expect(processKill).not.toHaveBeenCalledWith(424243, 'SIGKILL');
    for (const pid of [424244, 424245]) {
      expect(processKill).toHaveBeenCalledWith(pid, 0);
      expect(processKill).toHaveBeenCalledWith(pid, 'SIGKILL');
    }
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.runIf(READS_PS)('escalates only the shell when the current process snapshot fails', async () => {
  vi.useFakeTimers();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-'));
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 424242 });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    // The first snapshot, taken before the stop, lists a descendant; every later one fails.
    fs.writeFileSync(path.join(directory, 'ps'), `#!/bin/sh
[ -e "${directory}/listed" ] && exit 1
: > "${directory}/listed"
echo '424243 424242 Sun Oct 18 10:00:00 2026'
`, { mode: 0o755 });
    vi.stubEnv('PATH', directory);
    const stopping = stopProcess(child, Promise.resolve('closed'), false)();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await stopping).toBe('closed');
    expect(processKill.mock.calls).toEqual([[424243, 'SIGTERM']]);
    expect(kill.mock.calls.filter(([signal]) => signal !== 0)).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(kill).toHaveBeenCalledWith(0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** Starts a detached shell that leads its own group and keeps a `sleep` in it, as a command's shell does. */
async function detachedGroup() {
  const shell = spawn('sh', ['-c', 'sleep 300 & wait'], { detached: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    shell.once('spawn', resolve);
    shell.once('error', reject);
  });
  const pid = shell.pid;
  if (pid === undefined) throw new Error('the detached shell has no pid');
  const alive = (): boolean => {
    try { return process.kill(-pid, 0); } catch { return false; }
  };
  return { shell, pid, alive };
}

/** The record `recordGroup` keeps of `pid` in `records`, once it says when the process started. */
async function completedRecord(records: string, pid: number): Promise<Record<string, unknown>> {
  const file = path.join(records, `group-${pid}.json`);
  let record: Record<string, unknown> = {};
  await vi.waitFor(() => {
    record = z.record(z.string(), z.unknown()).parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect('startTicks' in record || 'start' in record).toBe(true);
  }, { timeout: 5000 });
  return record;
}

it.skipIf(process.platform === 'win32')('stops a detached group whose shell was killed, from what was recorded of it', async () => {
  const records = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-killed-'));
  const { shell, pid, alive } = await detachedGroup();
  try {
    recordGroup(shell, records);
    await completedRecord(records, pid);
    const closed = new Promise((resolve) => { shell.once('close', resolve); });
    process.kill(pid, 'SIGKILL');
    await closed;
    expect(alive()).toBe(true);
    await stopRecordedGroup(records);
    expect(alive()).toBe(false);
  } finally {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    fs.rmSync(records, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('leaves a group alone when its pid now leads a process started at another time', async () => {
  const { pid, alive } = await detachedGroup();
  try {
    expect(await stopGroup({ pid, start: 'Thu Jan  1 00:00:00 1970' })).toBe(false);
    expect(alive()).toBe(true);
  } finally {
    process.kill(-pid, 'SIGKILL');
  }
});

it.skipIf(process.platform === 'win32')('stops every group recorded in a directory, not only the last one', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-groups-'));
  const first = await detachedGroup();
  const second = await detachedGroup();
  try {
    recordGroup(first.shell, directory);
    recordGroup(second.shell, directory);
    await stopRecordedGroup(directory);
    expect(first.alive()).toBe(false);
    expect(second.alive()).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally {
    for (const group of [first, second]) {
      try { process.kill(-group.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('stops a group whose starter was killed before ps told it when the group started', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-unread-'));
  const group = await detachedGroup();
  try {
    // No ps answers while the starter records the group, as when it is killed before ps does.
    vi.stubEnv('PATH', '');
    recordGroup(group.shell, directory);
    vi.unstubAllEnvs();

    await stopRecordedGroup(directory);

    expect(group.alive()).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally {
    try { process.kill(-group.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('stops a group recorded before ps answered where ps prints dates in the person\'s language', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-locale-'));
  const bin = path.join(directory, 'bin');
  const records = path.join(directory, 'records');
  fs.mkdirSync(bin);
  fs.mkdirSync(records);
  // A ps that prints in Chinese, as under a Chinese locale, unless asked for the C locale.
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\n[ "$LC_ALL" = C ] || export LC_ALL=zh_CN.UTF-8\nexec /bin/ps "$@"\n', { mode: 0o755 });
  const group = await detachedGroup();
  try {
    vi.stubEnv('PATH', '');
    recordGroup(group.shell, records);
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);

    await stopRecordedGroup(records);

    expect(group.alive()).toBe(false);
  } finally {
    try { process.kill(-group.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** A directory with a `ps` that answers after `seconds`, as on a loaded machine, and the records folder. */
function slowPs(seconds: number): { directory: string; bin: string; records: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-slow-ps-'));
  const bin = path.join(directory, 'bin');
  const records = path.join(directory, 'records');
  fs.mkdirSync(bin);
  fs.mkdirSync(records);
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\nsleep ${seconds}\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  return { directory, bin, records };
}

it.runIf(READS_PS)('records a group without holding the event loop while ps answers', async () => {
  const { directory, bin, records } = slowPs(1.5);
  const group = await detachedGroup();
  try {
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
    const started = performance.now();
    const fired = new Promise<number>((resolve) => { setTimeout(() => resolve(performance.now() - started), 10); });
    recordGroup(group.shell, records);
    vi.unstubAllEnvs();

    expect(await fired).toBeLessThan(1000);
    const file = path.join(records, `group-${group.pid}.json`);
    await vi.waitFor(() => { expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ pid: group.pid, start: expect.any(String) }); }, { timeout: 5000 });
    expect(fs.readFileSync(path.join(records, 'group.json'), 'utf8')).toBe(fs.readFileSync(file, 'utf8'));
  } finally {
    try { process.kill(-group.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('stops a group recorded while ps has not answered yet, and leaves no record behind', async () => {
  const { directory, bin, records } = slowPs(0.6);
  const group = await detachedGroup();
  try {
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
    recordGroup(group.shell, records);
    vi.unstubAllEnvs();

    await stopRecordedGroup(records);

    expect(group.alive()).toBe(false);
    // Past the time ps takes to answer, so a write it made after the stop would show.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(fs.readdirSync(records)).toEqual([]);
  } finally {
    try { process.kill(-group.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** A directory whose `ps` answers as BusyBox's does, which prints no start time: no `lstart`, no `-p`. */
function busyboxPs(): { directory: string; bin: string; records: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-busybox-ps-'));
  const bin = path.join(directory, 'bin');
  const records = path.join(directory, 'records');
  fs.mkdirSync(bin);
  fs.mkdirSync(records);
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\necho "ps: bad -o argument \'lstart\'" >&2\nexit 1\n', { mode: 0o755 });
  return { directory, bin, records };
}

/** Whether process `pid` is still running. */
function isRunning(pid: number): boolean {
  try { return process.kill(pid, 0); } catch { return false; }
}

it.runIf(process.platform === 'linux')('stops a recorded group where ps cannot tell when a process started, as in an Alpine container', async () => {
  const { directory, bin, records } = busyboxPs();
  const group = await detachedGroup();
  try {
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
    recordGroup(group.shell, records);

    await stopRecordedGroup(records);

    expect(group.alive()).toBe(false);
  } finally {
    try { process.kill(-group.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'linux')('stops a recorded attached command and what it started where ps cannot tell when a process started', async () => {
  const { directory, bin, records } = busyboxPs();
  const shell = spawn('sh', ['-c', 'sleep 300 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const sleeper = await new Promise<number>((resolve, reject) => {
    shell.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    shell.once('error', reject);
  });
  try {
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
    recordGroup(shell, records, { isAttached: true });

    await stopRecordedGroup(records);

    await vi.waitFor(() => { expect(isRunning(sleeper)).toBe(false); }, { timeout: 2000 });
    await vi.waitFor(() => { expect(shell.signalCode ?? shell.exitCode).not.toBeNull(); }, { timeout: 2000 });
  } finally {
    try { process.kill(sleeper, 'SIGKILL'); } catch { /* Already stopped. */ }
    shell.kill('SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** When process `pid` started, in clock ticks since boot, as the kernel reports it in field 22 of `/proc/<pid>/stat`. */
function kernelStartTicks(pid: number): number {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
}

it.runIf(process.platform === 'linux')('leaves a recorded group alone when its record names another pid namespace', async () => {
  const records = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-namespace-'));
  const group = await detachedGroup();
  try {
    // Written in a container sharing this home: its pid and start name a process only in its own namespace.
    fs.writeFileSync(path.join(records, `group-${group.pid}.json`), JSON.stringify({ pid: group.pid, startTicks: kernelStartTicks(group.pid), pidNamespace: 'pid:[1]' }));

    await stopRecordedGroup(records);

    expect(group.alive()).toBe(true);
    // Kept for a stop in that namespace, which can still tell its process.
    expect(fs.existsSync(path.join(records, `group-${group.pid}.json`))).toBe(true);
  } finally {
    try { process.kill(-group.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    fs.rmSync(records, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'linux')('keeps the spawn time in a record whose start /proc tells, which a teamai that reads no startTicks stops by', async () => {
  const records = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-record-spawned-'));
  const group = await detachedGroup();
  try {
    recordGroup(group.shell, records);

    expect(await completedRecord(records, group.pid)).toMatchObject({ pid: group.pid, startTicks: kernelStartTicks(group.pid), spawnedAt: expect.any(Number) });
  } finally {
    try { process.kill(-group.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    fs.rmSync(records, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'linux')('stops a recorded group whose record has its start but no pid namespace, as a teamai that could not read its namespace writes', async () => {
  const records = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-no-namespace-'));
  const group = await detachedGroup();
  try {
    fs.writeFileSync(path.join(records, `group-${group.pid}.json`), JSON.stringify({ pid: group.pid, startTicks: kernelStartTicks(group.pid) }));

    await stopRecordedGroup(records);

    expect(group.alive()).toBe(false);
  } finally {
    try { process.kill(-group.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    fs.rmSync(records, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'linux')('stops a group an earlier teamai recorded with the start ps printed', async ({ skip }) => {
  const records = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stop-lstart-'));
  const group = await detachedGroup();
  try {
    let start = '';
    try {
      start = execFileSync('ps', ['-o', 'lstart=', '-p', String(group.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
    } catch {
      skip('this ps prints no start time (BusyBox)');
    }
    fs.writeFileSync(path.join(records, `group-${group.pid}.json`), JSON.stringify({ pid: group.pid, start }));
    const closed = new Promise((resolve) => { group.shell.once('close', resolve); });
    process.kill(group.pid, 'SIGKILL');
    await closed;

    await stopRecordedGroup(records);

    expect(group.alive()).toBe(false);
  } finally {
    try { process.kill(-group.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    fs.rmSync(records, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('tells the process a record names from a later one given its pid, by the time the record keeps', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const spawnedAt = Date.now();
  try {
    const { pid } = child;
    if (pid === undefined) throw new Error('sleep did not start');

    expect(await isSameProcess({ pid, spawnedAt })).toBe('same');
    expect(await isSameProcess({ pid, spawnedAt: spawnedAt - 3_600_000 })).toBe('other');
    expect(await isSameProcess({ pid, startedAt: spawnedAt + 1000 })).toBe('same');
    expect(await isSameProcess({ pid, startedAt: spawnedAt - 3_600_000 })).toBe('other');
    expect(await isSameProcess({ pid })).toBe('unknown');
    expect(await isSameProcess({ pid: 2147483646 })).toBe('other');
  } finally {
    child.kill('SIGKILL');
  }
});

it.runIf(process.platform === 'linux')('tells a process by its start ticks, and leaves one another pid namespace recorded to that namespace', async () => {
  const own = await identityOf(process.pid);

  expect(own).toEqual({ pid: process.pid, startTicks: kernelStartTicks(process.pid), pidNamespace: fs.readlinkSync('/proc/self/ns/pid') });
  expect(await isSameProcess(own)).toBe('same');
  expect(await isSameProcess({ ...own, startTicks: kernelStartTicks(process.pid) + 1 })).toBe('other');
  expect(await isSameProcess({ ...own, pidNamespace: 'pid:[1]' })).toBe('foreign');
});
