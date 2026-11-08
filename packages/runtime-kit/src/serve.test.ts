import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RuntimeMessageSchema, type OpId, type RuntimeMessage, type RuntimeRequest } from '@teamai/runtime-protocol';
import { opLedger } from './ledger.js';
import { serveRuntime, type RuntimeHandlers } from './serve.js';

const OP = 'op-0123abcd' as OpId;

const HELD = 'op-89abcdef' as OpId;

/** A runtime served over an in-memory stdin, with the handlers `make` gives over a set that answers nothing. */
function served(make: (write: (message: RuntimeMessage) => void) => Partial<RuntimeHandlers> = () => ({})) {
  const input = new PassThrough();
  const written: RuntimeMessage[] = [];
  const debugged: string[] = [];
  const nothing = async (): Promise<void> => {};
  const ledger = opLedger({ name: 'fake', write: (message) => { written.push(RuntimeMessageSchema.parse(message)); } });
  const { write } = ledger;

  const done = serveRuntime({
    name: 'fake',
    input,
    ledger,
    handlers: { init: nothing, open: nothing, exec: nothing, prompt: nothing, cancel: nothing, collect: nothing, reattach: nothing, close: nothing, ...make(write) },
    holds: (op) => op === HELD,
    stopped: 'its fake agent',
    debug: (line) => debugged.push(line),
  });

  /** Sends `line` and waits until the runtime handled it. */
  const send = async (line: string | RuntimeRequest): Promise<void> => {
    input.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  };

  return { input, written, debugged, done, send };
}

const exec = (op: OpId): RuntimeRequest => ({ type: 'exec', op, handle: 'h-1', argv: ['true'], env: {}, unset: [], credentials: {}, cwd: '/w' });

describe('serving runtime protocol 1', () => {
  it('hands each request to the handler for its type', async () => {
    const seen: string[] = [];
    const runtime = served(() => ({ exec: async (request) => { seen.push(`exec ${request.op}`); }, close: async (request) => { seen.push(`close ${request.handle}`); } }));

    await runtime.send(exec(OP));
    await runtime.send({ type: 'close', handle: 'h-1' });

    expect(seen).toEqual([`exec ${OP}`, 'close h-1']);
    expect(runtime.written).toEqual([]);
  });

  it('ends once teamai closes its stdin', async () => {
    const runtime = served();
    runtime.input.end();

    await expect(runtime.done).resolves.toBeUndefined();
  });

  it.each([
    ['a line that is no JSON, which names nothing, with an error line', 'not json', { event: 'error', message: expect.stringContaining('Not a protocol 1 request') }],
    ['an unreadable request naming an op, with that op\'s failure', JSON.stringify({ type: 'exec', op: OP }), { op: OP, event: 'failed', failure: { code: 'runtime_protocol', message: expect.stringContaining('Not a protocol 1 request') } }],
    ['an unreadable request naming a handle, with that handle\'s failure', JSON.stringify({ type: 'reattach', handle: 'h-1', credentials: 'none' }), { event: 'failed', handle: 'h-1', failure: { code: 'runtime_protocol', message: expect.stringContaining('Not a protocol 1 request') } }],
    ['an unreadable init, with init\'s refusal', JSON.stringify({ type: 'init', protocol: 2 }), { type: 'init', ok: false, error: { code: 'runtime_protocol', message: expect.stringContaining('Not a protocol 1 request') } }],
  ])('answers %s', async (_, line, answer) => {
    const runtime = served();

    await runtime.send(line);

    expect(runtime.written).toEqual([answer]);
  });

  it('drops an unreadable line naming an op it holds, since that op has its outcome, and says so for debugging', async () => {
    const runtime = served();

    await runtime.send(JSON.stringify({ type: 'exec', op: HELD }));

    expect(runtime.written).toEqual([]);
    expect(runtime.debugged).toEqual([expect.stringContaining(`Dropped a line that names ${HELD}, which runtime fake already runs or answered`)]);
  });

  it.each<[string, RuntimeRequest, RuntimeMessage]>([
    ['an init, with init\'s refusal', { type: 'init', protocol: 1, mode: 'unattended', options: {} }, { type: 'init', ok: false, error: { code: 'runtime_error', message: 'Runtime fake could not start: boom' } }],
    ['an exec, with its failure', exec(OP), { op: OP, event: 'failed', failure: { code: 'runtime_error', message: `Runtime fake could not carry out exec of ${OP}: boom` } }],
    ['a cancel, with a stop it could not confirm', { type: 'cancel', op: OP }, { op: OP, event: 'failed', failure: { code: 'cancel_failed', message: `Runtime fake could not carry out the cancel of ${OP}, so its fake agent may still run: boom. Run teamai workflow cancel again.` } }],
    ['a reattach, with its handle\'s failure', { type: 'reattach', handle: 'h-1' }, { event: 'failed', handle: 'h-1', failure: { code: 'runtime_error', message: 'Runtime fake could not carry out reattach of h-1: boom' } }],
  ])('answers %s when its handler throws', async (_, request, answer) => {
    const boom = async (): Promise<void> => { throw new Error('boom'); };
    const runtime = served(() => ({ init: boom, exec: boom, cancel: boom, reattach: boom }));

    await runtime.send(request);

    expect(runtime.written).toEqual([answer]);
  });

  it.each<[string, RuntimeRequest, RuntimeMessage]>([
    ['a prompt it ended finished', { type: 'prompt', op: OP, handle: 'h-1', env: {}, unset: [], credentials: {}, cwd: '/w', lease: { step: 's', tool: 'claude', prompt: 'p', result: '/w/r.json', permissions: 'approval-required', interactive: false } }, { op: OP, event: 'finished', session: { tool: 'claude', id: 's-1' }, result: { output: {} } }],
    ['an open it reported ready', { type: 'open', op: OP, run: 'r', attempt: 'a', credentials: {} }, { op: OP, event: 'ready' }],
    ['a cancel whose op it ended cancelled', { type: 'cancel', op: OP }, { op: OP, event: 'cancelled' }],
  ])('writes nothing more for %s when its handler throws after that end', async (_, request, end) => {
    const runtime = served((write) => {
      const endThenThrow = async (): Promise<void> => {
        write(end);
        throw new Error('boom after the end');
      };

      return { prompt: endThenThrow, open: endThenThrow, cancel: endThenThrow };
    });

    await runtime.send(request);

    expect(runtime.written).toEqual([end]);
  });
});
