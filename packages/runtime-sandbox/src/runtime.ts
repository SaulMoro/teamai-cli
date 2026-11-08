import path from 'node:path';
import type { Readable } from 'node:stream';
import { opLedger } from '@teamai/runtime-kit/ledger';
import { serveRuntime } from '@teamai/runtime-kit/serve';
import { redact, redactJson } from '@teamai/shared/redact';
import { CANCEL_FAILED, PromptResultSchema, type Can, type ExecRequestSchema, type InitInstance, type OpenRequestSchema, type OpId, type OpState, type PromptRequestSchema, type RuntimeFailure, type RuntimeMessage, type RuntimeRequest } from '@teamai/runtime-protocol';
import type { z } from 'zod';
import { listen, placeOf, socketPathOf, type Answering, type AttemptSocket, type OuterHandle } from './attempt-socket.js';
import type { ExecRecord, Journal, Outcome, PlaceRecord } from './journal.js';
import { EVIDENCE_DIR, inEvidenceDir, judgeOf, noJudgeCredential, offersSignedIn } from './judge.js';
import { maskedAsGiven, onThisMachine, rewrittenMasks, toAlias } from './loopback.js';
import { parseOptions, type SandboxOptions } from './options.js';
import { COMMAND_MS, handleOf, unreachable, type HostRoute, type PlaceKey, type Provider } from './provider.js';
import type { UnusedGateways } from './sign-in.js';
import { removeLeftScratch } from './warm.js';
import { heldProbe, LAUNCHABLE } from './providers/cli.js';
import { isWithin, realOf } from './providers/native.js';

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

/**
 * What `init` settled: the provider, what it offered, the member's gateways a login it keeps replaces, and each instance
 * teamai passed, by its name, which teamai gives as the `tool` of an instance's open.
 */
interface Ready {
  provider: Provider;
  can: Can;
  host: HostRoute;
  unusedGateways: UnusedGateways;
  instances: ReadonlyMap<string, InitInstance>;
}

/** The host route of a runtime that offered no sandbox: teamai opens no attempt on it. */
const NOT_OFFERED: HostRoute = { ok: false, refusal: 'This sandbox runtime offered no sandbox, so it opens none.' };

/** The answer to a `check` init, which asks only whether a run could start now, signing in, writing and launching nothing. */
const CHECK_UNSUPPORTED: RuntimeFailure = {
  code: 'check_unsupported',
  message: 'The sandbox runtime cannot tell whether a run could start without starting a sandbox, which a check may not do, so teamai offers no start on it from here.',
};

/** How often an exec another runtime process runs is looked at, to answer its outcome. */
const FOLLOW_MS = 100;

/**
 * How long a stop, or a whole close, may take before it is answered unconfirmed (#1717: "A runtime confirms a stop, or
 * a whole `close` (removal included, its stops confirmed in parallel), within 10 s"), inside teamai's own 15 s.
 */
const BOUND_MS = 10_000;

/** How long a stopped step's exec may take to end before its sandbox is stopped again, within BOUND_MS. */
const RESTOP_MS = 1_000;

/**
 * How long a sweep of what earlier runs left may take before it says so on stderr. Nothing waits for it, so its bound is
 * its own: past its slowest sound run, a list then a judge's container, filter and network removed in turn, each within
 * COMMAND_MS.
 */
const SWEEP_MS = 5 * COMMAND_MS;

