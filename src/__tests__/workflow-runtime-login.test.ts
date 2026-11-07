import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { attemptRun, attemptSessionStore, attemptToolHome, readAttemptRuntime, seedToolHome, type AttemptRuntimeRecord } from '../workflow/runtimes/attempt.js';
import { ensureLogin, holdLogin, loginHolder, writeLoginBack } from '../workflow/runtimes/login.js';
import { OpIdSchema, type RuntimeDisplay } from '@teamai/runtime-protocol';
import { newOpId, type ExecEnd, type PromptEnd, type Reattached, type StepRuntime } from '../workflow/runtimes/step-runtime.js';
import { attemptDir, AttemptIdSchema, RunIdSchema } from '../workflow/store.js';

const RUN = RunIdSchema.parse('r0123abcd');
const FIRST = AttemptIdSchema.parse('a00000001');
const SECOND = AttemptIdSchema.parse('a00000002');

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-login-'));
  vi.stubEnv('HOME', root);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const auth = (refresh: string): string => JSON.stringify({ tokens: { account_id: 'acct-1', refresh_token: refresh } });
const dedicated = (): string => path.join(root, '.teamai', 'logins', 'codex', 'auth.json');

const plantDedicated = (refresh: string): void => {
  fs.mkdirSync(path.dirname(dedicated()), { recursive: true });
  fs.writeFileSync(dedicated(), auth(refresh), { mode: 0o600 });
};

const hold = (attempt: typeof FIRST, signal: AbortSignal) => holdLogin({
  tool: 'codex', run: RUN, attempt, toolHome: path.join(root, attempt), signal, onWait: async () => {},
});

describe('the dedicated Codex login lock', () => {
  it('lets one of two attempts that ask in the same millisecond hold the login, and the other wait', async () => {
    plantDedicated('r1');
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);

    const asked = await Promise.all([FIRST, SECOND].map(async (attempt) => ({ attempt, held: await hold(attempt, AbortSignal.timeout(1500)) })));

    const holders = asked.filter(({ held }) => held.ok);
    expect(holders).toHaveLength(1);
    expect(asked.find(({ held }) => !held.ok)?.held).toMatchObject({ ok: false, failure: { code: 'login_held' } });
    expect(await loginHolder('codex')).toMatchObject({ run: RUN, attempt: holders[0]?.attempt });
  });

  it('takes a login already written back, by a driver killed before it released the lock, as written back', async () => {
    plantDedicated('r1');
    const toolHome = path.join(root, FIRST);
    expect(await hold(FIRST, new AbortController().signal)).toEqual({ ok: true });
    fs.writeFileSync(path.join(toolHome, 'auth.json'), auth('r2'));
    fs.writeFileSync(dedicated(), auth('r2'));

    const notBack = await writeLoginBack({ tool: 'codex', run: RUN, attempt: FIRST, toolHome, collected: true });

    expect(notBack).toBeUndefined();
    expect(createHash('sha256').update(fs.readFileSync(dedicated())).digest('hex')).toBe(createHash('sha256').update(auth('r2')).digest('hex'));
  });
});

