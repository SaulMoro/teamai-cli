import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../utils/logger.js';
import { localStepRuntime } from '../workflow/runtimes/local.js';
import { stdioStepRuntime } from '../workflow/runtimes/stdio.js';
import { composedStepRuntime } from '../workflow/runtimes/composed.js';
import type { OpState, RuntimeDisplay, RuntimeFailure, RuntimeOptions } from '@teamai/runtime-protocol';
import { newOpId, type ExecEnd, type ExecRequest, type OpenRequest, type PromptRequest, type StepRuntime } from '../workflow/runtimes/step-runtime.js';
import type { JsonValue } from '../types.js';
import { sandboxOnFake } from './helpers/sandbox-runtime.js';
import { t3OnFakeServer } from './helpers/t3-runtime.js';
import { paseoOnFakeDaemon } from './helpers/paseo-runtime.js';
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
  /** The display the runtime gives for the suite's attempt when it is reattached, if it gives one. */
  display?: RuntimeDisplay;
  /** The directories the runtime keeps its records of `state` in, when it keeps any. */
  journal?(state: string): string[];
  /**
   * How the runtime still answers an op whose end it cannot journal (`<kind> <failure code>`), where that is not its true
   * end: the scenario then checks that answer, as the record of a gap the runtime's owner closes by removing this.
   * fails, as the record of a gap the runtime's owner closes.
   */
  unjournaledEnd?: string;
}

const [docker, sbx] = await Promise.all([sandboxOnFake('docker'), sandboxOnFake('sbx')]);

const SUBJECTS: Subject[] = [
  {
    name: 'toy over stdio',
    start: () => stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] }),
    options: (state) => ({ state }),
    retains: true,
    journal: (state) => [path.join(state, 'ops')],
  },
  {
    name: 'toy through toy over stdio',
    start: () => composedStepRuntime({
      outer: stdioStepRuntime({ name: 'outertoy', command: process.execPath, args: [TOY_RUNTIME] }),
      inner: stdioStepRuntime({ name: 'innertoy', command: process.execPath, args: [TOY_RUNTIME] }),
      innerCredentials: {},
    }),
    options: (state) => ({ outertoy: { state: path.join(state, 'outer') }, innertoy: { state: path.join(state, 'inner') } }),
    retains: true,
    journal: (state) => [path.join(state, 'outer', 'ops'), path.join(state, 'inner', 'ops')],
  },
  { name: 'local', start: () => localStepRuntime(), options: () => ({}), retains: false },
  {
    name: 'sandbox on a fake docker',
    start: (state) => stdioStepRuntime({ name: 'sandbox', command: docker.command, args: docker.args(state) }),
    options: () => docker.options,
    retains: true,
    journal: (state) => [path.join(state, 'home', '.teamai', 'runtime-state', 'sandbox')],
    unjournaledEnd: 'failed runtime_failed',
    display: { label: 'teamai-r0123abcd-a0123abcd (docker)', fields: { container: 'teamai-r0123abcd-a0123abcd', image: 'scenario/agent:1' } },
  },
  {
    name: 'sandbox on a fake sbx',
    start: (state) => stdioStepRuntime({ name: 'sandbox', command: sbx.command, args: sbx.args(state) }),
    options: () => sbx.options,
    retains: true,
    journal: (state) => [path.join(state, 'home', '.teamai', 'runtime-state', 'sandbox')],
    unjournaledEnd: 'failed runtime_failed',
    // An sbx sandbox's name starts with its journal's id, which follows the subject's HOME.
    display: { label: expect.stringMatching(/^teamai-[0-9a-f]{16}-r0123abcd-a0123abcd \(sbx\)$/), fields: { sandbox: expect.stringMatching(/^teamai-[0-9a-f]{16}-r0123abcd-a0123abcd$/), agent: 'claude' } },
  },
];

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

/** Sets the mode of `root` and of every directory under it: 0o500 keeps a runtime from writing a record there. */
function setDirModes(root: string, mode: number): void {
  if (!fs.existsSync(root)) return;
  fs.chmodSync(root, mode);

  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) fs.chmodSync(path.join(entry.parentPath, entry.name), mode);
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
  const alive = (ops: OpState[]) => ({ kind: 'alive', ops, ...(subject.display && { display: subject.display }) });
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
    view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
  });

  const execRequest = (handle: string, argv: string[], op = newOpId()): ExecRequest => ({ op, handle, argv, env: { STEP_VALUE: 'from-teamai' }, unset: [], credentials: {}, cwd: worktree });

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

  it('answers an open id repeated before it settles with the same handle, persisted for each caller', async () => {
    const runtime = await start();
    const accepted: string[] = [];
    const request = openRequest();
    const persist = async (handle: string): Promise<void> => { accepted.push(handle); };
    const [first, repeated] = await Promise.all([runtime.open(request, persist), runtime.open(request, persist)]);

    expect(first.kind).toBe('ready');
    expect(repeated).toEqual(first);
    if (first.kind !== 'ready') return;
    expect(accepted).toEqual([first.handle, first.handle]);
  });

  it('fails the open with the error that kept it from persisting the handle', async () => {
    const runtime = await start();

    await expect(runtime.open(openRequest(), async () => { throw new Error('the run record could not be written'); }))
      .rejects.toThrow('the run record could not be written');
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

  // Protocol 1 bounds the stdout an `exited` carries; the step still gets all of it, from the stream.
  it('ends an exec that prints more than 64 KiB with its whole stdout', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');

    const end = await runtime.exec(execRequest(opened.handle, [process.execPath, '-e', 'process.stdout.write("start" + "x".repeat(100000) + "end")']), {});

    expect(end).toEqual({ kind: 'exited', code: 0, stdout: `start${'x'.repeat(100_000)}end` });
  });

  it('sets the credentials an exec brings over its process\'s environment', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');

    const end = await runtime.exec({ ...execRequest(opened.handle, [process.execPath, '-e', 'process.stdout.write(String(process.env.SCENARIO_TOKEN))']), credentials: { SCENARIO_TOKEN: 'scenario-value' } }, {});

    expect(end).toEqual({ kind: 'exited', code: 0, stdout: 'scenario-value' });
  });

  it('keeps names the exec unsets out of its process', async () => {
    // Set before the runtime starts, so a runtime in a process of its own inherits the name it has to remove.
    process.env.TEAMAI_SCENARIO_WITHHELD = 'secret';

    try {
      const runtime = await start();
      const opened = await runtime.open(openRequest(), async () => {});
      if (opened.kind !== 'ready') throw new Error('not opened');
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

  it('answers an exec id repeated while it runs with the same acceptance and outcome, running it once', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, [process.execPath, '-e', 'require("fs").appendFileSync("runs", "x"); setTimeout(() => process.stdout.write("once"), 300)']);
    let accepted = 0;
    const events = { onAccepted: () => { accepted += 1; } };
    const first = runtime.exec(request, events);
    expect(await until(() => fs.existsSync(path.join(worktree, 'runs')))).toBe(true);
    const repeated = runtime.exec(request, events);

    expect(await Promise.all([first, repeated])).toEqual([{ kind: 'exited', code: 0, stdout: 'once' }, { kind: 'exited', code: 0, stdout: 'once' }]);
    expect(accepted).toBe(2);
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
    expect(await runtime.close(opened.handle)).toEqual({ ok: true });
    expect(await runtime.reattach(opened.handle)).toEqual({ kind: 'gone' });
  });

  it('answers closed to a close of a handle it already closed', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');

    expect(await runtime.close(opened.handle)).toEqual({ ok: true });
    expect(await runtime.close(opened.handle)).toEqual({ ok: true });
  });

  // A runtime answers the true end of an op whose end it cannot journal, since teamai keeps that end as soon as it reads
  // it, and remembers it for reattach until the place closes.
  it.runIf(subject.journal !== undefined)(subject.unjournaledEnd === undefined ? 'answers the true end of an exec whose end it cannot journal, says so, and reports it on reattach until close' : `still answers an exec whose end it cannot journal with ${subject.unjournaledEnd}, not its true end`, async () => {
    const warned = vi.spyOn(log, 'warn');
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, ['/bin/sh', '-c', 'echo started; while [ ! -f release ]; do sleep 0.05; done; echo done']);
    let isRunning = false;
    const ended = runtime.exec(request, { onOutput: (stream, data) => { if (stream === 'stdout' && data.includes('started')) isRunning = true; } });
    expect(await until(() => isRunning)).toBe(true);
    const journal = subject.journal?.(state) ?? [];

    try {
      for (const root of journal) setDirModes(root, 0o500);
      fs.writeFileSync(path.join(worktree, 'release'), '');

      const end = await ended;

      if (subject.unjournaledEnd !== undefined) {
        expect(end.kind === 'failed' ? `failed ${end.failure.code}` : end.kind).toBe(subject.unjournaledEnd);

        return;
      }

      expect(end).toEqual({ kind: 'exited', code: 0, stdout: 'started\ndone\n' });
      expect(warned).toHaveBeenCalledWith(expect.stringContaining(`operation ${request.op}`));
      expect(await runtime.reattach(opened.handle)).toEqual(alive([{ op: request.op, state: 'exited', code: 0, stdout: 'started\ndone\n' }]));
    } finally {
      for (const root of journal) setDirModes(root, 0o700);
    }
  });

  it.runIf(subject.retains)('reattaches after its own restart with a finished exec and its complete stdout', async () => {
    const first = await start();
    const opened = await first.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, [process.execPath, '-e', 'process.stdout.write("retained")']);
    await first.exec(request, {});
    await first.dispose();
    const second = await start();

    expect(await second.reattach(opened.handle)).toEqual(alive([{ op: request.op, state: 'exited', code: 0, stdout: 'retained' }]));
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

    expect(await second.reattach(opened.handle)).toEqual(alive([{ op: request.op, state: 'running' }]));
    await second.cancel(request.op);
    expect(await until(() => !pidAlive(shell))).toBe(true);
    // The operation ends cancelled once no process of it is left, which the runtime may record after the shell is gone.
    let settled: unknown;
    expect(await until(async () => {
      const reattached = await second.reattach(opened.handle);
      settled = reattached;
      return reattached.kind !== 'alive' || reattached.ops.some((op) => op.state !== 'running');
    })).toBe(true);
    expect(settled).toEqual(alive([{ op: request.op, state: 'cancelled' }]));
  });

  it.runIf(subject.retains)('does not run again an exec id its own restart left running, and ends it when cancelled', async () => {
    const first = await start();
    const opened = await first.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, ['/bin/sh', '-c', 'echo x >> runs; sleep 30']);
    void first.exec(request, {});
    const runs = path.join(worktree, 'runs');
    expect(await until(() => fs.existsSync(runs))).toBe(true);
    await first.dispose();
    const second = await start();
    let accepted = false;
    const ending = second.exec(request, { onAccepted: () => { accepted = true; } });
    expect(await until(() => accepted)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(fs.readFileSync(runs, 'utf8')).toBe('x\n');
    await second.cancel(request.op);
    expect(await ending).toEqual<ExecEnd>({ kind: 'cancelled' });
  });

  it.runIf(subject.retains)('ends an exec id its own restart left running with the outcome that exec recorded', async () => {
    const first = await start();
    const opened = await first.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, [process.execPath, '-e', 'require("fs").writeFileSync("started", ""); setTimeout(() => process.stdout.write("finished"), 3000)']);
    void first.exec(request, {});
    expect(await until(() => fs.existsSync(path.join(worktree, 'started')))).toBe(true);
    // The exec outlasts the wait dispose gives the runtime to exit, so the second runtime gets it still running.
    await first.dispose();
    const second = await start();

    expect(await second.reattach(opened.handle)).toEqual(alive([{ op: request.op, state: 'running' }]));
    expect(await second.exec(request, {})).toEqual<ExecEnd>({ kind: 'exited', code: 0, stdout: 'finished' });
  });
});