/** What `work` settled with, or `late` once `deadline` (a Date.now() time) came first. `work` goes on either way. */
async function by<T>(deadline: number, work: Promise<T>): Promise<{ kind: 'done'; value: T } | { kind: 'late' }> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<{ kind: 'late' }>((resolve) => { timer = setTimeout(() => resolve({ kind: 'late' }), Math.max(0, deadline - Date.now())); });

  try {
    return await Promise.race([work.then((value) => ({ kind: 'done' as const, value })), late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RuntimeDeps {
  input: Readable;
  /** Writes one protocol line; once teamai stops reading, a line goes nowhere and the runtime goes on. */
  write: (message: RuntimeMessage) => void;
  journal: Journal;
  /** Writes one line for a person, never a protocol line: a warning on stderr. */
  warn: (line: string) => void;
  /** The provider the options choose. */
  provider: (options: SandboxOptions) => Provider;
  /**
   * The environment teamai started this runtime with, the member's: a hint names the sign-in it sets. It serves only
   * when teamai started it (`RUNTIME_PROTOCOL_ENV`), and removes that variable, so nothing it starts serves.
   */
  env: NodeJS.ProcessEnv;
}

/** One exec as the journal keeps it, with its id. */
type Journaled = { op: OpId } & ExecRecord;

/**
 * Why an attempt whose credentials point at this machine itself cannot open on `provider`, checked before anything is
 * created or journaled: a sandbox that has no name for this machine, or, on sbx, a policy that does not let a sandbox
 * reach that port. A keyed message names the variable, never its value.
 */
async function hostUnreachable(credentials: Record<string, string>, { provider, host }: Ready): Promise<RuntimeFailure | undefined> {
  const local = onThisMachine(credentials);
  const [first] = local;

  if (first === undefined) return undefined;

  if (!host.ok) return { code: 'bad_option', key: `credentials.${first.name}`, message: `${first.name} points at this machine itself, which a sandbox does not reach at that address. ${host.refusal} Use an address of this machine the sandbox can reach, and start again.` };

  for (const { name, port } of local) {
    const reached = await provider.reachesHost?.(port, name);

    if (reached?.ok === false) return reached.failure;
  }

  return undefined;
}

/**
 * Serves runtime protocol 1 on `input` through the runtime kit, and resolves to the exit status once teamai closes it:
 * an exec still running keeps the process alive, and records its end.
 */
export function serve({ input, write: send, journal, warn, provider: providerFor, env }: RuntimeDeps): Promise<number> {
  // Until an init succeeds, requests are answered from the journal, over a provider that reaches nothing.
  let ready: Ready = { provider: unreachable({ code: 'runtime_failed', message: 'The sandbox runtime has not been initialized: teamai sends init first.' }), can: {}, host: NOT_OFFERED, unusedGateways: {}, instances: new Map() };
  /** The ops this process runs, each with what resolves once its end is written. */
  const running = new Map<OpId, { ended: Promise<void>; end: () => void }>();
  /** The ops whose stop this process asked for and has not confirmed or failed yet, so a second cancel starts no second stop. */
  const pendingStops = new Set<OpId>();
  /** The ops this process answers but does not run, each with its handle and what stops following it. */
  const followers = new Map<OpId, { handle: string; stop: () => void }>();
  /**
   * The sandboxes and judges' containers this process is creating, each with its place's handle and what settles once
   * that creation did.
   */
  const creating = new Set<{ handle: string; settled: Promise<unknown> }>();
  /** The tools whose unused gateway this process told the member about, so it says so once per drive. */
  const toldGateway = new Set<string>();
  /**
   * The attempt sockets this process serves, by place, each with the step's credentials its grants carry and the names
   * they go without: those of the place's open, or of teamai's reattach, in memory only; undefined in a runtime that
   * restarted until a reattach brings them.
   */
  const sockets = new Map<string, { socket: AttemptSocket; credentials: Record<string, string> | undefined; unset: string[] }>();

  /** Every line goes through the ledger, which writes each op's one end. */
  const ledger = opLedger({ name: 'sandbox', write: send });
  const { write } = ledger;

  /** Writes `op`'s one end: `outcome`. */
  const endWith = (op: OpId, outcome: Outcome): void => ledger.end({ op, ...outcome });

  /** Ends `op` failed with `failure`, before this process ran anything of it. */
  const fail = (op: OpId, failure: RuntimeFailure): void => endWith(op, { state: 'failed', failure });

  const claim = (op: OpId): void => {
    let end = (): void => {};
    const ended = new Promise<void>((resolve) => { end = resolve; });
    running.set(op, { ended, end });
  };

  /** Awaits `work`, a creation in `handle`'s place, which a close of that place waits for, however it settles. */
  const creation = async <T>(handle: string, work: Promise<T>): Promise<T> => {
    const entry = { handle, settled: work.catch(() => undefined) };
    creating.add(entry);

    try {
      return await work;
    } finally {
      creating.delete(entry);
    }
  };

  const release = (op: OpId): void => {
    running.get(op)?.end();
    running.delete(op);
  };

  /**
   * Keeps `kept` as op's outcome, unless the journal holds one already or `close` forgot the op; throws when the journal
   * cannot be read or written.
   */
  const keep = (op: OpId, kept: Outcome): void => {
    const record = journal.exec(op);

    if (record !== undefined && record.outcome === undefined) journal.saveExec(op, { ...record, outcome: kept });
  };

  /**
   * Ends `op`, which this process claimed, with its true outcome once the journal keeps `kept`: one the journal cannot
   * keep is answered all the same, and the ledger remembers it until the place closes. Only an op's first end counts,
   * so an exec that ends after its cancel already failed it writes nothing more.
   */
  const finish = (op: OpId, outcome: Outcome, kept: Outcome = outcome): void => {
    if (!running.has(op)) return;
    ledger.settle({ op, ...outcome }, () => keep(op, kept));
    release(op);
  };

  /**
   * An op with no outcome is running, wherever it runs: the runtime process that ran it may be gone, but what it started
   * in the sandbox may still run (#1717: only `running`, or `failed` with `cancel_failed`, may still run). Only a stop the
   * provider confirmed ends it.
   */
  const stateOf = (exec: Journaled): OpState => (exec.outcome ? { op: exec.op, ...exec.outcome } : { op: exec.op, state: 'running' });

  /** `credentials` as a sandbox gets them: a URL on this machine itself at the name `host` gives it there. */
  const inSandbox = (credentials: Record<string, string>, host: HostRoute): Record<string, string> => (host.ok ? toAlias(credentials, host.alias) : credentials);

  /**
   * Writes the end of an op this process does not run, and stops following it here. With `keepIt`, the end is answered
   * once that kept it in the journal, or all the same, remembered by the ledger, when it could not.
   */
  const conclude = (op: OpId, outcome: Outcome, keepIt?: () => void): void => {
    followers.get(op)?.stop();

    if (keepIt === undefined) endWith(op, outcome);
    else ledger.settle({ op, ...outcome }, keepIt);
  };

  /** The place's sandbox: the id the journal kept, or the one its labels find when a runtime died before keeping it. */
  const sandboxOf = async (place: PlaceRecord, provider: Provider): ReturnType<Provider['find']> => (place.id === undefined ? provider.find(place) : { ok: true, id: place.id });

  /**
   * Removes what a runtime killed while the engine created a sandbox can leave: a sandbox of this journal whose attempt
   * it no longer records, because a close found nothing yet and forgot the place before the sandbox landed, and a judge's
   * filter and network with it. The provider tells this journal's sandboxes by their `teamai.owner` label, or on sbx by
   * their name's prefix. A sandbox whose attempt has a record (a create in flight included, since a place is saved before
   * its create), one that names no attempt, and another journal's are left alone. A failed list or removal is one
   * warning, never the open's failure, and so is anything it throws. It starts once its open is accepted and nothing
   * waits for it: not that open, nor a cancel or a close.
   */
  const sweep = async (provider: Provider): Promise<void> => {
    const { owned } = provider;

    if (owned === undefined) return;

    // Nothing awaits it, so a throw would end this process, and the execs it runs with it.
    const removeOrphans = async (): Promise<void> => {
      try {
        const listed = await owned();

        if (!listed.ok) {
          warn(`teamai-runtime-sandbox: warning: ${listed.failure.message}. Sandboxes an earlier run left stay until a later open.`);

          return;
        }

        const orphans = listed.sandboxes.filter((key) => {
          if (!RUN_ID.test(key.run) || !ATTEMPT_ID.test(key.attempt)) return false;

          try {
            return journal.place(handleOf(key)) === undefined;
          } catch {
            // A record it cannot read may be this attempt's: its sandbox stays.
            return false;
          }
        });

        // An attempt's containers (a judge's and its filter) go before its network, which is removed once.
        const byAttempt = new Map<string, { key: PlaceKey; ids: string[] }>();

        for (const { id, run, attempt } of orphans) {
          const handle = handleOf({ run, attempt });
          byAttempt.set(handle, { key: { run, attempt }, ids: [...(byAttempt.get(handle)?.ids ?? []), id] });
        }

        await Promise.all([...byAttempt.values()].map(async ({ key, ids }) => {
          const destroyed = await Promise.all(ids.map((id) => provider.destroy(id)));
          // A step's container has no filter or network, so their removal finds nothing and succeeds.
          const removed = destroyed.find((done) => !done.ok) ?? (provider.judges ? await provider.judges.release(key) : { ok: true as const });

          if (!removed.ok) warn(`teamai-runtime-sandbox: warning: ${provider.display(key).label} was left by an earlier run, and ${removed.failure.message}`);
        }));

        await Promise.all((listed.leftWarm ?? []).map(async (id) => {
          const removed = await provider.destroy(id);

          if (!removed.ok) warn(`teamai-runtime-sandbox: warning: the scratch sandbox ${id} of a warm image was left by a runtime that stopped while it made it, and ${removed.failure.message}`);
        }));
        removeLeftScratch();
      } catch (error) {
        warn(`teamai-runtime-sandbox: warning: removing what an earlier run left failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    if ((await by(Date.now() + SWEEP_MS, removeOrphans())).kind === 'late') {
      warn(`teamai-runtime-sandbox: warning: removing what an earlier run left took over ${SWEEP_MS / 1000} s; it goes on, and holds no step.`);
    }
  };

  /**
   * Answers a wrapper's ask on `place`'s socket: how to start the tool it was called as in the attempt's sandbox, with
   * the step's credentials and the tool home variable at the attempt's tool home, or why not.
   */
  const answerOn = (place: string): Answering => async ({ tool, cwd }) => {
    const { provider, can, host, instances } = ready;
    const served = sockets.get(place);
    const credentials = served?.credentials;
    const unset = served?.unset ?? [];
    const record = journal.place(place);

    if (record?.outer === undefined || provider.client === undefined) return { ok: false, failure: { code: 'runtime_gone', message: `No sandbox is open for this attempt any more (${place}).` } };

    if (credentials === undefined) {
      return { ok: false, failure: { code: 'credentials_pending', message: 'The sandbox runtime restarted and has not got the step\'s credentials back yet: teamai sends them again when it reattaches the attempt. The step\'s app starts the tool again once it has.' } };
    }

    const worktree = realOf(record.outer.worktree);

    if (!isWithin(realOf(cwd), worktree)) {
      return { ok: false, failure: { code: 'isolation_unproven', message: `${cwd} is not in this attempt's worktree ${record.outer.worktree}, so its sandbox runs nothing for it.` } };
    }

    // The sandbox mounts the worktree at the path teamai named, which a symlink may lead to (/tmp on macOS).
    const at = path.join(record.outer.worktree, path.relative(worktree, realOf(cwd)));

    const instance = instances.get(tool);
    const base = instance?.tool ?? tool;
    const command = instance?.command ?? base;

    if (instance === undefined && !LAUNCHABLE.some((launchable) => launchable === tool)) {
      return { ok: false, failure: { code: 'tool_unsupported', message: `This sandbox runs ${LAUNCHABLE.join(', ')} and the instances teamai named at init, and not ${tool}.` } };
    }

    if (!(can.tools ?? []).includes(base)) {
      return { ok: false, failure: { code: 'tool_unsupported', message: `This sandbox does not offer ${base}: it cannot sign ${base} in there, or does not hold it. teamai said why when the run started.` } };
    }

    const found = await sandboxOf(record, provider);

    if (!found.ok) return found;

    if (found.id === undefined) return { ok: false, failure: { code: 'sandbox_failed', message: `The sandbox of attempt ${record.attempt} is not made yet, so it runs nothing for the tool.` } };
    const { id } = found;
    let held = '';

    const probed = await provider.exec(id, { argv: ['/bin/sh', ...heldProbe([command])], env: {}, unset: [], cwd: record.outer.worktree }, (stream, data) => {
      if (stream === 'stdout') held += data;
    });

    if (probed.kind === 'failed') return { ok: false, failure: probed.failure };

    if (!held.split('\n').includes(command)) {
      const { fields = {} } = provider.display(record);
      const where = fields.image !== undefined ? `image ${fields.image}` : fields.agent !== undefined ? `template ${fields.agent}` : provider.display(record).label;

      return { ok: false, failure: { code: 'tool_unsupported', message: `${command} is not installed in this sandbox (${where}). Add it to the image or template the sandbox starts from, or run the step with --driver local.` } };
    }

    // A credential the prompt goes without is not set, as an exec withholds it.
    const scoped = inSandbox(Object.fromEntries(Object.entries(credentials).filter(([name]) => !unset.includes(name))), host);
    const client = provider.client(id, { argv: [command], env: { ...scoped, ...record.outer.toolHome }, unset, cwd: at });

    return client.ok ? { ok: true, grant: { argv: client.argv, cwd: at, env: client.env, ...(client.signal && { signal: client.signal }) } } : client;
  };

  /**
   * Serves `place`'s socket at `socketPath` in this process, with `credentials` (undefined: not given yet) less the
   * names in `unset`, or gives it both when it serves it already.
   */
  const serveSocket = async ({ place, socketPath, credentials, unset }: { place: string; socketPath: string; credentials: Record<string, string> | undefined; unset: string[] }): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
    const served = sockets.get(place);

    if (served !== undefined) {
      if (credentials !== undefined) Object.assign(served, { credentials, unset });

      return { ok: true };
    }

    const listened = await listen(socketPath, answerOn(place));

    if (!listened.ok) return listened;
    sockets.set(place, { socket: listened.socket, credentials, unset });

    return { ok: true };
  };

  /** Stops serving `place`'s socket and removes it, once the place is forgotten. */
  const unserveSocket = async (place: string): Promise<void> => {
    const served = sockets.get(place);
    sockets.delete(place);
    await served?.socket.close();
  };

  const open = async ({ op, run, attempt, view, tool, credentials, unset = [], deadline }: OpenRequest, current: Ready): Promise<void> => {
    const { provider } = current;

    if (!RUN_ID.test(run) || !ATTEMPT_ID.test(attempt)) {
      fail(op, { code: 'bad_request', message: `Open ${op} names run "${run}" and attempt "${attempt}", which are not teamai ids.` });

      return;
    }

    const refused = await hostUnreachable(credentials, current);

    if (refused) {
      fail(op, refused);

      return;
    }

    const key = { run, attempt };
    const handle = handleOf(key);

    // A judge's place: nothing of the host, and no sandbox until its prompt names the directory.
    if (view === undefined) {
      if (Object.keys(credentials).length === 0) {
        fail(op, noJudgeCredential(env));

        return;
      }

      journal.savePlace(handle, { ...key, confined: true });
      write({ op, event: 'accepted', handle });
      write({ op, event: 'ready', display: provider.display(key) });

      return;
    }

    // A place whose tool an app may launch through teamai's wrapper serves the attempt socket from now on; its path
    // travels in the handle, which teamai gives that app's runtime as `outer`.
    const outer = tool !== undefined && provider.client !== undefined ? { socket: socketPathOf({ result: view.result, place: handle }), worktree: view.worktree, toolHome: view.toolHome } : undefined;

    if (outer !== undefined) {
      const served = await serveSocket({ place: handle, socketPath: outer.socket, credentials, unset });

      if (!served.ok) {
        fail(op, served.failure);

        return;
      }
    }

    journal.savePlace(handle, { ...key, ...(outer && { outer }) });
    write({ op, event: 'accepted', handle: outer === undefined ? handle : JSON.stringify({ place: handle, socket: outer.socket } satisfies OuterHandle) });
    // Its own place is saved first, so the sweep keeps it.
    void sweep(provider);
    // An instance's place is its tool's: the same template, sign-in link and gateway; its command and home come in exec.
    const launched = tool === undefined ? undefined : current.instances.get(tool)?.tool ?? tool;

    // The warm image comes before the sandbox's creation, which a close waits for: a close meanwhile ends at once, and its
    // place then gets no sandbox.
    const warmed = provider.warm === undefined ? { ok: true as const } : await provider.warm(view, launched, deadline);

    if (!warmed.ok) {
      fail(op, warmed.failure);

      return;
    }

    if (journal.place(handle) === undefined) {
      fail(op, { code: 'sandbox_failed', message: `Attempt ${attempt} was closed while its warm image was being made, so no sandbox was made for it.` });

      return;
    }

    /** The attempt's sandbox, found or created, kept under its id. */
    const make = async (): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
      const found = await provider.find(key);

      if (!found.ok) return found;
      const created = found.id === undefined ? await provider.create(key, view, launched, deadline) : { ok: true as const, id: found.id };

      if (!created.ok) return created;

      // A place a close forgot meanwhile stays forgotten, and the sandbox made for it is removed: a close that found
      // nothing yet, or a released one past its bound.
      if (journal.place(handle) === undefined) {
        const destroyed = await provider.destroy(created.id);
        const removal = destroyed.ok ? 'so it was removed' : `and removing it failed, so a later open's sweep removes it: ${destroyed.failure.message}`;

        return { ok: false, failure: { code: 'sandbox_failed', message: `Attempt ${attempt} was closed while its sandbox was being made, ${removal}.` } };
      }

      journal.savePlace(handle, { ...key, ...(outer && { outer }), id: created.id });

      return created;
    };

    // A close meanwhile waits for this, so its removal finds whatever the engine made.
    const made = await creation(handle, make());

    if (!made.ok) {
      fail(op, made.failure);

      return;
    }

    const unused = launched === undefined ? undefined : current.unusedGateways[launched];

    // A definition that gives the step the gateway, or a sign-in of its own, is not signed in on sbx's login.
    if (launched !== undefined && unused !== undefined && !unused.ownSignIn.some((name) => name in credentials) && !toldGateway.has(launched)) {
      toldGateway.add(launched);
      write({ event: 'notice', op, message: unused.notice });
    }

    write({ op, event: 'ready', display: provider.display(key) });
  };

  /**
   * Answers an op another runtime process started, or one whose process is gone: with its outcome once the journal holds
   * one, or once a stop or a close here ends it. Its polling never keeps this process alive once teamai is gone.
   */
  const follow = (op: OpId, handle: string): Promise<void> => new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;

    const stop = (): void => {
      clearTimeout(timer);
      followers.delete(op);
      resolve();
    };

    const look = (): void => {
      try {
        const now = journal.exec(op);

        // A close forgot it once its sandbox, and whatever ran there, was removed.
        if (now === undefined) conclude(op, { state: 'cancelled' });
        else if (now.outcome) conclude(op, now.outcome);
        else timer = setTimeout(look, FOLLOW_MS).unref();
      } catch (error) {
        followers.delete(op);
        reject(error);
      }
    };

    followers.set(op, { handle, stop });
    look();
  });

  /**
   * Answers an id this runtime has seen, with its outcome or once it has one, without running it again; undefined for
   * a new id. It decides without awaiting, so the caller claims a new id before anything else is read.
   */
  const replay = (op: OpId): Promise<void> | undefined => {
    const unkept = ledger.unkept(op);

    if (unkept !== undefined) {
      write({ op, event: 'accepted' });
      ledger.end(unkept);

      return Promise.resolve();
    }

    const record = journal.exec(op);

    if (record?.outcome) {
      write({ op, event: 'accepted' });
      endWith(op, record.outcome);

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

  const exec = async (request: ExecRequest, { provider, host }: Ready): Promise<void> => {
    const { op } = request;
    const handle = placeOf(request.handle);
    const replayed = replay(op);

    if (replayed) return replayed;

    // Claimed before the first await, so the same id sent again meanwhile is answered by this run.
    claim(op);
    const place = journal.place(handle);

    if (place?.confined) {
      finish(op, { state: 'failed', failure: { code: 'bad_request', message: `Handle ${handle} is a judge's place, which runs only its confined prompt, never an exec.` } });

      return;
    }

    const noSandbox: Outcome = { state: 'failed', failure: { code: 'runtime_gone', message: `No sandbox is open under handle ${handle}.` } };

    if (place === undefined) {
      finish(op, noSandbox);

      return;
    }

    journal.saveExec(op, { handle, runner: process.pid });
    write({ op, event: 'accepted' });
    // Journaled and accepted first: a runtime that died before it kept the sandbox id leaves it to its labels, a lookup
    // that takes the engine's time, and a cancel or a close meanwhile finds this exec and keeps it from starting.
    const found = await sandboxOf(place, provider);

    if (!found.ok) {
      finish(op, { state: 'failed', failure: found.failure });

      return;
    }

    const { id } = found;

    if (id === undefined) {
      finish(op, noSandbox);

      return;
    }

    if (journal.isCancelled(op)) {
      finish(op, { state: 'cancelled' });

      return;
    }

    // A credential the exec withholds is not set; a name the exec sets itself wins over a credential.
    const scoped = inSandbox(Object.fromEntries(Object.entries(request.credentials).filter(([name]) => !request.unset.includes(name))), host);
    // teamai masks what the step prints with the values it gave. A URL on this machine itself reached the step as the
    // sandbox names it, which teamai cannot know, so that value is masked here first.
    const rewritten = rewrittenMasks(request.credentials, scoped);
    const unrewritten = (text: string): string => redact(text, { envSecrets: rewritten, patterns: false });
    let stdout = '';

    const ran = await provider.exec(id, { argv: request.argv, env: { ...scoped, ...request.env }, unset: request.unset, cwd: request.cwd }, (stream, data) => {
      if (stream === 'stdout') stdout += data;
      write({ op, event: 'output', stream, data: unrewritten(data) });
    });

    const outcome: Outcome = journal.isCancelled(op) ? { state: 'cancelled' } : ran.kind === 'failed' ? { state: 'failed', failure: ran.failure } : { state: 'exited', code: ran.code, stdout: unrewritten(stdout) };
    // teamai gets the complete stdout and masks it itself; the journal never holds a credential the tool printed, so a
    // repeated id is answered with it masked.
    finish(op, outcome, outcome.state === 'exited' ? { ...outcome, stdout: redact(outcome.stdout, { envSecrets: maskedAsGiven(request.credentials, scoped), patterns: false }) } : outcome);
  };

  /** Runs a judge: its tool in a sandbox of its own that sees only the prompt's directory, read-only. */
  const prompt = async (request: PromptRequest, { provider, can, host }: Ready): Promise<void> => {
    const { op, confined, lease } = request;
    const handle = placeOf(request.handle);

    if (confined === undefined) {
      fail(op, { code: 'prompt_unsupported', message: 'The sandbox runtime runs the tool teamai builds, as an exec, and launches no agent of its own.' });

      return;
    }

    const replayed = replay(op);

    if (replayed) return replayed;
    const place = journal.place(handle);

    if (!place?.confined) {
      fail(op, { code: 'bad_request', message: `Prompt ${op} is confined, and handle ${handle} is not a judge's place. Open one with no view first.` });

      return;
    }

    const { judges } = provider;

    if (!judges || !can.confined?.some((offer) => offer.tools.includes(lease.tool))) {
      fail(op, { code: 'tool_unavailable', message: `The sandbox offers no ${lease.tool} judge: it judges on ${can.confined?.flatMap((offer) => offer.tools).join(', ') || 'no tool'}.` });

      return;
    }

    const given = inSandbox(request.credentials, host);
    const chosen = judgeOf(lease.tool, given, env);

    if (!chosen.ok) {
      fail(op, chosen.failure);

      return;
    }

    // Claimed before the first await, as an exec is.
    claim(op);
    journal.saveExec(op, { handle, runner: process.pid });
    write({ op, event: 'accepted' });
    const { judge } = chosen;

    // The journal never holds a credential the tool echoed into its reply. Only its strings are masked: a setting such
    // as `1` leaves a reply's numbers as they are.
    // teamai masks the reply with the values it gave; a value the sandbox got rewritten is masked here first.
    const masks = maskedAsGiven(request.credentials, given);
    const rewritten = rewrittenMasks(request.credentials, given);
    const replyMasked = (outcome: Outcome, envSecrets: Record<string, string>): Outcome => (outcome.state === 'finished' ? { ...outcome, result: PromptResultSchema.parse(redactJson(outcome.result, envSecrets)) } : outcome);
    const settle = (outcome: Outcome): void => finish(op, replyMasked(outcome, rewritten), replyMasked(outcome, masks));

    /** The judge's container, or undefined once the prompt settled: its creation failed, or a cancel came meanwhile. */
    const create = async (): Promise<string | undefined> => {
      const created = await judges.create(place, { dir: confined.dir, hosts: judge.hosts });

      if (!created.ok) {
        settle(journal.isCancelled(op) ? { state: 'cancelled' } : { state: 'failed', failure: created.failure });

        return undefined;
      }

      // A place a released close forgot meanwhile stays forgotten, as an open's does.
      if (journal.place(handle) !== undefined) journal.savePlace(handle, { ...place, id: created.id });

      if (!journal.isCancelled(op)) return created.id;
      // A creation a cancel or a close overtook removes the container it made before it settles; the filter and the
      // network stay for close.
      const removed = await provider.destroy(created.id);
      settle(removed.ok ? { state: 'cancelled' } : { state: 'failed', failure: { code: CANCEL_FAILED, message: removed.failure.message } });

      return undefined;
    };

    // A close waits for this to settle, however it does, so the removal after it finds whatever the creation made.
    const id = await creation(handle, create());

    if (id === undefined) return;

    const launch = judge.tool.launch({ ...lease, prompt: inEvidenceDir(lease.prompt, confined.dir) }, confined);
    // Only the credentials the judge's own tool reads, less any the prompt withholds.
    const scoped = Object.fromEntries(Object.entries(judge.credentials).filter(([name]) => !request.unset.includes(name)));
    let stdout = '';
    let stderr = '';

    const ran = await provider.exec(id, { argv: launch.argv, env: { ...scoped, ...launch.env, ...request.env }, unset: request.unset, cwd: EVIDENCE_DIR }, (stream, data) => {
      if (stream === 'stdout') stdout += data;
      else stderr = `${stderr}${data}`.slice(-4000);
    });

    if (journal.isCancelled(op)) {
      settle({ state: 'cancelled' });

      return;
    }

    if (ran.kind === 'failed') {
      settle({ state: 'failed', failure: ran.failure });

      return;
    }

    const reading = judge.tool.read(stdout);
    const masked = (text: string): string => redact(text, { envSecrets: masks, patterns: false });

    if (ran.code !== 0) {
      const lastStderr = stderr.trim().split('\n').at(-1) || 'it printed nothing on stderr';
      settle({ state: 'failed', failure: { code: 'tool_failed', message: masked(`${lease.tool} exited with code ${ran.code} in the judge's container: ${reading.ok ? lastStderr : reading.message}`) } });

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
   * or undefined once it is, all within BOUND_MS. A judge's container is removed, so an exec still on its way to the
   * engine has nothing to start in; a step's restarts, ready for the step's next exec, and is stopped again while that
   * exec has not ended. One the engine cannot look up is not stopped.
   */
  const stopOf = async (op: OpId, { handle }: ExecRecord, provider: Provider): Promise<RuntimeFailure | undefined> => {
    const deadline = Date.now() + BOUND_MS;
    const place = journal.place(handle);

    const overdue = (what: string): RuntimeFailure => ({
      code: CANCEL_FAILED,
      message: `${what} within ${BOUND_MS / 1000} s, so exec ${op} may still run. Run \`teamai workflow cancel ${place?.run ?? '<run>'}\` again to stop it${place ? `, or ${provider.removal(place)}` : ''}.`,
    });

    const stopping = async (): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
      const found = place ? await sandboxOf(place, provider) : { ok: true as const, id: undefined };

      return !found.ok ? found : found.id === undefined ? { ok: true } : place?.confined ? provider.destroy(found.id) : provider.stop(found.id);
    };

    const stop = async (): Promise<RuntimeFailure | undefined> => {
      const stopped = await by(deadline, stopping());

      if (stopped.kind === 'late') return overdue(`The stop of sandbox ${handle} did not end`);

      return stopped.value.ok ? undefined : stopped.value.failure;
    };

    const unstopped = await stop();

    if (unstopped !== undefined) return unstopped;
    const ended = running.get(op)?.ended;

    if (ended === undefined) return undefined;

    // A step's sandbox outlives its stop, so an exec still on its way to the engine when the stop landed starts after it
    // (sbx starts a stopped sandbox again for it): each later stop ends what started since, until the exec ends.
    const waitUntil = (): number => (place?.confined ? deadline : Math.min(deadline, Date.now() + RESTOP_MS));

    while ((await by(waitUntil(), ended)).kind === 'late') {
      if (Date.now() >= deadline) return overdue(`Sandbox ${handle} was stopped, but exec ${op} did not end`);
      const again = await stop();

      if (again !== undefined) return again;
    }

    return undefined;
  };

  const cancel = async (op: OpId, provider: Provider): Promise<void> => {
    const record = journal.exec(op);
    // An end this process answered and could not journal stands in for the record's.
    const ended = ledger.unkept(op) ?? record?.outcome;
    // A stop this runtime could not confirm is the one outcome a later cancel replaces.
    const isRetried = ended?.state === 'failed' && ended.failure.code === CANCEL_FAILED;

    if (!record || pendingStops.has(op)) return;

    // A cancel of an op that already ended answers that end again.
    if (ended !== undefined && !isRetried) {
      conclude(op, ended);

      return;
    }

    const endsBefore = ledger.endsOf(op);
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
          finish(op, outcome);

          return;
        }

        // An exec that ended on its own meanwhile keeps that end, and one a close forgot is not kept again.
        const now = journal.exec(op);

        if (now === undefined || now.outcome !== undefined) return;
        conclude(op, outcome, () => journal.saveExec(op, { handle: record.handle, runner: record.runner, outcome }));

        return;
      }

      // The engine confirmed the stop, so whatever ran is gone: an exec this process ran has ended cancelled already, and
      // any other ends cancelled here.
      const now = journal.exec(op);

      if (now === undefined || now.outcome !== undefined) return;
      conclude(op, { state: 'cancelled' }, () => journal.saveExec(op, { handle: record.handle, runner: record.runner, outcome: { state: 'cancelled' } }));
    } finally {
      pendingStops.delete(op);

      // The runtime process that ran the op, which teamai may no longer read, recorded its end while this stop ran:
      // this cancel answers with it, since nothing else here would. An op this process runs ends through finish only.
      if (!running.has(op) && ledger.endsOf(op) === endsBefore) {
        const recorded = journal.exec(op)?.outcome;

        if (recorded !== undefined) conclude(op, recorded);
      }
    }
  };

  /**
   * Answers once the place's work is at its host paths: at once on a bind mount, once copied back on a copy provider. A
   * place it cannot find fails, never answered as collected.
   */
  const collect = async (handle: string, provider: Provider): Promise<void> => {
    const placeKey = placeOf(handle);

    switch (provider.family) {
      case 'bind':
        write({ event: 'collected', handle });

        return;
      case 'copy':
        break;
      default: {
        const unhandled: never = provider;

        return unhandled;
      }
    }

    const place = journal.place(placeKey);
    const found = place === undefined ? { ok: true as const, id: undefined } : await sandboxOf(place, provider);

    if (!found.ok) {
      write({ event: 'collect_failed', handle, failure: found.failure });

      return;
    }

    if (found.id === undefined) {
      write({ event: 'collect_failed', handle, failure: { code: 'runtime_gone', message: `No sandbox is open under handle ${handle}, so its work cannot be copied back.` } });

      return;
    }

    const copied = await provider.collect(found.id);
    write(copied.ok ? { event: 'collected', handle } : { event: 'collect_failed', handle, failure: copied.failure });
  };

  /**
   * Answers from the journal alone, never the provider, so a stop is read while the engine is down: gone only when the
   * journal holds no place of that handle. A sandbox removed meanwhile is found absent by the next exec or close.
   */
  const reattach = async (handle: string, provider: Provider, credentials: Record<string, string> | undefined, unset: string[] = []): Promise<void> => {
    const placeKey = placeOf(handle);
    const place = journal.place(placeKey);

    if (place === undefined) {
      write({ event: 'gone', handle });

      return;
    }

    // A place whose tool an app launches through the wrapper is served again, with the credentials teamai sent again.
    if (place.outer !== undefined) {
      const served = await serveSocket({ place: placeKey, socketPath: place.outer.socket, credentials, unset });

      if (!served.ok) warn(`teamai-runtime-sandbox: warning: ${served.failure.message}. The step's tool cannot start in its sandbox until it can.`);
    }

    write({ event: 'alive', handle, ops: journal.opsOf(placeKey).map(({ op, record }) => ledger.unkept(op) ?? stateOf({ op, ...record })), display: provider.display(place) });
  };

  /** Removes the place's sandbox, and a judge's filter and network: ok once the provider confirmed they are gone. */
  const removeSandbox = async (place: PlaceRecord | undefined, provider: Provider): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
    const found = place ? await sandboxOf(place, provider) : { ok: true as const, id: undefined };
    const destroyed = !found.ok ? found : found.id === undefined ? { ok: true as const } : await provider.destroy(found.id);

    return destroyed.ok && place?.confined && provider.judges ? provider.judges.release(place) : destroyed;
  };

  /**
   * Removes the place, within BOUND_MS: an op still running there is marked cancelled, a sandbox or a judge's container
   * this process is still creating there is waited for so the removal finds whatever it made, and each running op's own
   * end is written before `closed`. Past the bound, or when the removal fails, the journal keeps the place for a later
   * close, unless the person released the attempt (`release`): then it is forgotten all the same.
   */
  const close = async (given: string, provider: Provider, isReleased: boolean): Promise<void> => {
    const handle = placeOf(given);
    const deadline = Date.now() + BOUND_MS;
    const ops = journal.opsOf(handle);
    const known = journal.place(handle);

    /** Forgets the place, and the ends of its ops the ledger remembers. */
    const forget = (): void => {
      journal.forget(handle);

      for (const { op } of ops) ledger.forget(op);
    };

    const failed = (failure: RuntimeFailure): void => {
      if (isReleased) {
        forget();
        void unserveSocket(handle);
      }

      write({ event: 'close_failed', handle: given, failure });
    };

    const overdue = (what: string): void => failed({
      code: 'sandbox_failed',
      message: isReleased
        ? `Closing ${handle} took over ${BOUND_MS / 1000} s: ${what}, so what ran there may still run. You released the attempt, so this runtime no longer keeps its place${known ? `: ${provider.removal(known)}` : ''}.`
        : `Closing ${handle} took over ${BOUND_MS / 1000} s: ${what}, so what ran there may still run, and the place stays this attempt's. Run \`teamai workflow cancel ${known?.run ?? '<run>'}\` again to close it${known ? `, or ${provider.removal(known)}` : ''}.`,
    });

    const stopping = ops.flatMap(({ op }) => {
      const run = running.get(op);

      if (run === undefined) return [];
      journal.cancel(op);

      return [run.ended];
    });

    if ((await by(deadline, Promise.all([...creating].flatMap((entry) => (entry.handle === handle ? [entry.settled] : []))))).kind === 'late') {
      overdue('its sandbox was still being created');

      return;
    }

    const removed = await by(deadline, removeSandbox(journal.place(handle), provider));

    if (removed.kind === 'late') {
      overdue('its removal did not end');

      return;
    }

    if (!removed.value.ok) {
      const { failure } = removed.value;

      // The journal keeps the place, so a later close or reattach of this handle still finds the sandbox; a released one
      // is forgotten, which the provider's message cannot know.
      failed(isReleased ? { ...failure, message: `${failure.message} You released the attempt, so this runtime no longer keeps its place.` } : failure);

      return;
    }

    if ((await by(deadline, Promise.all(stopping))).kind === 'late') {
      overdue('an exec that ran there did not end after its removal');

      return;
    }

    // The sandbox is gone, so an op answered here but run by no live process ended with it, unless its runner recorded
    // its own end since this process last looked.
    for (const [op, follower] of followers) if (follower.handle === handle) conclude(op, journal.exec(op)?.outcome ?? { state: 'cancelled' });
    forget();
    await unserveSocket(handle);
    write({ event: 'closed', handle: given });
  };

  /**
   * `credentials`: the names the definition gives this runtime; an older teamai sends none, and every judge is offered.
   * In `recover` mode teamai only stops and closes what the journal holds: nothing is checked or offered, and the
   * provider is reached only when a cancel or a close needs it. `check` mode is refused: what a provider offers is
   * known only once its image is pulled and a sandbox started, which a check may not do.
   */
  const init = async ({ options, credentials, mode, instances = [] }: Extract<RuntimeRequest, { type: 'init' }>): Promise<void> => {
    const parsed = parseOptions(options);

    if (!parsed.ok) {
      ready = { provider: unreachable(parsed.failure), can: {}, host: NOT_OFFERED, unusedGateways: {}, instances: new Map() };
      write({ type: 'init', ok: false, error: parsed.failure });

      return;
    }

    if (mode === 'check') {
      ready = { provider: unreachable(CHECK_UNSUPPORTED), can: {}, host: NOT_OFFERED, unusedGateways: {}, instances: new Map() };
      write({ type: 'init', ok: false, error: CHECK_UNSUPPORTED });

      return;
    }

    const provider = providerFor(parsed.options);

    if (mode === 'recover') {
      ready = { provider, can: {}, host: NOT_OFFERED, unusedGateways: {}, instances: new Map() };
      write({ type: 'init', ok: true, can: {} });

      return;
    }

    const offered = await provider.offer(credentials, instances);

    if (!offered.ok) {
      ready = { provider: unreachable(offered.failure, provider.family), can: {}, host: NOT_OFFERED, unusedGateways: {}, instances: new Map() };
      write({ type: 'init', ok: false, error: offered.failure });

      return;
    }

    const { confined: offers = [], ...rest } = offered.can;
    const judges = credentials === undefined ? offers : offersSignedIn(offers, credentials.env);
    const can: Can = { ...rest, ...(judges.length > 0 && { confined: judges }) };
    ready = { provider, can, host: offered.host, unusedGateways: offered.unusedGateways, instances: new Map(instances.map((instance) => [instance.name, instance])) };

    // The wrapper runs a link named after an instance outside any attempt too (`--version`): it reads them here.
    if (instances.length > 0) {
      let kept: ReturnType<Journal['instances']> = {};

      try {
        kept = journal.instances();
      } catch (error) {
        warn(`teamai-runtime-sandbox: warning: ${error instanceof Error ? error.message : String(error)} It is written again with the instances of this run.`);
      }

      try {
        journal.saveInstances({ ...kept, ...Object.fromEntries(instances.map(({ name, tool, command }) => [name, { tool, ...(command !== undefined && { command }) }])) });
      } catch (error) {
        warn(`teamai-runtime-sandbox: warning: the instances teamai named could not be kept for teamai-sandbox-<instance> links: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    write({ type: 'init', ok: true, can, ...(can.confined && { confinedPrompt: true }), ...(Object.keys(offered.unavailable).length > 0 && { unavailable: offered.unavailable }), ...(offered.ownLogins.length > 0 && { ownLogins: offered.ownLogins }) });
  };

  /**
   * An exec or a prompt that threw: one this process still runs ends failed through finish, which releases it, so a
   * close of its place waits for no end that never comes. The kit answers any other.
   */
  const ending = <TRequest extends ExecRequest | PromptRequest>(run: (request: TRequest, current: Ready) => Promise<void>) => async (request: TRequest): Promise<void> => {
    try {
      await run(request, ready);
    } catch (error) {
      if (!running.has(request.op)) throw error;
      finish(request.op, { state: 'failed', failure: { code: 'runtime_error', message: `Runtime sandbox could not carry out ${request.type} of ${request.op}: ${error instanceof Error ? error.message : String(error)}` } });
    }
  };

  return serveRuntime({
    name: 'sandbox',
    input,
    env,
    ledger,
    handlers: {
      init,
      open: (request) => open(request, ready),
      exec: ending(exec),
      prompt: ending(prompt),
      async cancel({ op }) {
        const endsBefore = ledger.endsOf(op);

        try {
          await cancel(op, ready.provider);
        } catch (error) {
          // A cancel has no reply of its own, so its op ends with the failure: it may still run, and a later cancel
          // retries. It is kept in the op's record when that can still be written, so a reattach before the retry reads
          // it, never running.
          const outcome: Outcome = { state: 'failed', failure: { code: CANCEL_FAILED, message: `Exec ${op} may still run: the sandbox runtime could not stop it. ${error instanceof Error ? error.message : String(error)}` } };

          if (running.has(op)) finish(op, outcome);
          else if (ledger.endsOf(op) === endsBefore) conclude(op, outcome, () => keep(op, outcome));
        }
      },
      collect: ({ handle }) => collect(handle, ready.provider),
      reattach: ({ handle, credentials, unset }) => reattach(handle, ready.provider, credentials, unset),
      async close({ handle, release: isReleased }) {
        try {
          await close(handle, ready.provider, isReleased === true);
        } catch (error) {
          if (isReleased !== true) throw error;
          // A place the person released is forgotten all the same, however much of its record can be read.
          let unforgotten = '';

          try {
            journal.forget(placeOf(handle));
          } catch (forgetting) {
            unforgotten = ` Its records could not be removed either: ${forgetting instanceof Error ? forgetting.message : String(forgetting)}`;
          }

          write({ event: 'failed', handle, failure: { code: 'runtime_error', message: `Runtime sandbox could not carry out close of ${handle}: ${error instanceof Error ? error.message : String(error)}${unforgotten}` } });
        }
      },
    },
    // An op this process runs, follows or stops, or one the journal holds or may hold, gets its end from what runs it.
    holds: (op) => running.has(op) || followers.has(op) || pendingStops.has(op) || ledger.unkept(op) !== undefined || journal.exec(op) !== undefined,
    stopped: 'what it ran in the sandbox',
    debug: warn,
  });
}
