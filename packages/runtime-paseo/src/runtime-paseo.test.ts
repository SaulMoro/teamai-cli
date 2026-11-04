import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PromptLeaseSchema, RuntimeMessage, RuntimeOptions, RuntimeRequestSchema } from '@teamai/runtime-protocol';
import type { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeDaemon, type Behaviour } from './testing/fake-daemon.js';
import { startRuntime, type Runtime } from './testing/harness.js';

/**
 * teamai-runtime-paseo through its stdio entry, as teamai spawns it, against a fake Paseo daemon that speaks Paseo
 * 0.14.0's WebSocket protocol and checks every frame against Paseo's own schemas.
 */

let dir: string;
let worktree: string;
let daemonState: string;
let daemon: Awaited<ReturnType<typeof startFakeDaemon>>;
const runtimes: Runtime[] = [];

const RUN = 'r0123abcd';
const ATTEMPT = 'a0123abcd';

const behave = (behaviour: Behaviour): void => fs.writeFileSync(path.join(daemonState, 'behaviour.json'), JSON.stringify(behaviour));

/** The agent creates and cancels the daemon received, as they crossed the wire. */
const received = (): Array<Record<string, unknown> & { type: string }> => {
  const file = path.join(daemonState, 'requests.jsonl');

  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};

const start = (): Runtime => {
  const runtime = startRuntime(path.join(dir, 'home'));
  runtimes.push(runtime);

  return runtime;
};

const isOp = (op: string, event: string) => (line: RuntimeMessage): boolean => 'op' in line && line.op === op && 'event' in line && line.event === event;
const isEnd = (op: string) => (line: RuntimeMessage): boolean => 'op' in line && line.op === op && 'event' in line && ['finished', 'failed', 'cancelled'].includes(line.event);
const isInit = (line: RuntimeMessage): boolean => 'type' in line && line.type === 'init';

async function ready(runtime: Runtime, { mode = 'unattended', options = { url: daemon.url } }: { mode?: 'attended' | 'unattended'; options?: RuntimeOptions } = {}): Promise<RuntimeMessage> {
  runtime.send({ type: 'init', protocol: 1, mode, options });

  return runtime.next(isInit);
}

async function opened(runtime: Runtime): Promise<string> {
  runtime.send({ type: 'open', op: 'op-0000000a', run: RUN, attempt: ATTEMPT, credentials: {}, view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'run'), toolHome: {} } });
  const accepted = await runtime.next(isOp('op-0000000a', 'accepted'));

  if (!('handle' in accepted) || !accepted.handle) throw new Error(`no handle in ${JSON.stringify(accepted)}`);

  return accepted.handle;
}

