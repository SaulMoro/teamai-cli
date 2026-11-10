import { describe, expect, it } from 'vitest';
import type { ToolClosed, ToolLauncher } from '../run-step-launch.js';

/** What a launch saw of one process: the order of its events, and the chunks `onStdout` got. */
interface Watched {
  closed: ToolClosed;
  started: boolean;
  events: string[];
  chunks: string[];
}

/** Starts `script` under node through `start`, as a launch does, and watches every call the adapter makes back. */
async function watch(start: ToolLauncher, { executable = process.execPath, script, cwd, onStarted }: { executable?: string; script: string; cwd: string; onStarted?: (stop: () => Promise<void>) => void }): Promise<Watched> {
  const events: string[] = [];
  const chunks: string[] = [];
  let returned = false;
  let stopNow: () => Promise<void> = async () => {};

  const launched = start({
    executable, args: ['-e', script], cwd, env: { ...process.env }, interactive: false,
    onStart: () => {
      events.push(returned ? 'start' : 'start before return');
      onStarted?.(stopNow);
    },
    onStdout: (text) => {
      events.push(returned ? 'stdout' : 'stdout before return');
      chunks.push(text);
    },
  });

  returned = true;
  stopNow = () => launched.stop();

  return { closed: await launched.closed, started: launched.started(), events, chunks };
}

/**
 * The contract every `ToolLauncher` adapter keeps, which `runStepLaunch` relies on: it calls `onStart` once, when the
 * process started and before any of its output; it never calls `onStdout` before `start` returns, so the launch holds
 * the process before a limit stops it; `closed` carries the exit status and the stdout `onStdout` got, in order; `stop`
 * ends a process that runs until stopped; and a process that cannot start still closes, with no success.
 * `adapter` builds the launcher under test in `cwd`, a directory of its own for each case.
 */
export function toolLauncherConformance(name: string, adapter: () => Promise<{ start: ToolLauncher; cwd: string }>): void {
  describe(`the ToolLauncher port: ${name}`, () => {
    it('starts once before any output, gives its stdout in order and its exit status, and never calls back before it returns', async () => {
      const { start, cwd } = await adapter();
      const watched = await watch(start, { cwd, script: 'process.stdout.write("one\\n"); setTimeout(() => { process.stdout.write("two\\n"); process.exitCode = 3; }, 50);' });

      expect(watched.events[0]).toBe('start');
      expect(watched.events.filter((event) => event.startsWith('start'))).toEqual(['start']);
      expect(watched.events.filter((event) => event.endsWith('before return'))).toEqual([]);
      expect(watched.chunks.join('')).toBe('one\ntwo\n');
      expect(watched.closed).toMatchObject({ exitCode: 3, stdout: 'one\ntwo\n' });
      expect(watched.started).toBe(true);
    }, 30_000);

    it('ends a process that runs until stopped', async () => {
      const { start, cwd } = await adapter();
      const watched = await watch(start, { cwd, script: 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);', onStarted: (stop) => { setTimeout(() => { void stop(); }, 200); } });

      expect(watched.started).toBe(true);
      expect('failure' in watched.closed || watched.closed.exitCode !== 0).toBe(true);
    }, 30_000);

    it('closes a process that cannot start, with no success', async () => {
      const { start, cwd } = await adapter();
      const watched = await watch(start, { cwd, executable: '/nonexistent/teamai-no-such-tool', script: '' });

      expect('failure' in watched.closed || watched.closed.exitCode !== 0 || watched.closed.error !== undefined).toBe(true);
    }, 30_000);
  });
}
