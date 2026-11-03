import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localStepRuntime } from '../workflow/runtimes/local.js';
import { stdioStepRuntime } from '../workflow/runtimes/stdio.js';
import { newOpId, type ExecEnd, type ExecRequest, type OpenRequest, type RuntimeOptions, type StepRuntime } from '../workflow/runtimes/step-runtime.js';
import type { JsonValue } from '../types.js';
import { TOY_RUNTIME } from './helpers/toy-runtime.js';

/**
 * One scenario suite every step runtime passes, through the `StepRuntime` interface alone. `retains` says whether the
 * runtime keeps outcomes across a restart of its own process, which `local`, in teamai's process, cannot.
 */
interface Subject {
  name: string;
  /** A runtime over `state`, which a restarted runtime of the same subject reads again. */
  start(state: string): StepRuntime;
  options(state: string): RuntimeOptions;
  retains: boolean;
}

const SUBJECTS: Subject[] = [
  {
    name: 'toy over stdio',
    start: () => stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] }),
    options: (state) => ({ state }),
    retains: true,
  },
  { name: 'local', start: () => localStepRuntime(), options: () => ({}), retains: false },
];

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return check();
}

describe.each(SUBJECTS)('StepRuntime scenarios: $name', (subject) => {
  let dir: string;
  let worktree: string;
  let state: string;
  const started: StepRuntime[] = [];

  const start = async (): Promise<StepRuntime> => {
    const runtime = subject.start(state);
    started.push(runtime);
    const ready = await runtime.init({ options: subject.options(state), mode: 'unattended' });
    expect(ready).toMatchObject({ ok: true });

    return runtime;
  };

  const openRequest = (op = newOpId()): OpenRequest => ({
    op, run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
    view: { worktree, readonly: [], result: path.join(dir, 'out'), toolHome: {} },
  });

  const execRequest = (handle: string, argv: string[], op = newOpId()): ExecRequest => ({ op, handle, argv, env: { STEP_VALUE: 'from-teamai' }, unset: [], cwd: worktree });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-runtime-'));
    worktree = path.join(dir, 'worktree');
    state = path.join(dir, 'state');
    fs.mkdirSync(worktree);
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails init on an option it does not take, naming the key', async () => {
    const runtime = subject.start(state);
    started.push(runtime);

    expect(await runtime.init({ options: { ...subject.options(state), imgae: 'x' }, mode: 'unattended' }))
      .toMatchObject({ ok: false, failure: { code: 'bad_option', key: 'imgae' } });
  });

  it('accepts an open with a handle, then reports it ready, and a repeated open returns the same handle', async () => {
    const runtime = await start();
    const accepted: string[] = [];
    const request = openRequest();
    const opened = await runtime.open(request, async (handle) => { accepted.push(handle); });

    expect(opened.kind).toBe('ready');
    if (opened.kind !== 'ready') return;
    expect(accepted).toEqual([opened.handle]);
    expect(await runtime.open(request, async () => {})).toEqual(opened);
    // A new operation for the same run and attempt opens no second place.
    expect(await runtime.open(openRequest(), async () => {})).toEqual(opened);
  });

  it('accepts an exec, streams its output, and ends with its exit code and complete stdout, in the step env', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const output: string[] = [];
    let accepted = false;

    const end = await runtime.exec(execRequest(opened.handle, [process.execPath, '-e', 'process.stdout.write(`${process.env.STEP_VALUE}\\n`); process.exitCode = 3']), {
      onAccepted: () => { accepted = true; },
      onOutput: (stream, data) => { if (stream === 'stdout') output.push(data); },
    });

    expect(accepted).toBe(true);
    expect(end).toEqual({ kind: 'exited', code: 3, stdout: 'from-teamai\n' });
    expect(output.join('')).toBe('from-teamai\n');
  });

  it('keeps names the exec unsets out of its process', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    process.env.TEAMAI_SCENARIO_WITHHELD = 'secret';

    try {
      const end = await runtime.exec({ ...execRequest(opened.handle, [process.execPath, '-e', 'process.stdout.write(String(process.env.TEAMAI_SCENARIO_WITHHELD))']), unset: ['TEAMAI_SCENARIO_WITHHELD'] }, {});

      expect(end).toEqual({ kind: 'exited', code: 0, stdout: 'undefined' });
    } finally {
      delete process.env.TEAMAI_SCENARIO_WITHHELD;
    }
  });

  it('answers a repeated exec id with the same outcome without running it again', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, [process.execPath, '-e', 'require("fs").appendFileSync("runs", "x"); process.stdout.write("once")']);
    const first = await runtime.exec(request, {});

    expect(await runtime.exec(request, {})).toEqual(first);
    expect(fs.readFileSync(path.join(worktree, 'runs'), 'utf8')).toBe('x');
  });

  it('collects a failed exec and leaves its work in the place', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const end = await runtime.exec(execRequest(opened.handle, [process.execPath, '-e', 'require("fs").writeFileSync("work.txt", "kept"); process.exit(1)']), {});

    expect(end).toMatchObject({ kind: 'exited', code: 1 });
    expect(await runtime.collect(opened.handle)).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(worktree, 'work.txt'), 'utf8')).toBe('kept');
  });

  it('cancels a running exec with the processes it started', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, ['/bin/sh', '-c', 'sleep 30 & echo $! > child.pid; wait']);
    const ending = runtime.exec(request, {});
    const pidFile = path.join(worktree, 'child.pid');
    expect(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true);
    const child = Number(fs.readFileSync(pidFile, 'utf8').trim());

    await runtime.cancel(request.op);

    expect(await ending).toEqual<ExecEnd>({ kind: 'cancelled' });
    expect(await until(() => !pidAlive(child))).toBe(true);
  });

  it('answers gone for a handle it never opened, and after close', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');

    expect(await runtime.reattach('never-opened')).toEqual({ kind: 'gone' });
    await runtime.close(opened.handle);
    expect(await runtime.reattach(opened.handle)).toEqual({ kind: 'gone' });
  });

  it.runIf(subject.retains)('reattaches after its own restart with a finished exec and its complete stdout', async () => {
    const first = await start();
    const opened = await first.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, [process.execPath, '-e', 'process.stdout.write("retained")']);
    await first.exec(request, {});
    await first.dispose();
    const second = await start();

    expect(await second.reattach(opened.handle)).toEqual({ kind: 'alive', ops: [{ op: request.op, state: 'exited', code: 0, stdout: 'retained' }] });
    expect(await second.exec(request, {})).toEqual({ kind: 'exited', code: 0, stdout: 'retained' });
  });

  it.runIf(subject.retains)('finishes an exec its own restart left running, so reattach reads it running, and cancel stops it', async () => {
    const first = await start();
    const opened = await first.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, ['/bin/sh', '-c', 'echo $$ > shell.pid; sleep 30']);
    void first.exec(request, {});
    const pidFile = path.join(worktree, 'shell.pid');
    expect(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true);
    const shell = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await first.dispose();
    const second = await start();

    expect(await second.reattach(opened.handle)).toEqual({ kind: 'alive', ops: [{ op: request.op, state: 'running' }] });
    await second.cancel(request.op);
    expect(await until(() => !pidAlive(shell))).toBe(true);
    // The operation ends cancelled once no process of it is left, which the runtime may record after the shell is gone.
    let settled: unknown;
    expect(await until(async () => {
      const reattached = await second.reattach(opened.handle);
      settled = reattached;
      return reattached.kind !== 'alive' || reattached.ops.some((op) => op.state !== 'running');
    })).toBe(true);
    expect(settled).toEqual({ kind: 'alive', ops: [{ op: request.op, state: 'cancelled' }] });
  });
});

