import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { redact, redactJson } from '@teamai/shared/redact';
import { CANCEL_FAILED, PromptResultSchema, RuntimeRequestSchema, type Can, type ExecRequestSchema, type OpenRequestSchema, type OpId, type OpState, type PromptRequestSchema, type RuntimeFailure, type RuntimeMessage, type RuntimeRequest } from '@teamai/runtime-protocol';
import type { z } from 'zod';
import type { ExecRecord, Journal, Outcome, PlaceRecord } from './journal.js';
import { EVIDENCE_DIR, inEvidenceDir, judgeOf, offersSignedIn, NO_JUDGE_CREDENTIAL } from './judge.js';
import { parseOptions, type SandboxOptions } from './options.js';
import { sandboxName, unreachable, type Provider } from './provider.js';

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

/** How long an exec this process runs gets to end once its sandbox was stopped, before its cancel is answered unconfirmed. */
const CONFIRM_MS = 4_000;

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
  // Until an init succeeds, requests are answered from the journal, over a provider that reaches nothing.
  let ready: Ready = { provider: unreachable({ code: 'runtime_failed', message: 'The sandbox runtime has not been initialized: teamai sends init first.' }), can: {} };
  /** The ops this process runs, each with what resolves once its end is written. */
  const running = new Map<OpId, { ended: Promise<void>; end: () => void }>();
  /** The ops whose stop this process asked for and has not confirmed or failed yet, so a second cancel starts no second stop. */
  const pendingStops = new Set<OpId>();
  /** The ops this process answers but does not run, each with its handle and what writes its end, once. */
  const followers = new Map<OpId, { handle: string; end: (outcome: Outcome) => void }>();

  const claim = (op: OpId): void => {
    let end = (): void => {};
    const ended = new Promise<void>((resolve) => { end = resolve; });
    running.set(op, { ended, end });
  };

  const release = (op: OpId): void => {
    running.get(op)?.end();
    running.delete(op);
  };

  /**
   * Ends `op`, which this process claimed: keeps `kept` (its outcome as the journal holds it), then writes `outcome`.
   * Only an op's first end counts, so an exec that ends after its cancel already failed it writes nothing more, and an
   * op ends even when keeping it throws. An op another process failed, or one `close` forgot, is not kept again.
   */
  const finish = (op: OpId, handle: string, outcome: Outcome, kept: Outcome = outcome): void => {
    if (!running.has(op)) return;

    try {
      const record = journal.exec(op);

      if (record !== undefined && record.outcome === undefined) journal.saveExec(op, { handle, runner: process.pid, outcome: kept });
    } finally {
      release(op);
      write(terminal(op, outcome));
    }
  };

  /**
   * An op with no outcome is running, wherever it runs: the runtime process that ran it may be gone, but what it started
   * in the sandbox may still run (#1717: only `running`, or `failed` with `cancel_failed`, may still run). Only a stop the
   * provider confirmed ends it.
   */
  const stateOf = (exec: Journaled): OpState => (exec.outcome ? { op: exec.op, ...exec.outcome } : { op: exec.op, state: 'running' });

  /** Writes the end of an op this process does not run: through its follower here when it has one. */
  const conclude = (op: OpId, outcome: Outcome): void => {
    const follower = followers.get(op);

    if (follower) follower.end(outcome);
    else write(terminal(op, outcome));
  };

  /** The place's sandbox: the id the journal kept, or the one its labels find when a runtime died before keeping it. */
  const sandboxOf = async (place: PlaceRecord, provider: Provider): ReturnType<Provider['find']> => (place.id === undefined ? provider.find(place) : { ok: true, id: place.id });

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

    if (!found.ok) {
      write({ op, event: 'failed', failure: found.failure });

      return;
    }

    const created = found.id === undefined ? await provider.create(key, view) : { ok: true as const, id: found.id };

    if (!created.ok) {
      write({ op, event: 'failed', failure: created.failure });

      return;
    }

    journal.savePlace(handle, { ...key, id: created.id });
    write({ op, event: 'ready', display: provider.display(key) });
  };

  /**
   * Answers an op another runtime process started, or one whose process is gone: with its outcome once the journal holds
   * one, or once a stop or a close here ends it. Its polling never keeps this process alive once teamai is gone.
   */
  const follow = (op: OpId, handle: string): Promise<void> => new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;

    const end = (outcome: Outcome): void => {
      clearTimeout(timer);
      followers.delete(op);
      write(terminal(op, outcome));
      resolve();
    };

    const look = (): void => {
      try {
        const now = journal.exec(op);

        // A close forgot it once its sandbox, and whatever ran there, was removed.
        if (now === undefined) end({ state: 'cancelled' });
        else if (now.outcome) end(now.outcome);
        else timer = setTimeout(look, FOLLOW_MS).unref();
      } catch (error) {
        followers.delete(op);
        reject(error);
      }
    };

    followers.set(op, { handle, end });
    look();
  });

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

    if (running.has(op) || followers.has(op)) {
      // Its end is written when it ends, under the same id.
      write({ op, event: 'accepted' });

      return Promise.resolve();
    }

    if (record) {
      write({ op, event: 'accepted' });

      return follow(op, record.handle);
    }

    return undefined;
  };

  const exec = async (request: ExecRequest, provider: Provider): Promise<void> => {
    const { op, handle } = request;
    const replayed = replay(op);

    if (replayed) return replayed;

    // Claimed before the first await, so the same id sent again meanwhile is answered by this run.
    claim(op);
    const place = journal.place(handle);

    if (place?.confined) {
      finish(op, handle, { state: 'failed', failure: { code: 'bad_request', message: `Handle ${handle} is a judge's place, which runs only its confined prompt, never an exec.` } });

      return;
    }

    const found = place && await sandboxOf(place, provider);

    if (found?.ok === false) {
      finish(op, handle, { state: 'failed', failure: found.failure });

      return;
    }

    const id = found?.id;

    if (id === undefined) {
      finish(op, handle, { state: 'failed', failure: { code: 'runtime_gone', message: `No sandbox is open under handle ${handle}.` } });

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
    finish(op, handle, outcome, outcome.state === 'exited' ? { ...outcome, stdout: redact(stdout, { envSecrets: request.credentials, patterns: false }) } : outcome);
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

    const { judges } = provider;

    if (!judges || !can.confined?.some((offer) => offer.tools.includes(lease.tool))) {
      write({ op, event: 'failed', failure: { code: 'tool_unavailable', message: `The sandbox offers no ${lease.tool} judge: it judges on ${can.confined?.flatMap((offer) => offer.tools).join(', ') || 'no tool'}.` } });

      return;
    }

    const chosen = judgeOf(lease.tool, request.credentials);

    if (!chosen.ok) {
      write({ op, event: 'failed', failure: chosen.failure });

      return;
    }

    // Claimed before the first await, as an exec is.
    claim(op);
    journal.saveExec(op, { handle, runner: process.pid });
    write({ op, event: 'accepted' });
    const { judge } = chosen;

    // The journal never holds a credential the tool echoed into its reply. Only its strings are masked: a setting such
    // as `1` leaves a reply's numbers as they are.
    const settle = (outcome: Outcome): void => finish(op, handle, outcome, outcome.state === 'finished' ? { ...outcome, result: PromptResultSchema.parse(redactJson(outcome.result, request.credentials)) } : outcome);

    const created = await judges.create(place, { dir: confined.dir, hosts: judge.hosts });

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

  /**
   * Stops what `op` runs, and when this process runs it, waits for its process to end: why the stop is not confirmed,
   * or undefined once it is. A step's stop answers within STOP_MS + CONFIRM_MS, inside teamai's 15 s; a judge's
   * removal, and the lookup of a sandbox whose id the journal lacks, have no bound of their own.
   */
  const stopOf = async (op: OpId, { handle }: ExecRecord, provider: Provider): Promise<RuntimeFailure | undefined> => {
    const place = journal.place(handle);
    const found = place ? await sandboxOf(place, provider) : { ok: true as const, id: undefined };

    // A judge's container is removed, so an exec still on its way to the engine has nothing to start in; a step's
    // restarts, ready for the step's next exec. One the engine cannot look up is not stopped.
    const stopped = !found.ok ? found : found.id === undefined ? { ok: true as const } : place?.confined ? await provider.destroy(found.id) : await provider.stop(found.id);

    if (!stopped.ok) return stopped.failure;
    const ended = running.get(op)?.ended;

    if (ended === undefined) return undefined;
    let timer: NodeJS.Timeout | undefined;
    const isEnded = await Promise.race([ended.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), CONFIRM_MS); })]);
    clearTimeout(timer);

    return isEnded ? undefined : { code: CANCEL_FAILED, message: `Sandbox ${handle} was stopped, but exec ${op} did not end within ${CONFIRM_MS / 1000} s after, so it may still run. Run \`teamai workflow cancel ${place?.run ?? '<run>'}\` again to stop it.` };
  };

  const cancel = async (op: OpId, provider: Provider): Promise<void> => {
    const record = journal.exec(op);
    // A stop this runtime could not confirm is the one outcome a later cancel replaces.
    const isRetried = record?.outcome?.state === 'failed' && record.outcome.failure.code === CANCEL_FAILED;

    if (!record || (record.outcome !== undefined && !isRetried) || pendingStops.has(op)) return;
    journal.cancel(op);

    // A retried stop clears the failure the stop before it left, before anything else is read: until it is confirmed or
    // fails, a reattach or a resent id reads the op running, in this process or any other, never that old failure.
    if (isRetried) journal.saveExec(op, { handle: record.handle, runner: record.runner });
    pendingStops.add(op);

    try {
      const unconfirmed = await stopOf(op, record, provider);

      // One the engine could not stop may still run: it ends failed now, with why, wherever it runs, and its place stays
      // this attempt's for close to remove. When it ends after all, that end is not a second outcome (finish).
      if (unconfirmed !== undefined) {
        const outcome: Outcome = { state: 'failed', failure: { code: CANCEL_FAILED, message: unconfirmed.message } };

        if (running.has(op)) {
          finish(op, record.handle, outcome);

          return;
        }

        // An exec that ended on its own meanwhile keeps that end, and one a close forgot is not kept again.
        const now = journal.exec(op);

        if (now === undefined || now.outcome !== undefined) return;
        journal.saveExec(op, { handle: record.handle, runner: record.runner, outcome });
        conclude(op, outcome);

        return;
      }

      // The engine confirmed the stop, so whatever ran is gone: an exec this process ran has ended cancelled already, and
      // any other ends cancelled here.
      const now = journal.exec(op);

      if (now === undefined || now.outcome !== undefined) return;
      journal.saveExec(op, { handle: record.handle, runner: record.runner, outcome: { state: 'cancelled' } });
      conclude(op, { state: 'cancelled' });
    } finally {
      pendingStops.delete(op);
    }
  };

  /**
   * Answers from the journal alone, never the provider, so a stop is read while the engine is down: gone only when the
   * journal holds no place of that handle. A sandbox removed meanwhile is found absent by the next exec or close.
   */
  const reattach = (handle: string, provider: Provider): void => {
    const place = journal.place(handle);

    if (place === undefined) {
      write({ event: 'gone', handle });

      return;
    }

    write({ event: 'alive', handle, ops: journal.opsOf(handle).map(({ op, record }) => stateOf({ op, ...record })), display: provider.display(place) });
  };

  const close = async (handle: string, provider: Provider): Promise<void> => {
    const place = journal.place(handle);

    // What still runs there is stopped with the sandbox, and ends as cancelled before the place is answered closed.
    const stopping = journal.opsOf(handle).flatMap(({ op }) => {
      const run = running.get(op);

      if (run === undefined) return [];
      journal.cancel(op);

      return [run.ended];
    });

    const found = place ? await sandboxOf(place, provider) : { ok: true as const, id: undefined };
    const destroyed = !found.ok ? found : found.id === undefined ? { ok: true as const } : await provider.destroy(found.id);
    const removed = destroyed.ok && place?.confined && provider.judges ? await provider.judges.release(place) : destroyed;

    if (!removed.ok) {
      // The journal keeps the place, so a later close or reattach of this handle still finds the sandbox.
      write({ event: 'close_failed', handle, failure: removed.failure });

      return;
    }

    await Promise.all(stopping);

    // The sandbox is gone, so an op answered here but run by no live process ended with it.
    for (const follower of followers.values()) if (follower.handle === handle) follower.end({ state: 'cancelled' });
    journal.forget(handle);
    write({ event: 'closed', handle });
  };

  /**
   * `credentials`: the names the definition gives this runtime; an older teamai sends none, and every judge is offered.
   * In `recover` mode teamai only stops and closes what the journal holds: nothing is checked or offered, and the
   * provider is reached only when a cancel or a close needs it.
   */
  const init = async ({ options, credentials, mode }: Extract<RuntimeRequest, { type: 'init' }>): Promise<void> => {
    const parsed = parseOptions(options);

    if (!parsed.ok) {
      ready = { provider: unreachable(parsed.failure), can: {} };
      write({ type: 'init', ok: false, error: parsed.failure });

      return;
    }

    const provider = providerFor(parsed.options);

    if (mode === 'recover') {
      ready = { provider, can: {} };
      write({ type: 'init', ok: true, can: {} });

      return;
    }

    const offered = await provider.offer();

    if (!offered.ok) {
      ready = { provider: unreachable(offered.failure), can: {} };
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
      await init(request);

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
      const message = `The sandbox runtime failed on a ${request.type} request: ${error instanceof Error ? error.message : String(error)}`;
      const failure = { code: 'runtime_failed', message };

      // teamai waits for the answer to each request but a cancel: it gets this failure as that request's own reply,
      // never silence, and never an error line, which would fail every other request it waits on.
      switch (request.type) {
        case 'init':
          write({ type: 'init', ok: false, error: failure });

          return;
        case 'exec':
        case 'prompt':
          // One this process claimed ends failed; one that threw before it was claimed is answered here.
          if (running.has(request.op)) finish(request.op, request.handle, { state: 'failed', failure });
          else write({ op: request.op, event: 'failed', failure });

          return;
        case 'open':
          write({ op: request.op, event: 'failed', failure });

          return;
        case 'collect':
        case 'reattach':
        case 'close':
          // A journal it cannot read is not a place it knows is gone, and the place stays for a later close.
          write({ event: 'failed', handle: request.handle, failure });

          return;
        case 'cancel':
          // Its outcome is the operation's end, which teamai reads on reattach, and bounds on its own.
          return;
        default: {
          const unhandled: never = request;

          return unhandled;
        }
      }
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
