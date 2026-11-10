import type { Readable } from 'node:stream';
import { opLedger } from '@teamai/runtime-kit/ledger';
import type { OuterHandle } from '@teamai/runtime-kit/outer';
import { serveRuntime } from '@teamai/runtime-kit/serve';
import type { Can, InitInstance, OpenRequestSchema, OpId, RuntimeFailure, RuntimeMessage, RuntimeRequest } from '@teamai/runtime-protocol';
import type { z } from 'zod';
import { placeOf, socketPathOf } from './attempt-socket.js';
import { BOUND_MS, by } from './deadline.js';
import { execOperations } from './exec.js';
import type { Journal, PlaceRecord } from './journal.js';
import { noJudgeCredential, offersSignedIn } from './judge.js';
import { onThisMachine } from './loopback.js';
import { parseOptions, type SandboxOptions } from './options.js';
import { attemptSockets } from './outer.js';
import { prompts } from './prompt.js';
import { ATTEMPT_ID, handleOf, RUN_ID, sandboxOf, unreachable, type HostRoute, type Provider } from './provider.js';
import type { UnusedGateways } from './sign-in.js';
import { sweep } from './sweep.js';

// ─── The sandbox runtime over runtime protocol 1 ─────────
//
//  One attempt is one sandbox, named after its run and attempt, so a repeated open, or an open after a restart, finds
//  the same one. The place is journaled before its sandbox is created, and every exec under teamai's id before it
//  starts, so a repeated id is answered with the same outcome, a reattach reads what an exec did while teamai was
//  down, and a sandbox a dead runtime created is still found by its labels. Each exec brings the credentials teamai
//  gives it (a prompt's tool the attempt's, a command none); they are set over that exec's process only, never when the
//  sandbox is created, and never kept: not in the journal, and not in memory past the exec. A `prompt` runs its tool
//  here, in the attempt's sandbox on the attempt's tool home, journaled as an exec is (step.ts). A confined `prompt` is a
//  judge: its place opens with no view, and the prompt runs its tool in a sandbox that sees only the prompt's directory
//  (judge.ts).
//
//  This module owns the place: init, open, collect, reattach and close. What runs there is exec.ts and prompt.ts, the
//  attempt socket an app's wrapper asks on is outer.ts, and what earlier runtimes left is sweep.ts.
//

type OpenRequest = z.infer<typeof OpenRequestSchema>;

/**
 * What `init` settled: the provider, what it offered, the member's gateways a login it keeps replaces, and each instance
 * teamai passed, by its name, which teamai gives as the `tool` of an instance's open.
 */
export interface Ready {
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

export interface RuntimeDeps {
  /** Where requests come from, when a test serves another stream; unset, `serveRuntime` reads the process input. */
  input?: Readable;
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
  /**
   * The sandboxes and judges' containers this process is creating, each with its place's handle and what settles once
   * that creation did.
   */
  const creating = new Set<{ handle: string; settled: Promise<unknown> }>();
  /** The tools whose unused gateway this process told the member about, so it says so once per drive. */
  const toldGateway = new Set<string>();

  /** Every line goes through the ledger, which writes each op's one end. */
  const ledger = opLedger({ name: 'sandbox', write: send });
  const { write } = ledger;
  const execs = execOperations({ journal, ledger });
  const sockets = attemptSockets({ journal, ready: () => ready });

  /**
   * What an answer about `handle` names in `kept` when the runtime leaves its sandbox: the sandbox, by the name its
   * engine knows it by. None for a handle that names no attempt.
   */
  const keptOf = (handle: string, provider: Provider): { kept: string[] } | Record<string, never> => {
    const [, run = '', attempt = ''] = /^teamai-([^-]+)-([^-]+)$/.exec(placeOf(handle)) ?? [];

    return RUN_ID.test(run) && ATTEMPT_ID.test(attempt) ? { kept: [provider.name({ run, attempt })] } : {};
  };

  /** Ends `op` failed with `failure`, before this process ran anything of it. */
  const fail = (op: OpId, failure: RuntimeFailure): void => ledger.end({ op, state: 'failed', failure });

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
      const served = await sockets.serve({ place: handle, socketPath: outer.socket, credentials, unset });

