import readline from 'node:readline';
import { CANCEL_FAILED, OpIdSchema, RUNTIME_PROTOCOL, RuntimeHandleSchema, RuntimeRequestSchema, type OpId, type RuntimeMessage, type RuntimeRequest } from '@teamai/runtime-protocol';
import { z } from 'zod';

// ─── Serving runtime protocol 1 ──────────────────────────
//
//  The loop every step runtime process runs: it reads one request per line, hands each to the runtime's handler for its
//  type, and answers a request whose handler threw, or a line it cannot read, with that request's own failure: teamai
//  fails every request still waiting on an `error` line, so one is written only for a line that names no request.
//

/** What the runtime does for each request type: it answers the request itself, through the lines it writes. */
export type RuntimeHandlers = { readonly [TType in RuntimeRequest['type']]: (request: Extract<RuntimeRequest, { type: TType }>) => Promise<void> };

export interface ServeRuntime {
  /** The runtime's name as its messages give it, such as `t3` in "Runtime t3 could not start". */
  name: string;
  input: NodeJS.ReadableStream;
  write(message: RuntimeMessage): void;
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
 * Serves runtime protocol 1 on `input` until teamai closes it. Each request runs as it comes, without waiting for the
 * ones before it: a slow prompt never holds a cancel.
 */
export function serveRuntime({ name, input, write, handlers, holds, stopped, debug }: ServeRuntime): Promise<void> {
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

  /** Answers a line that is no protocol request with the failure of the request it names, if it names one. */
  const unreadable = (text: string, why: string): void => {
    const message = `Not a protocol ${RUNTIME_PROTOCOL} request: ${why}`;
    let named: z.infer<typeof NamedSchema> = {};

    try {
      named = NamedSchema.catch({}).parse(JSON.parse(text));
    } catch {
      // Not JSON: it names nothing.
    }

    if (named.op !== undefined && holds(named.op)) debug(`Dropped a line that names ${named.op}, which runtime ${name} already runs or answered: ${message}`);
    else if (named.op !== undefined) write({ op: named.op, event: 'failed', failure: { code: named.type === 'cancel' ? CANCEL_FAILED : 'runtime_protocol', message } });
    else if (named.handle !== undefined) write({ event: 'failed', handle: named.handle, failure: { code: 'runtime_protocol', message } });
    else if (named.type === 'init') write({ type: 'init', ok: false, error: { code: 'runtime_protocol', message } });
    else write({ event: 'error', message });
  };

  return new Promise((resolve) => {
    const lines = readline.createInterface({ input });

    lines.on('line', (text) => {
      let request: RuntimeRequest;

      try {
        request = RuntimeRequestSchema.parse(JSON.parse(text));
      } catch (error) {
        unreadable(text, error instanceof Error ? error.message : String(error));

        return;
      }

      void (async () => {
        try {
          await dispatch(handlers, request);
        } catch (error) {
          failRequest(request, error instanceof Error ? error.message : String(error));
        }
      })();
    });

    // teamai is gone: what still runs keeps going, and a later teamai reattaches to it.
    lines.on('close', () => resolve());
  });
}
