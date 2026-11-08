import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Connection } from './connect.js';

// ─── What a test left running ───
//
//  Every runtime harness ends a test with `expectNothingLeft`, so a test that leaves a runtime, or a process a runtime
//  or a fake started, fails, and a new test is checked without asking (after sandcastle's testGlobalSetup.ts).
//

/** Every process on this machine whose command line names a path under `dir`, as `<pid> <args>`. */
export function processesUnder(dir: string): string[] {
  const roots = [...new Set([dir, ...(fs.existsSync(dir) ? [fs.realpathSync(dir)] : [])])];

  return execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).split('\n').map((line) => line.trim()).filter((line) => line !== '' && roots.some((root) => line.includes(root)));
}

/** Whether the process `pid` runs. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** How long a process may take to end by itself after the test, as a detached opener or a fake's child does. */
const SETTLE_MS = 2000;

/** What `connections` and `dir` still run, as `<kind>: <pid> <args>`. */
function leftRunning({ dir, connections }: { dir: string; connections: readonly Connection[] }): string[] {
  const runtimes = connections.flatMap(({ child }) => (child.pid !== undefined && child.exitCode === null && child.signalCode === null && isAlive(child.pid) ? [`runtime: ${child.pid} ${child.spawnargs.join(' ')}`] : []));

  return [...runtimes, ...processesUnder(dir).map((line) => `process: ${line}`)];
}

/**
 * Fails the test, naming each, when a runtime of `connections` still runs, or any process names a path under `dir`,
 * the test's own directory, which everything it made is under, `SETTLE_MS` after the test: one that ends by itself
 * within that is no leak.
 */
export async function expectNothingLeft({ dir, connections = [] }: { dir: string; connections?: readonly Connection[] }): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  let named = leftRunning({ dir, connections });

  while (named.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    named = leftRunning({ dir, connections });
  }

  if (named.length > 0) throw new Error(`The test left behind:\n${named.join('\n')}`);
}
