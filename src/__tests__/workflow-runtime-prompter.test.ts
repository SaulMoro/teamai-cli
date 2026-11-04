import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// oxlint-disable-next-line teamai/workflow-boundaries -- places a stop before the prompt is sent, which no CLI run can time
import { runtimePrompter } from '../workflow/drivers/local/runtime-steps.js';
import type { AttemptRun } from '../workflow/runtimes/attempt.js';
import type { PromptEnd } from '../workflow/runtimes/step-runtime.js';

/**
 * An attempt on a runtime that launches agents its own way. Like the real one, `cancel` stops only the prompt it has
 * sent: `beforeSend` runs first, as an open or a reattach does, and a prompt not cancelled finishes on the next turn.
 */
function promptOnlyRun({ duringOpen, beforeSend }: { duringOpen?: () => void; beforeSend?: () => Promise<void> } = {}): { run: AttemptRun; cancels: () => number } {
  let sent: ((end: PromptEnd) => void) | undefined;
  let cancels = 0;

  const run: AttemptRun = {
    open: async () => {
      duringOpen?.();

      return { ok: true, handle: 'h-1' };
    },
    exec: async () => ({ kind: 'failed', failure: { code: 'exec_unsupported', message: 'prompt only' } }),
    prompt: async (_request, events) => {
      await beforeSend?.();

      return new Promise<PromptEnd>((resolve) => {
        sent = resolve;
        events.onAccepted?.({});
        setImmediate(() => resolve({ kind: 'finished', session: { tool: 'claude', id: 's-1' }, result: { output: { ok: true } } }));
      });
    },
    cancel: async () => {
      if (!sent) return;
      cancels += 1;
      sent({ kind: 'cancelled' });
    },
    collect: async () => undefined,
    close: async () => {},
    stopLeftOperation: async () => true,
  };

  return { run, cancels: () => cancels };
}

describe('a prompt step on a runtime that launches agents its own way', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-prompter-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const view = { worktree: '/work', readonly: [], result: '/work/out', runDir: '/work/scratch', toolHome: {} };

  it('is cancelled when the driver aborts while the place opens', async () => {
    const controller = new AbortController();
    const { run, cancels } = promptOnlyRun({ duringOpen: () => controller.abort() });

    const ran = await runtimePrompter(run, { view, step: 'review', unset: [], credentials: {} }).run('claude', { prompt: 'Review.', cwd: dir, resultPath: path.join(dir, 'result.json'), secrets: {} }, controller.signal);

    expect(ran).toMatchObject({ exitCode: 143, failure: { code: 'tool_failed' } });
    expect(cancels()).toBe(1);
  });

  it('stops at its timeout when the timeout passes before the prompt is sent', async () => {
    const { run, cancels } = promptOnlyRun({ beforeSend: () => new Promise((resolve) => setTimeout(resolve, 50)) });

    const ran = await runtimePrompter(run, { view, step: 'review', unset: [], credentials: {} }).run('claude', { prompt: 'Review.', cwd: dir, resultPath: path.join(dir, 'result.json'), timeoutMs: 1, secrets: {} }, undefined);

    expect(ran).toMatchObject({ exitCode: 143, stoppedBy: 'timeout' });
    expect(cancels()).toBe(1);
  });
});