      if (!served.ok) {
        fail(op, served.failure);

        return;
      }
    }

    journal.savePlace(handle, { ...key, toolHome: view.toolHome, ...(outer && { outer }) });
    write({ op, event: 'accepted', handle: outer === undefined ? handle : JSON.stringify({ place: handle, socket: outer.socket } satisfies OuterHandle) });
    // Its own place is saved first, so the sweep keeps it.
    void sweep({ provider, journal, warn });
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

      journal.savePlace(handle, { ...key, toolHome: view.toolHome, ...(outer && { outer }), id: created.id });

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
      const served = await sockets.serve({ place: placeKey, socketPath: place.outer.socket, credentials, unset });

      if (!served.ok) warn(`teamai-runtime-sandbox: warning: ${served.failure.message}. The step's tool cannot start in its sandbox until it can.`);
    }

    write({ event: 'alive', handle, ops: journal.opsOf(placeKey).map(({ op, record }) => execs.reported(op, record)), display: provider.display(place) });
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
        void sockets.unserve(handle);
      }

      // A released place is forgotten, and its sandbox, which the failure says how to remove, is left on purpose.
      write({ event: 'close_failed', handle: given, failure, ...(isReleased && keptOf(given, provider)) });
    };

    const overdue = (what: string): void => failed({
      code: 'sandbox_failed',
      message: isReleased
        ? `Closing ${handle} took over ${BOUND_MS / 1000} s: ${what}, so what ran there may still run. You released the attempt, so this runtime no longer keeps its place${known ? `: ${provider.removal(known)}` : ''}.`
        : `Closing ${handle} took over ${BOUND_MS / 1000} s: ${what}, so what ran there may still run, and the place stays this attempt's. Run \`teamai workflow cancel ${known?.run ?? '<run>'}\` again to close it${known ? `, or ${provider.removal(known)}` : ''}.`,
    });

    const stopping = execs.stopIn(ops);

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
    execs.endFollowersOf(handle);
    forget();
    await sockets.unserve(handle);
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

    write({ type: 'init', ok: true, can, prompt: true, toolHome: true, ...(can.confined && { confinedPrompt: true }), ...(Object.keys(offered.unavailable).length > 0 && { unavailable: offered.unavailable }), ...(offered.ownLogins.length > 0 && { ownLogins: offered.ownLogins }) });
  };

  const prompt = prompts({ journal, ledger, env, execs, creation });

  return serveRuntime({
    name: 'sandbox',
    input,
    env,
    ledger,
    handlers: {
      init,
      open: (request) => open(request, ready),
      exec: (request) => execs.exec(request, ready),
      prompt: (request) => prompt(request, ready),
      cancel: ({ op }) => execs.cancel(op, ready.provider),
      collect: ({ handle }) => collect(handle, ready.provider),
      reattach: ({ handle, credentials, unset }) => reattach(handle, ready.provider, credentials, unset),
      async close({ handle, release: isReleased }) {
        try {
          await close(handle, ready.provider, isReleased === true);
        } catch (error) {
          // A place the person released is forgotten all the same, however much of its record can be read, and its
          // sandbox is left. One not released stays in the journal for a close once its record can be read.
          let unforgotten = '';

          try {
            if (isReleased === true) journal.forget(placeOf(handle));
          } catch (forgetting) {
            unforgotten = ` Its records could not be removed either: ${forgetting instanceof Error ? forgetting.message : String(forgetting)}`;
          }

          write({ event: 'failed', handle, failure: { code: 'runtime_failed', message: `Runtime sandbox could not carry out close of ${handle}: ${error instanceof Error ? error.message : String(error)}${unforgotten}` }, ...(isReleased === true && keptOf(handle, ready.provider)) });
        }
      },
    },
    // An op this process runs, follows or stops, or one the journal holds or may hold, gets its end from what runs it.
    holds: execs.holds,
    stopped: 'what it ran in the sandbox',
    debug: warn,
  });
}
