import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonValue } from '../types.js';
import { composedOffer, composedStepRuntime, nestedOptions } from '../workflow/runtimes/composed.js';
import { stdioStepRuntime } from '../workflow/runtimes/stdio.js';
import { newOpId, type Initialized, type OpenRequest, type PromptRequest, type StepRuntime } from '../workflow/runtimes/step-runtime.js';
import { TOY_RUNTIME } from './helpers/toy-runtime.js';

type Offer = Extract<Initialized, { ok: true }>;

describe('the offer of a runtime through another', () => {
  const outer: Offer = {
    ok: true, launchesAgents: false, ownLogins: ['codex'], unavailable: { codebuddy: 'not in the image' },
    can: {
      isolation: 'sandbox', env: true, setup: true, exec: true, unattended: true, network: false, tokens: false, max_turns: false, end_turn: true, role: false, hitl: true,
      workspace: ['new', 'continue', 'clone', 'team'], tools: ['claude', 'codex', 'codebuddy'], confined: [{ tools: ['claude'], level: 'verified', access: 'read' }],
    },
  };
  const inner: Offer = {
    ok: true, launchesAgents: true, unavailable: { codex: 'no provider instance' },
    can: {
      isolation: 'none', env: false, setup: false, exec: false, unattended: false, network: true, tokens: true, max_turns: true, end_turn: false, role: true, hitl: false,
      workspace: ['new', 'continue'], tools: ['claude'], default_tool: 'claude', fullAccess: ['claude'], confined: [{ tools: ['claude'], level: 'best-effort', access: 'read' }],
    },
  };

  it('takes where the tool runs from the outer and how it is launched from the inner, with the outer\'s prepared places', () => {
    expect(composedOffer(outer, inner)).toEqual({
      ok: true, launchesAgents: true, ownLogins: ['codex'], unavailable: { codex: 'no provider instance' },
      can: {
        isolation: 'sandbox', env: true, setup: true, exec: true, unattended: true, fullAccess: ['claude'], network: false,
        tools: ['claude'], default_tool: 'claude', workspace: ['new', 'continue', 'clone', 'team'], hitl: false, tokens: false, max_turns: false, end_turn: false, role: true,
      },
    });
  });

  it('keeps the tools the inner runs in full access when the outer offers no unattended prompt, so the run still warns of them', () => {
    const { unattended: _none, ...attended } = outer.can;

    expect(composedOffer({ ...outer, can: attended }, inner).can).toMatchObject({ fullAccess: ['claude'] });
    expect(composedOffer({ ...outer, can: attended }, inner).can.unattended).toBeUndefined();
  });

  it('offers unattended for no tool when the inner runs none in full access', () => {
    const { fullAccess: _none, ...asks } = inner.can;

    expect(composedOffer(outer, { ...inner, can: asks }).can).toMatchObject({ unattended: true, fullAccess: [] });
  });
});

