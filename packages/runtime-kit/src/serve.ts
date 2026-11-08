import readline from 'node:readline';
import { CANCEL_FAILED, OpIdSchema, RUNTIME_PROTOCOL, RUNTIME_PROTOCOL_ENV, RuntimeHandleSchema, RuntimeRequestSchema, type OpId, type RuntimeRequest } from '@teamai/runtime-protocol';
import { z } from 'zod';
import type { OpLedger } from './ledger.js';

// ─── Serving runtime protocol 1 ──────────────────────────
//
//  The loop every step runtime process runs: it reads one request per line, hands each to the runtime's handler for its
//  type, and answers a request whose handler threw, or a line it cannot read, with that request's own failure: teamai
//  fails every request still waiting on an `error` line, so one is written only for a line that names no request.
//  An operation ends once: a handler that wrote its op's end and then threw gets no second one.
//

/** What the runtime does for each request type: it answers the request itself, through the lines it writes. */
export type RuntimeHandlers = { readonly [TType in RuntimeRequest['type']]: (request: Extract<RuntimeRequest, { type: TType }>) => Promise<void> };

export interface ServeRuntime {
  /** The runtime's name as its messages give it, such as `t3` in "Runtime t3 could not start". */
  name: string;
  /** Where requests come from: the process input, which only the kit reads, unless a test serves another stream. */
  input?: NodeJS.ReadableStream;
  /**
   * The runtime process's environment. It serves only when teamai started it, which sets `RUNTIME_PROTOCOL_ENV`, and
   * then removes that variable, so no process it starts inherits it.
   */
  env: NodeJS.ProcessEnv;
  /** What every line goes through, the handlers' too: it counts each op's ends. */
  ledger: OpLedger;
  handlers: RuntimeHandlers;
  /**
   * Whether the runtime already runs `op` or answered it, or a record it keeps holds or may hold it: such an op has its
   * outcome, or gets it from what runs it, so a line that names it and cannot be read is dropped, not answered.
   */
  holds(op: OpId): boolean;
  /** What may still run when a cancel threw, as the subject of "… may still run", such as `its T3 thread`. */
  stopped: string;
  /** A line that only helps to debug the runtime, such as a dropped line: stderr. */
  debug(line: string): void;
}

/**
 * Calls `onLine` with each line `input` carries, such as a socket a runtime reads: the one line reader of a runtime
 * package, so none reads its process input around `serveRuntime`. Resolves once `input` ends.
 */
export function eachLine(input: NodeJS.ReadableStream, onLine: (text: string) => void): Promise<void> {
  return new Promise((resolve) => {
    readline.createInterface({ input }).on('line', onLine).on('close', () => resolve());
  });
}

/** What a line that is no protocol request may still name: the request it fails, which then gets its own failure. */
const NamedSchema = z.object({ type: z.string().optional(), op: OpIdSchema.optional(), handle: RuntimeHandleSchema.optional() });

/** Runs `request` through its type's handler. */
function dispatch(handlers: RuntimeHandlers, request: RuntimeRequest): Promise<void> {
  switch (request.type) {
    case 'init':
      return handlers.init(request);
    case 'open':
      return handlers.open(request);
    case 'exec':
      return handlers.exec(request);
    case 'prompt':
      return handlers.prompt(request);
    case 'cancel':
      return handlers.cancel(request);
    case 'collect':
      return handlers.collect(request);
    case 'reattach':
      return handlers.reattach(request);
    case 'close':
      return handlers.close(request);
    default: {
      const unhandled: never = request;

      return unhandled;
    }
  }
}

/**
 * Serves runtime protocol 1 on `input` until teamai closes it, and resolves to the exit status the process ends with:
 * 2 when teamai did not start it, which reads nothing then. Each request runs as it comes, without waiting for the
 * ones before it: a slow prompt never holds a cancel.
 */
