import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { attemptRun, attemptToolHome, seedToolHome } from '../workflow/runtimes/attempt.js';
import { holdLogin, loginHolder, writeLoginBack } from '../workflow/runtimes/login.js';
import { OpIdSchema } from '@teamai/runtime-protocol';
import { newOpId, type ExecEnd, type Reattached, type StepRuntime } from '../workflow/runtimes/step-runtime.js';
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

  /** A runtime whose exec never ends, and whose reattach answers `seen` in turn, then the last of them. */
  const runtimeSeeing = (seen: Array<(op: string) => Reattached>): StepRuntime => {
    let asked = 0;
    let op = '';

    return {
      name: 'fake',
      init: async () => ({ ok: true, can: {}, launchesAgents: false }),
      open: async (_request, onAccepted) => {
        await onAccepted('h1');

        return { kind: 'ready', handle: 'h1' };
      },
      exec: (request) => {
        op = request.op;

        return new Promise<ExecEnd>(() => {});
      },
      prompt: async () => ({ kind: 'failed', failure: { code: 'prompt_unsupported', message: 'execs only' } }),
      cancel: async () => {},
      collect: async () => ({ ok: true }),
      reattach: async () => (seen[Math.min(asked++, seen.length - 1)] ?? (() => ({ kind: 'gone' })))(op),
      close: async () => ({ ok: true }),
      dispose: async () => {},
    };
  };

  /** Opens the attempt and sends its exec on `runtime`, as the teamai that was killed did. */
  const leftRunning = async (runtime: StepRuntime): Promise<void> => {
    const before = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });
    expect(await before.open({ worktree: root, readonly: [], result: path.join(root, 'out'), runDir: path.join(root, 'scratch'), toolHome: {} })).toMatchObject({ ok: true });
    void before.exec({ argv: ['tool'], env: {}, unset: [], credentials: {}, cwd: root }, {});
    await vi.waitFor(() => expect(fs.readFileSync(path.join(attemptDir(config(), RUN, FIRST), 'runtime.json'), 'utf8')).toContain('"exec"'));
  };

  const running = (op: string): Reattached => ({ kind: 'alive', ops: [{ op: OpIdSchema.parse(op), state: 'running' }] });
  const unreachable = (): Reattached => ({ kind: 'failed', failure: { code: 'runtime_exited', message: 'gone away' } });

  it('is not taken as stopped when its runtime cannot be asked after the cancel', async () => {
    const runtime = runtimeSeeing([unreachable]);
    await leftRunning(runtime);

    expect(await attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).stopLeftOperation()).toBe(false);
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
