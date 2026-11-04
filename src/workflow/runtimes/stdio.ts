import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import crossSpawn from 'cross-spawn';
import { log } from '../../utils/logger.js';
import { RUNTIME_PROTOCOL, type Can, type RuntimeFailure, type RuntimeRequest } from '@teamai/runtime-protocol';
import { parseRuntimeLine, type HandleEvent, type OpEvent, type Shown } from './protocol.js';
import type { ExecEnd, Initialized, Opened, PromptEnd, Reattached, StepRuntime } from './step-runtime.js';

/** How long `dispose` waits for a runtime to exit once its stdin ends; one that runs on is left to finish its own work. */
const DISPOSE_WAIT_MS = 2000;

/** How long teamai waits for a runtime's reply to an `init`, a `reattach` or a `close` before it fails that request `runtime_unanswered`. */
const ANSWER_WITHIN_MS = 15_000;

type HandleRequest = Extract<RuntimeRequest, { handle: string; type: 'collect' | 'reattach' | 'close' }>;

/** The display a runtime gave, if the run's details show it; one they do not show is named in a warning. */
function displayOf(name: string, shown: Shown) {
  if (shown.kind === 'dropped') log.warn(`Step runtime "${name}" gave a display the run's details do not show: ${shown.reason}.`);

  return shown.kind === 'shown' ? { display: shown.display } : {};
}

type HandleWaiter = { request: HandleRequest; events: ReadonlySet<HandleEvent['event']>; settle: (event: HandleEvent | RuntimeFailure) => void };

/** A runtime's offer as teamai takes it: `can.confined` only from a runtime that says it answers confined prompts. */
function offered(can: Can, answersConfined: boolean): Can {
  if (answersConfined) return can;
  const { confined: _dropped, ...rest } = can;

  return rest;
}

/**
 * The client of an external step runtime: `command` spawned with `args`, speaking runtime protocol 1 over its stdio.
 * The process starts at `init`. Once it exits, or writes a line the protocol does not have, no request reaches it
 * again: an exec or prompt in flight ends `lost`, since what it started may outlive the runtime, and every other
 * request fails with `runtime_exited`. A `reattach`, `collect` or `close` ends with its own reply, or with the failure
 * reply for its handle; `init` and those requests fail `runtime_unanswered` when the runtime writes an error that names
 * no request, and an `init`, a `reattach` or a `close` does when it gets no reply within 15 s.
 */