describe('an attempt a killed teamai left running on its step runtime', () => {
  const config = (): LocalConfig => ({ repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') });

  /** How many prompts the runtime of `runtimeSeeing` was sent. */
  let prompts = 0;

  /**
   * A runtime whose exec and prompt never end, and whose reattach answers `seen` in turn, then the last of them.
   * `received` settles once it was sent its exec or prompt: teamai records the operation before it sends it.
   */
  const runtimeSeeing = (seen: Array<(op: string) => Reattached>): StepRuntime & { received: Promise<void> } => {
    let asked = 0;
    let op = '';
    let receive = (): void => {};
    const received = new Promise<void>((resolve) => { receive = resolve; });
    prompts = 0;

    return {
      received,
      name: 'fake',
      init: async () => ({ ok: true, can: {}, launchesAgents: false }),
      open: async (_request, onAccepted) => {
        await onAccepted('h1');

        return { kind: 'ready', handle: 'h1' };
      },
      exec: (request) => {
        op = request.op;
        receive();

        return new Promise<ExecEnd>(() => {});
      },
      prompt: (request) => {
        op = request.op;
        prompts += 1;
        receive();

        return new Promise<PromptEnd>(() => {});
      },
      cancel: async () => {},
      collect: async () => ({ ok: true }),
      reattach: async () => (seen[Math.min(asked++, seen.length - 1)] ?? (() => ({ kind: 'gone' })))(op),
      close: async () => ({ ok: true }),
      dispose: async () => {},
    };
  };

  /** Opens the attempt and sends its exec on `runtime`, as the teamai that was killed did. */
  const leftRunning = async (runtime: ReturnType<typeof runtimeSeeing>): Promise<void> => {
    const before = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });
    expect(await before.open({ worktree: root, readonly: [], result: path.join(root, 'out'), runDir: path.join(root, 'scratch'), toolHome: {} })).toMatchObject({ ok: true });
    void before.exec({ argv: ['tool'], env: {}, unset: [], credentials: {}, cwd: root }, {});
    await runtime.received;
  };

  /** Opens the attempt and sends its prompt on `runtime`, as the teamai that was killed did. */
  const promptLeftRunning = async (runtime: ReturnType<typeof runtimeSeeing>): Promise<void> => {
    const before = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });
    expect(await before.open({ worktree: root, readonly: [], result: path.join(root, 'out'), runDir: path.join(root, 'scratch'), toolHome: {} })).toMatchObject({ ok: true });
    void resumePrompt(runtime);
    await runtime.received;
  };

  const running = (op: string): Reattached => ({ kind: 'alive', ops: [{ op: OpIdSchema.parse(op), state: 'running' }] });
  const unreachable = (): Reattached => ({ kind: 'failed', failure: { code: 'runtime_exited', message: 'gone away' } });
  const ended = (failure: { code: string; message: string }) => (op: string): Reattached => ({ kind: 'alive', ops: [{ op: OpIdSchema.parse(op), state: 'failed', failure }] });
  const cancelled = (op: string): Reattached => ({ kind: 'alive', ops: [{ op: OpIdSchema.parse(op), state: 'cancelled' }] });
  const cannotStop = { code: 'cancel_failed', message: 'The provider is down. Start it, then run teamai workflow cancel again.' };

  it('takes an operation an alive reattach no longer lists as ended: it sends no cancel and still closes the place', async () => {
    const omits = (): Reattached => ({ kind: 'alive', ops: [] });
    const cancels: string[] = [];
    const closes: string[] = [];
    const runtime = { ...runtimeSeeing([omits]), cancel: async (op) => { cancels.push(op); }, close: async (handle) => { closes.push(handle); return { ok: true }; } } satisfies StepRuntime;
    await leftRunning(runtime);
    const placed = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });

    expect(await placed.stopLeftOperation()).toBeUndefined();
    expect(await placed.close()).toBeUndefined();
    expect({ cancels, closes }).toEqual({ cancels: [], closes: ['h1'] });
    expect(await readAttemptRuntime(config(), RUN, FIRST)).toMatchObject({ phase: 'closed' });
  });

  it('takes an operation that failed with any code but cancel_failed after the cancel as ended, as the next cancel does', async () => {
    const runtime = runtimeSeeing([running, ended({ code: 'tool_failed', message: 'codex exited with status 1' })]);
    await leftRunning(runtime);

    expect(await attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).stopLeftOperation()).toBeUndefined();
  });

  const resumePrompt = (runtime: StepRuntime) => attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).prompt({
    lease: { step: 'review', tool: 'codex', prompt: 'p', result: path.join(root, 'out', 'result.json'), permissions: 'unattended', interactive: false }, env: {}, unset: [], credentials: {}, cwd: root,
  }, {});

  it('keeps the recovered agent link while a prompt reconnects and after it finishes without another display', async () => {
    const op = newOpId();
    const workspace = { label: 'Workspace', url: 'https://example.com/workspace/1' };
    const agent = { label: 'Review', url: 't3://thread/actual-agent' };
    let atReconnect: RuntimeDisplay | undefined;
    const runtime: StepRuntime = {
      ...runtimeSeeing([]),
      reattach: async () => ({ kind: 'alive', display: agent, ops: [{ op, state: 'running' }] }),
      prompt: async (request, events) => {
        expect(request.op).toBe(op);
        events.onAccepted?.({});
        atReconnect = (await readAttemptRuntime(config(), RUN, FIRST))?.display;

        return { kind: 'finished', session: { tool: 'codex', id: 'actual-agent' }, result: { output: { ok: true } } };
      },
    };
    const saved = {
      runtime: runtime.name, driver: 'd', phase: 'running', open: { op: newOpId(), handle: 'h1' }, prompt: { op }, display: workspace,
    } satisfies AttemptRuntimeRecord;
    const dir = attemptDir(config(), RUN, FIRST);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(saved));

    const end = await resumePrompt(runtime);
    const afterEnd = (await readAttemptRuntime(config(), RUN, FIRST))?.display;

    expect({ atReconnect, afterEnd, end: end.kind }).toEqual({ atReconnect: agent, afterEnd: agent, end: 'finished' });
  });

  it('stops a prompt a killed teamai left failed cancel_failed, instead of taking it as failed or sending it again', async () => {
    const runtime = runtimeSeeing([ended(cannotStop), cancelled]);
    await promptLeftRunning(runtime);

    expect(await resumePrompt(runtime)).toEqual({ kind: 'cancelled' });
    expect(prompts).toBe(1);
  });

  it('ends a prompt a killed teamai left failed cancel_failed as lost while its runtime still cannot stop it', async () => {
    const runtime = runtimeSeeing([ended(cannotStop)]);
    await promptLeftRunning(runtime);

    expect(await resumePrompt(runtime)).toMatchObject({ kind: 'lost', failure: { code: 'cancel_failed', message: expect.stringContaining(cannotStop.message) } });
  });

  it('ends its wait for the stop 15 s after the cancel, even when a reattach sent just before then answers late', async () => {
    const base = runtimeSeeing([running]);
    let op = '';
    let slowFrom = Number.POSITIVE_INFINITY;
    let askedToCancel: () => void = () => {};
    let letCancel: () => void = () => {};
    const cancelAsked = new Promise<void>((resolve) => { askedToCancel = resolve; });
    const cancelLet = new Promise<void>((resolve) => { letCancel = resolve; });
    // Its reattach answers at once until just before the 15 s, then takes as long as a runtime may take to answer one.
    const runtime = {
      ...base,
      exec: (request, events) => {
        op = request.op;

        return base.exec(request, events);
      },
      cancel: async () => {
        askedToCancel();
        await cancelLet;
      },
      reattach: async () => (Date.now() < slowFrom ? running(op) : new Promise<Reattached>((resolve) => setTimeout(() => resolve(running(op)), 15_000))),
    } satisfies StepRuntime;
    await leftRunning(runtime);
    const stopped = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).stopLeftOperation();
    await cancelAsked;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    try {
      slowFrom = Date.now() + 14_900;
      letCancel();
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await Promise.race([stopped, 'still waiting'])).toEqual({ code: 'runtime_unanswered', message: `Step runtime "fake" still reported operation ${op} of attempt ${FIRST} running 15 s after teamai asked it to cancel it.` });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not taken as stopped when its runtime cannot be asked after the cancel', async () => {
    const runtime = runtimeSeeing([unreachable]);
    await leftRunning(runtime);

    expect(await attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).stopLeftOperation()).toEqual({ code: 'runtime_exited', message: 'gone away' });
  });

  it('ends a restarted exec whose old run the runtime cannot show stopped as lost, instead of reporting it interrupted', async () => {
    const runtime = runtimeSeeing([running, unreachable]);
    await leftRunning(runtime);

    const end = await attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).exec({ argv: ['tool'], env: {}, unset: [], credentials: {}, cwd: root }, {});

    expect(end).toMatchObject({ kind: 'lost' });
  });
});

