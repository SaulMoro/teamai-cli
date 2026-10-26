import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runShellCommand } from '../workflow/shell-command.js';

const dirs: string[] = [];
const SLEEP = `"${process.execPath}" -e "setTimeout(() => {}, 20000)"`;

function workdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-shell-command-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('runShellCommand', () => {
  it('answers the exit code and what the command printed', async () => {
    const ran = await runShellCommand({ command: 'echo shell-command-output && exit 3', cwd: workdir(), env: process.env });
    expect(ran.exit).toEqual({ kind: 'exited', code: 3 });
    expect(ran.output).toContain('shell-command-output');
  });

  it.skipIf(process.platform === 'win32')('answers the signal that ended a command its caller stopped', async () => {
    const controller = new AbortController();
    const running = runShellCommand({ command: SLEEP, cwd: workdir(), env: process.env, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    expect((await running).exit).toEqual({ kind: 'signal', signal: 'SIGTERM' });
  });

  it('stops a command at its deadline and answers timeout', async () => {
    const startedAt = Date.now();
    const ran = await runShellCommand({ command: SLEEP, cwd: workdir(), env: process.env, expiresAt: new Date(startedAt + 500).toISOString() });
    expect(ran.exit).toEqual({ kind: 'timeout' });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('answers spawn_failed when the shell cannot start', async () => {
    const ran = await runShellCommand({ command: 'echo never', cwd: path.join(workdir(), 'missing'), env: process.env });
    expect(ran.exit).toEqual({ kind: 'spawn_failed', message: expect.stringContaining('ENOENT') });
  });
});
