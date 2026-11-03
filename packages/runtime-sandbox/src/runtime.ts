import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { redact } from '@teamai/shared/redact';
import { RuntimeRequestSchema, type ExecRequestSchema, type OpenRequestSchema, type OpId, type OpState, type RuntimeMessage, type RuntimeOptions, type RuntimeRequest } from '@teamai/runtime-protocol';
import type { z } from 'zod';
import type { ExecRecord, Journal, Outcome, PlaceRecord } from './journal.js';
import { parseOptions, type SandboxOptions } from './options.js';
import { sandboxName, type Provider } from './provider.js';

// ─── The sandbox runtime over runtime protocol 1 ─────────
//
//  One attempt is one sandbox, named after its run and attempt, so a repeated open, or an open after a restart, finds
//  the same one. The place is journaled before its sandbox is created, and every exec under teamai's id before it
//  starts, so a repeated id is answered with the same outcome, a reattach reads what an exec did while teamai was
//  down, and a sandbox a dead runtime created is still found by its labels. Each exec brings the credentials teamai
//  gives it (a prompt's tool the attempt's, a command none); they are set over that exec's process only, never when the
//  sandbox is created, and never kept: not in the journal, and not in memory past the exec. A `prompt` is answered
//  `failed`: this runtime runs the tool teamai builds, as an exec.
//

const RUN_ID = /^r[0-9a-f]{8}(?:[0-9a-f]{8})?$/;
const ATTEMPT_ID = /^a[0-9a-f]{8}$/;

type OpenRequest = z.infer<typeof OpenRequestSchema>;

type ExecRequest = z.infer<typeof ExecRequestSchema>;

/** How often an exec another runtime process runs is looked at, to answer its outcome. */
const FOLLOW_MS = 100;

export interface RuntimeDeps {
  input: Readable;
  /** Writes one protocol line; once teamai stops reading, a line goes nowhere and the runtime goes on. */
  write: (message: RuntimeMessage) => void;
  journal: Journal;
  /** The provider the options choose. */
  provider: (options: SandboxOptions) => Provider;
}

/** One exec as the journal keeps it, with its id. */
type Journaled = { op: OpId } & ExecRecord;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function terminal(op: OpId, outcome: Outcome): RuntimeMessage {
  switch (outcome.state) {
    case 'exited':
      return { op, event: 'exited', code: outcome.code, stdout: outcome.stdout };
    case 'cancelled':
      return { op, event: 'cancelled' };
    case 'failed':
      return { op, event: 'failed', failure: outcome.failure };
    default: {
      const unhandled: never = outcome;

      return unhandled;
    }
  }
}

