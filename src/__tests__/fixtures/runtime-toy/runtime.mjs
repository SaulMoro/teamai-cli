#!/usr/bin/env node
// The toy step runtime: protocol 1 over JSON lines on stdio. It runs each exec on the host, in a process group of its
// own, and keeps handles and outcomes in the `state` option's directory, so a toy started again answers a repeated
// operation and a reattach from them. `die_at` kills the process that spawned it, once per state directory, right after
// it recorded that point and before it replies: `open-accepted`, `exec-exited` or `prompt-finished`. It reads each
// request with the protocol's own schema, so a request teamai writes that the protocol does not have is answered with
// an error.
//
// With `agent`, it is a runtime that launches agents its own way, as T3 or Paseo: it offers `prompt` and no `exec`, and
// its agent works `hold_ms` (from when the prompt was first sent, across a restart of the toy) and until the file
// `release` names exists, then writes `output` (or the whole `result`) to the lease's result file and finishes with a
// session and `usage`, or ends with `fail`. It appends each prompt it is sent, and how each ended, to `prompts.jsonl` in its state, which
// `close` keeps.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { RuntimeRequestSchema } from '@teamai/runtime-protocol';

const OPTIONS = new Set(['state', 'die_at', 'exit_at', 'close_fails', 'can', 'display', 'agent']);

const DEFAULT_CAN = {
  hitl: false, workspace: ['read-only', 'new', 'continue'], network: false, isolation: 'none', env: true,
  tokens: true, max_turns: true, setup: true, tools: ['claude', 'codex', 'codebuddy'], end_turn: true, unattended: true, role: true,
};

let options;
const running = new Map();

// When teamai is gone, a line it would have read goes nowhere: an exec still running keeps going and records its end.
let stdoutOpen = true;

process.stdout.on('error', () => { stdoutOpen = false; });

function send(message) {
  if (stdoutOpen) process.stdout.write(`${JSON.stringify(message)}\n`);
}

function file(...parts) {
  return path.join(options.state, ...parts);
}

