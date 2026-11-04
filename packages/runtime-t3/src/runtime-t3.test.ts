import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeMessageSchema } from '@teamai/runtime-protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bundleRuntime, CLAUDE, connect, credentialsFile, fakeBrowser, fakeT3, signIn, type Connection, type FakeT3, type Line } from './testing/harness.js';

// teamai-runtime-t3 through its stdio entry, against a fake T3 Code server (testing/fake-t3.mjs).

let bundleDir: string;
let executable: string;

beforeAll(async () => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-t3-bundle-'));
  executable = await bundleRuntime(bundleDir);
}, 60_000);

afterAll(() => fs.rmSync(bundleDir, { recursive: true, force: true }));

describe('teamai-runtime-t3', () => {
  let dir: string;
  let checkout: string;
  let t3: FakeT3;
  const connections: Connection[] = [];

  const start = (env: Record<string, string> = {}): Connection => {
    const runtime = connect(executable, t3, env);
    connections.push(runtime);

    return runtime;
  };

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-t3-')));
    checkout = path.join(dir, 'acme-app');
    fs.mkdirSync(checkout);
    execFileSync('git', ['init', '-q', '-b', 'main', checkout]);
    execFileSync('git', ['-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    t3 = fakeT3(dir, checkout);
    await t3.start();
  });

  afterEach(async () => {
    await Promise.all(connections.splice(0).map((runtime) => runtime.close()));
    await t3.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('init', () => {
    it('offers prompt steps for the tools the environment runs, and no command', async () => {
      signIn(t3);
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      const reply = await runtime.next((line) => line['type'] === 'init');

      expect(RuntimeMessageSchema.safeParse(reply).success).toBe(true);
      expect(reply).toEqual({
        type: 'init', ok: true, prompt: true,
        can: { exec: false, setup: false, env: false, hitl: true, tokens: false, unattended: false, max_turns: false, workspace: ['new', 'continue'], tools: ['claude', 'codex'] },
      });
    });

    it('signs in through T3\'s page in an attended run, keeps the credential to itself, and a later unattended run reuses it', async () => {
      const browser = fakeBrowser(dir);
      const attended = start({ PATH: `${browser.bin}${path.delimiter}${process.env['PATH'] ?? ''}` });

      attended.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });

      const signedIn = await attended.next((line) => line['type'] === 'init');
      expect(signedIn, JSON.stringify(signedIn)).toMatchObject({ ok: true });
      expect(browser.visits()).toEqual(['/oauth/mcp/authorize']);
      expect(fs.statSync(credentialsFile(t3.home)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(credentialsFile(t3.home))).mode & 0o777).toBe(0o700);
      await attended.close();

      const unattended = start();
      unattended.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' } });

      expect(await unattended.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { hitl: false } });
      expect(t3.calls().filter((call) => call.tool === 'oauth_token')).toHaveLength(1);
    });

    it('fails an unattended run with no sign-in, saying how to sign in, and asks T3 for none', async () => {
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toEqual({
        type: 'init', ok: false,
        error: { code: 'login_required', message: expect.stringContaining('Start any workflow with --driver t3 from a terminal on this machine once') },
      });
      expect(t3.calls()).toEqual([]);
    });

    it('fails an unattended run whose sign-in has expired', async () => {
      signIn(t3, undefined, 60);
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { code: 'login_required' } });
    });

    it('fails when T3 Code is not running, saying to open it', async () => {
      signIn(t3);
      await t3.stop();
      fs.rmSync(path.join(t3.t3Home, 'userdata', 'server-runtime.json'));
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { code: 't3_unavailable', message: expect.stringContaining('Open T3 Code') } });
    });

    it('runs every prompt on the provider instance `instance` names, and fails naming the setup step for one T3 lacks', async () => {
      signIn(t3);
      t3.config({ providers: [CLAUDE, { ...CLAUDE, providerInstanceId: 'claude-work', displayName: 'Claude (work)' }, { ...CLAUDE, providerInstanceId: 'claude-off', constraints: ['Provider instance is disabled.'] }] });
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', instance: 'claude-work' } });
      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude'] } });

      const missing = start();
      missing.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', instance: 'claude-sandbox' } });
      expect(await missing.next((line) => line['type'] === 'init')).toEqual({
        type: 'init', ok: false,
        error: { code: 'bad_option', key: 'instance', message: expect.stringContaining('T3 Code has no provider instance "claude-sandbox". Add it in T3 Code under Settings → Providers') },
      });

      const disabled = start();
      disabled.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', instance: 'claude-off' } });
      expect(await disabled.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { key: 'instance', message: expect.stringContaining('Provider instance is disabled.') } });
    });

    it('names an option it does not take', async () => {
      signIn(t3);
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', instnace: 'x' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'instnace' } });
    });
  });

  describe('a prompt step', () => {
    let worktree: string;
    let result: string;
    const OPEN = 'op-0000000a';
    const RUN = 'r7f3a91c2';

    /** A runtime past init and open on the attempt's worktree, and its handle. */
    const opened = async (mode: 'attended' | 'unattended' = 'attended', env: Record<string, string> = {}): Promise<{ runtime: Connection; handle: string }> => {
      const runtime = start(env);
      runtime.send({ type: 'init', protocol: 1, mode, options: { environment: 'local' } });
      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      runtime.send({ type: 'open', op: OPEN, run: RUN, attempt: 'a1b2c3d4', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), toolHome: {} } });
      const accepted = await runtime.next((line) => line['op'] === OPEN && line['event'] === 'accepted');
      expect(await runtime.next((line) => line['op'] === OPEN && line['event'] !== 'accepted')).toMatchObject({ event: 'ready' });

      return { runtime, handle: z.string().parse(accepted['handle']) };
    };

    const prompt = (handle: string, op: string, lease: Record<string, unknown> = {}) => ({
      type: 'prompt', op, handle, env: { TEAMAI_WORKFLOW_RESULT: result }, unset: [], cwd: worktree,
      lease: {
        step: 'review', tool: 'claude', model: { name: 'claude-opus-5-5' }, permissions: 'approval-required', interactive: false, result,
        prompt: `Review the change on this branch.\n\nWrite the workflow result as JSON to ${result}. Use this shape: {"output":{}}.`,
        ...lease,
      },
    });

    const ended = (runtime: Connection, op: string): Promise<Line> => runtime.next((line) => line['op'] === op && line['event'] !== 'accepted', 20_000);

    beforeEach(() => {
      signIn(t3);
      worktree = path.join(checkout, '.teamai', 'workflow-worktrees', `${RUN}-a1b2c3d4`);
      execFileSync('git', ['-C', checkout, 'worktree', 'add', '-q', '--detach', worktree]);
      result = path.join(dir, 'attempt', 'out', 'result.json');
      fs.mkdirSync(path.dirname(result), { recursive: true });
    });

    it('fails open for a checkout that is not a T3 project, saying how to add it', async () => {
      t3.config({ projects: [] });
      const runtime = start();
      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await runtime.next((line) => line['type'] === 'init');

      runtime.send({ type: 'open', op: OPEN, run: RUN, attempt: 'a1b2c3d4', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), toolHome: {} } });

      expect(await runtime.next((line) => line['op'] === OPEN && line['event'] === 'failed')).toEqual({
        op: OPEN, event: 'failed',
        failure: { code: 'not_a_t3_project', message: `${checkout} is not a project in T3 Code fake-laptop. Add it in T3 Code (Add project, then pick that folder), then start the workflow again.` },
      });
    });

    it('runs as a T3 thread of its own on the attempt\'s worktree, then ends finished with the result and the session, and settles the thread', async () => {
      const { runtime, handle } = await opened('attended', { T3CODE_THREAD_ID: 'thread-parent-1' });
      const op = 'op-0000000b';

      runtime.send(prompt(handle, op));

      expect(await runtime.next((line) => line['op'] === op)).toEqual({ op, event: 'accepted' });
      const end = await ended(runtime, op);
      expect(RuntimeMessageSchema.safeParse(end).success).toBe(true);
      expect(end).toEqual({ op, event: 'finished', session: { tool: 'claude', id: expect.stringMatching(/^[0-9a-f-]{36}$/) }, result: { output: { verdict: 'approve' } } });

      const [thread] = t3.threads();
      expect(thread).toMatchObject({
        title: `review · teamai ${RUN}`, worktreePath: worktree, projectId: 'project-1', provider: 'claudeAgent', model: 'claude-opus-5-5',
        runtimeMode: 'approval-required', status: 'completed', settled: true,
      });
      expect(thread?.message).toMatch(new RegExp(`^This thread runs step "review" of teamai workflow run ${RUN} \\(attempt a1b2c3d4\\)\\. It was started from the T3 thread t3-thread://v2/env-fake-1/thread-parent-1\\.`));
      expect(thread?.message).toContain(`Write the workflow result as JSON to ${result}.`);
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args).toMatchObject({ clientRequestId: op, workspaceStrategy: { type: 'existing_worktree', worktreePath: worktree } });
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args).not.toHaveProperty('delegatedFrom');
    });

    it('started outside a T3 thread, names no thread it was started from', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000000c'));

      expect(await ended(runtime, 'op-0000000c')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.message).not.toContain('started from');
    });

    it('runs a Codex step on the Codex instance with the effort the lease asks, and finds its session', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000000d', { tool: 'codex', model: { name: 'gpt-6.1-sol', effort: 'high' } }));

      expect(await ended(runtime, 'op-0000000d')).toMatchObject({ event: 'finished', session: { tool: 'codex', id: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'high' }] });
    });

    it('fails model_unavailable for a model or an effort the instance does not run, and launches nothing', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000000e', { model: { name: 'claude-opus-9' } }));
      runtime.send(prompt(handle, 'op-0000000f', { model: { name: 'claude-sonnet-5-5', effort: 'max' } }));

      expect(await ended(runtime, 'op-0000000e')).toEqual({ op: 'op-0000000e', event: 'failed', failure: { code: 'model_unavailable', message: 'T3 Code provider instance "claudeAgent" (Claude) has no model claude-opus-9. Its models: claude-opus-5-5, claude-sonnet-5-5.' } });
      expect(await ended(runtime, 'op-0000000f')).toMatchObject({ failure: { code: 'model_unavailable', message: 'T3 Code provider instance "claudeAgent" (Claude) runs claude-sonnet-5-5 with no effort "max".' } });
      expect(t3.threads()).toEqual([]);
    });

    it('fails tool_failed when the thread\'s run fails, and leaves the thread active for the person', async () => {
      t3.config({ agent: { fail: true } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000010'));

      expect(await ended(runtime, 'op-00000010')).toEqual({ op: 'op-00000010', event: 'failed', failure: { code: 'tool_failed', message: expect.stringMatching(/^The T3 thread t3-thread:\/\/v2\/env-fake-1\/mcp:launch:\w+ \("review · teamai r7f3a91c2"\) ended failed before the step was done\.$/) } });
      expect(t3.threads()[0]?.settled).toBe(false);
    });

    it('fails a thread that completes without writing the result file', async () => {
      t3.config({ agent: {} });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000011'));

      expect(await ended(runtime, 'op-00000011')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining(`ended without writing the result file ${result}.`) } });
    });

    it('fails a thread whose tool kept no session, since the step could not be scored', async () => {
      t3.config({ agent: { output: { verdict: 'approve' }, noSession: true } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000012'));

      expect(await ended(runtime, 'op-00000012')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('claude kept no session for') } });
    });

    it('stops the thread on cancel and ends cancelled', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000013'));
      await runtime.next((line) => line['op'] === 'op-00000013' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');

      runtime.send({ type: 'cancel', op: 'op-00000013' });

      expect(await ended(runtime, 'op-00000013')).toEqual({ op: 'op-00000013', event: 'cancelled' });
      expect(t3.calls().find((call) => call.tool === 't3_thread_interrupt')?.args).toMatchObject({ stop: true });
      expect(t3.threads()[0]?.status).toBe('interrupted');
    });

    it('fails a step whose agent asks for an approval in an unattended run, and stops its thread', async () => {
      t3.config({ agent: { waits: true } });
      const { runtime, handle } = await opened('unattended');

      runtime.send(prompt(handle, 'op-00000014'));

      expect(await ended(runtime, 'op-00000014')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('asked for an approval, and nobody is there to give it in an unattended run.') } });
      expect(t3.threads()[0]).toMatchObject({ runtimeMode: 'approval-required', status: 'interrupted' });
    });

    it('refuses a lease in unattended permissions, which its offer never takes, and launches nothing', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000015', { permissions: 'unattended' }));

      expect(await ended(runtime, 'op-00000015')).toMatchObject({ event: 'failed', failure: { code: 'unattended_unsupported' } });
      expect(t3.threads()).toEqual([]);
    });

    it('reconnects to the same thread after its own restart: reattach shows it running, and the repeated prompt launches no other', async () => {
      const release = path.join(dir, 'release');
      t3.config({ agent: { release, output: { verdict: 'approve' } } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-00000017'));
      await first.runtime.next((line) => line['op'] === 'op-00000017' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();

      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'reattach', handle: first.handle });
      const [thread] = t3.threads();

      expect(await second.next((line) => line['event'] === 'alive')).toEqual({
        event: 'alive', handle: first.handle, ops: [{ op: 'op-00000017', state: 'running' }],
        display: { label: `review · teamai ${RUN}`, url: `t3-thread://v2/env-fake-1/${thread?.threadId}`, fields: { thread: thread?.threadId, model: 'claude-opus-5-5', environment: 'fake-laptop' } },
      });
      second.send(prompt(first.handle, 'op-00000017'));
      fs.writeFileSync(release, '');

      expect(await ended(second, 'op-00000017')).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
      expect(t3.threads()).toHaveLength(1);
    });

    it('answers a repeated prompt that ended with the same outcome, before and after its own restart', async () => {
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000018'));
      const end = await ended(runtime, 'op-00000018');
      runtime.send(prompt(handle, 'op-00000018'));
      expect(await ended(runtime, 'op-00000018')).toEqual(end);
      await runtime.close();

      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'reattach', handle });
      expect(await second.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000018', state: 'finished', session: end['session'], result: end['result'] }] });
      second.send(prompt(handle, 'op-00000018'));

      expect(await ended(second, 'op-00000018')).toEqual(end);
      expect(t3.threads()).toHaveLength(1);
    });

    it('answers reattach of a closed place gone', async () => {
      const { runtime, handle } = await opened();
      runtime.send({ type: 'collect', handle });
      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['event'] === 'closed')).toEqual({ event: 'closed', handle });

      runtime.send({ type: 'reattach', handle });

      expect(await runtime.next((line) => line['event'] === 'gone')).toEqual({ event: 'gone', handle });
    });

    it('ends an interactive step only once the agent wrote the result: an idle thread after a turn does not end it', async () => {
      t3.config({ agent: {} });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000019', { interactive: true }));
      await expect.poll(() => t3.threads()[0]?.status).toBe('completed');
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(runtime.lines.filter((line) => line['op'] === 'op-00000019').map((line) => line['event'])).toEqual(['accepted']);
      expect(t3.threads()[0]?.message).toContain('Write the result file only once they say the step is done.');
      // The person said it is done, and the agent wrote the result.
      fs.writeFileSync(result, JSON.stringify({ output: { notes: 'agreed' } }));

      expect(await ended(runtime, 'op-00000019')).toMatchObject({ event: 'finished', result: { output: { notes: 'agreed' } } });
    });

    it('runs no command', async () => {
      const { runtime, handle } = await opened();

      runtime.send({ type: 'exec', op: 'op-00000016', handle, argv: ['/bin/sh', '-c', 'touch ran'], env: {}, unset: [], cwd: worktree });

      expect(await ended(runtime, 'op-00000016')).toMatchObject({ event: 'failed', failure: { code: 'exec_unsupported' } });
      expect(fs.existsSync(path.join(worktree, 'ran'))).toBe(false);
    });
  });
});
