import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawnCommand } from '@teamai/tool-core/exec';
import { recordGroup, stopProcess } from '@teamai/shared/process-group';
import { MAX_TIMER_MS } from '../utils/timer.js';

export interface ToolRun {
  stdout: string;
  stderr: string;
  code: number;
  /** Why teamai stopped the run, when it did: its `timeoutMs` passed, or it printed nothing for `idleTimeoutMs`. */
  stopped?: 'timeout' | 'idle';
}

/**
 * Runs a headless tool with `stdin` as its input, stopping whatever it started at `timeoutMs` or when `signal` aborts. A `detached` tool
 * leads its own process group outside Windows, recorded in `group` when given, so it outlives no stop but also gets
 * no Ctrl-C from the terminal: only a run nobody waits on in the foreground detaches.
 */
export async function runTool(input: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; idleTimeoutMs?: number; detached: boolean; group?: string; signal?: AbortSignal }): Promise<ToolRun> {
  const detached = input.detached && process.platform !== 'win32';
  const options: SpawnOptions = { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'], detached, windowsHide: true };
  let child: ChildProcess;

  try {
    child = spawnCommand(input.executable, input.args, options);
  } catch (error) {
    // cmd.exe cannot carry these arguments to a batch file: nothing was started.
    return { stdout: '', stderr: error instanceof Error ? error.message : String(error), code: 1 };
  }

  if (detached && input.group !== undefined) recordGroup(child, input.group);
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stopped: ToolRun['stopped'];
  let idleTimer: NodeJS.Timeout | undefined;

  // Each line the tool prints restarts the idle limit, so a tool that streams lives and a silent one is stopped. A limit
  // longer than a timer can wait (about 24.8 days) is none: Node would fire the timer at once.
  const active = (): void => {
    if (input.idleTimeoutMs === undefined || input.idleTimeoutMs > MAX_TIMER_MS) return;

    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!input.signal?.aborted) stopped ??= 'idle'; void stop(); }, input.idleTimeoutMs);
  };

  child.stdout?.setEncoding('utf8').on('data', (text: string) => { stdout.push(text); active(); });
  child.stderr?.setEncoding('utf8').on('data', (text: string) => { stderr.push(text); active(); });
  const exited = new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code ?? 1)); });
  const stop = stopProcess(child, exited, detached);
  // A timeout longer than a timer can wait (about 24.8 days) is none: Node would fire the timer at once.
  const timer = input.timeoutMs > MAX_TIMER_MS ? undefined : setTimeout(() => { stopped ??= 'timeout'; void stop(); }, input.timeoutMs);

  active();
  const onAbort = (): void => { void stop(); };

  input.signal?.addEventListener('abort', onAbort, { once: true });

  if (input.signal?.aborted) onAbort();
  child.stdin?.on('error', () => {});
  child.stdin?.end(input.stdin);

  try {
    const code = await exited;
    const run: ToolRun = { stdout: stdout.join(''), stderr: stderr.join(''), code };

    if (stopped !== undefined) run.stopped = stopped;

    return run;
  } finally {
    clearTimeout(timer);
    clearTimeout(idleTimer);
    input.signal?.removeEventListener('abort', onAbort);
  }
}