const promptRequest = (handle: string, op: string, lease: Partial<z.input<typeof PromptLeaseSchema>> = {}): z.input<typeof RuntimeRequestSchema> => ({
  type: 'prompt', op, handle, env: { TEAMAI_WORKFLOW_RESULT: path.join(dir, 'out', 'result.json'), STEP_TOKEN: 'from-teamai' }, unset: [], cwd: worktree,
  lease: {
    step: 'review', tool: 'claude', model: { name: 'claude-opus-5-5' }, permissions: 'approval-required', interactive: false,
    prompt: `Review the change.\n\nWrite the workflow result as JSON to ${path.join(dir, 'out', 'result.json')}. Write {"output": …}.`, result: path.join(dir, 'out', 'result.json'),
    ...lease,
  },
});

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-paseo-runtime-')));
  worktree = path.join(dir, 'worktree');
  daemonState = path.join(dir, 'daemon');
  fs.mkdirSync(worktree);
  fs.mkdirSync(path.join(dir, 'out'));
  daemon = await startFakeDaemon({ state: daemonState, port: 0 });
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.kill()));
  await daemon.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('teamai-runtime-paseo', () => {
  it('offers prompt steps only, in a new or continued worktree, with no env, token count or unattended mode, for the tools the daemon has', async () => {
    behave({ models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'] } });

    expect(await ready(start())).toEqual({
      type: 'init', ok: true, prompt: true,
      can: { exec: false, setup: false, hitl: false, unattended: false, env: false, tokens: false, max_turns: false, workspace: ['new', 'continue'], tools: ['claude', 'codex'] },
    });
  });

  it('runs a prompt step as a Paseo agent in teamai\'s worktree, and ends finished with the tool\'s session and the output the agent wrote', async () => {
    behave({ output: { verdict: 'approve', findings: 2 } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);

    runtime.send(promptRequest(handle, 'op-0000000b'));

    await runtime.next(isOp('op-0000000b', 'accepted'));
    const end = await runtime.next(isEnd('op-0000000b'));
    const [create] = received();
    expect(end).toEqual({ op: 'op-0000000b', event: 'finished', session: { tool: 'claude', id: `fake-session-${String(create?.agentId)}` }, result: { output: { verdict: 'approve', findings: 2 } } });
    expect(create).toMatchObject({
      type: 'agent.create.request',
      idempotencyKey: 'op-0000000b',
      config: { provider: 'claude', model: 'claude-opus-5-5', modeId: 'default', cwd: worktree, title: `teamai review · ${RUN}` },
      labels: { 'teamai-attempt': `${RUN}/${ATTEMPT}` },
    });
    // No env crosses: Paseo keeps a create's env in plain text.
    expect(create).not.toHaveProperty('env');
  });

  it('fails a step whose model the daemon lacks as model_unavailable, naming what it offers, and creates no agent', async () => {
    behave({ models: { claude: ['claude-sonnet-5-5'] } });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { model: { name: 'claude-opus-5-5' } }));

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'model_unavailable', message: `The Paseo daemon at ${daemon.url} has no claude model claude-opus-5-5. It offers: claude-sonnet-5-5.` },
    });
    expect(runtime.lines.filter(isOp('op-0000000b', 'accepted'))).toEqual([]);
    expect(received()).toEqual([]);
  });

  it('runs the step\'s effort as the model\'s thinking option, and fails an effort the model lacks', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b', { model: { name: 'claude-opus-5-5', effort: 'high' } }));
    runtime.send(promptRequest(handle, 'op-0000000c', { model: { name: 'claude-opus-5-5', effort: 'ultra' } }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
    expect(await runtime.next(isEnd('op-0000000c'))).toMatchObject({ event: 'failed', failure: { code: 'model_unavailable', message: expect.stringContaining('no effort ultra for claude model claude-opus-5-5') } });
    expect(received()).toEqual([expect.objectContaining({ config: expect.objectContaining({ model: 'claude-opus-5-5', thinkingOptionId: 'high' }) })]);
  });

  it.each([['codex', 'auto', 'gpt-6.1-sol'], ['opencode', 'build', 'opencode/beam-free']])('starts a %s agent in its default mode %s, on the daemon\'s default model %s when the step names none', async (tool, modeId, model) => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool, model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool } });
    const [create] = received();
    expect(create).toMatchObject({ config: { provider: tool, model, modeId } });
  });

  it('cancels a running prompt: the agent is cancelled, and the prompt ends cancelled though Paseo reports the agent idle', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request']);
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'cancelled' }] });
  });

  it('fails a cancel Paseo refuses, saying its agent may still run, rather than ending cancelled', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy' });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));

    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    const end = await runtime.next(isEnd('op-0000000b'));
    const [create] = received();

    expect(end).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'cancel_failed', message: `Paseo did not cancel the claude agent ${String(create?.agentId)}: Agent is busy. It may still run in the worktree; stop it in the Paseo app.` },
    });
  });

  it('resumes on the same agent after it is killed with -9 once the agent was created, and creates no second one', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { verdict: 'approve' } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);
    await first.kill();

    const second = start();
    await ready(second);
    second.send({ type: 'reattach', handle });
    expect(await second.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'running' }] });
    second.send(promptRequest(handle, 'op-0000000b'));
    await second.next(isOp('op-0000000b', 'accepted'));
    fs.writeFileSync(release, '');

    expect(await second.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
    const agents = JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { agents: Record<string, unknown> };
    expect(Object.keys(agents.agents)).toHaveLength(1);
  });

  it('cancels the agent of a prompt whose runtime was killed with -9, and ends it cancelled', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);
    await first.kill();

    const second = start();
    await ready(second);
    second.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await second.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request']);
    second.send({ type: 'reattach', handle });
    expect(await second.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'cancelled' }] });
  });

  it('ends a prompt cancelled only once Paseo cancels its agent, and fails it when Paseo refuses late', async () => {
    behave({ ask_permission: true, output: { ok: true }, refuse_cancel: 'Agent is busy', refuse_cancel_ms: 2500 });
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
  });

  it('fails the attempt with its work kept when the daemon restarts mid-step, and a retried prompt runs again', async () => {
    behave({ hold_ms: 60_000, touch: 'work.txt', output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => fs.existsSync(path.join(worktree, 'work.txt'))).toBe(true);

    const port = Number(new URL(daemon.url).port);
    await daemon.close();
    behave({ output: { ok: true } });
    daemon = await startFakeDaemon({ state: daemonState, port });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'daemon_restarted', message: `The Paseo daemon at ${daemon.url} stopped while the claude agent worked, before it wrote a workflow result. Its work is kept in the worktree; run \`teamai workflow retry\` to run the step again.` },
    });
    expect(fs.readFileSync(path.join(worktree, 'work.txt'), 'utf8')).toBe('work in progress\n');
    runtime.send(promptRequest(handle, 'op-0000000c'));
    expect(await runtime.next(isEnd('op-0000000c'))).toMatchObject({ event: 'finished', result: { output: { ok: true } } });
  });

  it('fails an unattended step whose agent asks for permission, naming the mode, and stops the agent', async () => {
    behave({ ask_permission: true, output: { ok: true } });
    const runtime = start();
    await ready(runtime, { mode: 'unattended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: {
        code: 'tool_failed',
        message: 'The claude agent asked for permission (Run npm test) in Paseo mode default, which asks before it runs what it does not allow, and an unattended run has nobody to answer. Run the workflow attended to answer it in the Paseo app, or run this step on a runtime that offers unattended.',
      },
    });
    expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request']);
  });

  it('waits in an attended run until the person answers the permission request in Paseo, then finishes', async () => {
    behave({ ask_permission: true, output: { ok: true } });
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);
    const agentId = String(received()[0]?.agentId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runtime.lines.filter(isEnd('op-0000000b'))).toEqual([]);

    fs.writeFileSync(path.join(daemonState, 'answers', agentId), 'allow');

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', result: { output: { ok: true } } });
  });

  it('shows the workspace when it opens, and the agent with a link to it in Paseo once a prompt runs', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const workspace = handle.split('/')[0];

    expect(await runtime.next(isOp('op-0000000a', 'ready'))).toEqual({ op: 'op-0000000a', event: 'ready', display: { label: 'Paseo workspace worktree', fields: { workspace, daemon: 'Paseo 0.14.0' } } });
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));
    const agentId = String(received()[0]?.agentId);
    runtime.send({ type: 'reattach', handle });

    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({
      display: { label: `teamai review · ${RUN}`, url: `paseo://h/srv_fake0001/agent/${agentId}`, fields: { agent: agentId, workspace, model: 'claude/claude-opus-5-5' } },
    });
  });

  it.each([
    ['an option it does not take', { url: 'ws://127.0.0.1:1/ws', imgae: 'x' }, {}, { code: 'bad_option', key: 'imgae' }],
    ['no daemon at the url', { url: 'ws://127.0.0.1:1/ws' }, {}, { code: 'daemon_unreachable' }],
    ['a daemon older than the client', undefined, { version: '0.13.2' }, { code: 'daemon_version', message: expect.stringContaining('runs version 0.13.2') }],
    ['a daemon without agent receipts', undefined, { missing: ['agentRequestReceipts'] }, { code: 'daemon_version', message: expect.stringContaining('lacks agentRequestReceipts') }],
  ])('fails init on %s', async (_, options, behaviour, error) => {
    behave(behaviour);

    expect(await ready(start(), { options: options ?? { url: daemon.url } })).toEqual({ type: 'init', ok: false, error: expect.objectContaining(error) });
  });

  it('fails a step whose agent errors, with Paseo\'s error, and one whose agent wrote no result', async () => {
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    behave({ error: 'Claude Code exited: not logged in' });
    runtime.send(promptRequest(handle, 'op-0000000b'));
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'failed', failure: { code: 'tool_failed', message: 'The claude agent failed in Paseo: Claude Code exited: not logged in' } });

    behave({});
    runtime.send(promptRequest(handle, 'op-0000000c'));
    expect(await runtime.next(isEnd('op-0000000c'))).toEqual({ op: 'op-0000000c', event: 'failed', failure: { code: 'tool_failed', message: 'claude did not write a valid workflow result' } });
  });
});