describe('a toy through a toy, over stdio', () => {
  let dir: string;
  let worktree: string;
  let calls: string;
  const started: StepRuntime[] = [];

  const toy = (name: string): StepRuntime => stdioStepRuntime({ name, command: process.execPath, args: [TOY_RUNTIME] });

  /** The toy pair over the same state, as a restarted teamai starts it again; `inner` adds options to the inner toy. */
  const start = async (inner: Record<string, JsonValue> = {}, innerCredentials: Record<string, string> = { INNER_TOKEN: 'inner-value' }): Promise<StepRuntime> => {
    const runtime = composedStepRuntime({ outer: toy('sandboxtoy'), inner: toy('apptoy'), innerCredentials });
    started.push(runtime);
    const ready = await runtime.init({
      options: { sandboxtoy: { state: path.join(dir, 'outer'), calls }, apptoy: { state: path.join(dir, 'inner'), calls, agent: { output: { ok: true } }, ...inner } },
      mode: 'unattended',
    });
    // The outer runs commands (it leaves `exec` out, which means it does), though the inner says it runs none.
    expect(ready).toMatchObject({ ok: true, launchesAgents: true });
    expect(ready.ok && ready.can.exec).not.toBe(false);

    return runtime;
  };

  const openRequest = (op = newOpId()): OpenRequest => ({
    op, run: 'r0123abcd', attempt: 'a0123abcd', tool: 'claude', credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'prompt-value' },
    view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
  });

  const promptRequest = (handle: string, op = newOpId()): PromptRequest => ({
    op, handle, env: {}, unset: [], credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'prompt-value' }, cwd: worktree,
    lease: { step: 'review', tool: 'claude', prompt: 'Review.', result: path.join(dir, 'out', 'result.json'), permissions: 'approval-required', interactive: false },
  });

  /** What each toy was asked, in order: which toy, the request, and what of it the test reads. */
  const asked = (): Array<{ toy: string; type: string; outer?: string; credentials?: string[] }> => fs.readFileSync(calls, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { toy: string; type: string; outer?: string; credentials?: string[] })
    .map(({ toy: which, type, outer, credentials }) => ({ toy: which, type, ...(outer !== undefined && { outer }), ...(credentials !== undefined && { credentials }) }));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-composed-'));
    worktree = path.join(dir, 'worktree');
    calls = path.join(dir, 'calls.jsonl');
    fs.mkdirSync(worktree);
    fs.mkdirSync(path.join(dir, 'out'));
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens the outer with the prompt\'s credentials, then the inner with the outer\'s handle unchanged and only its own', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});

    expect(opened.kind).toBe('ready');
    expect(asked()).toEqual([
      { toy: 'outer', type: 'open', credentials: ['CLAUDE_CODE_OAUTH_TOKEN'] },
      { toy: 'inner', type: 'open', outer: 'toy-r0123abcd-a0123abcd', credentials: ['INNER_TOKEN'] },
    ]);
  });

  it('runs a prompt on the inner with only its credentials, and an exec on the outer', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');

    expect(await runtime.prompt(promptRequest(opened.handle), {})).toMatchObject({ kind: 'finished' });
    expect(await runtime.exec({ op: newOpId(), handle: opened.handle, argv: [process.execPath, '-e', 'process.stdout.write("out")'], env: {}, unset: [], credentials: {}, cwd: worktree }, {})).toMatchObject({ kind: 'exited', code: 0, stdout: 'out' });
    expect(asked().slice(2)).toEqual([{ toy: 'inner', type: 'prompt', credentials: ['INNER_TOKEN'] }, { toy: 'outer', type: 'exec', credentials: [] }]);
  });

  it('cancels a prompt on the inner, then collects and closes the inner before the outer', async () => {
    const release = path.join(dir, 'release');
    const runtime = await start({ agent: { output: { ok: true }, release } });
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = promptRequest(opened.handle);
    const ended = runtime.prompt(request, {});
    await expect.poll(() => asked().some((call) => call.type === 'prompt')).toBe(true);

    await runtime.cancel(request.op);
    expect(await ended).toEqual({ kind: 'cancelled' });
    expect(await runtime.collect(opened.handle)).toEqual({ ok: true });
    expect(await runtime.close(opened.handle)).toEqual({ ok: true });
    expect(asked().slice(3).map(({ toy: which, type }) => `${which} ${type}`)).toEqual(['inner cancel', 'inner collect', 'outer collect', 'inner close', 'outer close']);
  });

  it('reattaches the outer first, with the prompt\'s credentials again, then the inner, once a restarted teamai opens the place again', async () => {
    const release = path.join(dir, 'release');
    const first = await start({ agent: { output: { ok: true }, release } });
    const request = openRequest();
    const opened = await first.open(request, async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const prompt = promptRequest(opened.handle);
    void first.prompt(prompt, {});
    await expect.poll(() => asked().some((call) => call.type === 'prompt')).toBe(true);
    await first.dispose();
    fs.writeFileSync(calls, '');

    const restarted = await start({ agent: { output: { ok: true }, release } });
    expect(await restarted.open(request, async () => {})).toEqual(opened);
    const seen = await restarted.reattach(opened.handle);

    expect(seen).toMatchObject({ kind: 'alive', ops: [{ op: prompt.op, state: 'running' }] });
    expect(asked().slice(2)).toEqual([{ toy: 'outer', type: 'reattach', credentials: ['CLAUDE_CODE_OAUTH_TOKEN'] }, { toy: 'inner', type: 'reattach' }]);
    fs.writeFileSync(release, '');
  });

  it('reattaches each attempt\'s outer with that attempt\'s own credentials, when two attempts share the runtime', async () => {
    const runtime = await start();
    const claude = await runtime.open(openRequest(), async () => {});
    const codex = await runtime.open({ ...openRequest(), attempt: 'a0123abce', tool: 'codex', credentials: { OPENAI_API_KEY: 'codex-value' } }, async () => {});
    if (claude.kind !== 'ready' || codex.kind !== 'ready') throw new Error('not opened');

    await runtime.reattach(claude.handle);
    await runtime.reattach(codex.handle);

    expect(asked().filter((call) => call.type === 'reattach' && call.toy === 'outer').map((call) => call.credentials)).toEqual([['CLAUDE_CODE_OAUTH_TOKEN'], ['OPENAI_API_KEY']]);
  });

  it('keeps both places and fails a close whose inner runtime cannot confirm its stop', async () => {
    const runtime = await start({ close_fails: true });
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');

    expect(await runtime.close(opened.handle)).toMatchObject({ ok: false, failure: { code: 'close_failed' } });
    expect(asked().slice(2).map(({ toy: which, type }) => `${which} ${type}`)).toEqual(['inner close']);
    expect(await runtime.reattach(opened.handle)).toMatchObject({ kind: 'alive' });
  });
});

describe('the options of a runtime through another', () => {
  it('splits them by runtime, and names a key that is neither runtime\'s or holds no options', () => {
    const names = { outer: 'sandbox', inner: 't3' };

    expect(nestedOptions({ sandbox: { provider: 'docker' }, t3: {} }, names)).toEqual({ ok: true, outer: { provider: 'docker' }, inner: {} });
    expect(nestedOptions({ provider: 'docker' }, names)).toMatchObject({ ok: false, key: 'provider' });
    expect(nestedOptions({ sandbox: 'docker' }, names)).toMatchObject({ ok: false, key: 'sandbox' });
  });
});