/**
 * The scenario suite of a runtime that launches agents its own way (T3, Paseo): it offers `prompt` and no `exec`, and
 * each prompt step reaches it as one `prompt` that ends finished, failed or cancelled. `agent` sets how the subject's
 * agent behaves: how long it works, the output it writes, or the failure it ends with.
 */
interface PromptSubject {
  name: string;
  start(state: string): StepRuntime;
  options(state: string, agent: JsonValue): RuntimeOptions;
  /** The display the runtime gives for the suite's attempt when it is reattached, if it gives one. */
  display?: RuntimeDisplay;
  /** Whether a finished prompt carries the tokens the agent billed; absent: it does. */
  reportsUsage?: false;
  /** The failure a prompt ends with when its agent fails with `failure`; absent: that failure as it is. */
  failure?(failure: RuntimeFailure): RuntimeFailure;
  /** The directories the runtime keeps its records of `state` in. */
  journal(state: string): string[];
  /** How the runtime still answers a prompt whose end it cannot journal (`<kind> <failure code>`), where that is not its true end. */
  unjournaledEnd?: string;
}

const T3 = await t3OnFakeServer();
const paseo = await paseoOnFakeDaemon();

const PROMPT_SUBJECTS: PromptSubject[] = [
  {
    name: 'toy over stdio, prompt only',
    start: () => stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] }),
    options: (state, agent) => ({ state, agent }),
    journal: (state) => [path.join(state, 'ops')],
  },
  {
    name: 't3 over stdio, on a fake T3 Code server',
    start: (state) => {
      const runtime = stdioStepRuntime({ name: 't3', command: T3.command, args: T3.args(state) });

      return { ...runtime, init: async (input) => { await T3.ready(state); return runtime.init(input); } };
    },
    options: (state, agent) => T3.options(state, agent),
    display: {
      label: 'review · teamai r0123abcd', url: expect.stringMatching(/^t3code:\/\/threads\/env-fake-1\/mcp%3Alaunch%3A[0-9a-f]+$/),
      fields: { thread: expect.stringMatching(/^mcp:launch:[0-9a-f]+$/), model: 'claude-opus-5-5', environment: 'fake-laptop' },
    },
    // T3 reports no usage, and a thread whose run fails names T3's status, not the agent's own failure.
    reportsUsage: false,
    failure: () => ({ code: 'tool_failed', message: expect.stringContaining('ended failed before the step was done.') }),
    journal: (state) => [path.join(state, 'home', '.teamai', 'runtime-state', 't3')],
  },
  {
    name: 'paseo over stdio, on a fake Paseo daemon',
    start: (state) => stdioStepRuntime({ name: 'paseo', command: '/usr/bin/env', args: paseo.args(state) }),
    // The toy's agent, as the fake daemon's: a model it cannot run is one the daemon does not offer.
    options: (_, agent) => {
      const { fail, usage: _usage, ...behaviour } = typeof agent === 'object' && agent !== null && !Array.isArray(agent) ? agent : {};
      paseo.behave({ ...behaviour, ...(fail !== undefined && { models: { claude: ['claude-sonnet-5-5'] } }) });

      return { url: paseo.url };
    },
    display: expect.objectContaining({ label: 'teamai review · r0123abcd', url: expect.stringMatching(/^paseo:\/\/h\/srv_fake0001\/agent\//) }),
    reportsUsage: false,
    failure: (failure) => ({ ...failure, message: `The Paseo daemon at ${paseo.url} has no claude model claude-opus-5-5. It offers: claude-sonnet-5-5.` }),
    journal: (state) => [path.join(state, 'home', '.teamai', 'runtime-state', 'paseo')],
  },
];

describe.each(PROMPT_SUBJECTS)('StepRuntime prompt scenarios: $name', (subject) => {
  const alive = (ops: OpState[]) => ({ kind: 'alive', ops, ...(subject.display && { display: subject.display }) });
  let dir: string;
  let worktree: string;
  let state: string;
  const started: StepRuntime[] = [];

  const start = async (agent: JsonValue = {}): Promise<StepRuntime> => {
    const runtime = subject.start(state);
    started.push(runtime);
    const ready = await runtime.init({ options: subject.options(state, agent), mode: 'unattended' });
    expect(ready).toMatchObject({ ok: true, launchesAgents: true, can: { exec: false } });

    return runtime;
  };

  const opened = async (runtime: StepRuntime): Promise<string> => {
    const place = await runtime.open({
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
      view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
    }, async () => {});

    if (place.kind !== 'ready') throw new Error(`not opened: ${JSON.stringify(place)}`);

    return place.handle;
  };

  const promptRequest = (handle: string, op = newOpId()): PromptRequest => ({
    op, handle, env: { STEP_VALUE: 'from-teamai' }, unset: [], credentials: {}, cwd: worktree,
    lease: {
      step: 'review', tool: 'claude', model: { name: 'claude-opus-5-5' }, permissions: 'approval-required', interactive: false,
      prompt: `Review the change.\n\nWrite the workflow result as JSON to ${path.join(dir, 'out', 'result.json')}.`, result: path.join(dir, 'out', 'result.json'),
    },
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-prompt-'));
    worktree = path.join(dir, 'worktree');
    state = path.join(dir, 'state');
    fs.mkdirSync(worktree);
    fs.mkdirSync(path.join(dir, 'out'));
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a prompt, then ends finished with the tool\'s session, the result the agent wrote and its usage', async () => {
    const runtime = await start({ output: { verdict: 'approve' }, usage: { input: 1200, output: 300 } });
    const handle = await opened(runtime);
    const request = promptRequest(handle);
    let accepted = false;

    const end = await runtime.prompt(request, { onAccepted: () => { accepted = true; } });

    expect(accepted).toBe(true);
    expect(end).toEqual({ kind: 'finished', session: { tool: 'claude', id: expect.any(String) }, result: { output: { verdict: 'approve' } }, ...(subject.reportsUsage !== false && { usage: { input: 1200, output: 300 } }) });
    expect(JSON.parse(fs.readFileSync(request.lease.result, 'utf8'))).toEqual({ output: { verdict: 'approve' } });
  });

  it('ends finished with no failure when the agent writes "failure": null beside its output', async () => {
    const runtime = await start({ result: { output: { verdict: 'approve' }, failure: null } });

    const end = await runtime.prompt(promptRequest(await opened(runtime)), {});

    expect(end).toMatchObject({ kind: 'finished', result: { output: { verdict: 'approve' } } });
    expect(end.kind === 'finished' ? end.result.failure : 'not finished').toBeUndefined();
  });

  it('answers closed to a close of a place it already closed, after a prompt ran there', async () => {
    const runtime = await start({ output: { verdict: 'approve' } });
    const handle = await opened(runtime);
    expect(await runtime.prompt(promptRequest(handle), {})).toMatchObject({ kind: 'finished' });

    expect(await runtime.close(handle)).toEqual({ ok: true });
    expect(await runtime.close(handle)).toEqual({ ok: true });
  });

  it('answers a repeated prompt id with the same outcome', async () => {
    const runtime = await start({ output: { verdict: 'approve' } });
    const request = promptRequest(await opened(runtime));
    const first = await runtime.prompt(request, {});

    expect(first.kind).toBe('finished');
    expect(await runtime.prompt(request, {})).toEqual(first);
  });

  it('answers a prompt id repeated while it runs with the same acceptance and outcome for each caller', async () => {
    // The agent works until the test releases it, so the repeat arrives while the first prompt is in flight.
    const release = path.join(dir, 'release');
    const runtime = await start({ release, output: { verdict: 'approve' } });
    const request = promptRequest(await opened(runtime));
    let firstAccepted = false;
    let repeatAccepted = false;
    const first = runtime.prompt(request, { onAccepted: () => { firstAccepted = true; } });
    expect(await until(() => firstAccepted)).toBe(true);
    const repeated = runtime.prompt(request, { onAccepted: () => { repeatAccepted = true; } });
    fs.writeFileSync(release, '');

    const [firstEnd, repeatedEnd] = await Promise.all([first, repeated]);

    expect(firstEnd.kind).toBe('finished');
    expect(repeatedEnd).toEqual(firstEnd);
    expect(repeatAccepted).toBe(true);
  });

  it('ends failed when the agent cannot finish the step, naming why', async () => {
    const failure = { code: 'model_unavailable', message: 'The daemon has no model claude-opus-5-5.' };
    const runtime = await start({ fail: failure });

    expect(await runtime.prompt(promptRequest(await opened(runtime)), {})).toEqual({ kind: 'failed', failure: subject.failure?.(failure) ?? failure });
  });

  it('cancels a running prompt', async () => {
    const runtime = await start({ hold_ms: 60_000 });
    const handle = await opened(runtime);
    const request = promptRequest(handle);
    let accepted = false;
    const ending = runtime.prompt(request, { onAccepted: () => { accepted = true; } });
    expect(await until(() => accepted)).toBe(true);

    await runtime.cancel(request.op);

    expect(await ending).toEqual({ kind: 'cancelled' });
    expect(await runtime.reattach(handle)).toEqual(alive([{ op: request.op, state: 'cancelled' }]));
  });

  it('runs no command: an exec fails, naming the runtime\'s offer', async () => {
    const runtime = await start();
    const end = await runtime.exec({ op: newOpId(), handle: await opened(runtime), argv: ['/bin/sh', '-c', 'touch ran'], env: {}, unset: [], credentials: {}, cwd: worktree }, {});

    expect(end).toMatchObject({ kind: 'failed', failure: { code: 'exec_unsupported' } });
    expect(fs.existsSync(path.join(worktree, 'ran'))).toBe(false);
  });

  it(subject.unjournaledEnd === undefined ? 'answers the true end of a prompt whose end it cannot journal, says so, and reports it on reattach until close' : `still answers a prompt whose end it cannot journal with ${subject.unjournaledEnd}, not its true end`, async () => {
    const warned = vi.spyOn(log, 'warn');
    const release = path.join(dir, 'release');
    const runtime = await start({ release, output: { verdict: 'approve' } });
    const handle = await opened(runtime);
    const request = promptRequest(handle);
    let accepted = false;
    const ended = runtime.prompt(request, { onAccepted: () => { accepted = true; } });
    expect(await until(() => accepted)).toBe(true);
    const journal = subject.journal(state);

    try {
      for (const root of journal) setDirModes(root, 0o500);
      fs.writeFileSync(release, '');

      const end = await ended;

      if (subject.unjournaledEnd !== undefined) {
        expect(end.kind === 'failed' ? `failed ${end.failure.code}` : end.kind).toBe(subject.unjournaledEnd);

        return;
      }

      expect(end).toMatchObject({ kind: 'finished', result: { output: { verdict: 'approve' } } });
      expect(warned).toHaveBeenCalledWith(expect.stringContaining(`operation ${request.op}`));
      expect(await runtime.reattach(handle)).toMatchObject({ kind: 'alive', ops: [{ op: request.op, state: 'finished', result: { output: { verdict: 'approve' } } }] });
    } finally {
      for (const root of journal) setDirModes(root, 0o700);
    }
  });

  it('reattaches after its own restart with a finished prompt, and a repeated prompt reads the same outcome', async () => {
    const first = await start({ output: { verdict: 'approve' }, usage: { input: 10 } });
    const handle = await opened(first);
    const request = promptRequest(handle);
    const finished = await first.prompt(request, {});
    expect(finished.kind).toBe('finished');
    if (finished.kind !== 'finished') return;
    await first.dispose();
    const second = await start({ output: { verdict: 'approve' }, usage: { input: 10 } });

    expect(await second.reattach(handle)).toEqual(alive([{ op: request.op, state: 'finished', session: finished.session, result: finished.result, usage: finished.usage }]));
    expect(await second.prompt(request, {})).toEqual(finished);
  });

  it('reconnects to a prompt its own restart left running: reattach reads it running, and the repeated prompt ends finished', async () => {
    // The agent works until the test releases it, so it is still running when the runtime restarts.
    const release = path.join(dir, 'release');
    const agent = { release, output: { verdict: 'approve' } };
    const first = await start(agent);
    const handle = await opened(first);
    const request = promptRequest(handle);
    let accepted = false;
    void first.prompt(request, { onAccepted: () => { accepted = true; } });
    expect(await until(() => accepted)).toBe(true);
    await first.dispose();
    const second = await start(agent);

    expect(await second.reattach(handle)).toEqual(alive([{ op: request.op, state: 'running' }]));
    const reconnected = second.prompt(request, {});
    fs.writeFileSync(release, '');
    expect(await reconnected).toMatchObject({ kind: 'finished', result: { output: { verdict: 'approve' } } });
  });
});

/**
 * A confined prompt: a judge with one directory as its only readable root, in a place opened without a view of the
 * host. A runtime offers `can.confined` only when its `init` says it answers such prompts; teamai drops the offer
 * otherwise, so a step confined to a directory never reaches it.
 */
describe('a runtime that answers confined prompts, over stdio', () => {
  let dir: string;
  let evidence: string;
  let state: string;
  const started: StepRuntime[] = [];
  const offer = [{ level: 'best-effort' as const, access: 'read' as const, tools: ['claude'] }];

  const start = (): StepRuntime => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);

    return runtime;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-confined-'));
    evidence = path.join(dir, 'evidence');
    state = path.join(dir, 'state');
    fs.mkdirSync(path.join(evidence, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(evidence, 'transcript.jsonl'), '{}\n');
    fs.writeFileSync(path.join(evidence, 'nested', 'diff.patch'), '');
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tells the runtime at init the names of the credentials and logins it brings, never a value, so it offers only the judges it can sign in', async () => {
    const ready = await start().init({ options: { state, judge: {} }, mode: 'unattended', credentials: { env: ['ANTHROPIC_API_KEY'], logins: ['codex'] } });

    expect(ready).toMatchObject({ ok: true });
    const noted = fs.readFileSync(path.join(state, 'credentials.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(noted).toEqual([{ type: 'init', names: ['ANTHROPIC_API_KEY'], logins: ['codex'] }]);
  });

  it('drops can.confined from an offer whose init does not say it answers confined prompts', async () => {
    const ready = await start().init({ options: { state, can: { confined: offer } }, mode: 'unattended' });

    expect(ready).toMatchObject({ ok: true });
    expect(ready.ok && ready.can.confined).toBeUndefined();
  });

  it('answers a confined prompt in a place opened with no view, reading only its directory, and reports the level it kept', async () => {
    const runtime = start();
    const ready = await runtime.init({ options: { state, judge: { reply: { answer: { label: 'good' } } } }, mode: 'unattended' });
    expect(ready).toMatchObject({ ok: true, can: { confined: offer } });
    const place = await runtime.open({ op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {} }, async () => {});

    if (place.kind !== 'ready') throw new Error(`not opened: ${JSON.stringify(place)}`);
    const schema = { type: 'object', properties: { answer: { type: 'object' } }, required: ['answer'] };

    const end = await runtime.prompt({
      op: newOpId(), handle: place.handle, env: {}, unset: [], credentials: {}, cwd: evidence,
      lease: { step: 'judge', tool: 'claude', prompt: 'Judge the work.', result: path.join(dir, 'out', 'result.json'), permissions: 'approval-required', interactive: false },
      confined: { dir: evidence, level: 'best-effort', access: 'read', schema },
    }, {});

    expect(end).toMatchObject({ kind: 'finished', result: { output: { answer: { label: 'good' } } }, confined: { level: 'best-effort', access: 'read' } });
    const sent = fs.readFileSync(path.join(state, 'prompts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { sees?: string[]; confined?: unknown });
    expect(sent[0]).toMatchObject({ sees: ['nested/diff.patch', 'transcript.jsonl'], confined: { dir: evidence, level: 'best-effort', access: 'read', schema } });
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
      view: { worktree: path.join(dir, 'worktree'), readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
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

  it.each([
    ['carries the display', { label: 'Review the change', url: 'paseo://agent/9f2c', fields: { agent: 'claude', mode: 'default' } }, true],
    ['drops a display it cannot show from', { label: 'x'.repeat(81) }, false],
  ])('%s a prompt runtime gives once it accepted the prompt', async (_, display, kept) => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ options: { state: path.join(dir, 'state'), agent: { output: { ok: true }, display } }, mode: 'unattended' })).toMatchObject({ ok: true });
    const opened = await runtime.open({
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
      view: { worktree: path.join(dir, 'worktree'), readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
    }, async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const lease = { step: 'review', tool: 'claude', prompt: 'Review.', result: path.join(dir, 'out', 'result.json'), permissions: 'approval-required', interactive: false } as const;
    const shown: unknown[] = [];

    await runtime.prompt({ op: newOpId(), handle: opened.handle, lease, env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, { onAccepted: (accepted) => { shown.push(accepted); } });

    expect(opened).toEqual({ kind: 'ready', handle: 'toy-r0123abcd-a0123abcd' });
    expect(shown).toEqual([kept ? { display } : {}]);
  });

  it('carries a display a prompt runtime sends after it accepted the prompt, apart from the acceptance', async () => {
    const display = { label: 'Review the change', url: 't3://thread/5e1c', fields: { agent: 'claude' } };
    const release = path.join(dir, 'release');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ options: { state: path.join(dir, 'state'), agent: { output: { ok: true }, display, display_after_ms: 0, release } }, mode: 'unattended' })).toMatchObject({ ok: true });
    const opened = await runtime.open({
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
      view: { worktree: path.join(dir, 'worktree'), readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
    }, async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const lease = { step: 'review', tool: 'claude', prompt: 'Review.', result: path.join(dir, 'out', 'result.json'), permissions: 'approval-required', interactive: false } as const;
    const accepted: unknown[] = [];
    const shown: unknown[] = [];

    // The agent finishes only once its display arrived, so the display comes while the prompt runs.
    const end = await runtime.prompt({ op: newOpId(), handle: opened.handle, lease, env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, {
      onAccepted: (acceptance) => { accepted.push(acceptance); },
      onDisplay: (sent) => { shown.push(sent); fs.writeFileSync(release, ''); },
    });

    expect(end).toMatchObject({ kind: 'finished', result: { output: { ok: true } } });
    expect(accepted).toEqual([{}]);
    expect(shown).toEqual([display]);
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

describe('a runtime that cannot close a place, over stdio', () => {
  let dir: string;
  const started: StepRuntime[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-close-'));
    fs.mkdirSync(path.join(dir, 'worktree'));
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const opened = async (options: RuntimeOptions): Promise<{ runtime: StepRuntime; handle: string }> => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ options: { state: path.join(dir, 'state'), ...options }, mode: 'unattended' })).toMatchObject({ ok: true });
    const place = await runtime.open({
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
      view: { worktree: path.join(dir, 'worktree'), readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
    }, async () => {});
    if (place.kind !== 'ready') throw new Error('not opened');

    return { runtime, handle: place.handle };
  };

  it('answers close_failed with why, and keeps the place', async () => {
    const { runtime, handle } = await opened({ close_fails: true });

    expect(await runtime.close(handle)).toEqual({ ok: false, failure: { code: 'close_failed', message: `The toy keeps place ${handle}: close_fails is set.` } });
    expect(await runtime.reattach(handle)).toMatchObject({ kind: 'alive' });
  });

  it('fails a close once the runtime has stopped, instead of answering it closed', async () => {
    const { runtime, handle } = await opened({ exit_at: 'exec-accepted' });
    expect(await runtime.exec({ op: newOpId(), handle, argv: [process.execPath, '-e', 'setTimeout(() => {}, 200)'], env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, {}))
      .toMatchObject({ kind: 'lost', failure: { code: 'runtime_exited' } });

    expect(await runtime.close(handle)).toMatchObject({ ok: false, failure: { code: 'runtime_exited' } });
  });

  it('fails an open sent once the runtime has stopped as runtime_not_sent, since the runtime never got it', async () => {
    const { runtime, handle } = await opened({ exit_at: 'exec-accepted' });
    await runtime.exec({ op: newOpId(), handle, argv: [process.execPath, '-e', 'setTimeout(() => {}, 200)'], env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, {});
    const op = newOpId();
    let isAccepted = false;

    expect(await runtime.open({ op, run: 'r0123abcd', attempt: 'a0123abce', credentials: {} }, async () => { isAccepted = true; }))
      .toMatchObject({ kind: 'failed', failure: { code: 'runtime_not_sent', message: expect.stringContaining(`teamai did not send open ${op}`) } });
    expect(isAccepted).toBe(false);
  });

  it('reads the failure reply for a handle as that request\'s failure, for reattach, collect and close', async () => {
    const { runtime, handle } = await opened({ answer: { reattach: 'failed', collect: 'failed', close: 'failed' } });
    const failure = (type: string) => ({ code: 'toy_refused', message: `The toy refuses ${type} of ${handle}: answer.${type} is set.` });

    expect(await runtime.reattach(handle)).toEqual({ kind: 'failed', failure: failure('reattach') });
    expect(await runtime.collect(handle)).toEqual({ ok: false, failure: failure('collect') });
    expect(await runtime.close(handle)).toEqual({ ok: false, failure: failure('close') });
  });

  it('answers failed, never gone, for a handle whose journal it cannot read', async () => {
    const { runtime, handle } = await opened({});
    fs.writeFileSync(path.join(dir, 'state', 'handles.json'), '{not json');

    expect(await runtime.reattach(handle)).toMatchObject({ kind: 'failed', failure: { code: 'toy_failed', message: expect.stringContaining('The toy cannot read its journal') } });
    expect(await runtime.close(handle)).toMatchObject({ ok: false, failure: { code: 'toy_failed' } });
  });

  it('fails a close it is waiting on as runtime_unanswered when the runtime writes an error that names no request, and the place stays', async () => {
    const { runtime, handle } = await opened({ answer: { close: 'error' } });

    expect(await runtime.close(handle)).toEqual({
      ok: false,
      failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not answer close of ${handle}: it wrote an error that names no request (The toy cannot answer close of ${handle}: answer.close is set.).` },
    });
    expect(await runtime.reattach(handle)).toMatchObject({ kind: 'alive' });
  });

  it('ends an exec it is waiting on as lost with runtime_unanswered when the runtime writes an error that names no request', async () => {
    const { runtime, handle } = await opened({ answer: { exec: 'error' } });
    const op = newOpId();

    expect(await runtime.exec({ op, handle, argv: [process.execPath, '-e', ''], env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, {})).toEqual({
      kind: 'lost',
      failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not answer exec ${op}: it wrote an error that names no request (The toy cannot answer exec of ${handle}: answer.exec is set.).` },
    });
  });

  it('ends a prompt, and fails an open, the runtime does not accept within 15 s, as runtime_unanswered', async () => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ options: { state: path.join(dir, 'state'), agent: {}, answer: { open: 'silent', prompt: 'silent' } }, mode: 'unattended' })).toMatchObject({ ok: true });
    const handle = 'toy-r0123abcd-a0123abcd';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const promptOp = newOpId();
      const openOp = newOpId();
      const prompted = runtime.prompt({
        op: promptOp, handle, env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree'),
        lease: { step: 'review', tool: 'claude', prompt: 'p', result: path.join(dir, 'out', 'result.json'), permissions: 'unattended', interactive: false },
      }, {});
      const reopened = runtime.open({ op: openOp, run: 'r0123abcd', attempt: 'a0123abcd', credentials: {} }, async () => {});
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await Promise.race([prompted, 'still waiting'])).toEqual({ kind: 'lost', failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not accept prompt ${promptOp} within 15 s.` } });
      expect(await Promise.race([reopened, 'still waiting'])).toEqual({ kind: 'failed', failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not accept open ${openOp} within 15 s.` } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends an accepted exec and prompt as lost with runtime_unanswered when the runtime gives no outcome within 15 s of their cancel, whatever they write meanwhile', async () => {
    const { runtime, handle } = await opened({ answer: { cancel: 'silent' } });
    const release = path.join(dir, 'release');
    const agentToy = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(agentToy);
    expect(await agentToy.init({ options: { state: path.join(dir, 'agent-state'), agent: { release }, answer: { cancel: 'silent' } }, mode: 'unattended' })).toMatchObject({ ok: true });
    let execAccepted: () => void = () => {};
    let promptAccepted: () => void = () => {};
    let wroteAfterCancel: () => void = () => {};
    let cancelSent = false;
    const execAcceptance = new Promise<void>((resolve) => { execAccepted = resolve; });
    const promptAcceptance = new Promise<void>((resolve) => { promptAccepted = resolve; });
    const outputAfterCancel = new Promise<void>((resolve) => { wroteAfterCancel = resolve; });
    const execOp = newOpId();
    const promptOp = newOpId();
    // The exec writes for a few seconds and then ends, so the toy that ignores its cancel exits once disposed.
    const execEnd = runtime.exec({ op: execOp, handle, argv: [process.execPath, '-e', 'const t = setInterval(() => console.log("tick"), 20); setTimeout(() => clearInterval(t), 3000)'], env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, {
      onAccepted: () => execAccepted(),
      onOutput: () => { if (cancelSent) wroteAfterCancel(); },
    });
    const promptEnd = agentToy.prompt({
      op: promptOp, handle: 'toy-r0123abcd-a0123abcd', env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree'),
      lease: { step: 'review', tool: 'claude', prompt: 'p', result: path.join(dir, 'out', 'result.json'), permissions: 'unattended', interactive: false },
    }, { onAccepted: () => promptAccepted() });
    await Promise.all([execAcceptance, promptAcceptance]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      await runtime.cancel(execOp);
      await agentToy.cancel(promptOp);
      cancelSent = true;
      await outputAfterCancel;
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await Promise.race([execEnd, 'still waiting'])).toEqual({ kind: 'lost', failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not confirm the cancel of exec ${execOp} within 15 s, so what it started may still run.` } });
      expect(await Promise.race([promptEnd, 'still waiting'])).toEqual({ kind: 'lost', failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not confirm the cancel of prompt ${promptOp} within 15 s, so what it started may still run.` } });
    } finally {
      vi.useRealTimers();
      fs.writeFileSync(release, '');
    }
  });

  it('keeps a display the runtime sends before it accepts a prompt, and still ends the prompt runtime_unanswered when no acceptance comes within 15 s', async () => {
    const display = { label: 'Review the change', url: 't3://thread/5e1c' };
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ options: { state: path.join(dir, 'state'), agent: { display }, answer: { prompt: 'display' } }, mode: 'unattended' })).toMatchObject({ ok: true });
    const accepted: unknown[] = [];
    let showed: (sent: RuntimeDisplay) => void = () => {};
    const shown = new Promise<RuntimeDisplay>((resolve) => { showed = resolve; });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const op = newOpId();
      const prompted = runtime.prompt({
        op, handle: 'toy-r0123abcd-a0123abcd', env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree'),
        lease: { step: 'review', tool: 'claude', prompt: 'p', result: path.join(dir, 'out', 'result.json'), permissions: 'unattended', interactive: false },
      }, { onAccepted: (acceptance) => { accepted.push(acceptance); }, onDisplay: showed });

      expect(await Promise.race([shown, prompted])).toEqual(display);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await Promise.race([prompted, 'still waiting'])).toEqual({ kind: 'lost', failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not accept prompt ${op} within 15 s.` } });
      expect(accepted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends an accepted prompt lost with runtime_unanswered 15 s after its cancel when the runtime answers the cancel with only a display', async () => {
    const display = { label: 'Review the change', url: 't3://thread/5e1c' };
    const release = path.join(dir, 'release');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ options: { state: path.join(dir, 'state'), agent: { release, display }, answer: { cancel: 'display' } }, mode: 'unattended' })).toMatchObject({ ok: true });
    let promptAccepted: () => void = () => {};
    let showed: (sent: RuntimeDisplay) => void = () => {};
    const acceptance = new Promise<void>((resolve) => { promptAccepted = resolve; });
    const shown = new Promise<RuntimeDisplay>((resolve) => { showed = resolve; });
    const op = newOpId();
    const promptEnd = runtime.prompt({
      op, handle: 'toy-r0123abcd-a0123abcd', env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree'),
      lease: { step: 'review', tool: 'claude', prompt: 'p', result: path.join(dir, 'out', 'result.json'), permissions: 'unattended', interactive: false },
    }, { onAccepted: () => promptAccepted(), onDisplay: showed });
    await acceptance;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      await runtime.cancel(op);

      expect(await Promise.race([shown, promptEnd])).toEqual(display);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await Promise.race([promptEnd, 'still waiting'])).toEqual({ kind: 'lost', failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not confirm the cancel of prompt ${op} within 15 s, so what it started may still run.` } });
    } finally {
      vi.useRealTimers();
      fs.writeFileSync(release, '');
    }
  });

  it('ignores a display for an operation it does not wait on', async () => {
    const { runtime, handle } = await opened({ display: { label: 'place' }, answer: { cancel: 'display' } });

    await runtime.cancel(newOpId());

    expect(await runtime.reattach(handle)).toMatchObject({ kind: 'alive' });
  });

  it('fails an init the runtime does not answer within 15 s as runtime_unanswered', async () => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const ready = runtime.init({ options: { state: path.join(dir, 'state'), answer: { init: 'silent' } }, mode: 'unattended' });
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await Promise.race([ready, 'still waiting'])).toEqual({ ok: false, failure: { code: 'runtime_unanswered', message: 'Step runtime "toy" did not answer init within 15 s.' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives an attended init 10 min, long enough to approve a sign-in page, and shows the runtime\'s notice meanwhile', async () => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    let noticed: (line: string) => void = () => {};
    const notice = new Promise<string>((resolve) => { noticed = resolve; });
    const warned = vi.spyOn(log, 'warn').mockImplementation((line) => noticed(line));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const ready = runtime.init({ options: { state: path.join(dir, 'state'), answer: { init: 'silent' }, notice: { init: 'Open https://toy.example.test/device to sign in.' } }, mode: 'attended' });

      expect(await notice).toBe('Step runtime "toy": Open https://toy.example.test/device to sign in.');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await Promise.race([ready, 'still waiting'])).toBe('still waiting');
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 15_000);
      expect(await Promise.race([ready, 'still waiting'])).toEqual({ ok: false, failure: { code: 'runtime_unanswered', message: 'Step runtime "toy" did not answer init within 10 min, while it ran attended.' } });
    } finally {
      vi.useRealTimers();
      warned.mockRestore();
    }
  });

  it('fails a reattach and a close the runtime does not answer within 15 s as runtime_unanswered', async () => {
    const { runtime, handle } = await opened({ answer: { reattach: 'silent', close: 'silent' } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const reattached = runtime.reattach(handle);
      const closed = runtime.close(handle);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await reattached).toEqual({ kind: 'failed', failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not answer reattach of ${handle} within 15 s.` } });
      expect(await closed).toEqual({ ok: false, failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not answer close of ${handle} within 15 s.` } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a cancel a runtime tries again, over stdio', () => {
  let dir: string;
  const started: StepRuntime[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-retry-'));
    fs.mkdirSync(path.join(dir, 'worktree'));
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const toy = async (options: RuntimeOptions): Promise<StepRuntime> => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ options: { state: path.join(dir, 'state'), ...options }, mode: 'unattended' })).toMatchObject({ ok: true });

    return runtime;
  };

  it('reports the operation running from when it reads the retried cancel until the stop is confirmed, never the stop that failed before', async () => {
    const cannotStop = { code: 'cancel_failed', message: 'The provider is down. Start it, then run teamai workflow cancel again.' };
    const first = await toy({ cancel_fails: cannotStop });
    const place = await first.open({
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
      view: { worktree: path.join(dir, 'worktree'), readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
    }, async () => {});
    if (place.kind !== 'ready') throw new Error('not opened');
    const op = newOpId();
    void first.exec({ op, handle: place.handle, argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, {});
    expect(await until(async () => JSON.stringify(await first.reattach(place.handle)).includes('"running"'))).toBe(true);
    await first.cancel(op);
    expect(await until(async () => JSON.stringify(await first.reattach(place.handle)).includes('cancel_failed'))).toBe(true);

    // A later runtime process, once the provider is back, stops it a while after it reads the cancel.
    const again = await toy({ stop_ms: 1000 });
    await again.cancel(op);

    expect(await again.reattach(place.handle)).toMatchObject({ kind: 'alive', ops: [{ op, state: 'running' }] });
    expect(await until(async () => JSON.stringify(await again.reattach(place.handle)).includes('"cancelled"'), 10_000)).toBe(true);
  });
});

describe('the toy runtime once teamai stops reading it', () => {
  let dir: string;
  const started: StepRuntime[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-epipe-'));
    fs.mkdirSync(path.join(dir, 'worktree'));
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps running an exec whose output nobody reads, and a toy started again reads how it exited', async () => {
    const state = path.join(dir, 'state');
    const worktree = path.join(dir, 'worktree');
    // teamai is gone: the toy's stdout has no reader, so each line it writes fails with EPIPE.
    const toy = spawn(process.execPath, [TOY_RUNTIME], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = readline.createInterface({ input: toy.stdout });
    const replies: string[] = [];
    lines.on('line', (line) => replies.push(line));
    const exec = newOpId();
    toy.stdin.write(`${JSON.stringify({ type: 'init', protocol: 1, mode: 'unattended', options: { state } })}\n`);
    toy.stdin.write(`${JSON.stringify({ type: 'open', op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} } })}\n`);
    toy.stdin.write(`${JSON.stringify({ type: 'exec', op: exec, handle: 'toy-r0123abcd-a0123abcd', argv: [process.execPath, '-e', 'setTimeout(() => { for (let i = 0; i < 50; i += 1) console.log(`line ${i}`); }, 300)'], env: {}, unset: [], cwd: worktree })}\n`);
    expect(await until(() => replies.some((line) => line.includes(exec) && line.includes('accepted')))).toBe(true);
    lines.close();
    toy.stdout.destroy();
    toy.stdin.end();
    await new Promise((resolve) => toy.once('close', resolve));
    const again = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(again);
    expect(await again.init({ options: { state }, mode: 'unattended' })).toMatchObject({ ok: true });

    expect(await again.reattach('toy-r0123abcd-a0123abcd')).toMatchObject({ kind: 'alive', ops: [{ op: exec, state: 'exited', code: 0 }] });
  });

  it('records the outcome of an exec whose output arrives after the teamai that started it is gone', async () => {
    const worktree = path.join(dir, 'worktree');
    const state = path.join(dir, 'state');
    const toy = spawn(process.execPath, [TOY_RUNTIME], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines: string[] = [];
    readline.createInterface({ input: toy.stdout }).on('line', (line) => { lines.push(line); });
    const write = (request: object): void => { toy.stdin.write(`${JSON.stringify(request)}\n`); };
    const op = newOpId();
    write({ type: 'init', protocol: 1, mode: 'unattended', options: { state } });
    write({ type: 'open', op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} } });
    expect(await until(() => lines.some((line) => line.includes('"ready"')))).toBe(true);
    const argv = [process.execPath, '-e', 'setTimeout(() => process.stdout.write("finished"), 500)'];
    write({ type: 'exec', op, handle: 'toy-r0123abcd-a0123abcd', argv, env: {}, unset: [], credentials: {}, cwd: worktree });
    expect(await until(() => lines.some((line) => line.includes(op) && line.includes('"accepted"')))).toBe(true);
    // As when teamai is killed: nobody reads the toy's stdout any more, and its stdin ends.
    toy.stdout.destroy();
    toy.stdin.end();

    const second = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(second);
    expect(await second.init({ options: { state }, mode: 'unattended' })).toMatchObject({ ok: true });

    // Another command under the same id: an outcome of `finished` is the recorded one, not a second run.
    const rerun = [process.execPath, '-e', 'process.stdout.write("ran again")'];
    expect(await second.exec({ op, handle: 'toy-r0123abcd-a0123abcd', argv: rerun, env: {}, unset: [], credentials: {}, cwd: worktree }, {}))
      .toEqual<ExecEnd>({ kind: 'exited', code: 0, stdout: 'finished' });
  });

  it('reads an exec its stopped owner has not recorded yet as running, then as the outcome the owner records', async () => {
    const worktree = path.join(dir, 'worktree');
    const state = path.join(dir, 'state');
    const toy = spawn(process.execPath, [TOY_RUNTIME], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines: string[] = [];
    readline.createInterface({ input: toy.stdout }).on('line', (line) => { lines.push(line); });
    const write = (request: object): void => { toy.stdin.write(`${JSON.stringify(request)}\n`); };
    const op = newOpId();
    write({ type: 'init', protocol: 1, mode: 'unattended', options: { state } });
    write({ type: 'open', op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} } });
    expect(await until(() => lines.some((line) => line.includes('"ready"')))).toBe(true);
    write({ type: 'exec', op, handle: 'toy-r0123abcd-a0123abcd', argv: [process.execPath, '-e', 'setTimeout(() => { process.stdout.write("retained"); require("fs").writeFileSync("ended", ""); }, 300)'], env: {}, unset: [], credentials: {}, cwd: worktree });
    expect(await until(() => lines.some((line) => line.includes(op) && line.includes('"accepted"')))).toBe(true);
    // The owner cannot record the outcome while it is stopped, though its exec ends.
    toy.kill('SIGSTOP');

    try {
      expect(await until(() => fs.existsSync(path.join(worktree, 'ended')))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
      started.push(second);
      expect(await second.init({ options: { state }, mode: 'unattended' })).toMatchObject({ ok: true });

      expect(await second.reattach('toy-r0123abcd-a0123abcd')).toEqual({ kind: 'alive', ops: [{ op, state: 'running' }] });
      toy.kill('SIGCONT');
      let read: unknown;
      expect(await until(async () => {
        read = await second.reattach('toy-r0123abcd-a0123abcd');

        return JSON.stringify(read) !== JSON.stringify({ kind: 'alive', ops: [{ op, state: 'running' }] });
      })).toBe(true);
      expect(read).toEqual({ kind: 'alive', ops: [{ op, state: 'exited', code: 0, stdout: 'retained' }] });
    } finally {
      toy.kill('SIGCONT');
      toy.stdin.end();
    }
  });

  it('fails init for a protocol version it does not speak, naming the key', async () => {
    const toy = spawn(process.execPath, [TOY_RUNTIME], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines: string[] = [];
    readline.createInterface({ input: toy.stdout }).on('line', (line) => { lines.push(line); });
    toy.stdin.write(`${JSON.stringify({ type: 'init', protocol: 99, mode: 'unattended', options: { state: path.join(dir, 'state') } })}\n`);

    try {
      expect(await until(() => lines.length > 0)).toBe(true);
      expect(JSON.parse(lines[0] ?? '')).toMatchObject({ type: 'init', ok: false, error: { code: 'bad_protocol', key: 'protocol' } });
    } finally {
      toy.stdin.end();
    }
  });
});

describe('a driver whose runtime stopped on a line it could not read', () => {
  let dir: string;
  let driver: ReturnType<typeof spawn> | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-stray-'));
    fs.mkdirSync(path.join(dir, 'worktree'));
  });

  afterEach(() => {
    if (driver?.exitCode === null && driver.signalCode === null) driver.kill('SIGKILL');
    const strayPid = path.join(dir, 'state', 'stray.pid');

    if (fs.existsSync(strayPid)) {
      try {
        process.kill(Number(fs.readFileSync(strayPid, 'utf8')), 'SIGKILL');
      } catch {
        // It already ended.
      }
    }

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exits once it disposes the runtime, though a tool the runtime started still holds the runtime\'s output open', async () => {
    const runtimes = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflow', 'runtimes');
    const entry = path.join(dir, 'driver.mjs');
    // A driver of its own process, as teamai is: it runs one exec through the StepRuntime interface, then disposes it.
    buildSync({
      stdin: {
        contents: `
          import { stdioStepRuntime } from './stdio.js';
          const [toy, dir] = process.argv.slice(2);
          const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [toy] });
          await runtime.init({ options: { state: dir + '/state', stray: true }, mode: 'unattended' });
          const place = await runtime.open({ op: 'op-00000001', run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, view: { worktree: dir + '/worktree', readonly: [], result: dir + '/out', runDir: dir + '/scratch', toolHome: {} } }, async () => {});
          const end = await runtime.exec({ op: 'op-00000002', handle: place.handle, argv: [process.execPath, '-e', ''], env: {}, unset: [], credentials: {}, cwd: dir + '/worktree' }, {});
          console.log(JSON.stringify(end));
          await runtime.dispose();
        `,
        resolveDir: runtimes, loader: 'ts', sourcefile: 'driver.ts',
      },
      outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
      banner: { js: "import { createRequire as driverCreateRequire } from 'node:module'; const require = driverCreateRequire(import.meta.url);" },
    });
    let printed = '';
    driver = spawn(process.execPath, [entry, TOY_RUNTIME, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
    driver.stdout?.setEncoding('utf8').on('data', (data: string) => { printed += data; });
    const exited = new Promise<number | null>((resolve) => driver?.once('exit', (code) => resolve(code)));

    expect(await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('still running'), 5000))])).toBe(0);
    expect(printed).toContain('"kind":"lost"');
    expect(printed).toContain('runtime_exited');
    expect(pidAlive(Number(fs.readFileSync(path.join(dir, 'state', 'stray.pid'), 'utf8')))).toBe(true);
  });
});

