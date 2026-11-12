import { spawn } from 'node:child_process';
import diagnostics from 'node:diagnostics_channel';
import { once } from 'node:events';
import { PROCESS_READ_CHANNEL, signalPid } from '@teamai/shared/process-group';
import { describe, expect, it, vi } from 'vitest';

import { endProcessTree } from '../utils/git.js';

function alive(pid: number): boolean {
  return signalPid(pid, 0) === 'sent';
}

describe('endProcessTree', () => {
  // The shape of a stalled pull: git, a git fetch it started, an ssh under that.
  it('ends a process and every process under it', async () => {
    const grandchild = 'setInterval(() => {}, 1000)';
    const child = `const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
console.log(grandchild.pid);
setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ['-e', `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', (pid) => console.log(child.pid + ' ' + String(pid).trim()));
setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'ignore'] });

    const [line] = await once(parent.stdout, 'data');
    const tree = [parent.pid!, ...String(line).trim().split(' ').map(Number)];
    expect(tree.filter(alive)).toEqual(tree);

    const exited = once(parent, 'exit');
    // The wait budget counts the processes a stop waits on from the reads told here.
    const reads: unknown[] = [];
    const told = (read: unknown): void => { reads.push(read); };
    diagnostics.subscribe(PROCESS_READ_CHANNEL, told);

    try {
      await endProcessTree(parent.pid!);
    } finally {
      diagnostics.unsubscribe(PROCESS_READ_CHANNEL, told);
    }

    await exited;
    await vi.waitFor(() => expect(tree.filter(alive)).toEqual([]), { timeout: 5_000, interval: 50 });
    // The channel tells process-identity reads, not kills: taskkill /T ends the tree on Windows without listing it.
    expect(reads).toHaveLength(process.platform === 'win32' ? 0 : 1);
  }, 15_000);
});
