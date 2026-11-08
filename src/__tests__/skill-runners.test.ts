import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stopLeftSkillRunners } from './helpers/skill-runners.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const IDLE = 'setInterval(() => {}, 1000)';

/**
 * A process that runs as a skill runner does, with a child in its group and its step's command in a group of its own,
 * and its pid and the command's. A short-lived parent starts it detached, as the CLI does, so it is not this worker's
 * child, which would keep it a zombie.
 */
function runner(root: string, args: string[], cwd = root): { pid: number; step: number } {
  const pids = path.join(root, `pids-${args.join('-')}`);
  const step = `require('node:fs').appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n'); ${IDLE}`;
  const fake = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(IDLE)}], { stdio: 'ignore' });
    spawn(process.execPath, ['-e', ${JSON.stringify(step)}], { detached: true, stdio: 'ignore' }); ${IDLE}`;
  const starter = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(fake)}, ...${JSON.stringify(args)}], { cwd: ${JSON.stringify(cwd)}, detached: true, stdio: 'ignore' }); child.unref(); console.log(child.pid);`;
  const pid = Number(execFileSync(process.execPath, ['-e', starter], { encoding: 'utf8' }).trim());
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(pids) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  return { pid, step: Number(fs.readFileSync(pids, 'utf8').trim()) };
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

it.skipIf(process.platform === 'win32')('stops the process group of a skill runner that outlived its test and the command it started, and leaves another process alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-runners-'));
  roots.push(root);
  const left = runner(root, ['workflow', 'report', 'r0123456789abcdef', '--driver', 'skill', '--attempt', 'a00000000']);
  const other = runner(root, ['workflow', 'next', 'r0123456789abcdef']);
  try {
    expect(stopLeftSkillRunners(() => [left.pid, other.pid], { exitMs: 500 })).toEqual([left.pid]);
    expect(groupAlive(left.pid), 'the runner and its child were stopped').toBe(false);
    expect(groupAlive(left.step), 'the command the runner started was stopped').toBe(false);
    expect(groupAlive(other.pid), 'a process that is no runner is not signalled').toBe(true);
    expect(groupAlive(other.step), 'nor the groups it started').toBe(true);
    expect(stopLeftSkillRunners(() => [left.pid, other.pid], { exitMs: 0 })).toEqual([]);
  } finally {
    for (const pid of [left.pid, left.step, other.pid, other.step]) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
});

it.skipIf(process.platform === 'win32')('stops only the skill runners working in a directory it is given', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-runners-'));
  roots.push(root);
  const inside = path.join(root, 'checkout', 'sub');
  const outside = path.join(root, 'elsewhere');
  for (const dir of [inside, outside]) fs.mkdirSync(dir, { recursive: true });
  const args = ['workflow', 'report', 'r0123456789abcdef', '--driver', 'skill', '--attempt'];
  const working = runner(root, [...args, 'a00000001'], inside);
  const away = runner(root, [...args, 'a00000002'], outside);
  try {
    expect(stopLeftSkillRunners(() => [working.pid, away.pid], { exitMs: 0, workingIn: path.join(root, 'checkout') })).toEqual([working.pid]);
    expect(groupAlive(working.pid), 'the runner working in the directory was stopped').toBe(false);
    expect(groupAlive(away.pid), 'a runner working elsewhere is left alone').toBe(true);
  } finally {
    for (const pid of [working.pid, working.step, away.pid, away.step]) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
});

it.skipIf(process.platform === 'win32')('stops a runner working in a directory it is given though no tracked process started it, as one a confined tool started without NODE_OPTIONS', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-runners-'));
  roots.push(root);
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(checkout);
  const untracked = runner(root, ['workflow', 'report', 'r0123456789abcdef', '--driver', 'skill', '--attempt', 'a00000003'], checkout);
  try {
    expect(stopLeftSkillRunners(() => [], { exitMs: 0, workingIn: checkout })).toEqual([untracked.pid]);
    expect(groupAlive(untracked.pid), 'the untracked runner was stopped').toBe(false);
  } finally {
    for (const pid of [untracked.pid, untracked.step]) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
});