function readJson(at, fallback) {
  try {
    return JSON.parse(fs.readFileSync(at, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(at, value) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  const tmp = `${at}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, at);
}

const opPath = (op) => file('ops', `${op}.json`);

function dieAt(point) {
  if (options.die_at !== point) return false;
  const marker = file(`died-${point}`);

  if (fs.existsSync(marker)) return false;
  fs.writeFileSync(marker, '');
  process.kill(process.ppid, 'SIGKILL');

  return true;
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);

    return true;
  } catch {
    return false;
  }
}

function stopGroup(pgid) {
  try { process.kill(-pgid, 'SIGTERM'); } catch { return; }
  setTimeout(() => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

// `exit_at: 'exec-accepted'` makes the toy itself exit right after it accepted an exec, which keeps running. With
// `close_fails`, it answers every `close` with `close_failed`.
// `display` is sent as given, valid or not, so a test reads what teamai keeps of it.
function shown() {
  return options.display === undefined ? {} : { display: options.display };
}

function init(request) {
  const unknown = Object.keys(request.options ?? {}).find((key) => !OPTIONS.has(key));

  if (unknown !== undefined) {
    send({ type: 'init', ok: false, error: { code: 'bad_option', key: unknown, message: `The toy runtime takes no option "${unknown}". It takes: ${[...OPTIONS].join(', ')}.` } });

    return;
  }

  if (typeof request.options?.state !== 'string') {
    send({ type: 'init', ok: false, error: { code: 'bad_option', key: 'state', message: 'The toy runtime needs option "state", the directory it keeps its handles in.' } });

    return;
  }

  options = request.options;
  fs.mkdirSync(options.state, { recursive: true });

  if (options.agent === undefined) {
    send({ type: 'init', ok: true, can: { ...DEFAULT_CAN, ...options.can } });

    return;
  }

  // An agent the toy launches works in the place on the host: it takes no command, so it runs no setup either.
  send({ type: 'init', ok: true, prompt: true, can: { ...DEFAULT_CAN, exec: false, setup: false, tokens: false, end_turn: false, ...options.can } });
}

function open(request) {
  const handles = readJson(file('handles.json'), {});
  const key = `${request.run}/${request.attempt}`;
  const handle = handles[key] ?? `toy-${request.run}-${request.attempt}`;
  handles[key] = handle;
  writeJson(file('handles.json'), handles);
  writeJson(opPath(request.op), { kind: 'open', handle });

  if (dieAt('open-accepted')) return;
  send({ op: request.op, event: 'accepted', handle });
  send({ op: request.op, event: 'ready', ...shown() });
}

function replay(op, record) {
  send({ op, event: 'accepted' });

  if (record.outcome.state === 'exited') send({ op, event: 'exited', code: record.outcome.code, stdout: record.outcome.stdout });
  else send({ op, event: 'cancelled' });
}

function exec(request) {
  if (options.agent !== undefined) {
    send({ op: request.op, event: 'failed', failure: { code: 'exec_unsupported', message: 'The toy launches agents its own way and runs no command (can.exec: false).' } });

    return;
  }

  const record = readJson(opPath(request.op), undefined);

  if (record?.outcome) {
    replay(request.op, record);

    return;
  }

  if (running.has(request.op)) {
    send({ op: request.op, event: 'accepted' });

    return;
  }

  const env = { ...process.env, ...request.env };

  for (const name of request.unset ?? []) delete env[name];
  const [command, ...args] = request.argv;
  const child = spawn(command, args, { cwd: request.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(request.op, child);
  writeJson(opPath(request.op), { kind: 'exec', handle: request.handle, pgid: child.pid });
  send({ op: request.op, event: 'accepted' });

  // The toy itself stops while the exec runs on, as a runtime that crashes leaves its processes behind.
  if (options.exit_at === 'exec-accepted') {
    process.stdout.write('', () => process.exit(70));

    return;
  }
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; send({ op: request.op, event: 'output', stream: 'stdout', data }); });
  child.stderr.setEncoding('utf8').on('data', (data) => { send({ op: request.op, event: 'output', stream: 'stderr', data }); });
  child.on('error', (error) => { stdout += ''; send({ op: request.op, event: 'output', stream: 'stderr', data: error.message }); });
  child.on('close', (code) => {
    running.delete(request.op);
    const cancelled = fs.existsSync(file('cancel', request.op));
    const outcome = cancelled ? { state: 'cancelled' } : { state: 'exited', code: code ?? 1, stdout };
    writeJson(opPath(request.op), { kind: 'exec', handle: request.handle, outcome });

    if (!cancelled && dieAt('exec-exited')) return;
    send(cancelled ? { op: request.op, event: 'cancelled' } : { op: request.op, event: 'exited', code: outcome.code, stdout });
    exitWhenIdle();
  });
}

/** The prompts this toy waits on, by operation: the timer that finishes each. */
const working = new Map();

/** What the agent of a prompt record ended with, once it worked `hold_ms` since the prompt was first sent. */
function agentOutcome(record) {
  if (record.outcome) return record.outcome;

  if (fs.existsSync(file('cancel', record.op))) return { state: 'cancelled' };

  if (Date.now() < record.startedAt + (options.agent.hold_ms ?? 0)) return undefined;

  if (options.agent.release !== undefined && !fs.existsSync(options.agent.release)) return undefined;

  if (options.agent.fail) return { state: 'failed', failure: options.agent.fail };
  const result = options.agent.result ?? { output: options.agent.output ?? {} };
  fs.mkdirSync(path.dirname(record.lease.result), { recursive: true });
  fs.writeFileSync(record.lease.result, JSON.stringify(result));
  const usage = options.agent.usage === undefined ? {} : { usage: options.agent.usage };

  return { state: 'finished', session: { tool: record.lease.tool, id: record.lease.resume ?? `toy-session-${record.op.slice(3)}` }, result, ...usage };
}

function promptEnded(op, outcome) {
  const { state, ...rest } = outcome;

  return { op, event: state, ...rest };
}

/** Records how the prompt's agent ended and says so, or waits for it. */
function settlePrompt(op) {
  const record = readJson(opPath(op), undefined);
  const outcome = agentOutcome(record);

  if (outcome === undefined) {
    working.set(op, setTimeout(() => settlePrompt(op), Math.max(record.startedAt + (options.agent.hold_ms ?? 0) - Date.now(), 25)));

    return;
  }

  working.delete(op);

  if (!record.outcome) fs.appendFileSync(file('prompts.jsonl'), `${JSON.stringify({ op, ended: outcome.state })}\n`);
  writeJson(opPath(op), { ...record, outcome });

  if (outcome.state === 'finished' && dieAt('prompt-finished')) return;
  send(promptEnded(op, outcome));
  exitWhenIdle();
}

function prompt(request) {
  const record = readJson(opPath(request.op), undefined);

  if (options.agent === undefined) {
    send({ op: request.op, event: 'failed', failure: { code: 'prompt_unsupported', message: 'The toy runs a prompt\'s tool as an exec; start it with the agent option to take prompts.' } });

    return;
  }

  send({ op: request.op, event: 'accepted' });

  if (working.has(request.op)) return;

  // The first prompt of this id starts the agent; a repeated one reconnects to it, or reads how it ended.
  fs.appendFileSync(file('prompts.jsonl'), `${JSON.stringify({ op: request.op, sent: request.lease })}\n`);

  if (!record) writeJson(opPath(request.op), { kind: 'prompt', op: request.op, handle: request.handle, lease: request.lease, startedAt: Date.now() });
  settlePrompt(request.op);
}

function cancel(request) {
  const record = readJson(opPath(request.op), undefined);

  if (!record || record.outcome) return;

  if (record.kind === 'prompt') {
    fs.mkdirSync(file('cancel'), { recursive: true });
    fs.writeFileSync(file('cancel', request.op), '');
    clearTimeout(working.get(request.op));

    // A prompt this toy waits on ends now; one a toy before it sent ends when teamai sends it again.
    if (working.has(request.op)) settlePrompt(request.op);

    return;
  }

  fs.mkdirSync(file('cancel'), { recursive: true });
  fs.writeFileSync(file('cancel', request.op), '');

  if (record.pgid === undefined) return;
  stopGroup(record.pgid);

  // An exec a toy before this one started ends here: no child of this process reports it.
  if (!running.has(request.op)) {
    const wait = setInterval(() => {
      if (groupAlive(record.pgid)) return;
      clearInterval(wait);
      writeJson(opPath(request.op), { kind: 'exec', handle: record.handle, outcome: { state: 'cancelled' } });
      send({ op: request.op, event: 'cancelled' });
    }, 25);
  }
}

function opsOf(handle) {
  let names;

  try { names = fs.readdirSync(file('ops')); } catch { names = []; }

  return names.filter((name) => name.endsWith('.json')).map((name) => ({ op: name.slice(0, -5), record: readJson(file('ops', name), undefined) }))
    .filter(({ record }) => (record?.kind === 'exec' || record?.kind === 'prompt') && record.handle === handle);
}

function known(handle) {
  return Object.values(readJson(file('handles.json'), {})).includes(handle);
}

function reattach(request) {
  if (!known(request.handle)) {
    send({ event: 'gone', handle: request.handle });

    return;
  }

  const ops = opsOf(request.handle).map(({ op, record }) => {
    if (record.kind === 'prompt') {
      const { state, ...rest } = agentOutcome(record) ?? { state: 'running' };

      return { op, state, ...rest };
    }

    if (record.outcome?.state === 'exited') return { op, state: 'exited', code: record.outcome.code, stdout: record.outcome.stdout };

    if (record.outcome?.state === 'cancelled') return { op, state: 'cancelled' };

    if (running.has(op) || groupAlive(record.pgid)) return { op, state: 'running' };

    // A cancelled exec whose processes are gone has ended cancelled, though its outcome may not be written yet.
    return fs.existsSync(file('cancel', op)) ? { op, state: 'cancelled' } : { op, state: 'failed', failure: { code: 'runtime_lost', message: `The toy lost exec ${op}.` } };
  });

  send({ event: 'alive', handle: request.handle, ops, ...shown() });
}

function close(request) {
  if (options.close_fails) {
    send({ event: 'close_failed', handle: request.handle, failure: { code: 'close_failed', message: `The toy keeps place ${request.handle}: close_fails is set.` } });

    return;
  }

  const handles = readJson(file('handles.json'), {});

  for (const [key, handle] of Object.entries(handles)) if (handle === request.handle) delete handles[key];
  writeJson(file('handles.json'), handles);

  for (const { op } of opsOf(request.handle)) fs.rmSync(opPath(op), { force: true });
  send({ event: 'closed', handle: request.handle });
}

let ended = false;

/** The toy outlives its stdin while an exec runs, so an exec that finishes while teamai is down is still recorded. */
function exitWhenIdle() {
  if (ended && running.size === 0 && working.size === 0) process.exit(0);
}

const HANDLERS = { init, open, exec, prompt, cancel, collect: (request) => send({ event: 'collected', handle: request.handle }), reattach, close };

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  const parsed = RuntimeRequestSchema.safeParse(JSON.parse(line));

  if (!parsed.success) {
    send({ event: 'error', message: `The toy runtime does not know request ${line.slice(0, 200)}: ${parsed.error.issues[0]?.message}` });

    return;
  }

  const request = parsed.data;
  const handler = HANDLERS[request.type];

  if (request.type !== 'init' && !options) {
    send({ event: 'error', message: 'Send init first.' });

    return;
  }

  handler(request);
}).on('close', () => {
  ended = true;
  exitWhenIdle();
});