export function stdioStepRuntime({ name, command, args = [], cwd }: { name: string; command: string; args?: string[]; cwd?: string }): StepRuntime {
  let child: ChildProcess | undefined;
  let dead: RuntimeFailure | undefined;
  let stderrTail = '';
  let exited: Promise<void> = Promise.resolve();
  let onInit: ((reply: Initialized) => void) | undefined;
  const ops = new Map<string, (event: OpEvent | RuntimeFailure) => void>();
  const handles = new Map<string, HandleWaiter[]>();

  const die = (reason: string): void => {
    if (dead) return;
    const tail = stderrTail.trim().split('\n').slice(-5).join(' | ');
    dead = { code: 'runtime_exited', message: `Step runtime "${name}" stopped: ${reason}.${tail ? ` It wrote: ${tail}` : ''}` };
    onInit?.({ ok: false, failure: dead });

    for (const listener of ops.values()) listener(dead);
    ops.clear();

    for (const waiters of handles.values()) for (const waiter of waiters) waiter.settle(dead);
    handles.clear();
    child?.kill('SIGKILL');
  };

  /** Fails `init` and every handle request still waiting, as the runtime left them unanswered: `why` says how. */
  const unanswered = (why: string): void => {
    onInit?.({ ok: false, failure: { code: 'runtime_unanswered', message: `Step runtime "${name}" did not answer init: ${why}.` } });
    onInit = undefined;
    const waiting = [...handles.values()].flat();
    handles.clear();

    for (const { request, settle } of waiting) settle({ code: 'runtime_unanswered', message: `Step runtime "${name}" did not answer ${request.type} of ${request.handle}: ${why}.` });
  };

  const send = (request: RuntimeRequest): void => {
    if (!dead) child?.stdin?.write(`${JSON.stringify(request)}\n`);
  };

  const receive = (line: string): void => {
    if (line.trim() === '') return;
    const parsed = parseRuntimeLine(line);

    if (!parsed.ok) {
      die(parsed.reason);

      return;
    }

    const { message } = parsed;

    if ('type' in message) {
      onInit?.(message.ok ? { ok: true, can: offered(message.can, message.confinedPrompt === true), launchesAgents: message.prompt === true } : { ok: false, failure: message.error });
      onInit = undefined;

      return;
    }

    if (message.event === 'error') {
      if (onInit === undefined && handles.size === 0) log.warn(`Step runtime "${name}" answered: ${message.message}`);
      else unanswered(`it wrote an error that names no request (${message.message})`);

      return;
    }

    if ('op' in message) {
      ops.get(message.op)?.(message);

      return;
    }

    const waiters = handles.get(message.handle) ?? [];
    const at = waiters.findIndex((waiter) => waiter.events.has(message.event));

    if (at === -1) return;
    const [waiter] = waiters.splice(at, 1);

    if (waiters.length === 0) handles.delete(message.handle);
    waiter?.settle(message.event === 'failed' ? message.failure : message);
  };

  /** Sends a handle request and waits for one of `events` for its handle, or for the failure reply to it. */
  const askHandle = (request: HandleRequest, events: HandleEvent['event'][]): Promise<HandleEvent | RuntimeFailure> => {
    if (dead) return Promise.resolve(dead);

    return new Promise((resolve) => {
      const waiters = handles.get(request.handle) ?? [];
      let timer: NodeJS.Timeout | undefined;

      const waiter: HandleWaiter = {
        request,
        events: new Set([...events, 'failed']),
        settle: (answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
      };

      // A collect brings the place's work back, which takes as long as that work is large: only its own reply or the
      // runtime's end settles it.
      if (request.type !== 'collect') {
        timer = setTimeout(() => {
          const left = handles.get(request.handle) ?? [];
          const at = left.indexOf(waiter);

          if (at === -1) return;
          left.splice(at, 1);

          if (left.length === 0) handles.delete(request.handle);
          waiter.settle({ code: 'runtime_unanswered', message: `Step runtime "${name}" did not answer ${request.type} of ${request.handle} within ${ANSWER_WITHIN_MS / 1000} s.` });
        }, ANSWER_WITHIN_MS);
        timer.unref();
      }

      waiters.push(waiter);
      handles.set(request.handle, waiters);
      send(request);
    });
  };

  const isFailure = (value: OpEvent | HandleEvent | RuntimeFailure): value is RuntimeFailure => 'code' in value && !('event' in value);

  return {
    name,

    async init({ options, mode, credentials }) {
      if (dead) return { ok: false, failure: dead };

      try {
        child = crossSpawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        return { ok: false, failure: { code: 'runtime_exited', message: `Step runtime "${name}" could not start: ${error instanceof Error ? error.message : String(error)}` } };
      }

      const started = child;
      const { stdin, stdout, stderr } = started;

      if (!stdin || !stdout || !stderr) return { ok: false, failure: { code: 'runtime_exited', message: `Step runtime "${name}" started without its stdio.` } };
      exited = new Promise((resolve) => started.on('close', () => resolve()));
      started.on('error', (error) => die(`it could not start (${error.message})`));
      started.on('close', (code, signal) => die(signal ? `it was killed by ${signal}` : `it exited with status ${code ?? 1}`));
      stdin.on('error', () => {});
      stderr.setEncoding('utf8').on('data', (data: string) => { stderrTail = `${stderrTail}${data}`.slice(-4000); });
      readline.createInterface({ input: stdout }).on('line', receive);

      return new Promise<Initialized>((resolve) => {
        const settle = (reply: Initialized): void => {
          clearTimeout(timer);
          resolve(reply);
        };

        // An init that checks a provider which never answers would hold the command, and a cancel the run's lock, forever.
        const timer = setTimeout(() => {
          if (onInit !== settle) return;
          onInit = undefined;
          resolve({ ok: false, failure: { code: 'runtime_unanswered', message: `Step runtime "${name}" did not answer init within ${ANSWER_WITHIN_MS / 1000} s.` } });
        }, ANSWER_WITHIN_MS);

        timer.unref();
        onInit = settle;
        send({ type: 'init', protocol: RUNTIME_PROTOCOL, mode, options, ...(credentials && { credentials }) });
      });
    },

    open(request, onAccepted) {
      if (dead) return Promise.resolve<Opened>({ kind: 'failed', failure: dead });

      return new Promise<Opened>((resolve) => {
        let persisted: Promise<void> = Promise.resolve();
        let handle: string | undefined;

        ops.set(request.op, (event) => {
          if (isFailure(event)) {
            ops.delete(request.op);
            resolve({ kind: 'failed', failure: event });

            return;
          }

          if (event.event === 'accepted') {
            if (event.handle === undefined) {
              die(`it accepted open ${request.op} without a handle`);

              return;
            }

            const accepted = event.handle;
            handle = accepted;
            persisted = persisted.then(() => onAccepted(accepted));

            return;
          }

          if (event.event !== 'ready' && event.event !== 'failed') return;
          ops.delete(request.op);

          const settled: Opened = event.event === 'failed' ? { kind: 'failed', failure: event.failure }
            : handle === undefined ? { kind: 'failed', failure: { code: 'runtime_protocol', message: `Step runtime "${name}" reported open ${request.op} ready before it accepted it.` } }
              : { kind: 'ready', handle, ...displayOf(name, event.display) };

          void persisted.then(() => resolve(settled));
        });

        send({ type: 'open', ...request });
      });
    },

    exec(request, events) {
      if (dead) return Promise.resolve<ExecEnd>({ kind: 'failed', failure: dead });

      return new Promise<ExecEnd>((resolve) => {
        ops.set(request.op, (event) => {
          if (isFailure(event)) {
            ops.delete(request.op);
            resolve({ kind: 'lost', failure: event });

            return;
          }

          switch (event.event) {
            case 'accepted':
              events.onAccepted?.(displayOf(name, event.display));

              return;
            case 'output':
              events.onOutput?.(event.stream, event.data);

              return;
            case 'exited':
              ops.delete(request.op);
              resolve({ kind: 'exited', code: event.code, stdout: event.stdout });

              return;
            case 'cancelled':
              ops.delete(request.op);
              resolve({ kind: 'cancelled' });

              return;
            case 'failed':
              ops.delete(request.op);
              resolve({ kind: 'failed', failure: event.failure });

              return;
            case 'ready':
              return;
            case 'finished':
              die(`it answered exec ${request.op} with finished, which an exec does not have`);

              return;
            default: {
              const unhandled: never = event;

              return unhandled;
            }
          }
        });

        send({ type: 'exec', ...request });
      });
    },

    prompt(request, events) {
      if (dead) return Promise.resolve<PromptEnd>({ kind: 'failed', failure: dead });

      return new Promise<PromptEnd>((resolve) => {
        const settle = (end: PromptEnd): void => {
          ops.delete(request.op);
          resolve(end);
        };

        ops.set(request.op, (event) => {
          if (isFailure(event)) {
            settle({ kind: 'lost', failure: event });

            return;
          }

          switch (event.event) {
            case 'accepted':
              events.onAccepted?.(displayOf(name, event.display));

              return;
            case 'finished': {
              const end: PromptEnd = { kind: 'finished', session: event.session, result: event.result };

              if (event.usage) end.usage = event.usage;

              if (event.confined) end.confined = event.confined;

              if (event.resumed === true) end.resumed = true;
              settle(end);

              return;
            }

            case 'cancelled':
              settle({ kind: 'cancelled' });

              return;
            case 'failed':
              settle({ kind: 'failed', failure: event.failure });

              return;
            case 'ready':
            case 'output':
            case 'exited':
              die(`it answered prompt ${request.op} with ${event.event}, which a prompt does not have`);

              return;
            default: {
              const unhandled: never = event;

              return unhandled;
            }
          }
        });

        send({ type: 'prompt', ...request });
      });
    },

    async cancel(op) {
      send({ type: 'cancel', op });
    },

    async collect(handle) {
      const reply = await askHandle({ type: 'collect', handle }, ['collected', 'collect_failed']);

      if (isFailure(reply)) return { ok: false, failure: reply };

      return reply.event === 'collect_failed' ? { ok: false, failure: reply.failure } : { ok: true };
    },

    async reattach(handle) {
      const reply = await askHandle({ type: 'reattach', handle }, ['alive', 'gone']);

      if (isFailure(reply)) return { kind: 'failed', failure: reply } satisfies Reattached;

      return reply.event === 'alive' ? { kind: 'alive', ops: reply.ops, ...displayOf(name, reply.display) } : { kind: 'gone' };
    },

    async close(handle) {
      const reply = await askHandle({ type: 'close', handle }, ['closed', 'close_failed']);

      if (isFailure(reply)) return { ok: false, failure: reply };

      return reply.event === 'close_failed' ? { ok: false, failure: reply.failure } : { ok: true };
    },

    async dispose() {
      if (!child || dead) return;
      child.stdin?.end();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, DISPOSE_WAIT_MS).unref())]);
    },
  };
}