export function serve({ input, write, journal, provider: providerFor }: RuntimeDeps): void {
  let ready: { provider: Provider } | undefined;
  const running = new Set<OpId>();

  /** The outcome of an exec no live runtime process will finish: cancelled when teamai cancelled it, otherwise lost. */
  const settleOrphan = ({ op, handle, runner }: Journaled): Outcome => {
    const outcome: Outcome = journal.isCancelled(op) ? { state: 'cancelled' } : { state: 'failed', failure: { code: 'runtime_lost', message: `The sandbox runtime that ran exec ${op} stopped before it ended, so its outcome is unknown.` } };
    journal.saveExec(op, { handle, runner, outcome });

    return outcome;
  };

  const stateOf = (exec: Journaled): OpState => {
    if (exec.outcome) return { op: exec.op, ...exec.outcome };

    if (running.has(exec.op) || alive(exec.runner)) return { op: exec.op, state: 'running' };

    return { op: exec.op, ...settleOrphan(exec) };
  };

  /** The place's sandbox: the id the journal kept, or the one its labels find when a runtime died before keeping it. */
  const sandboxOf = async (place: PlaceRecord, provider: Provider): Promise<string | undefined> => place.id ?? provider.find(place);

  const open = async ({ op, run, attempt, view }: OpenRequest, provider: Provider): Promise<void> => {
    if (!RUN_ID.test(run) || !ATTEMPT_ID.test(attempt)) {
      write({ op, event: 'failed', failure: { code: 'bad_request', message: `Open ${op} names run "${run}" and attempt "${attempt}", which are not teamai ids.` } });

      return;
    }

    if (view === undefined) {
      write({ op, event: 'failed', failure: { code: 'bad_request', message: `Open ${op} gives no view of the host, as a confined prompt's place does, and this runtime answers no confined prompt.` } });

      return;
    }

    const key = { run, attempt };
    const handle = sandboxName(key);
    journal.savePlace(handle, key);
    write({ op, event: 'accepted', handle });
    const found = await provider.find(key);
    const created = found === undefined ? await provider.create(key, view) : { ok: true as const, id: found };

    if (!created.ok) {
      write({ op, event: 'failed', failure: created.failure });

      return;
    }

    journal.savePlace(handle, { ...key, id: created.id });
    write({ op, event: 'ready', display: provider.display(key) });
  };

  /** Answers an exec another runtime process started: its outcome once it has one. */
  const follow = async (exec: Journaled): Promise<void> => {
    for (;;) {
      const now = journal.exec(exec.op);

      if (now?.outcome) {
        write(terminal(exec.op, now.outcome));

        return;
      }

      if (!alive(exec.runner)) {
        write(terminal(exec.op, settleOrphan(exec)));

        return;
      }

      await new Promise((resolve) => setTimeout(resolve, FOLLOW_MS));
    }
  };

  const exec = async (request: ExecRequest, provider: Provider): Promise<void> => {
    const { op, handle } = request;
    const record = journal.exec(op);

    if (record?.outcome) {
      write({ op, event: 'accepted' });
      write(terminal(op, record.outcome));

      return;
    }

    if (running.has(op)) {
      // Its end is written when it ends, under the same id.
      write({ op, event: 'accepted' });

      return;
    }

    if (record) {
      write({ op, event: 'accepted' });
      await follow({ op, ...record });

      return;
    }

    // Claimed before the first await, so the same id sent again meanwhile is answered by this run.
    running.add(op);
    const place = journal.place(handle);
    const id = place && await sandboxOf(place, provider);

    if (!place || id === undefined) {
      running.delete(op);
      write({ op, event: 'failed', failure: { code: 'runtime_gone', message: `No sandbox is open under handle ${handle}.` } });

      return;
    }

    journal.saveExec(op, { handle, runner: process.pid });
    write({ op, event: 'accepted' });
    // A credential the exec withholds is not set; a name the exec sets itself wins over a credential.
    const scoped = Object.fromEntries(Object.entries(request.credentials).filter(([name]) => !request.unset.includes(name)));
    let stdout = '';

    const end = await provider.exec(id, { argv: request.argv, env: { ...scoped, ...request.env }, unset: request.unset, cwd: request.cwd }, (stream, data) => {
      if (stream === 'stdout') stdout += data;
      write({ op, event: 'output', stream, data });
    });

    const outcome: Outcome = journal.isCancelled(op) ? { state: 'cancelled' } : end.kind === 'failed' ? { state: 'failed', failure: end.failure } : { state: 'exited', code: end.code, stdout };
    // teamai gets the complete stdout and masks it itself; the journal never holds a credential the tool printed, so a
    // repeated id is answered with it masked.
    const kept: Outcome = outcome.state === 'exited' ? { ...outcome, stdout: redact(stdout, { envSecrets: request.credentials, patterns: false }) } : outcome;
    journal.saveExec(op, { handle, runner: process.pid, outcome: kept });
    running.delete(op);
    write(terminal(op, outcome));
  };

  const cancel = async (op: OpId, provider: Provider): Promise<void> => {
    const record = journal.exec(op);

    if (!record || record.outcome) return;
    journal.cancel(op);
    const place = journal.place(record.handle);
    const id = place && await sandboxOf(place, provider);

    if (id !== undefined) await provider.stop(id);

    // An exec whose runtime process is gone ends here: no process of this runtime reports it.
    if (!running.has(op) && !alive(record.runner)) write(terminal(op, settleOrphan({ op, ...record })));
  };

  const reattach = async (handle: string, provider: Provider): Promise<void> => {
    const place = journal.place(handle);

    if (!place || (await provider.find(place)) === undefined) {
      journal.forget(handle);
      write({ event: 'gone', handle });

      return;
    }

    write({ event: 'alive', handle, ops: journal.opsOf(handle).map(({ op, record }) => stateOf({ op, ...record })), display: provider.display(place) });
  };

  const close = async (handle: string, provider: Provider): Promise<void> => {
    const place = journal.place(handle);
    const id = place && await sandboxOf(place, provider);
    const removed = id === undefined ? { ok: true as const } : await provider.destroy(id);

    if (!removed.ok) {
      // The journal keeps the place, so a later close or reattach of this handle still finds the sandbox.
      write({ event: 'close_failed', handle, failure: removed.failure });

      return;
    }

    journal.forget(handle);
    write({ event: 'closed', handle });
  };

  const init = async (options: RuntimeOptions): Promise<void> => {
    const parsed = parseOptions(options);

    if (!parsed.ok) {
      write({ type: 'init', ok: false, error: parsed.failure });

      return;
    }

    const provider = providerFor(parsed.options);
    const offered = await provider.offer();

    if (!offered.ok) {
      write({ type: 'init', ok: false, error: offered.failure });

      return;
    }

    ready = { provider };
    write({ type: 'init', ok: true, can: offered.can });
  };

  const dispatch = async (request: RuntimeRequest): Promise<void> => {
    if (request.type === 'init') {
      await init(request.options);

      return;
    }

    if (!ready) {
      write({ event: 'error', message: 'Send init first.' });

      return;
    }

    const { provider } = ready;

    switch (request.type) {
      case 'open':
        return open(request, provider);
      case 'exec':
        return exec(request, provider);
      case 'prompt':
        write({ op: request.op, event: 'failed', failure: { code: 'prompt_unsupported', message: 'The sandbox runtime runs the tool teamai builds, as an exec, and launches no agent of its own.' } });

        return;
      case 'cancel':
        return cancel(request.op, provider);
      case 'collect':
        // Bind mounts: the work is already at its host paths.
        write({ event: 'collected', handle: request.handle });

        return;
      case 'reattach':
        return reattach(request.handle, provider);
      case 'close':
        return close(request.handle, provider);
      default: {
        const unhandled: never = request;

        return unhandled;
      }
    }
  };

  const answer = async (request: RuntimeRequest): Promise<void> => {
    try {
      await dispatch(request);
    } catch (error) {
      write({ event: 'error', message: `The sandbox runtime failed on a ${request.type} request: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  readline.createInterface({ input }).on('line', (line) => {
    if (line.trim() === '') return;
    let raw: unknown;

    try {
      raw = JSON.parse(line);
    } catch {
      write({ event: 'error', message: `Not a JSON line: ${line.slice(0, 200)}` });

      return;
    }

    const parsed = RuntimeRequestSchema.safeParse(raw);

    if (!parsed.success) {
      write({ event: 'error', message: `Not a protocol 1 request: ${line.slice(0, 200)}` });

      return;
    }

    // Requests run concurrently; this process outlives its stdin while an exec runs, so the exec still records its end.
    void answer(parsed.data);
  });
}