describe('a tool home seeded from the attempt whose session a step resumes', () => {
  it('copies the session, never the login teamai copied into that home under its lock', async () => {
    const config: LocalConfig = { repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
    const session = '019a0000-0000-7000-8000-000000000001';
    const home = attemptToolHome(config, RUN, FIRST, 'codex');
    const day = path.join(home, 'sessions', '2026', '11', '04');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, `rollout-2026-11-04T10-00-00-${session}.jsonl`), `${JSON.stringify({ timestamp: '2026-11-04T10:00:01.000Z', type: 'session_meta', payload: { id: session, timestamp: '2026-11-04T10:00:00.000Z', cwd: root, originator: 'codex_cli_rs', cli_version: '0.163.0' } })}\n`);
    fs.writeFileSync(path.join(home, 'auth.json'), auth('r2'));
    fs.writeFileSync(path.join(attemptDir(config, RUN, FIRST), 'runtime.json'), JSON.stringify({ runtime: 'toy', driver: 'd', phase: 'closed', open: { op: newOpId(), handle: 'h1' }, toolHome: { tool: 'codex', dir: home } }));

    const seeded = await seedToolHome({ config, run: RUN, attempt: SECOND, tool: 'codex', sessions: [{ tool: 'codex', id: session }] });

    const next = attemptToolHome(config, RUN, SECOND, 'codex');
    expect(seeded).toEqual({ tool: 'codex', id: session });
    expect(fs.existsSync(path.join(next, 'sessions', '2026', '11', '04', `rollout-2026-11-04T10-00-00-${session}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(next, 'auth.json'))).toBe(false);
  });
});

describe('the session store of an attempt whose runtime reported where it kept the session', () => {
  it('reads a Codex session in the home the runtime reported, such as a daemon\'s under another HOME, not in the member\'s own', async () => {
    const config: LocalConfig = { repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
    const reported = path.join(root, 'daemon-home', '.codex');
    fs.mkdirSync(attemptDir(config, RUN, FIRST), { recursive: true });
    fs.writeFileSync(path.join(attemptDir(config, RUN, FIRST), 'runtime.json'), JSON.stringify({ runtime: 'paseo', driver: 'd', phase: 'closed', open: { op: newOpId(), handle: 'h1' }, sessionHome: { tool: 'codex', dir: reported } }));

    expect(await attemptSessionStore(config, RUN, FIRST)).toBe(path.join(reported, 'sessions'));
  });
});

describe('the first login of a tool teamai keeps one for', () => {
  it('runs the tool\'s login once for steps that ask for it at the same time', async () => {
    const bin = path.join(root, 'bin');
    const logins = path.join(root, 'logins.txt');
    fs.mkdirSync(bin);
    // A codex whose login takes a moment, writes the login file, and counts how often it ran.
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\necho login >> "${logins}"\nsleep 0.2\nmkdir -p "$CODEX_HOME"\necho '{}' > "$CODEX_HOME/auth.json"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const ended = await Promise.all([
      ensureLogin('codex', { step: { run: RUN, id: 'left' }, canAsk: true }),
      ensureLogin('codex', { step: { run: RUN, id: 'right' }, canAsk: true }),
    ]);

    expect(ended).toEqual([undefined, undefined]);
    expect(fs.readFileSync(logins, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('the session store of an OpenCode prompt on a runtime that launches agents', () => {
  const config = (): LocalConfig => ({ repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') });

  /** A runtime whose prompt finishes an OpenCode session with `home`, or none. */
  const finishing = (home: string | undefined): StepRuntime => ({
    name: 'agents',
    init: async () => ({ ok: true, can: {}, launchesAgents: true }),
    open: async (_request, onAccepted) => {
      await onAccepted('h1');

      return { kind: 'ready', handle: 'h1' };
    },
    exec: () => new Promise<ExecEnd>(() => {}),
    prompt: async (_request, events) => {
      events.onAccepted?.({});

      return { kind: 'finished', session: { tool: 'opencode', id: 'ses_1', ...(home === undefined ? {} : { home }) }, result: { output: { ok: true } } };
    },
    cancel: async () => {},
    collect: async () => ({ ok: true }),
    reattach: async () => ({ kind: 'gone' }),
    close: async () => ({ ok: true }),
    dispose: async () => {},
  });

  const promptOn = async (runtime: StepRuntime): Promise<void> => {
    const run = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });
    expect(await run.open(undefined, { tool: 'opencode' })).toMatchObject({ ok: true });
    expect(await run.prompt({
      lease: { step: 'review', tool: 'opencode', prompt: 'p', result: path.join(root, 'out', 'result.json'), permissions: 'unattended', interactive: false }, env: {}, unset: [], credentials: {}, cwd: root,
    }, {})).toMatchObject({ kind: 'finished' });
  };

  it('reads an OpenCode session in the data home its runtime reported, where OpenCode keeps it under opencode/', async () => {
    const reported = path.join(root, 'daemon-home', '.local', 'share');
    await promptOn(finishing(reported));

    expect(await attemptSessionStore(config(), RUN, FIRST)).toBe(path.join(reported, 'opencode'));
  });

  it('reads an OpenCode session whose runtime named no home in the data home under $HOME, not in its config home', async () => {
    await promptOn(finishing(undefined));

    expect(await attemptSessionStore(config(), RUN, FIRST)).toBe(path.join(root, '.local', 'share', 'opencode'));
  });
});

describe('a place a restarted teamai opens again', () => {
  const config = (): LocalConfig => ({ repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') });

  it('keeps the handle it recorded while a place made in steps is opened again, so a failed reopen still names the whole place', async () => {
    const whole = JSON.stringify({ outer: 'box-1', inner: 'app-1' });
    const recorded = { runtime: 'app through box', driver: 'd', phase: 'running', open: { op: newOpId(), handle: whole }, prompt: { op: newOpId() } } satisfies AttemptRuntimeRecord;
    fs.mkdirSync(attemptDir(config(), RUN, FIRST), { recursive: true });
    fs.writeFileSync(path.join(attemptDir(config(), RUN, FIRST), 'runtime.json'), JSON.stringify(recorded));
    // The outer accepts again; the inner's open then fails, as one that timed out.
    const runtime: StepRuntime = {
      name: 'app through box',
      init: async () => ({ ok: true, can: {}, launchesAgents: true }),
      open: async (_request, onAccepted) => {
        await onAccepted(JSON.stringify({ outer: 'box-1' }));

        return { kind: 'failed', failure: { code: 'runtime_unanswered', message: 'the inner did not answer' } };
      },
      exec: () => new Promise<ExecEnd>(() => {}),
      prompt: () => new Promise<PromptEnd>(() => {}),
      cancel: async () => {},
      collect: async () => ({ ok: true }),
      reattach: async () => ({ kind: 'gone' }),
      close: async () => ({ ok: true }),
      dispose: async () => {},
    };

    expect(await attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).open(undefined)).toMatchObject({ ok: false });
    expect((await readAttemptRuntime(config(), RUN, FIRST))?.open.handle).toBe(whole);
  });
});
