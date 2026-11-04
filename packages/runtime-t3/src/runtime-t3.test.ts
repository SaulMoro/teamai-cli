import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeMessageSchema } from '@teamai/runtime-protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bundleRuntime, CLAUDE, CODEX, connect, credentialsFile, fakeBrowser, fakeT3, signIn, type Connection, type FakeT3, type Line } from './testing/harness.js';

// teamai-runtime-t3 through its stdio entry, against a fake T3 Code server (testing/fake-t3.mjs).

let bundleDir: string;
let executable: string;

beforeAll(async () => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-t3-bundle-'));
  executable = await bundleRuntime(bundleDir);
}, 60_000);

afterAll(() => fs.rmSync(bundleDir, { recursive: true, force: true }));

/** The link that opens a thread of the fake's environment in T3 Code's desktop app. */
const linkTo = (threadId: string | undefined): string => `t3code://threads/env-fake-1/${encodeURIComponent(threadId ?? '')}`;

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
    // A judge's copy left unclosed is read-only.
    execFileSync('chmod', ['-R', 'u+w', dir]);
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
        type: 'init', ok: true, prompt: true, confinedPrompt: true,
        can: {
          exec: false, setup: false, env: false, hitl: true, tokens: false, unattended: false, max_turns: false, workspace: ['new', 'continue'], tools: ['claude', 'codex'],
          confined: [{ level: 'best-effort', access: 'read', tools: ['claude', 'codex'] }],
        },
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
        error: { code: 'bad_option', key: 'instance', message: expect.stringMatching(/^T3 Code has no provider instance "claude-sandbox"\. Add it in T3 Code under Settings → Providers, .*Instances here: [^.]+$/) },
      });

      const disabled = start();
      disabled.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', instance: 'claude-off' } });
      expect(await disabled.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { key: 'instance', message: expect.stringMatching(/cannot run now: Provider instance is disabled\. Enable it in T3 Code under Settings → Providers$/) } });
    });

    // T3 Code 0.1.8 lists a signed-out Claude or Codex with these constraints, so neither is offered to run or to judge.
    it('offers no tool whose provider T3 reports as signed out', async () => {
      signIn(t3);
      t3.config({ providers: [{ ...CLAUDE, constraints: ['Claude Code is not authenticated. Run `claude auth login` and try again.', 'Provider is not authenticated.'] }, CODEX] });
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['codex'], confined: [{ tools: ['codex'] }] } });
    });

    // teamai quotes a keyed option failure inside a sentence of its own and ends it, so these messages bring no full stop.
    it.each(['full-access', 'yolo'])('refuses `runtime_mode: %s`, which would not tighten a step thread\'s mode', async (runtimeMode) => {
      signIn(t3);
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', runtime_mode: runtimeMode } });

      expect(await runtime.next((line) => line['type'] === 'init')).toEqual({
        type: 'init', ok: false,
        error: {
          code: 'bad_option', key: 'runtime_mode',
          message: `runtime_mode "${runtimeMode}" is not one runtime t3 takes. A step thread runs in auto, T3's Auto mode; runtime_mode only tightens it, to auto-accept-edits or approval-required. Remove it, or set one of those two`,
        },
      });
      expect(t3.calls()).toEqual([]);
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
    const opened = async (mode: 'attended' | 'unattended' = 'attended', env: Record<string, string> = {}, options: Line = {}): Promise<{ runtime: Connection; handle: string }> => {
      const runtime = start(env);
      runtime.send({ type: 'init', protocol: 1, mode, options: { environment: 'local', ...options } });
      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      runtime.send({ type: 'open', op: OPEN, run: RUN, attempt: 'a1b2c3d4', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
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

      runtime.send({ type: 'open', op: OPEN, run: RUN, attempt: 'a1b2c3d4', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });

      expect(await runtime.next((line) => line['op'] === OPEN && line['event'] === 'failed')).toEqual({
        op: OPEN, event: 'failed',
        failure: { code: 'not_a_t3_project', message: `${checkout} is not a project in T3 Code fake-laptop. Add it in T3 Code (Add project, then pick that folder), then start the workflow again.` },
      });
    });

    it('does not count a project T3 deleted', async () => {
      t3.config({ projects: [{ id: 'project-old', title: 'acme-app', workspaceRoot: checkout, deletedAt: '2026-10-01T09:00:00.000Z' }] });
      const runtime = start();
      runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await runtime.next((line) => line['type'] === 'init');

      runtime.send({ type: 'open', op: OPEN, run: RUN, attempt: 'a1b2c3d4', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });

      expect(await runtime.next((line) => line['op'] === OPEN && line['event'] === 'failed')).toMatchObject({ failure: { code: 'not_a_t3_project' } });
    });

    it('runs as a T3 thread of its own on the attempt\'s worktree, then ends finished with the result and the session', async () => {
      const { runtime, handle } = await opened('attended', { T3CODE_THREAD_ID: 'thread-parent-1' });
      const op = 'op-0000000b';

      runtime.send(prompt(handle, op));

      // The thread exists once T3 launched it, so the acceptance shows it, and the run details link it during the run.
      const accepted = await runtime.next((line) => line['op'] === op);
      expect(RuntimeMessageSchema.safeParse(accepted).success).toBe(true);
      expect(accepted).toEqual({
        op, event: 'accepted',
        display: { label: `review · teamai ${RUN}`, url: expect.stringMatching(/^t3code:\/\/threads\/env-fake-1\/mcp%3Alaunch%3A[0-9a-f]{64}$/), fields: { thread: expect.stringMatching(/^mcp:launch:/), model: 'claude-opus-5-5', environment: 'fake-laptop' } },
      });
      const end = await ended(runtime, op);
      expect(RuntimeMessageSchema.safeParse(end).success).toBe(true);
      expect(end).toEqual({ op, event: 'finished', session: { tool: 'claude', id: expect.stringMatching(/^[0-9a-f-]{36}$/) }, result: { output: { verdict: 'approve' } } });

      const [thread] = t3.threads();
      expect(thread).toMatchObject({
        title: `review · teamai ${RUN}`, worktreePath: worktree, projectId: 'project-1', provider: 'claudeAgent', model: 'claude-opus-5-5',
        runtimeMode: 'auto', status: 'completed',
      });
      // In T3's own chat form, which T3 shows as a link to that thread.
      expect(thread?.message).toMatch(new RegExp(`^This thread runs step "review" of teamai workflow run ${RUN} \\(attempt a1b2c3d4\\)\\. It was started from the T3 thread <t3-thread://v2/env-fake-1/thread-parent-1>\\.`));
      expect(thread?.message).toContain(`Write the workflow result as JSON to ${result}.`);
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args).toMatchObject({ clientRequestId: op, workspaceStrategy: { type: 'existing_worktree', worktreePath: worktree } });
      expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args).not.toHaveProperty('delegatedFrom');
    });

    it.each(['auto-accept-edits', 'approval-required'])('runs every thread in %s when `runtime_mode` tightens it', async (runtimeMode) => {
      const { runtime, handle } = await opened('attended', {}, { runtime_mode: runtimeMode });

      runtime.send(prompt(handle, 'op-0000001a'));

      expect(await ended(runtime, 'op-0000001a')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.runtimeMode).toBe(runtimeMode);
    });

    it('fails sign_in_too_narrow, naming the fix, when the sign-in does not allow the mode the thread runs in', async () => {
      t3.config({ access: 'approval-required' });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000001b'));

      expect(await ended(runtime, 'op-0000001b')).toEqual({
        op: 'op-0000001b', event: 'failed', failure: {
          code: 'sign_in_too_narrow',
          message: 'T3 Code refused to start the step\'s thread in auto mode, because teamai\'s sign-in does not allow it (Child runtime mode auto is broader than parent mode approval-required.). Remove ~/.teamai/runtime-state/t3/credentials.json, start the workflow again, and approve teamai with Auto access or broader. Or set runtime_mode to a mode the sign-in allows.',
        },
      });
      expect(t3.threads()).toEqual([]);

      // T3 refuses the repeated launch close looks the thread up with as well: there was none, and none is left.
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
      expect(t3.threads()).toEqual([]);
    });

    // Once a step ended and T3 holds no run of its thread, teamai settles it: it leaves the active list and still opens from its link.
    it.each([
      { ended: 'finished', agent: { output: { verdict: 'approve' } }, event: 'finished' },
      { ended: 'finished, reporting the step failed', agent: { failure: { code: 'tests_failed', message: 'npm test fails in src/cart.test.ts.' } }, event: 'finished' },
      { ended: 'failed', agent: { fail: true }, event: 'failed' },
      { ended: 'cancelled', agent: { hold: true, output: {} }, event: 'cancelled' },
    ])('settles the thread of a step that ended $ended once teamai collects it', async ({ agent, event }) => {
      t3.config({ agent });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000030'));
      await runtime.next((line) => line['op'] === 'op-00000030' && line['event'] === 'accepted');

      if (event === 'cancelled') {
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        runtime.send({ type: 'cancel', op: 'op-00000030' });
      }

      expect(await ended(runtime, 'op-00000030')).toMatchObject({ event });
      expect(t3.threads()[0]?.settled).toBe(false);

      runtime.send({ type: 'collect', handle });

      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      expect(t3.threads()[0]?.settled).toBe(true);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_organize').map((call) => call.args)).toEqual([{ threadId: t3.threads()[0]?.threadId, action: 'settle' }]);
    });

    // After a restart, cancel ends the op once T3 acknowledged the stop, which may come before the run ended.
    it('settles the thread of a step cancelled after a restart, once its run ends after T3 acknowledged the stop', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-00000036'));
      await first.runtime.next((line) => line['op'] === 'op-00000036' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();
      t3.config({ stopLagMs: 1_000 });

      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'cancel', op: 'op-00000036' });
      expect(await second.next((line) => line['op'] === 'op-00000036')).toEqual({ op: 'op-00000036', event: 'cancelled' });
      expect(t3.threads()[0]?.status).toBe('interrupted');
      second.send({ type: 'collect', handle: first.handle });

      expect(await second.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle: first.handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    it('never settles a thread that still runs, or an interactive step\'s thread that waits for the person', async () => {
      t3.config({ agent: {} });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000031', { interactive: true }));
      await expect.poll(() => t3.threads()[0]?.status).toBe('completed');
      t3.config({ agent: { hold: true, output: {} } });
      runtime.send(prompt(handle, 'op-00000032'));
      await expect.poll(() => t3.threads().map((thread) => thread.status).sort()).toEqual(['completed', 'running']);

      runtime.send({ type: 'collect', handle });

      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      expect(t3.threads().map((thread) => thread.settled)).toEqual([false, false]);
      expect(t3.calls().filter((call) => call.tool === 't3_thread_organize')).toEqual([]);
    });

    // The step fails at once, but its thread is still teamai's to stop: close keeps the place until T3 stops it.
    it.each([
      { stop: 'refuses', config: { interruptFails: true } },
      { stop: 'acknowledges but the run does not end', config: { stopLagMs: 60_000, waitCapMs: 50 } },
    ])('never settles or drops the thread of a step that ended while T3 still runs it, when T3 $stop the stop', async ({ config }) => {
      t3.config({ agent: { waits: true }, ...config });
      const { runtime, handle } = await opened('unattended');
      runtime.send(prompt(handle, 'op-00000035'));
      expect(await ended(runtime, 'op-00000035')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('Stop it in T3 Code with its Stop button.') } });

      runtime.send({ type: 'collect', handle });

      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'collected')).toMatchObject({ event: 'close_failed', handle, failure: { code: 'thread_still_runs' } });
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000035', state: 'failed' }] });
      expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

      // T3 stops it now: close stops it, settles it and drops the place.
      t3.config({ interruptFails: false, stopLagMs: 0 });
      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    it('settles only the threads it launched', async () => {
      t3.addThread({ threadId: 'thread-person-1', title: 'Fix the cart total', status: 'completed' });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000033'));
      expect(await ended(runtime, 'op-00000033')).toMatchObject({ event: 'finished' });
      const launched = t3.threads().find((thread) => thread.threadId !== 'thread-person-1');

      runtime.send({ type: 'collect', handle });
      await runtime.next((line) => line['event'] === 'collected');
      runtime.send({ type: 'close', handle });
      await runtime.next((line) => line['event'] === 'closed');

      expect(t3.calls().filter((call) => call.tool === 't3_thread_organize').map((call) => call.args['threadId'])).toEqual([launched?.threadId]);
      expect(t3.threads().find((thread) => thread.threadId === 'thread-person-1')?.settled).toBe(false);
    });

    it('says once that a thread could not be settled, and the step still counts', async () => {
      t3.config({ organizeFails: true });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000034'));
      expect(await ended(runtime, 'op-00000034')).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
      const threadId = t3.threads()[0]?.threadId;

      runtime.send({ type: 'collect', handle });
      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      runtime.send({ type: 'collect', handle });
      expect(await runtime.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['event'] === 'closed')).toEqual({ event: 'closed', handle });

      const said = `teamai could not settle the T3 thread ${linkTo(threadId)} ("review · teamai ${RUN}"), so it stays in T3 Code's active threads: Thread ${threadId} cannot be organized now.\n`;
      expect(runtime.stderr().split(said)).toHaveLength(2);
      expect(t3.threads()[0]?.settled).toBe(false);
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

    // A T3 thread always starts a session of its own, so teamai must not link it to the one the step asked to resume.
    it('says nothing of resuming when the lease asks to resume a session, since the thread started a new one', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000001b', { resume: '0b7e4a52-6f3c-4d1e-9a2b-5c8d7e6f1a30' }));

      const end = await ended(runtime, 'op-0000001b');
      expect(end).toMatchObject({ event: 'finished', session: { tool: 'claude' } });
      expect(end).not.toHaveProperty('resumed');
    });

    it('fails model_unavailable for a model or an effort the instance does not run, and launches nothing', async () => {
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-0000000e', { model: { name: 'claude-opus-9' } }));
      runtime.send(prompt(handle, 'op-0000000f', { model: { name: 'claude-sonnet-5-5', effort: 'max' } }));

      expect(await ended(runtime, 'op-0000000e')).toEqual({ op: 'op-0000000e', event: 'failed', failure: { code: 'model_unavailable', message: 'T3 Code provider instance "claudeAgent" (Claude) has no model claude-opus-9. Its models: claude-opus-5-5, claude-sonnet-5-5.' } });
      expect(await ended(runtime, 'op-0000000f')).toMatchObject({ failure: { code: 'model_unavailable', message: 'T3 Code provider instance "claudeAgent" (Claude) runs claude-sonnet-5-5 with no effort "max".' } });
      expect(t3.threads()).toEqual([]);
    });

    it('fails tool_failed when the thread\'s run fails, naming the thread by its link', async () => {
      t3.config({ agent: { fail: true } });
      const { runtime, handle } = await opened();

      runtime.send(prompt(handle, 'op-00000010'));

      expect(await ended(runtime, 'op-00000010')).toEqual({ op: 'op-00000010', event: 'failed', failure: { code: 'tool_failed', message: `The T3 thread ${linkTo(t3.threads()[0]?.threadId)} ("review · teamai r7f3a91c2") ended failed before the step was done.` } });
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

    it('stops the thread on cancel and ends cancelled once its run has ended', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000013'));
      await runtime.next((line) => line['op'] === 'op-00000013' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ stopLagMs: 1_000 });

      runtime.send({ type: 'cancel', op: 'op-00000013' });

      expect(await ended(runtime, 'op-00000013')).toEqual({ op: 'op-00000013', event: 'cancelled' });
      expect(t3.calls().find((call) => call.tool === 't3_thread_interrupt')?.args).toMatchObject({ stop: true });
      expect(t3.threads()[0]?.status).toBe('interrupted');
    });

    it('answers close_failed, keeping the place, when T3 acknowledges the stop but the thread\'s run does not end', async () => {
      t3.config({ agent: { hold: true, output: {} }, waitCapMs: 50 });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000038'));
      await runtime.next((line) => line['op'] === 'op-00000038' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ stopLagMs: 60_000 });

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted')).toMatchObject({
        event: 'close_failed', handle, failure: { code: 'thread_still_runs', message: expect.stringContaining('T3 Code acknowledged the stop, but its run was still running') },
      });
      expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });
    });

    // T3 answers a wait with the run's own status, and timedOut until the work it delegated settled too.
    describe('when the step\'s run delegated work that has not settled', () => {
      it('ends the step only once the delegated work settled, even though its own run completed', async () => {
        t3.config({ delegatesPending: true, waitCapMs: 50 });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-00000040'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('completed');
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(runtime.lines.filter((line) => line['op'] === 'op-00000040').map((line) => line['event'])).toEqual(['accepted']);
        t3.config({ delegatesPending: false });

        expect(await ended(runtime, 'op-00000040')).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
      });

      it('ends the step as the run that answered once the work settled ended, rather than as its own run', async () => {
        t3.config({ resultRunStatus: 'failed' });
        const { runtime, handle } = await opened();

        runtime.send(prompt(handle, 'op-00000041'));

        expect(await ended(runtime, 'op-00000041')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('ended failed before the step was done.') } });
      });

      // T3 answers the stop no_active_run, from the run's own events, while it stops the delegated work apart.
      it('answers close_failed, keeping the place, until the delegated work of a run that already ended settles', async () => {
        t3.config({ delegatesPending: true, waitCapMs: 50 });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-00000042'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('completed');

        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted')).toMatchObject({
          event: 'close_failed', handle, failure: { code: 'thread_still_runs', message: expect.stringContaining('the work it delegated had not settled') },
        });
        expect(t3.calls().filter((call) => call.tool === 't3_thread_interrupt')).toHaveLength(1);
        expect(t3.threads()[0]?.settled).toBe(false);
        t3.config({ delegatesPending: false });
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle && line['event'] === 'closed')).toEqual({ event: 'closed', handle });
        expect(t3.threads()[0]?.settled).toBe(true);
      });

      it('gives no cancelled after a restart until the stopped run\'s delegated work settled', async () => {
        t3.config({ agent: { hold: true, output: {} } });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-00000043'));
        await first.runtime.next((line) => line['op'] === 'op-00000043' && line['event'] === 'accepted');
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ delegatesPending: true, waitCapMs: 300, stopLagMs: 100 });

        const second = start();
        second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
        await second.next((line) => line['type'] === 'init');
        second.send({ type: 'cancel', op: 'op-00000043' });
        await expect.poll(() => t3.threads()[0]?.status).toBe('interrupted');
        await new Promise((resolve) => setTimeout(resolve, 600));

        expect(second.lines.filter((line) => line['op'] === 'op-00000043')).toEqual([]);
        second.send({ type: 'reattach', handle: first.handle });
        expect(await second.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000043', state: 'running' }] });

        t3.config({ delegatesPending: false });
        second.send({ type: 'cancel', op: 'op-00000043' });

        expect(await second.next((line) => line['op'] === 'op-00000043')).toEqual({ op: 'op-00000043', event: 'cancelled' });
        second.send({ type: 'collect', handle: first.handle });
        await second.next((line) => line['event'] === 'collected');
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });
    });

    it('refuses a prompt that carries credentials, since the thread runs on T3 Code\'s own sign-in, and launches nothing', async () => {
      const { runtime, handle } = await opened();

      runtime.send({ ...prompt(handle, 'op-0000001e'), credentials: { ACME_TOKEN: 'acme-secret-value' } });

      const end = await ended(runtime, 'op-0000001e');
      expect(end).toEqual({
        op: 'op-0000001e', event: 'failed', failure: {
          code: 'credentials_unsupported',
          message: 'Runtime t3 got credentials ACME_TOKEN, but a T3 thread runs its tool in T3 Code\'s environment, on T3 Code\'s own sign-in, and this runtime cannot pass it a value (its init offers can.env: false). Remove the credentials from the runtime, or run the step on a runtime that offers can.env.',
        },
      });
      expect(JSON.stringify(runtime.lines)).not.toContain('acme-secret-value');
      expect(t3.threads()).toEqual([]);
    });

    // T3 acknowledges a stop before the run ends, so close waits for the run's end before it settles the thread.
    it('stops a thread still running when teamai closes its place, settles it once its run ends, then answers closed', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-0000001f'));
      await runtime.next((line) => line['op'] === 'op-0000001f' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ stopLagMs: 1_000 });

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted')).toEqual({ event: 'closed', handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    it('answers close_failed, keeping the place, when T3 will not stop a thread still running there', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000020'));
      await runtime.next((line) => line['op'] === 'op-00000020' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      t3.config({ interruptFails: true });
      const [thread] = t3.threads();

      runtime.send({ type: 'close', handle });

      const answer = await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted');
      expect(RuntimeMessageSchema.safeParse(answer).success).toBe(true);
      expect(answer).toEqual({
        event: 'close_failed', handle, failure: {
          code: 'thread_still_runs',
          message: `The T3 thread ${linkTo(thread?.threadId)} ("review · teamai ${RUN}") still runs, and T3 Code did not stop it: Thread ${thread?.threadId} has a run T3 cannot interrupt now. Stop it in T3 Code with its Stop button.`,
        },
      });
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000020', state: 'running' }] });
    });

    it('keeps a prompt running, and a later close failing, while T3 will not stop its thread', async () => {
      t3.config({ agent: { hold: true, output: {} }, waitCapMs: 50 });
      const { runtime, handle } = await opened();
      runtime.send(prompt(handle, 'op-00000021'));
      await runtime.next((line) => line['op'] === 'op-00000021' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      // Waits on the thread answer while each refused stop is still pending.
      t3.config({ interruptFails: true, interruptMs: 400 });

      runtime.send({ type: 'cancel', op: 'op-00000021' });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['event'] === 'close_failed', 5_000)).toMatchObject({ handle });
      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['event'] === 'close_failed' || line['event'] === 'closed', 5_000)).toMatchObject({ event: 'close_failed', failure: { code: 'thread_still_runs' } });
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-00000021', state: 'running' }] });
      expect(runtime.lines.filter((line) => line['op'] === 'op-00000021' && line['event'] === 'cancelled')).toEqual([]);
      expect(t3.threads()[0]?.status).toBe('running');
    });

    it('fails a step whose agent asks for an approval in an unattended run, and stops its thread', async () => {
      t3.config({ agent: { waits: true } });
      const { runtime, handle } = await opened('unattended');

      runtime.send(prompt(handle, 'op-00000014'));

      expect(await ended(runtime, 'op-00000014')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('asked for an approval, and nobody is there to give it in an unattended run.') } });
      expect(t3.threads()[0]).toMatchObject({ runtimeMode: 'auto', status: 'interrupted' });
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
        display: { label: `review · teamai ${RUN}`, url: linkTo(thread?.threadId), fields: { thread: thread?.threadId, model: 'claude-opus-5-5', environment: 'fake-laptop' } },
      });
      second.send(prompt(first.handle, 'op-00000017'));
      fs.writeFileSync(release, '');

      expect(await ended(second, 'op-00000017')).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
      expect(t3.threads()).toHaveLength(1);
    });

    it('reconnects to the same thread after the member signed in again, where a repeated launch would start another', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-0000004f'));
      await first.runtime.next((line) => line['op'] === 'op-0000004f' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();
      t3.config({ token: 'fake-t3-token-second-0987654321', namespace: 'session-2' });
      signIn(t3, 'fake-t3-token-second-0987654321');

      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      expect(await second.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      second.send(prompt(first.handle, 'op-0000004f'));
      await second.next((line) => line['op'] === 'op-0000004f' && line['event'] === 'accepted');
      second.send({ type: 'close', handle: first.handle });

      expect(await second.next((line) => line['handle'] === first.handle)).toEqual({ event: 'closed', handle: first.handle });
      expect(t3.threads()).toHaveLength(1);
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    it('stops the thread a runtime before it left running when teamai cancels that prompt first thing after a restart, and settles it at collect', async () => {
      t3.config({ agent: { release: path.join(dir, 'release'), output: { verdict: 'approve' } } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-0000001c'));
      await first.runtime.next((line) => line['op'] === 'op-0000001c' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();

      // As `teamai workflow cancel` does for a run whose driver died: cancel, then reattach until the op no longer runs.
      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send({ type: 'cancel', op: 'op-0000001c' });

      await expect.poll(async () => {
        second.send({ type: 'reattach', handle: first.handle });

        return (await second.next((line) => line['event'] === 'alive'))['ops'];
      }).toEqual([{ op: 'op-0000001c', state: 'cancelled' }]);
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: false });

      second.send({ type: 'collect', handle: first.handle });

      expect(await second.next((line) => line['event'] === 'collected')).toEqual({ event: 'collected', handle: first.handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    // As `teamai workflow cancel` goes for a run whose driver died (cancel, reattach, collect, close), with T3 Code down.
    it('neither forgets nor drops a place whose thread still runs while T3 Code cannot be reached after a restart', async () => {
      t3.config({ agent: { hold: true, output: {} } });
      const first = await opened();
      first.runtime.send(prompt(first.handle, 'op-00000044'));
      await first.runtime.next((line) => line['op'] === 'op-00000044' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();
      await t3.stop();
      fs.rmSync(path.join(t3.t3Home, 'userdata', 'server-runtime.json'));

      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      expect(await second.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { code: 't3_unavailable' } });
      second.send({ type: 'reattach', handle: first.handle });

      expect(await second.next((line) => line['handle'] === first.handle)).toEqual({ event: 'alive', handle: first.handle, ops: [{ op: 'op-00000044', state: 'running' }] });
      second.send({ type: 'close', handle: first.handle });
      expect(await second.next((line) => line['handle'] === first.handle)).toMatchObject({ event: 'close_failed', failure: { code: 't3_unavailable' } });
      second.send({ type: 'reattach', handle: first.handle });
      expect(await second.next((line) => line['handle'] === first.handle)).toMatchObject({ event: 'alive' });

      // T3 Code is back: the place closes as usual.
      await t3.start();
      const third = start();
      third.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await third.next((line) => line['type'] === 'init');
      third.send({ type: 'close', handle: first.handle });

      expect(await third.next((line) => line['handle'] === first.handle)).toEqual({ event: 'closed', handle: first.handle });
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    // A thread the journal holds stays the runtime's to stop until it saw that thread stop, whatever ended its op and
    // whichever runtime process launched it.
    describe('when a prompt resumed after a restart is refused while its thread still runs', () => {
      /** A step thread left running by a runtime that exited, and a second runtime, set up by `before`, that it is resent to. */
      const resumed = async (op: string, before: () => void): Promise<{ runtime: Connection; handle: string }> => {
        t3.config({ agent: { hold: true, output: {} } });
        const first = await opened();
        first.runtime.send(prompt(first.handle, op));
        await first.runtime.next((line) => line['op'] === op && line['event'] === 'accepted');
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        before();

        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
        runtime.send(prompt(first.handle, op));

        return { runtime, handle: first.handle };
      };

      it('keeps the thread when T3 no longer offers the model: collect leaves it, and close stops it first', async () => {
        const { runtime, handle } = await resumed('op-00000045', () => t3.config({ providers: [{ ...CLAUDE, models: [{ id: 'claude-sonnet-5-5' }] }, CODEX] }));

        expect(await ended(runtime, 'op-00000045')).toMatchObject({ event: 'failed', failure: { code: 'model_unavailable' } });
        runtime.send({ type: 'collect', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'collected', handle });
        expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

        t3.config({ interruptFails: true });
        runtime.send({ type: 'close', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'close_failed', failure: { code: 'thread_still_runs' } });
        runtime.send({ type: 'reattach', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'alive', ops: [{ op: 'op-00000045', state: 'failed' }] });

        t3.config({ interruptFails: false });
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });

      // T3 finds a repeated launch only under the sign-in that sent it, so a thread the journal names is reconnected to by its id.
      it('sends no launch for a thread it holds, so T3 refusing launches cannot drop it, and close stops it', async () => {
        const { runtime, handle } = await resumed('op-00000046', () => t3.config({ launchFails: true }));
        await runtime.next((line) => line['op'] === 'op-00000046' && line['event'] === 'accepted');

        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(await ended(runtime, 'op-00000046')).toEqual({ op: 'op-00000046', event: 'cancelled' });
        expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toHaveLength(1);
        expect(t3.calls().filter((call) => call.tool === 't3_thread_interrupt')).toHaveLength(1);
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });
    });

    // A launch's clientRequestId is journaled before the launch, and T3 answers a repeated launch with the thread it
    // launched for that id, so a launch whose reply never came is found again.
    describe('when T3 launched a step\'s thread but its reply never came', () => {
      it('finds the thread at close by repeating the launch, keeping the place while T3 cannot answer', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchReplyLost: true });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-00000047'));

        expect(await ended(runtime, 'op-00000047')).toMatchObject({ event: 'failed', failure: { code: 't3_launch_failed' } });
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        runtime.send({ type: 'close', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({
          event: 'close_failed', failure: { code: 't3_unavailable', message: expect.stringContaining(`"review · teamai ${RUN}"`) },
        });

        t3.config({ launchReplyLost: false });
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });

      // T3 answers a call it could not complete with orchestration_error, which says nothing of what it launched.
      it('keeps the place when T3 cannot complete the repeated launch, and finds the thread once it can', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchReplyLost: true });
        const { runtime, handle } = await opened();
        runtime.send(prompt(handle, 'op-0000004a'));
        expect(await ended(runtime, 'op-0000004a')).toMatchObject({ event: 'failed', failure: { code: 't3_launch_failed' } });
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        t3.config({ launchReplyLost: false, launchUnavailable: true });

        runtime.send({ type: 'close', handle });
        expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({
          event: 'close_failed', failure: { code: 't3_unavailable', message: expect.stringContaining('The operation could not be completed') },
        });
        expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

        t3.config({ launchUnavailable: false });
        runtime.send({ type: 'close', handle });

        expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
      });

      it('gives no cancelled after a restart while T3 cannot complete the repeated launch, and cancels once it can', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchMs: 3_000 });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-0000004b'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ launchMs: 0, launchUnavailable: true });

        const second = start();
        second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
        await second.next((line) => line['type'] === 'init');
        second.send({ type: 'cancel', op: 'op-0000004b' });
        await expect.poll(() => t3.calls().filter((call) => call.tool === 't3_thread_launch')).toHaveLength(2);
        second.send({ type: 'reattach', handle: first.handle });

        expect(await second.next((line) => line['event'] === 'alive')).toMatchObject({ ops: [{ op: 'op-0000004b', state: 'running' }] });
        expect(second.lines.filter((line) => line['op'] === 'op-0000004b')).toEqual([]);
        expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });

        t3.config({ launchUnavailable: false });
        second.send({ type: 'cancel', op: 'op-0000004b' });

        expect(await second.next((line) => line['op'] === 'op-0000004b')).toEqual({ op: 'op-0000004b', event: 'cancelled' });
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]?.status).toBe('interrupted');
      });

      // T3 finds a repeated launch only under the sign-in that sent it, and a sign-in lasts a limited time.
      describe('after the member signed in again', () => {
        const SECOND = 'fake-t3-token-second-0987654321';

        /** A launch T3 made under the first sign-in and never answered, its runtime gone, and a runtime on a new sign-in. */
        const lostThenSignedInAgain = async (op: string): Promise<{ runtime: Connection; handle: string; record: string }> => {
          t3.config({ agent: { hold: true, output: {} }, launchMs: 3_000 });
          const first = await opened();
          first.runtime.send(prompt(first.handle, op));
          await expect.poll(() => t3.threads()[0]?.status).toBe('running');
          await first.runtime.close();
          t3.config({ launchMs: 0, token: SECOND, namespace: 'session-2' });
          signIn(t3, SECOND);

          const runtime = start();
          runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
          expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });

          return { runtime, handle: first.handle, record: path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(first.handle)}.json`) };
        };

        const unconfirmed = (record: string) => ({
          code: 'launch_unconfirmed',
          message: `teamai launched the T3 thread "review · teamai ${RUN}" in the T3 project "acme-app" under an earlier T3 Code sign-in, and T3 Code never answered, so it may still run. T3 Code finds that launch only under the sign-in that sent it, so teamai cannot find or stop it. In T3 Code, stop "review · teamai ${RUN}" with its Stop button if it runs, then delete ${record} and run teamai workflow cancel ${RUN} again.`,
        });

        it('keeps the place at close, naming the thread to stop and the record to delete, and launches nothing', async () => {
          const { runtime, handle, record } = await lostThenSignedInAgain('op-0000004c');

          runtime.send({ type: 'close', handle });

          expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'close_failed', handle, failure: unconfirmed(record) });
          expect(t3.threads()).toHaveLength(1);
          expect(t3.threads()[0]).toMatchObject({ status: 'running', settled: false });
          // The record names the sign-in by a hash, never by its token.
          expect(fs.readFileSync(record, 'utf8')).not.toContain('fake-t3-token');
        });

        it('fails the op on a cancel, saying the same, and launches nothing', async () => {
          const { runtime, handle, record } = await lostThenSignedInAgain('op-0000004d');

          runtime.send({ type: 'cancel', op: 'op-0000004d' });

          expect(await runtime.next((line) => line['op'] === 'op-0000004d')).toEqual({ op: 'op-0000004d', event: 'failed', failure: unconfirmed(record) });
          runtime.send({ type: 'close', handle });
          expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'close_failed', failure: { code: 'launch_unconfirmed' } });
          expect(t3.threads()).toHaveLength(1);
          expect(t3.threads()[0]?.status).toBe('running');
        });

        it('fails a resumed prompt, saying the same, rather than launching the step again', async () => {
          const { runtime, handle, record } = await lostThenSignedInAgain('op-0000004e');

          runtime.send(prompt(handle, 'op-0000004e'));

          expect(await ended(runtime, 'op-0000004e')).toEqual({ op: 'op-0000004e', event: 'failed', failure: unconfirmed(record) });
          expect(t3.threads()).toHaveLength(1);
        });
      });

      it('finds and stops the thread when teamai cancels the prompt after the runtime that launched it exited first', async () => {
        t3.config({ agent: { hold: true, output: {} }, launchMs: 3_000 });
        const first = await opened();
        first.runtime.send(prompt(first.handle, 'op-00000048'));
        await expect.poll(() => t3.threads()[0]?.status).toBe('running');
        await first.runtime.close();
        t3.config({ launchMs: 0 });

        const second = start();
        second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
        await second.next((line) => line['type'] === 'init');
        second.send({ type: 'cancel', op: 'op-00000048' });

        await expect.poll(async () => {
          second.send({ type: 'reattach', handle: first.handle });

          return (await second.next((line) => line['event'] === 'alive'))['ops'];
        }).toEqual([{ op: 'op-00000048', state: 'cancelled' }]);
        expect(t3.threads()).toHaveLength(1);
        expect(t3.threads()[0]?.status).toBe('interrupted');
        second.send({ type: 'close', handle: first.handle });
        expect(await second.next((line) => line['handle'] === first.handle)).toEqual({ event: 'closed', handle: first.handle });
        expect(t3.threads()[0]?.settled).toBe(true);
      });
    });

    it('keeps a place whose record it cannot read, failing what needs it with the file to look at, rather than answering gone', async () => {
      const { runtime, handle } = await opened();
      const record = path.join(t3.home, '.teamai', 'runtime-state', 't3', 'places', `${encodeURIComponent(handle)}.json`);
      fs.writeFileSync(record, '{broken');
      const unreadable = { code: 'journal_unreadable', message: expect.stringContaining(record) };

      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'alive', handle, ops: [] });
      runtime.send(prompt(handle, 'op-00000049'));
      expect(await ended(runtime, 'op-00000049')).toEqual({ op: 'op-00000049', event: 'failed', failure: unreadable });
      runtime.send({ type: 'collect', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'collect_failed', handle, failure: unreadable });
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'close_failed', handle, failure: unreadable });

      expect(fs.readFileSync(record, 'utf8')).toBe('{broken');
      expect(t3.threads()).toEqual([]);
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

  describe('a confined prompt (a judge)', () => {
    const RUN = 'r5c0de123';
    const OPEN = 'op-000000a0';
    const REPLY = { label: 'pass', reasoning: 'The diff adds the test the rubric asks for.' };
    let evidence: string;

    /** A runtime past init and an open with no view, as teamai opens a confined prompt's place, and its handle. */
    const opened = async (options: Line = {}, mode: 'attended' | 'unattended' = 'attended'): Promise<{ runtime: Connection; handle: string }> => {
      const runtime = start();
      runtime.send({ type: 'init', protocol: 1, mode, options: { environment: 'local', ...options } });
      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, confinedPrompt: true });
      runtime.send({ type: 'open', op: OPEN, run: RUN, attempt: 'a9e8d7c6', credentials: {} });
      const accepted = await runtime.next((line) => line['op'] === OPEN && line['event'] === 'accepted');
      expect(await runtime.next((line) => line['op'] === OPEN && line['event'] !== 'accepted')).toMatchObject({ event: 'ready' });

      return { runtime, handle: z.string().parse(accepted['handle']) };
    };

    // As teamai-score's judge step renders it: it names the evidence directory and the schema in it by their paths.
    const judge = (handle: string, op: string) => ({
      type: 'prompt', op, handle, env: {}, unset: [], credentials: {}, cwd: evidence,
      lease: {
        step: 'judge', tool: 'claude', model: { name: 'claude-sonnet-5-5' }, permissions: 'approval-required', interactive: false, result: path.join(dir, 'attempt', 'result.json'),
        prompt: `Judge one piece of work against a scorer's rubric. Read only the files under ${evidence}:\nthe transcript, the diff, and evidence.json.\n\nReply with JSON that matches the schema in ${path.join(evidence, 'schema.json')}, and nothing else.`,
      },
      confined: { dir: evidence, level: 'best-effort', access: 'read', schema: { type: 'object', required: ['label'] } },
    });

    const ended = (runtime: Connection, op: string): Promise<Line> => runtime.next((line) => line['op'] === op && line['event'] !== 'accepted', 20_000);

    beforeEach(() => {
      signIn(t3);
      evidence = path.join(dir, 'run', 'score', 'evidence');
      fs.mkdirSync(path.join(evidence, 'session'), { recursive: true });
      fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ skills: ['review'] }));
      fs.writeFileSync(path.join(evidence, 'diff.patch'), '+it("adds the cart test", () => {});\n');
      fs.writeFileSync(path.join(evidence, 'schema.json'), JSON.stringify({ type: 'object' }));
      fs.writeFileSync(path.join(evidence, 'session', 'transcript.jsonl'), '{"type":"user"}\n');
      t3.config({ agent: { reply: `\`\`\`json\n${JSON.stringify(REPLY)}\n\`\`\`` } });
    });

    it('judges in a fresh thread of its own on a read-only copy of the directory, and reports best-effort read access', async () => {
      const { runtime, handle } = await opened();
      const op = 'op-000000a1';

      runtime.send(judge(handle, op));

      const end = await ended(runtime, op);
      expect(RuntimeMessageSchema.safeParse(end).success).toBe(true);
      expect(end).toEqual({
        op, event: 'finished', session: { tool: 'claude', id: expect.stringMatching(/^[0-9a-f-]{36}$/) }, result: { output: REPLY },
        confined: { level: 'best-effort', access: 'read' },
      });

      const [thread] = t3.threads();
      const launch = t3.calls().find((call) => call.tool === 't3_thread_launch')?.args;
      expect(launch).toMatchObject({ scratch: true, title: `judge · teamai ${RUN}`, runtimeMode: 'auto', clientRequestId: op, modelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' } });
      expect(launch).not.toHaveProperty('projectId');
      expect(launch).not.toHaveProperty('message');
      const copy = z.string().parse(thread?.worktreePath);
      expect(copy).not.toBe(evidence);
      expect(thread).toMatchObject({ sees: ['diff.patch', 'evidence.json', 'schema.json', 'session/transcript.jsonl'], couldWrite: false, status: 'completed', settled: false });
      expect(thread?.message).toContain(`Read only the files under ${copy}:`);
      expect(thread?.message).toContain(`the schema in ${path.join(copy, 'schema.json')}`);
      expect(thread?.message).not.toContain(evidence);
      // The prompt may describe a reply of another shape, as teamai-score's names the label's own schema file.
      expect(thread?.message).toContain(`Reply with one JSON value and no other text. teamai checks it against this JSON Schema, so it decides the reply's shape: ${JSON.stringify({ type: 'object', required: ['label'] })}. Where the prompt below asks for a reply of another shape, give that value where this schema places it.`);
    });

    // teamai names the directory in the prompt exactly as it sends confined.dir, a repository path with a space included.
    it('points each mention of the directory at the copy, and leaves a sibling that shares its name', async () => {
      const spaced = path.join(dir, 'my repo', 'score', 'evidence');
      fs.cpSync(evidence, spaced, { recursive: true });
      const { runtime, handle } = await opened();
      const request = judge(handle, 'op-000000a6');

      runtime.send({
        ...request, cwd: spaced, confined: { ...request.confined, dir: spaced },
        lease: { ...request.lease, prompt: `Read only the files under ${spaced}:\nReply with JSON that matches the schema in ${path.join(spaced, 'schema.json')}, and nothing else. Ignore ${spaced}-old and ${spaced}.bak.` },
      });

      expect(await ended(runtime, 'op-000000a6')).toMatchObject({ event: 'finished' });
      const [thread] = t3.threads();
      const copy = z.string().parse(thread?.worktreePath);
      expect(thread?.message).toContain(`Read only the files under ${copy}:`);
      expect(thread?.message).toContain(`the schema in ${path.join(copy, 'schema.json')},`);
      expect(thread?.message).toContain(`Ignore ${spaced}-old and ${spaced}.bak.`);
      expect(thread?.message).not.toContain(`under ${spaced}`);
    });

    it('runs the judge\'s thread in the tighter `runtime_mode`', async () => {
      const { runtime, handle } = await opened({ runtime_mode: 'approval-required' });

      runtime.send(judge(handle, 'op-000000a2'));

      expect(await ended(runtime, 'op-000000a2')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.runtimeMode).toBe('approval-required');
    });

    // teamai collects no judge's place, so its thread is settled when the place closes.
    it('removes the copy and settles the thread when teamai closes the judge\'s place', async () => {
      const { runtime, handle } = await opened();
      runtime.send(judge(handle, 'op-000000a3'));
      expect(await ended(runtime, 'op-000000a3')).toMatchObject({ event: 'finished' });
      const copy = z.string().parse(t3.threads()[0]?.worktreePath);
      expect(fs.existsSync(copy)).toBe(true);

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['event'] === 'closed')).toEqual({ event: 'closed', handle });
      expect(fs.existsSync(copy)).toBe(false);
      expect(t3.threads()[0]?.settled).toBe(true);
      expect(fs.readdirSync(evidence).sort()).toEqual(['diff.patch', 'evidence.json', 'schema.json', 'session']);
    });

    it('keeps the judge\'s copy, its thread\'s folder, while T3 still runs a judge that failed, and removes it once close stopped the thread', async () => {
      t3.config({ agent: { waits: true }, interruptFails: true });
      const { runtime, handle } = await opened({}, 'unattended');
      runtime.send(judge(handle, 'op-000000a8'));
      expect(await ended(runtime, 'op-000000a8')).toMatchObject({ event: 'failed', failure: { code: 'tool_failed' } });
      const copy = z.string().parse(t3.threads()[0]?.worktreePath);

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'close_failed', failure: { code: 'thread_still_runs' } });
      expect(fs.existsSync(copy)).toBe(true);

      t3.config({ interruptFails: false });
      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
      expect(fs.existsSync(copy)).toBe(false);
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    it('fails a judge whose reply is not JSON, naming its thread by its link', async () => {
      t3.config({ agent: { reply: 'I think it passes.' } });
      const { runtime, handle } = await opened();

      runtime.send(judge(handle, 'op-000000a4'));

      expect(await ended(runtime, 'op-000000a4')).toEqual({
        op: 'op-000000a4', event: 'failed',
        failure: { code: 'tool_failed', message: `The T3 thread ${linkTo(t3.threads()[0]?.threadId)} ("judge · teamai r5c0de123") replied with no JSON value.` },
      });
    });

    it('fails judge_copy_failed, naming the directory, when the directory cannot be copied, and briefs no thread', async () => {
      fs.chmodSync(path.join(evidence, 'diff.patch'), 0o000);
      const { runtime, handle } = await opened();

      runtime.send(judge(handle, 'op-000000a7'));

      expect(await ended(runtime, 'op-000000a7')).toEqual({
        op: 'op-000000a7', event: 'failed',
        failure: { code: 'judge_copy_failed', message: expect.stringMatching(new RegExp(`^teamai could not copy ${evidence} into the judge thread's folder \\S+, so the judge did not start: .*EACCES`)) },
      });
      expect(t3.threads()[0]?.message).toBeUndefined();
    });

    it('reconnects to the same judge after its own restart, and copies and briefs it only once', async () => {
      const release = path.join(dir, 'release');
      t3.config({ agent: { release, reply: JSON.stringify(REPLY) } });
      const first = await opened();
      first.runtime.send(judge(first.handle, 'op-000000a5'));
      await first.runtime.next((line) => line['op'] === 'op-000000a5' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();

      const second = start();
      second.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send(judge(first.handle, 'op-000000a5'));
      fs.writeFileSync(release, '');

      expect(await ended(second, 'op-000000a5')).toMatchObject({ event: 'finished', result: { output: REPLY }, confined: { level: 'best-effort', access: 'read' } });
      expect(t3.threads()).toHaveLength(1);
      const briefs = t3.calls().filter((call) => call.tool === 't3_thread_send').map((call) => call.args['message']);
      expect(briefs).toEqual([t3.threads()[0]?.message]);
    });
  });
});
