import { randomBytes } from 'node:crypto';
import { OpIdSchema, type ExecRequestSchema, type OpenRequestSchema, type OpId, type OpState, type RuntimeDisplay, type RuntimeFailure, type RuntimeOptions } from '@teamai/runtime-protocol';
import type { z } from 'zod';
import type { RunMode } from '../../launch-context.js';
import type { DriverCan } from '../requirements.js';

// ─── Step runtimes ───────────────────────────────────────
//
//  A step runtime is where and how a workflow step's processes run: `local`, in teamai's process on the host, or an
//  external program speaking the runtime protocol over stdio (protocol.ts). The local loop reaches each through this
//  one interface. Not to be confused with the bundled runtime (`src/bundled-runtime.ts`), the Node and shell that
//  WorkBuddy and CodeBuddy ship, nor with `Executor` (`command` or `prompt`), nor with a tool.
//
//  Every operation is accepted first and finishes later. teamai names each with an id it persists before it sends the
//  request, and a runtime answers a repeated id with the same acceptance and the same terminal outcome until `close`.
//

/** A new operation id. */
export function newOpId(): OpId {
  return OpIdSchema.parse(`op-${randomBytes(6).toString('hex')}`);
}

/** An open as the local loop sends it; the protocol's request without its type. */
export type OpenRequest = Omit<z.infer<typeof OpenRequestSchema>, 'type'>;

/** An exec as the local loop sends it; the protocol's request without its type. */
export type ExecRequest = Omit<z.infer<typeof ExecRequestSchema>, 'type'>;

export type Opened = { kind: 'ready'; handle: string; display?: RuntimeDisplay } | { kind: 'failed'; failure: RuntimeFailure };

/** How an exec ended. `exited` carries the complete stdout, so a reattach rebuilds what a live run read. */
export type ExecEnd = { kind: 'exited'; code: number; stdout: string } | { kind: 'cancelled' } | { kind: 'failed'; failure: RuntimeFailure };

/** A reattach: the handle is gone, alive with what the runtime retains, or the runtime could not be asked. */
export type Reattached = { kind: 'gone' } | { kind: 'alive'; ops: OpState[]; display?: RuntimeDisplay } | { kind: 'failed'; failure: RuntimeFailure };

export interface ExecEvents {
  onAccepted?: () => void;
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
}

export type Initialized = { ok: true; can: DriverCan } | { ok: false; failure: RuntimeFailure };

/** One step runtime, as the local loop calls it. Expected failures are values; a runtime that dies fails what it had in flight. */
export interface StepRuntime {
  /** The runtime's name, as a driver definition's `use` names it. */
  readonly name: string;
  /** Validates `options` (a bad key fails with `bad_option` naming it) and answers what the runtime offers. */
  init(request: { options: RuntimeOptions; mode: RunMode }): Promise<Initialized>;
  /** Opens the attempt's place. `onAccepted` runs with the handle before `open` settles, so teamai persists it. */
  open(request: OpenRequest, onAccepted: (handle: string) => Promise<void>): Promise<Opened>;
  exec(request: ExecRequest, events: ExecEvents): Promise<ExecEnd>;
  /** Stops operation `op` and every process it started. Its `exec` then ends `cancelled`. */
  cancel(op: OpId): Promise<void>;
  /** Brings the place's work back to the host, deletions included, never committed; after success and after failure. */
  collect(handle: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  reattach(handle: string): Promise<Reattached>;
  /** Ends the handle: the runtime may drop its retained outcomes. */
  close(handle: string): Promise<void>;
  /** Ends this connection to the runtime. Operations the runtime keeps running stay its own. */
  dispose(): Promise<void>;
}
