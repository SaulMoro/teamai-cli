import { describe, expect, it } from 'vitest';
// oxlint-disable-next-line teamai/workflow-boundaries -- places a stop after setup and before the exec, which no CLI run can time
import { runtimeCommand } from '../workflow/drivers/local/runtime-steps.js';
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
    collect: async () => undefined,
    close: async () => {},
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
});
