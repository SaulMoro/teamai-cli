import { spawn, type SpawnOptions } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { batchLaunchOf } from '@teamai/tool-core/exec';
import { recordGroup, stopProcess } from './process-stop.js';

export interface ToolRun {
  stdout: string;
  stderr: string;
  code: number;
  /** Whether the run was stopped at `timeoutMs`. */
  timedOut: boolean;
  /** Whether the run was stopped for printing nothing for `idleTimeoutMs`. */
  idle: boolean;
}

/**
 * Runs a headless tool with `stdin` as its input, stopping whatever it started at `timeoutMs` or when `signal` aborts. A `detached` tool
 * leads its own process group outside Windows, recorded in `group` when given, so it outlives no stop but also gets
 * no Ctrl-C from the terminal: only a run nobody waits on in the foreground detaches.
 */
export async function runTool(input: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; idleTimeoutMs?: number; detached: boolean; group?: string; signal?: AbortSignal }): Promise<ToolRun> {
  const batch = process.platform === 'win32' ? batchLaunchOf(input.executable, input.args, input.env.ComSpec ?? input.env.COMSPEC ?? 'cmd.exe') : undefined;

  if (batch?.ok === false) return { stdout: '', stderr: batch.message, code: 1, timedOut: false, idle: false };
  const detached = input.detached && process.platform !== 'win32';
  const options: SpawnOptions = { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'], detached, windowsHide: true };
  // A batch file gets the command line escaped here, as cross-spawn escapes only one under node_modules/.bin twice.
  const child = batch ? spawn(batch.command, batch.args, { ...options, windowsVerbatimArguments: true }) : crossSpawn(input.executable, input.args, options);

  if (detached && input.group !== undefined) recordGroup(child, input.group);
  const stdout: string[] = [];
  const stderr: string[] = [];
  let idle = false;
  let idleTimer: NodeJS.Timeout | undefined;

  // Each line the tool prints restarts the idle limit, so a tool that streams lives and a silent one is stopped.
  const active = (): void => {
    if (input.idleTimeoutMs === undefined) return;

    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idle = true; void stop(); }, input.idleTimeoutMs);
  };

  child.stdout?.setEncoding('utf8').on('data', (text: string) => { stdout.push(text); active(); });
  child.stderr?.setEncoding('utf8').on('data', (text: string) => { stderr.push(text); active(); });
  const exited = new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code ?? 1)); });
  const stop = stopProcess(child, exited, detached);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void stop(); }, input.timeoutMs);

  active();
  const onAbort = (): void => { void stop(); };

  input.signal?.addEventListener('abort', onAbort, { once: true });

  if (input.signal?.aborted) onAbort();
  child.stdin?.on('error', () => {});
  child.stdin?.end(input.stdin);

  try { const code = await exited;

 return { stdout: stdout.join(''), stderr: stderr.join(''), code, timedOut, idle }; }
  finally { clearTimeout(timer); clearTimeout(idleTimer); input.signal?.removeEventListener('abort', onAbort); }
}