describe('a runtime\'s display over stdio', () => {
  let dir: string;
  const started: StepRuntime[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-display-'));
    fs.mkdirSync(path.join(dir, 'worktree'));
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const openWith = async (display: JsonValue) => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ options: { state: path.join(dir, 'state'), display }, mode: 'unattended' })).toMatchObject({ ok: true });
    const opened = await runtime.open({
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
      view: { worktree: path.join(dir, 'worktree'), readonly: [], result: path.join(dir, 'out'), toolHome: {} },
    }, async () => {});

    return { runtime, opened };
  };

  it('carries the display a runtime gives when it opens and when it is reattached', async () => {
    const display = { label: 'teamai-r7-a1 (sbx)', url: 't3://thread/7', fields: { sandbox: 'teamai-r7-a1', image: 'teamai-warm:3f9c' } };
    const { runtime, opened } = await openWith(display);

    expect(opened).toEqual({ kind: 'ready', handle: 'toy-r0123abcd-a0123abcd', display });
    expect(await runtime.reattach('toy-r0123abcd-a0123abcd')).toEqual({ kind: 'alive', ops: [], display });
  });

  it.each([
    ['a label over 80 characters', { label: 'x'.repeat(81) }],
    ['a script link', { label: 'sandbox', url: 'javascript:alert(1)' }],
    ['more than 8 fields', { label: 'sandbox', fields: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, 'v'])) }],
    ['a field that is not a string', { label: 'sandbox', fields: { cpus: 4 } }],
    ['a path in the member\'s home', { label: 'sandbox', fields: { dir: path.join(os.homedir(), 'work') } }],
  ])('opens without a display that has %s', async (_, display) => {
    const { opened } = await openWith(display);

    expect(opened).toEqual({ kind: 'ready', handle: 'toy-r0123abcd-a0123abcd' });
  });

  it('opens without a display that names a path in a Windows home', async () => {
    vi.stubEnv('HOME', 'C:\\Users\\me');

    try {
      const { opened } = await openWith({ label: 'sandbox', fields: { dir: 'C:\\Users\\me\\work' } });

      expect(opened).toEqual({ kind: 'ready', handle: 'toy-r0123abcd-a0123abcd' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
