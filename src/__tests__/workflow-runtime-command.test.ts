import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeCommand, runtimeLauncher } from '../workflow/steps/runtime-steps.js';
import { stepLauncher } from '@teamai/runtime-tools';
import { toolsLaunchDeps } from '../workflow/runtimes/sources.js';
import type { AttemptRun } from '../workflow/runtimes/attempt.js';

/** An attempt on a step runtime whose `cancel`, like the real one, stops only an exec it has sent. */
function commandRun(): { run: AttemptRun; execs: () => number } {
  let execs = 0;

  const run: AttemptRun = {
    open: async () => ({ ok: true, handle: 'h-1' }),
    exec: async () => {
      execs += 1;

      return { kind: 'exited', code: 0, stdout: '' };
    },
    setup: async () => ({ kind: 'exited', code: 0, stdout: '' }),
    prompt: async () => ({ kind: 'failed', failure: { code: 'prompt_unsupported', message: 'exec only' } }),
    cancel: async () => {},
    stop: async () => {},
    collect: async () => undefined,
    close: async () => {},
    stopLeftSetup: async () => undefined,
    stopLeftOperation: async () => undefined,
  };

  return { run, execs: () => execs };
}

describe('a command step on a step runtime', () => {
  const view = { worktree: '/work', readonly: [], result: '/work/out', runDir: '/work/scratch', toolHome: {} };

  it('does not run the command when the step is stopped once setup ended and before its exec is sent', async () => {
    const { run, execs } = commandRun();
    let stopStep = (): void => {};

    const started = runtimeCommand({
      run, view: async () => view, command: 'node build.js', env: {}, unset: [],
      setUp: async () => {
        // The stop arrives while teamai checks what setup left: no operation of the attempt runs on the runtime.
        stopStep();

        return undefined;
      },
    });
    stopStep = () => {
      void started.stop();
    };

    await expect(started.exit).resolves.toMatchObject({ exitCode: 130 });
    expect(execs()).toBe(0);
  });
  it('stops the setup it runs when the step is stopped while its place opens, so setup ends stopped and the command never runs', async () => {
    const { run, execs } = commandRun();
    let stopStep = (): void => {};
    const stoppedSetup = { code: 'setup_failed', message: 'Setup "make deps" was stopped, so the step did not run.' };

    const started = runtimeCommand({
      run: { ...run, open: async () => {
        stopStep();

        return { ok: true, handle: 'h-1' };
      } },
      view: async () => view, command: 'node build.js', env: {}, unset: [],
      // Setup, as teamai runs it, ends stopped once its signal aborts, and runs nothing on the runtime then.
      setUp: async (signal) => (signal?.aborted === true ? stoppedSetup : undefined),
    });
    stopStep = () => {
      void started.stop();
    };

    await expect(started.exit).resolves.toEqual(stoppedSetup);
    expect(execs()).toBe(0);
  });
});

describe('a prompt\'s tool exec\'d on a step runtime', () => {
  const view = { worktree: '/work', readonly: [], result: '/work/out', runDir: '/work/scratch', toolHome: {} };

  it('does not exec the tool when the step is stopped once setup ended and before its exec is sent', async () => {
    const { run, execs } = commandRun();
    let stopStep = (): void => {};

    const launcher = runtimeLauncher(run, {
      view, tool: 'claude', toolHome: { tool: 'claude', dir: '/work/home' }, unset: [], credentials: {},
      setUp: async () => {
        // The timeout passes while teamai checks what setup left: no operation of the attempt runs on the runtime.
        stopStep();

        return undefined;
      },
    });
    const started = launcher({ executable: 'claude', args: ['-p'], cwd: '/work', env: {}, interactive: false, onStart: () => {}, onStdout: () => {} });
    stopStep = () => {
      void started.stop();
    };

    await expect(started.closed).resolves.toMatchObject({ exitCode: 143 });
    expect(execs()).toBe(0);
  });
});

describe('the timeout of a prompt\'s tool exec\'d on a step runtime', () => {
  it('counts from when the runtime accepts the tool, so a setup longer than the timeout leaves the tool its whole time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-timeout-'));
    const resultPath = path.join(dir, 'out', 'result.json');
    const view = { worktree: dir, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} };
    const { run } = commandRun();
    const launcher = runtimeLauncher({
      ...run,
      exec: async (_request, events) => {
        events.onAccepted?.({});
        fs.writeFileSync(resultPath, '{"output":{"ok":true}}');

        return { kind: 'exited', code: 0, stdout: '' };
      },
    }, {
      view, tool: 'claude', toolHome: { tool: 'claude', dir: path.join(dir, 'home') }, unset: [], credentials: {},
      setUp: async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));

        return undefined;
      },
    });

    try {
      const ran = await stepLauncher(toolsLaunchDeps(), { start: launcher, resolveTool: () => 'claude', resolveInstanceCommand: () => null }).run('claude', { prompt: 'review', cwd: dir, resultPath, secrets: {}, expected: undefined, timeoutMs: 200 });

      expect(ran).toMatchObject({ started: true, exitCode: 0, output: { ok: true } });
      expect(ran).not.toHaveProperty('stoppedBy');
      expect(ran.failure).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the idle limit of a prompt\'s tool exec\'d on a step runtime', () => {
  it('counts from when the runtime accepts the tool, so a setup longer than the limit leaves the tool its whole limit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-idle-'));
    const resultPath = path.join(dir, 'out', 'result.json');
    const view = { worktree: dir, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} };
    const { run } = commandRun();
    const launcher = runtimeLauncher({
      ...run,
      exec: async (_request, events) => {
        events.onAccepted?.({});
        fs.writeFileSync(resultPath, '{"output":{"ok":true}}');

        return { kind: 'exited', code: 0, stdout: '' };
      },
    }, {
      view, tool: 'claude', toolHome: { tool: 'claude', dir: path.join(dir, 'home') }, unset: [], credentials: {},
      // Setup prints nothing the tool's stdout carries, for longer than the idle limit.
      setUp: async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));

        return undefined;
      },
    });

    try {
      const ran = await stepLauncher(toolsLaunchDeps(), { start: launcher, resolveTool: () => 'claude', resolveInstanceCommand: () => null }).run('claude', { prompt: 'review', cwd: dir, resultPath, secrets: {}, expected: undefined, idleTimeoutMs: 200 });

      expect(ran).toMatchObject({ started: true, exitCode: 0, output: { ok: true } });
      expect(ran.failure).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