describe('an attempt\'s deadline, over stdio', () => {
  let dir: string;
  const started: StepRuntime[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-deadline-'));
    fs.mkdirSync(path.join(dir, 'worktree'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A toy with `options`, and its place opened with `deadline`. */
  const opened = async (options: RuntimeOptions, deadline: string): Promise<{ runtime: StepRuntime; handle: string }> => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ options: { state: path.join(dir, 'state'), ...options }, mode: 'unattended' })).toMatchObject({ ok: true });
    const place = await runtime.open({
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, deadline,
      view: { worktree: path.join(dir, 'worktree'), readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
    }, async () => {});
    if (place.kind !== 'ready') throw new Error(`not opened: ${JSON.stringify(place)}`);

    return { runtime, handle: place.handle };
  };

  const soon = (ms: number): string => new Date(Date.now() + ms).toISOString();

  it('leaves an exec still running at the attempt\'s deadline to the step\'s own limit, and cancels it 15 s past the deadline', async () => {
    const { runtime, handle } = await opened({}, soon(5_000));
    const warned = vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const op = newOpId();

    let accepted = (): void => {};
    const isAccepted = new Promise<void>((resolve) => { accepted = resolve; });

    const end = runtime.exec({ op, handle, argv: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'], env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, { onAccepted: () => accepted() });
    await isAccepted;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await Promise.race([end, 'still running'])).toBe('still running');
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();

    expect(await end).toEqual({ kind: 'cancelled' });
    expect(warned.mock.calls.map(([line]) => line)).toEqual([`Step runtime "toy" still ran exec ${op} 15 s past the attempt's deadline, so teamai cancels it.`]);
    warned.mockRestore();
  });

  it('cancels an accepted prompt still running 15 s past the attempt\'s deadline', async () => {
    const { runtime, handle } = await opened({ agent: { release: path.join(dir, 'never'), output: { ok: true } } }, soon(5_000));
    const request: PromptRequest = {
      op: newOpId(), handle, env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree'),
      lease: { step: 'review', tool: 'claude', permissions: 'approval-required', interactive: false, prompt: 'Review.', result: path.join(dir, 'out', 'result.json') },
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let accepted = (): void => {};
    const isAccepted = new Promise<void>((resolve) => { accepted = resolve; });

    const end = runtime.prompt(request, { onAccepted: () => accepted() });
    await isAccepted;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await Promise.race([end, 'still running'])).toBe('still running');
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();

    expect(await end).toEqual({ kind: 'cancelled' });
  });

  it('fails a collect the runtime does not answer within 15 s past the attempt\'s deadline as runtime_unanswered', async () => {
    const { runtime, handle } = await opened({ answer: { collect: 'silent' } }, soon(5_000));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const collected = runtime.collect(handle);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await Promise.race([collected, 'still waiting'])).toBe('still waiting');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await Promise.race([collected, 'still waiting'])).toEqual({ ok: false, failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not answer collect of ${handle} within 15 s of the attempt's deadline.` } });
  });

  it('fails an open whose place is not ready at the attempt\'s deadline as runtime_unanswered, keeping its handle', async () => {
    // A runtime that accepts every open and never reports its place ready, as one whose image pull never ends.
    const acceptsOnly = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type === 'init') process.stdout.write(JSON.stringify({ type: 'init', ok: true, can: {} }) + '\\n');
      if (request.type === 'open') process.stdout.write(JSON.stringify({ op: request.op, event: 'accepted', handle: 'h1' }) + '\\n');
    });`;
    const runtime = stdioStepRuntime({ name: 'slow', command: process.execPath, args: ['-e', acceptsOnly] });
    started.push(runtime);
    expect(await runtime.init({ options: {}, mode: 'unattended' })).toMatchObject({ ok: true });
    const persisted: string[] = [];
    const op = newOpId();

    const place = await runtime.open({ op, run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, deadline: soon(1_000), view: { worktree: dir, readonly: [], result: dir, runDir: dir, toolHome: {} } }, async (handle) => { persisted.push(handle); });

    expect(place).toEqual({ kind: 'failed', failure: { code: 'runtime_unanswered', message: `Step runtime "slow" did not report the place of open ${op} ready by the attempt's deadline.` } });
    expect(persisted).toEqual(['h1']);
  });

  it('keeps the handle of an open sent past the attempt\'s deadline, which it fails once the runtime accepts it', async () => {
    // A runtime that accepts each open a moment later, and never reports its place ready.
    const late = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type === 'init') process.stdout.write(JSON.stringify({ type: 'init', ok: true, can: {} }) + '\\n');
      if (request.type === 'open') setTimeout(() => process.stdout.write(JSON.stringify({ op: request.op, event: 'accepted', handle: 'h1' }) + '\\n'), 300);
    });`;
    const runtime = stdioStepRuntime({ name: 'late', command: process.execPath, args: ['-e', late] });
    started.push(runtime);
    expect(await runtime.init({ options: {}, mode: 'unattended' })).toMatchObject({ ok: true });
    const persisted: string[] = [];
    const op = newOpId();

    const place = await runtime.open({ op, run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, deadline: soon(-60_000), view: { worktree: dir, readonly: [], result: dir, runDir: dir, toolHome: {} } }, async (handle) => { persisted.push(handle); });

    expect(place).toEqual({ kind: 'failed', failure: { code: 'runtime_unanswered', message: `Step runtime "late" did not report the place of open ${op} ready by the attempt's deadline.` } });
    expect(persisted).toEqual(['h1']);
  });
});

