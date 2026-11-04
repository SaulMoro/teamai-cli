import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { redact } from '@teamai/shared/redact';
import { PromptResultSchema, RuntimeRequestSchema, type Can, type ExecRequestSchema, type InitCredentials, type OpenRequestSchema, type OpId, type OpState, type PromptRequestSchema, type RuntimeFailure, type RuntimeMessage, type RuntimeOptions, type RuntimeRequest } from '@teamai/runtime-protocol';
import type { z } from 'zod';
import type { ExecRecord, Journal, Outcome, PlaceRecord } from './journal.js';
import { EVIDENCE_DIR, inEvidenceDir, judgeOf, offersSignedIn, NO_JUDGE_CREDENTIAL } from './judge.js';
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
//  `failed`: this runtime runs the tool teamai builds, as an exec. A confined `prompt` is a judge: its place opens with
//  no view, and the prompt runs its tool in a sandbox that sees only the prompt's directory (judge.ts).
//

const RUN_ID = /^r[0-9a-f]{8}(?:[0-9a-f]{8})?$/;
const ATTEMPT_ID = /^a[0-9a-f]{8}$/;

type OpenRequest = z.infer<typeof OpenRequestSchema>;

type ExecRequest = z.infer<typeof ExecRequestSchema>;

type PromptRequest = z.infer<typeof PromptRequestSchema>;

/** What `init` settled: the provider, and what it offered. */
interface Ready {
  provider: Provider;
  can: Can;
}

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

/**
 * Whether `hostname`, as a URL spells it, is this machine itself: localhost, 127.0.0.0/8, ::1 (also IPv4-mapped), or
 * the unspecified 0.0.0.0 and ::, which a client connects to as this machine.
 */
function isThisMachine(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '');

  return host === 'localhost' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '0.0.0.0'
    || ['[::1]', '[::]'].includes(host) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
}

/**
 * Why a credential that is a URL on this machine itself is refused: inside a container, that address is the
 * container's own, so the tool would fail to connect. The message names the variable, never its value.
 */
function loopbackRefused(credentials: Record<string, string>): RuntimeFailure | undefined {
  const name = Object.entries(credentials).find(([, value]) => URL.canParse(value) && isThisMachine(new URL(value).hostname))?.[0];

  return name === undefined ? undefined : {
    code: 'bad_option', key: `credentials.${name}`,
    message: `${name} points at this machine itself, which no container reaches: inside one, that address is the container's own. On Docker Desktop, write its host as host.docker.internal (Podman: host.containers.internal); on Linux, use an address of this machine the container can reach. Then start again.`,
  };
}

