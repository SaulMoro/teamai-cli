import type { Can, PlaceView, RuntimeDisplay, RuntimeFailure } from '@teamai/runtime-protocol';

// ─── The provider seam ───────────────────────────────────
//
//  A provider is one sandbox technology. It only starts sandboxes, runs processes in them, stops and removes them, and
//  says what its technology isolates. Everything else is written once above it, in runtime.ts: the protocol, the
//  journal of operations and their retained outcomes, credentials and options.
//
//  Bind-mount providers (docker and podman today) mount the place view at its host paths, so collect copies nothing.
//  A copy provider (a hosted sandbox) will add copyIn and copyOut to this seam. A judge (a confined prompt) gets a
//  sandbox of its own that sees only its directory.
//

/** The attempt a sandbox belongs to, which names it and finds it again. */
export interface PlaceKey {
  run: string;
  attempt: string;
}

/** An attempt's sandbox name, which is also its handle: `teamai-<run>-<attempt>`. */
export function sandboxName({ run, attempt }: PlaceKey): string {
  return `teamai-${run}-${attempt}`;
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

export interface Provider {
  /** Checks the technology is usable on this machine and says what it offers, or fails `sandbox_unavailable` with the fix. */
  offer(): Promise<{ ok: true; can: Can } | { ok: false; failure: RuntimeFailure }>;
  /** The sandbox of this attempt, when one exists. */
  find(key: PlaceKey): Promise<string | undefined>;
  /** Creates the attempt's sandbox with the view at its host paths and no credential, and returns its id. */
  create(key: PlaceKey, view: PlaceView): Promise<{ ok: true; id: string } | { ok: false; failure: RuntimeFailure }>;
  /**
   * Creates a judge's sandbox: only `dir`, read-only, at EVIDENCE_DIR (judge.ts), on a network whose one way out lets
   * through only `hosts` (`host:port`), and no credential. Returns its id; an existing one of `key` is that judge's.
   */
  createJudge(key: PlaceKey, { dir, hosts }: { dir: string; hosts: string[] }): Promise<{ ok: true; id: string } | { ok: false; failure: RuntimeFailure }>;
  /** Removes what a judge's sandbox needed besides itself: its network and the filter in front of it. */
  releaseJudge(key: PlaceKey): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  /** Runs one process in the sandbox, streaming its output, until it ends. */
  exec(id: string, spec: ExecSpec, onOutput: (stream: 'stdout' | 'stderr', data: string) => void): Promise<ExecEnd>;
  /** Stops every process running in the sandbox; the sandbox stays, ready for the next exec. */
  stop(id: string): Promise<void>;
  destroy(id: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  display(key: PlaceKey): RuntimeDisplay;
}