export function serveRuntime({ name, input = process.stdin, env, ledger, handlers, holds, stopped, debug }: ServeRuntime): Promise<number> {
  const { write } = ledger;

  if (env[RUNTIME_PROTOCOL_ENV] !== '1') {
    debug(`Runtime ${name} serves runtime protocol 1 only when teamai starts it, with TEAMAI_RUNTIME_PROTOCOL=1, so it reads nothing. Run it as the runtime of a workflow driver, not by itself.`);

    return Promise.resolve(2);
  }

  delete env[RUNTIME_PROTOCOL_ENV];

  /**
   * Answers a request that threw with a failure of its own: teamai fails every request it waits on when a line names
   * none. A cancel that threw did not confirm a stop.
   */
  const failRequest = (request: RuntimeRequest, why: string): void => {
    switch (request.type) {
      case 'init':
        return write({ type: 'init', ok: false, error: { code: 'runtime_error', message: `Runtime ${name} could not start: ${why}` } });
      case 'open':
      case 'exec':
      case 'prompt':
        return write({ op: request.op, event: 'failed', failure: { code: 'runtime_error', message: `Runtime ${name} could not carry out ${request.type} of ${request.op}: ${why}` } });
      case 'cancel':
        return write({ op: request.op, event: 'failed', failure: { code: CANCEL_FAILED, message: `Runtime ${name} could not carry out the cancel of ${request.op}, so ${stopped} may still run: ${why.replace(/\.$/, '')}. Run teamai workflow cancel again.` } });
      case 'reattach':
      case 'collect':
      case 'close':
        return write({ event: 'failed', handle: request.handle, failure: { code: 'runtime_error', message: `Runtime ${name} could not carry out ${request.type} of ${request.handle}: ${why}` } });
      default: {
        const unhandled: never = request;

        return unhandled;
      }
    }
  };

  /** Whether the runtime holds `op`: when it cannot tell, it may, so the line is dropped rather than answered. */
  const mayHold = (op: OpId): boolean => {
    try {
      return holds(op);
    } catch (error) {
      debug(`Runtime ${name} could not tell whether it holds ${op}, so it drops the line that names it: ${error instanceof Error ? error.message : String(error)}`);

      return true;
    }
  };

  /** Answers a line that is no protocol request with the failure of the request it names, if it names one. */
  const unreadable = (text: string, why: string): void => {
    const message = `Not a protocol ${RUNTIME_PROTOCOL} request: ${why}`;
    let named: z.infer<typeof NamedSchema> = {};

    try {
      named = NamedSchema.catch({}).parse(JSON.parse(text));
    } catch {
      // Not JSON: it names nothing.
    }

    if (named.op !== undefined && mayHold(named.op)) debug(`Dropped a line that names ${named.op}, which runtime ${name} already runs or answered: ${message}`);
    else if (named.op !== undefined) write({ op: named.op, event: 'failed', failure: { code: named.type === 'cancel' ? CANCEL_FAILED : 'runtime_protocol', message } });
    else if (named.handle !== undefined) write({ event: 'failed', handle: named.handle, failure: { code: 'runtime_protocol', message } });
    else if (named.type === 'init') write({ type: 'init', ok: false, error: { code: 'runtime_protocol', message } });
    else write({ event: 'error', message });
  };

  // teamai is gone once the input ends: what still runs keeps going, and a later teamai reattaches to it.
  return eachLine(input, (text) => {
    let request: RuntimeRequest;

    try {
      request = RuntimeRequestSchema.parse(JSON.parse(text));
    } catch (error) {
      unreadable(text, error instanceof Error ? error.message : String(error));

      return;
    }

    // The ends of its op written before it, which a repeated op is answered with again, are not this request's.
    const endsBefore = 'op' in request ? ledger.endsOf(request.op) : 0;

    void (async () => {
      try {
        await dispatch(handlers, request);
      } catch (error) {
        if ('op' in request && ledger.endsOf(request.op) !== endsBefore) {
          debug(`Runtime ${name} ended ${request.op} and then failed on its ${request.type}, which ends it no further: ${error instanceof Error ? error.message : String(error)}`);

          return;
        }

        failRequest(request, error instanceof Error ? error.message : String(error));
      }
    })();
  }).then(() => 0);
}