function terminal(op: OpId, outcome: Outcome): RuntimeMessage {
  switch (outcome.state) {
    case 'exited':
      return { op, event: 'exited', code: outcome.code, stdout: outcome.stdout };
    case 'finished': {
      const { state: _state, ...finished } = outcome;

      return { op, event: 'finished', ...finished };
    }

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
  let ready: Ready | undefined;
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

  const open = async ({ op, run, attempt, view, credentials }: OpenRequest, provider: Provider): Promise<void> => {
    if (!RUN_ID.test(run) || !ATTEMPT_ID.test(attempt)) {
      write({ op, event: 'failed', failure: { code: 'bad_request', message: `Open ${op} names run "${run}" and attempt "${attempt}", which are not teamai ids.` } });

      return;
    }

    const refused = loopbackRefused(credentials);

    if (refused) {
      write({ op, event: 'failed', failure: refused });

      return;
    }

    const key = { run, attempt };
    const handle = sandboxName(key);

    // A judge's place: nothing of the host, and no sandbox until its prompt names the directory.
    if (view === undefined) {
      if (Object.keys(credentials).length === 0) {
        write({ op, event: 'failed', failure: NO_JUDGE_CREDENTIAL });

        return;
      }

      journal.savePlace(handle, { ...key, confined: true });
      write({ op, event: 'accepted', handle });
      write({ op, event: 'ready', display: provider.display(key) });

      return;
    }

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

  /**
   * Answers an id this runtime has seen, with its outcome or once it has one, without running it again; undefined for
   * a new id. It decides without awaiting, so the caller claims a new id before anything else is read.
   */
  const replay = (op: OpId): Promise<void> | undefined => {
    const record = journal.exec(op);

    if (record?.outcome) {
      write({ op, event: 'accepted' });
      write(terminal(op, record.outcome));

      return Promise.resolve();
    }

    if (running.has(op)) {
      // Its end is written when it ends, under the same id.
      write({ op, event: 'accepted' });

      return Promise.resolve();
    }

    if (record) {
      write({ op, event: 'accepted' });

      return follow({ op, ...record });
    }

    return undefined;
  };

  const exec = async (request: ExecRequest, provider: Provider): Promise<void> => {
    const { op, handle } = request;
    const replayed = replay(op);

    if (replayed) return replayed;

    // Claimed before the first await, so the same id sent again meanwhile is answered by this run.
    running.add(op);
    const place = journal.place(handle);
    const id = place && await sandboxOf(place, provider);

    if (place?.confined) {
      running.delete(op);
      write({ op, event: 'failed', failure: { code: 'bad_request', message: `Handle ${handle} is a judge's place, which runs only its confined prompt, never an exec.` } });

      return;
    }

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

  /** Runs a judge: its tool in a sandbox of its own that sees only the prompt's directory, read-only. */
  const prompt = async (request: PromptRequest, { provider, can }: Ready): Promise<void> => {
    const { op, handle, confined, lease } = request;

    if (confined === undefined) {
      write({ op, event: 'failed', failure: { code: 'prompt_unsupported', message: 'The sandbox runtime runs the tool teamai builds, as an exec, and launches no agent of its own.' } });

      return;
    }

    const replayed = replay(op);

    if (replayed) return replayed;
    const place = journal.place(handle);

    if (!place?.confined) {
      write({ op, event: 'failed', failure: { code: 'bad_request', message: `Prompt ${op} is confined, and handle ${handle} is not a judge's place. Open one with no view first.` } });

      return;
    }

    const chosen = can.confined?.some((offer) => offer.tools.includes(lease.tool))
      ? judgeOf(lease.tool, request.credentials)
      : { ok: false as const, failure: { code: 'tool_unavailable', message: `The sandbox's image offers no ${lease.tool} judge: it judges on ${can.confined?.flatMap((offer) => offer.tools).join(', ') || 'no tool'}.` } };

    if (!chosen.ok) {
      write({ op, event: 'failed', failure: chosen.failure });

      return;
    }

    // Claimed before the first await, as an exec is.
    running.add(op);
    journal.saveExec(op, { handle, runner: process.pid });
    write({ op, event: 'accepted' });
    const { judge } = chosen;

    const settle = (outcome: Outcome): void => {
      // The journal never holds a credential the tool echoed into its reply.
      const kept: Outcome = outcome.state === 'finished' ? { ...outcome, result: PromptResultSchema.parse(JSON.parse(redact(JSON.stringify(outcome.result), { envSecrets: request.credentials, patterns: false }))) } : outcome;
      journal.saveExec(op, { handle, runner: process.pid, outcome: kept });
      running.delete(op);
      write(terminal(op, outcome));
    };

    const created = await provider.createJudge(place, { dir: confined.dir, hosts: judge.hosts });

    if (!created.ok) {
      settle(journal.isCancelled(op) ? { state: 'cancelled' } : { state: 'failed', failure: created.failure });

      return;
    }

    journal.savePlace(handle, { ...place, id: created.id });

    if (journal.isCancelled(op)) {
      settle({ state: 'cancelled' });

      return;
    }

    const launch = judge.tool.launch({ ...lease, prompt: inEvidenceDir(lease.prompt, confined.dir) }, confined);
    // Only the credentials the judge's own tool reads, less any the prompt withholds.
    const scoped = Object.fromEntries(Object.entries(judge.credentials).filter(([name]) => !request.unset.includes(name)));
    let stdout = '';
    let stderr = '';

    const end = await provider.exec(created.id, { argv: launch.argv, env: { ...scoped, ...launch.env, ...request.env }, unset: request.unset, cwd: EVIDENCE_DIR }, (stream, data) => {
      if (stream === 'stdout') stdout += data;
      else stderr = `${stderr}${data}`.slice(-4000);
    });

    if (journal.isCancelled(op)) {
      settle({ state: 'cancelled' });

      return;
    }

    if (end.kind === 'failed') {
      settle({ state: 'failed', failure: end.failure });

      return;
    }

    const reading = judge.tool.read(stdout);
    const masked = (text: string): string => redact(text, { envSecrets: request.credentials, patterns: false });

    if (end.code !== 0) {
      const lastStderr = stderr.trim().split('\n').at(-1) || 'it printed nothing on stderr';
      settle({ state: 'failed', failure: { code: 'tool_failed', message: masked(`${lease.tool} exited with code ${end.code} in the judge's container: ${reading.ok ? lastStderr : reading.message}`) } });

      return;
    }

    if (!reading.ok) {
      settle({ state: 'failed', failure: { code: 'tool_failed', message: masked(`${lease.tool} ended in the judge's container without a reply: ${reading.message}`) } });

      return;
    }

    settle({ state: 'finished', session: { tool: lease.tool, id: reading.session }, result: reading.result, ...(reading.usage && { usage: reading.usage }), confined: { level: 'verified', access: judge.tool.access } });
  };

  const cancel = async (op: OpId, provider: Provider): Promise<void> => {
    const record = journal.exec(op);

    if (!record || record.outcome) return;
    journal.cancel(op);
    const place = journal.place(record.handle);
    const id = place && await sandboxOf(place, provider);

    // A judge's container is removed, so an exec still on its way to the engine has nothing to start in; a step's
    // restarts, ready for the step's next exec.
    if (id !== undefined && place?.confined) await provider.destroy(id);
    else if (id !== undefined) await provider.stop(id);

    // An exec whose runtime process is gone ends here: no process of this runtime reports it.
    if (!running.has(op) && !alive(record.runner)) write(terminal(op, settleOrphan({ op, ...record })));
  };

  const reattach = async (handle: string, provider: Provider): Promise<void> => {
    const place = journal.place(handle);

    // A judge's place has no sandbox until its prompt, and keeps its prompt's outcome after.
    if (!place || (!place.confined && (await provider.find(place)) === undefined)) {
      journal.forget(handle);
      write({ event: 'gone', handle });

      return;
    }

    write({ event: 'alive', handle, ops: journal.opsOf(handle).map(({ op, record }) => stateOf({ op, ...record })), display: provider.display(place) });
  };

  const close = async (handle: string, provider: Provider): Promise<void> => {
    const place = journal.place(handle);
    const id = place && await sandboxOf(place, provider);
    const destroyed = id === undefined ? { ok: true as const } : await provider.destroy(id);
    const removed = destroyed.ok && place?.confined ? await provider.releaseJudge(place) : destroyed;

    if (!removed.ok) {
      // The journal keeps the place, so a later close or reattach of this handle still finds the sandbox.
      write({ event: 'close_failed', handle, failure: removed.failure });

      return;
    }

    journal.forget(handle);
    write({ event: 'closed', handle });
  };

  /** `credentials`: the names the definition gives this runtime; an older teamai sends none, and every judge is offered. */
  const init = async (options: RuntimeOptions, credentials: InitCredentials | undefined): Promise<void> => {
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

    const { confined: offers = [], ...rest } = offered.can;
    const judges = credentials === undefined ? offers : offersSignedIn(offers, credentials.env);
    const can: Can = { ...rest, ...(judges.length > 0 && { confined: judges }) };
    ready = { provider, can };
    write({ type: 'init', ok: true, can, ...(can.confined && { confinedPrompt: true }) });
  };

  const dispatch = async (request: RuntimeRequest): Promise<void> => {
    if (request.type === 'init') {
      await init(request.options, request.credentials);

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
        return prompt(request, ready);
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
