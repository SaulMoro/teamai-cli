import type { Can, InitCredentials, PlaceView, RuntimeDisplay, RuntimeFailure } from '@teamai/runtime-protocol';

// ─── The provider seam ───────────────────────────────────
//
//  A provider is one sandbox technology. It only starts sandboxes, runs processes in them, stops and removes them, and
//  says what its technology isolates. Everything else is written once above it, in runtime.ts: the protocol, the
//  journal of operations and their retained outcomes, credentials and options.
//
//  Bind-mount providers (sbx, docker and podman today) mount the place view at its host paths, so collect copies nothing.
//  A copy provider (a hosted sandbox) will add copyIn and copyOut to this seam. On a provider that can confine one, a
//  judge (a confined prompt) gets a sandbox of its own that sees only its directory.
//

/**
 * The longest one provider command on a stop or close path runs (a lookup, a stop, a removal) before it is killed and
 * answers with how to clean up by hand. The runtime bounds a whole stop or close at 10 s on top of that (runtime.ts).
 */
export const COMMAND_MS = 9_000;

/** The attempt a sandbox belongs to, which names it and finds it again. */
export interface PlaceKey {
  run: string;
  attempt: string;
}

/** An attempt's handle, `teamai-<run>-<attempt>`, which also names its container (sbx adds its journal: providers/sbx.ts). */
export function handleOf({ run, attempt }: PlaceKey): string {
  return `teamai-${run}-${attempt}`;
}

/**
 * The provider of a runtime that could not start one: `init` failed, or never came. teamai still sends a restarted
 * runtime its cancel, reattach, collect and close, so each is answered: a lookup fails with `failure`, and a sandbox
 * is never taken as absent, so a place stays its attempt's until a runtime that reaches the engine closes it.
 */
export function unreachable(failure: RuntimeFailure): Provider {
  const kept = (sandbox: string) => ({ ok: false as const, failure: { ...failure, message: `${failure.message} Sandbox ${sandbox}, if it exists, stays this attempt's until the sandbox runtime can reach it.` } });

  return {
    offer: async () => ({ ok: false, failure }),
    find: async (key) => kept(handleOf(key)),
    create: async (key) => kept(handleOf(key)),
    exec: async (id) => ({ kind: 'failed', failure: kept(id).failure }),
    stop: async (id) => kept(id),
    destroy: async (id) => kept(id),
    display: (key) => ({ label: handleOf(key) }),
    removal: (key) => `remove sandbox ${handleOf(key)} once the sandbox runtime reaches its engine`,
  };
}

export interface ExecSpec {
  argv: string[];
  /** Every name the process gets over the sandbox's own environment: the exec's names and the credentials. */
  env: Record<string, string>;
  /** Names the process must not inherit from the sandbox's own environment. */
  unset: string[];
  cwd: string;
}

export type ExecEnd = { kind: 'exited'; code: number } | { kind: 'failed'; failure: RuntimeFailure };

/** A provider's judges: each in a sandbox of its own that sees only its evidence and reaches only its model provider. */
export interface Judges {
  /**
   * Creates a judge's sandbox: only `dir`, read-only, at EVIDENCE_DIR (judge.ts), on a network whose one way out lets
   * through only `hosts` (`host:port`), and no credential. Returns its id; an existing one of `key` is that judge's.
   */
  create(key: PlaceKey, { dir, hosts }: { dir: string; hosts: string[] }): Promise<{ ok: true; id: string } | { ok: false; failure: RuntimeFailure }>;
  /** Removes what a judge's sandbox needed besides itself: its network and the filter in front of it. */
  release(key: PlaceKey): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
}

/**
 * How a sandbox reaches this machine itself: the name it has there, to which a URL credential on localhost is pointed
 * (loopback.ts), or, as a whole sentence, why teamai knows none.
 */
export type HostRoute = { ok: true; alias: string } | { ok: false; refusal: string };

export interface Provider {
  /**
   * Checks the technology is usable on this machine and says what it offers, or fails `sandbox_unavailable` with the
   * fix. It offers a tool only when it can sign in there with `credentials`, the names teamai gives, and lists each
   * other tool it holds in `unavailable` with how to sign it in (sign-in.ts).
   */
  offer(credentials: InitCredentials | undefined): Promise<{ ok: true; can: Can; host: HostRoute; unavailable: Record<string, string> } | { ok: false; failure: RuntimeFailure }>;
  /**
   * The sandbox of this attempt: its id, or undefined once the technology said there is none. A lookup it could not
   * make fails with what to do, so a sandbox is never taken as absent while its technology does not answer.
   */
  find(key: PlaceKey): Promise<{ ok: true; id: string | undefined } | { ok: false; failure: RuntimeFailure }>;
  /**
   * The sandboxes this runtime's journal owns (by their `teamai.owner` label, or on sbx by their name's prefix) that
   * name a run and an attempt (a judge's filter: the attempt it filters for), each with them, within COMMAND_MS. A
   * provider that cannot tell its journal's sandboxes from another's has none: nothing of it is ever swept.
   */
  owned?(): Promise<{ ok: true; sandboxes: Array<PlaceKey & { id: string }> } | { ok: false; failure: RuntimeFailure }>;
  /** Creates the attempt's sandbox with the view at its host paths and no credential, and returns its id. */
  create(key: PlaceKey, view: PlaceView): Promise<{ ok: true; id: string } | { ok: false; failure: RuntimeFailure }>;
  /**
   * On a provider whose own network policy decides what a sandbox reaches (sbx): whether it lets one reach `port` of
   * this machine, or how to allow it, naming the credential `variable` that needs it. The policy is never edited.
   */
  reachesHost?(port: number, variable: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  /** The sandboxes of judges, on a provider that can confine one; a provider without them offers no confined prompt. */
  judges?: Judges;
  /** Runs one process in the sandbox, streaming its output, until it ends. */
  exec(id: string, spec: ExecSpec, onOutput: (stream: 'stdout' | 'stderr', data: string) => void): Promise<ExecEnd>;
  /**
   * Stops every process running in the sandbox; the sandbox stays, ready for the next exec. Ok only once they are gone.
   * It answers within COMMAND_MS, failing with how to remove the sandbox when the technology does not answer by then.
   */
  stop(id: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  /** Removes the sandbox and every process in it; ok once it is gone. It answers within COMMAND_MS. */
  destroy(id: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  display(key: PlaceKey): RuntimeDisplay;
  /** How a person removes the place by hand, as the end of a sentence: "remove it with `…`". */
  removal(place: PlaceKey & { confined?: true }): string;
}