describe('the stdio step runtime client', () => {
  it('waits for the handle write when the runtime dies after accepting an open, and rejects with its error', async () => {
    // A runtime that accepts every open with a handle and exits before it reports the place ready.
    const acceptsThenExits = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type === 'init') process.stdout.write(JSON.stringify({ type: 'init', ok: true, can: {} }) + '\\n');
      if (request.type === 'open') process.stdout.write(JSON.stringify({ op: request.op, event: 'accepted', handle: 'h1' }) + '\\n', () => process.exit(1));
    });`;
    const runtime = stdioStepRuntime({ name: 'accepts-then-exits', command: process.execPath, args: ['-e', acceptsThenExits] });
    expect(await runtime.init({ options: {}, mode: 'unattended' })).toMatchObject({ ok: true });
    const request: OpenRequest = { op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, view: { worktree: os.tmpdir(), readonly: [], result: os.tmpdir(), runDir: os.tmpdir(), toolHome: {} } };

    await expect(runtime.open(request, async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      throw new Error('the run record could not be written');
    })).rejects.toThrow('the run record could not be written');
    await runtime.dispose();
  });

  it('shows the first 2000 characters of a longer notice, and keeps the runtime', async () => {
    const warned = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const long = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type === 'init') {
        process.stdout.write(JSON.stringify({ event: 'notice', message: 'x'.repeat(3000) }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'init', ok: true, can: {} }) + '\\n');
      }
    });`;
    const runtime = stdioStepRuntime({ name: 'long', command: process.execPath, args: ['-e', long] });

    try {
      expect(await runtime.init({ options: {}, mode: 'unattended' })).toMatchObject({ ok: true });
      expect(warned.mock.calls.map(([line]) => line)).toEqual([`Step runtime "long": ${'x'.repeat(2000)}…`]);
    } finally {
      warned.mockRestore();
      await runtime.dispose();
    }
  });

  it('shows a notice the runtime writes as a warning, with its credentials masked, and keeps the request it came with going', async () => {
    const warned = vi.spyOn(log, 'warn').mockImplementation(() => {});
    // A runtime that tells the person something while it answers: at init, and before it accepts an open.
    const notes = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      if (request.type === 'init') { write({ event: 'notice', message: 'Signing in to acme as al.' }); write({ type: 'init', ok: true, can: {} }); }
      if (request.type === 'open') {
        write({ event: 'notice', op: request.op, message: 'The acme token ' + request.credentials.ACME_TOKEN + ' expires tomorrow.' });
        write({ op: request.op, event: 'accepted', handle: 'h1' });
        write({ event: 'notice', handle: 'h1', message: 'Pulling acme/agent:1.' });
        write({ op: request.op, event: 'ready' });
      }
    });`;
    const runtime = stdioStepRuntime({ name: 'notes', command: process.execPath, args: ['-e', notes], secrets: { 'ACME_TOKEN (credential of notes)': 'acme-secret-7f3a91' } });

    try {
      expect(await runtime.init({ options: {}, mode: 'unattended' })).toMatchObject({ ok: true });
      const opened = await runtime.open({ op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: { ACME_TOKEN: 'acme-secret-7f3a91' }, view: { worktree: os.tmpdir(), readonly: [], result: os.tmpdir(), runDir: os.tmpdir(), toolHome: {} } }, async () => {});

      expect(opened).toMatchObject({ kind: 'ready', handle: 'h1' });
      const lines = warned.mock.calls.map(([line]) => line);
      expect(lines).toEqual([
        'Step runtime "notes": Signing in to acme as al.',
        expect.stringMatching(/^Step runtime "notes", operation op-[0-9a-f]+: The acme token <REDACTED:ACME_TOKEN \(credential of notes\)> expires tomorrow\.$/),
        'Step runtime "notes", place h1: Pulling acme/agent:1.',
      ]);
      expect(lines.join('\n')).not.toContain('acme-secret-7f3a91');
    } finally {
      warned.mockRestore();
      await runtime.dispose();
    }
  });

  it('counts and logs a terminal for an operation it no longer waits on, and keeps the first one', async () => {
    const warned = vi.spyOn(log, 'warn').mockImplementation(() => {});
    // A runtime that ends each exec twice, the second time differently, as one that answers a cancel after an end.
    const twice = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      if (request.type === 'init') write({ type: 'init', ok: true, can: {} });
      if (request.type === 'exec') {
        write({ op: request.op, event: 'accepted' });
        write({ op: request.op, event: 'exited', code: 0, stdout: 'ok' });
        write({ op: request.op, event: 'cancelled' });
        write({ op: request.op, event: 'output', stream: 'stdout', data: 'late' });
      }
    });`;
    const runtime = stdioStepRuntime({ name: 'twice', command: process.execPath, args: ['-e', twice] });

    try {
      expect(await runtime.init({ options: {}, mode: 'unattended' })).toMatchObject({ ok: true });
      const [first, second] = [newOpId(), newOpId()];
      const exec = (op: typeof first): ExecRequest => ({ op, handle: 'h1', argv: ['true'], env: {}, unset: [], credentials: {}, cwd: os.tmpdir() });

      expect(await runtime.exec(exec(first), {})).toEqual({ kind: 'exited', code: 0, stdout: 'ok' });
      expect(await until(() => warned.mock.calls.length === 1)).toBe(true);
      expect(await runtime.exec(exec(second), {})).toEqual({ kind: 'exited', code: 0, stdout: 'ok' });
      expect(await until(() => warned.mock.calls.length === 2)).toBe(true);

      expect(warned.mock.calls.map(([line]) => line)).toEqual([
        `Step runtime "twice" answered ${first} with cancelled after teamai stopped waiting for it, which teamai ignores (late answers from this runtime: 1).`,
        `Step runtime "twice" answered ${second} with cancelled after teamai stopped waiting for it, which teamai ignores (late answers from this runtime: 2).`,
      ]);
    } finally {
      warned.mockRestore();
      await runtime.dispose();
    }
  });

  it('counts no end that answers a cancel it sent, even one that repeats an end already given', async () => {
    const warned = vi.spyOn(log, 'warn').mockImplementation(() => {});
    // Each cancel is answered with an end twice; an exec ends, then ends again.
    const answers = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      if (request.type === 'init') write({ type: 'init', ok: true, can: {} });
      if (request.type === 'cancel') { write({ op: request.op, event: 'exited', code: 0, stdout: '' }); write({ op: request.op, event: 'cancelled' }); }
      if (request.type === 'exec') { write({ op: request.op, event: 'accepted' }); write({ op: request.op, event: 'exited', code: 0, stdout: '' }); write({ op: request.op, event: 'exited', code: 0, stdout: '' }); }
    });`;
    const runtime = stdioStepRuntime({ name: 'answers', command: process.execPath, args: ['-e', answers] });

    try {
      expect(await runtime.init({ options: {}, mode: 'unattended' })).toMatchObject({ ok: true });
      const [cancelled, ended] = [newOpId(), newOpId()];

      await runtime.cancel(cancelled);
      await runtime.exec({ op: ended, handle: 'h1', argv: ['true'], env: {}, unset: [], credentials: {}, cwd: os.tmpdir() }, {});
      expect(await until(() => warned.mock.calls.length > 0)).toBe(true);
      expect(warned.mock.calls.map(([line]) => line)).toEqual([
        `Step runtime "answers" answered ${ended} with exited after teamai stopped waiting for it, which teamai ignores (late answers from this runtime: 1).`,
      ]);
    } finally {
      warned.mockRestore();
      await runtime.dispose();
    }
  });

  it('fails a runtime that writes a key protocol 1 does not have, naming the key', async () => {
    const surplus = `require('readline').createInterface({ input: process.stdin }).on('line', () => {
      process.stdout.write(JSON.stringify({ type: 'init', ok: true, can: {}, surplus: true }) + '\\n');
    });`;
    const runtime = stdioStepRuntime({ name: 'surplus', command: process.execPath, args: ['-e', surplus] });

    expect(await runtime.init({ options: {}, mode: 'unattended' })).toMatchObject({ ok: false, failure: { message: expect.stringContaining('"surplus"') } });
    await runtime.dispose();
  });
});
