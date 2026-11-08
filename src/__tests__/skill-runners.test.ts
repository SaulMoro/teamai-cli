import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { processStarts } from '../tool-launch/process-stop.js';
import { stopLeftSkillRunners } from './helpers/skill-runners.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

/**
 * A process that runs as a skill runner does, with a child in its group, and the lock it would hold. A short-lived
 * parent starts it detached, as the CLI does, so it is not this worker's child, which would keep it a zombie.
 */
function runner(root: string, args: string[]): number {
  const fake = "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)";
  const starter = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(fake)}, ...${JSON.stringify(args)}], { detached: true, stdio: 'ignore' }); child.unref(); console.log(child.pid);`;
  const pid = Number(execFileSync(process.execPath, ['-e', starter], { encoding: 'utf8' }).trim());
  const lock = path.join(root, 'runs', 'r0123456789abcdef', 'attempts', `a${pid}`, 'runner.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid, startedAt: new Date().toISOString(), owner: 'fixture' }));
  return pid;
}

/** A process group a runner started for its step's command, recorded beside the runner's lock as teamai records it. */
function command(root: string, runnerPid: number): number {
  const pid = runner(path.join(root, 'commands'), ['command']);
  fs.writeFileSync(path.join(root, 'runs', 'r0123456789abcdef', 'attempts', `a${runnerPid}`, `group-${pid}.json`), JSON.stringify({ pid, start: processStarts()?.get(pid) }));
  return pid;
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

it.skipIf(process.platform === 'win32')('stops the process group of a skill runner that outlived its test and the command it started, and leaves another process holding a lock alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-runners-'));
  roots.push(root);
  const left = runner(root, ['workflow', 'report', 'r0123456789abcdef', '--driver', 'skill', '--attempt', 'a00000000']);
  const step = command(root, left);
  const other = runner(root, ['workflow', 'next', 'r0123456789abcdef']);
  try {
    expect(stopLeftSkillRunners(root, 500)).toEqual([left]);
    expect(groupAlive(left), 'the runner and its child were stopped').toBe(false);
    expect(groupAlive(step), 'the command the runner started was stopped').toBe(false);
    expect(groupAlive(other), 'a process that is no runner is not signalled').toBe(true);
    expect(stopLeftSkillRunners(root, 0)).toEqual([]);
  } finally {
    for (const pid of [left, step, other]) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
});
