import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimePrompter } from '../workflow/drivers/local/runtime-steps.js';
import type { AttemptRun } from '../workflow/runtimes/attempt.js';
import { RunIdSchema } from '../workflow/store.js';
import type { PromptEnd } from '../workflow/runtimes/step-runtime.js';

/**
 * An attempt on a runtime that launches agents its own way. Like the real one, `cancel` stops only the prompt it has
 * sent: `beforeSend` runs first, as an open or a reattach does, and a prompt not cancelled finishes on the next turn.
 */
function promptOnlyRun({ duringOpen, beforeSend, result = { output: { ok: true } } }: { duringOpen?: () => void; beforeSend?: () => Promise<void>; result?: Extract<PromptEnd, { kind: 'finished' }>['result'] } = {}): { run: AttemptRun; cancels: () => number } {
  let sent: ((end: PromptEnd) => void) | undefined;
  let cancels = 0;

  const run: AttemptRun = {
    open: async () => {
      duringOpen?.();

      return { ok: true, handle: 'h-1' };
    },
    exec: async () => ({ kind: 'failed', failure: { code: 'exec_unsupported', message: 'prompt only' } }),
    setup: async () => ({ kind: 'failed', failure: { code: 'exec_unsupported', message: 'prompt only' } }),
    prompt: async (_request, events) => {
      await beforeSend?.();

      return new Promise<PromptEnd>((resolve) => {
        sent = resolve;
        events.onAccepted?.({});
        setImmediate(() => resolve({ kind: 'finished', session: { tool: 'claude', id: 's-1' }, result }));
      });
    },
    cancel: async () => {
      if (!sent) return;
      cancels += 1;
      sent({ kind: 'cancelled' });
    },
    stop: async () => run.cancel(),
    collect: async () => undefined,
    close: async () => {},
    stopLeftSetup: async () => undefined,
    stopLeftOperation: async () => undefined,
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

    const ran = await runtimePrompter(run, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined }).run('claude', { prompt: 'Review.', cwd: dir, resultPath: path.join(dir, 'result.json'), secrets: {} }, controller.signal);

    expect(ran).toMatchObject({ exitCode: 143, failure: { code: 'tool_failed' } });
    expect(cancels()).toBe(1);
  });

  it('stops at its timeout when the timeout passes before the prompt is sent', async () => {
    const { run, cancels } = promptOnlyRun({ beforeSend: () => new Promise((resolve) => setTimeout(resolve, 50)) });

    const ran = await runtimePrompter(run, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined }).run('claude', { prompt: 'Review.', cwd: dir, resultPath: path.join(dir, 'result.json'), timeoutMs: 1, secrets: {} }, undefined);

    expect(ran).toMatchObject({ exitCode: 143, stoppedBy: 'timeout' });
    expect(cancels()).toBe(1);
  });

  it('says it started fresh when the runtime resumed no session, even when its place could not be collected', async () => {
    const { run } = promptOnlyRun();
    const uncollectable: AttemptRun = { ...run, collect: async () => ({ code: 'runtime_failed', message: 'The place could not be collected.' }) };

    const ran = await runtimePrompter(uncollectable, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined }).run('claude', { prompt: 'Review.', cwd: dir, resultPath: path.join(dir, 'result.json'), resume: 'earlier-session', secrets: {} }, undefined);

    expect(ran).toMatchObject({ exitCode: 1, session: 's-1', startedFresh: true });
  });

  it('takes the session of an instance step that the runtime reports under the tool the instance extends', async () => {
    const { run } = promptOnlyRun();

    const ran = await runtimePrompter(run, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'acme-claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined }).run('claude', { prompt: 'Review.', cwd: dir, resultPath: path.join(dir, 'result.json'), secrets: {} }, undefined);

    expect(ran).toMatchObject({ exitCode: 0, session: 's-1' });
  });

  it('masks a secret that the runtime result echoes in the result file teamai writes', async () => {
    const { run } = promptOnlyRun({ result: { output: { note: 'signed in with prompter-secret-7d2e' }, failure: { code: 'tool_failed', message: 'denied for prompter-secret-7d2e' } } });
    const resultPath = path.join(dir, 'result.json');

    await runtimePrompter(run, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined }).run('claude', { prompt: 'Review.', cwd: dir, resultPath, secrets: { TOY_TEAM: 'prompter-secret-7d2e' } }, undefined);
    const written = fs.readFileSync(resultPath, 'utf8');

    expect(written).not.toContain('prompter-secret-7d2e');
    expect(JSON.parse(written)).toMatchObject({ output: { note: expect.stringContaining('signed in with') } });
  });
});
