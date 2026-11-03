import { randomBytes } from 'node:crypto';
import { getUserHome } from '../../utils/home.js';
import { z } from 'zod';
import type { RunMode } from '../../launch-context.js';
import type { JsonValue } from '../../types.js';
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

/** An operation id: what teamai persists before it sends an `open` or an `exec`. */
export const OpIdSchema = z.string().regex(/^op-[0-9a-f]{8,32}$/, 'An operation id looks like op- followed by hex digits').brand<'OpId'>();

export type OpId = z.infer<typeof OpIdSchema>;

/** A new operation id. */
export function newOpId(): OpId {
  return OpIdSchema.parse(`op-${randomBytes(6).toString('hex')}`);
}

/** A runtime's id for one opened place, which teamai persists to reconnect after a restart. */
export const RuntimeHandleSchema = z.string().min(1).max(256);

/**
 * What a runtime may touch for one attempt: the worktree read-write at its host path, the git paths read-only, the
 * attempt's result directory read-write, and the attempt's tool home under the variable its tool reads.
 */
export interface PlaceView {
  worktree: string;
  readonly: string[];
  result: string;
  toolHome: Record<string, string>;
}

/** Why a runtime could not do what it was asked. `key` names a bad option. */
export const RuntimeFailureSchema = z.object({ code: z.string().min(1), message: z.string(), key: z.string().optional() });

export type RuntimeFailure = z.infer<typeof RuntimeFailureSchema>;

export interface OpenRequest {
  op: OpId;
  run: string;
  attempt: string;
  view: PlaceView;
  /** The credentials of this attempt: names and values, never set when the place is created, only per `exec`. */
  credentials: Record<string, string>;
}

export interface ExecRequest {
  op: OpId;
  handle: string;
  argv: string[];
  /** The names the process gets set over the runtime's own environment. */
  env: Record<string, string>;
  /** The names the process must not inherit from the runtime's own environment, such as the forge variables a strict step withholds. */
  unset: string[];
  cwd: string;
}

/** A scheme a display link may use: the web, or an app's own (`t3:`, `vscode:`), never one that runs or reads in the page. */
const DISPLAY_LINK = /^(?!(?:javascript|data|file|vbscript|blob):)[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/** Whether a text of a display names a path in the member's home. */
function inHome(text: string): boolean {
  const home = getUserHome();

  return home !== '/' && text.includes(home);
}

/**
 * What a runtime shows of an attempt's place in the run's details: a label, a link to open it, and up to 8 facts. A
 * runtime never puts a secret or a path in the member's home in it; one that names such a path is not shown.
 */
export const RuntimeDisplaySchema = z.object({
  label: z.string().min(1).max(80),
  url: z.string().max(2048).regex(DISPLAY_LINK, 'A display url is http(s) or an app scheme').optional(),
  fields: z.record(z.string().min(1).max(40), z.string().max(200))
    .refine((fields) => Object.keys(fields).length <= 8, 'A display holds at most 8 fields').optional(),
}).strict().refine((display) => ![display.label, display.url ?? '', ...Object.entries(display.fields ?? {}).flat()].some(inHome), 'A display names no path in the member\'s home');

export type RuntimeDisplay = z.infer<typeof RuntimeDisplaySchema>;

export type Opened = { kind: 'ready'; handle: string; display?: RuntimeDisplay } | { kind: 'failed'; failure: RuntimeFailure };

/** How an exec ended. `exited` carries the complete stdout, so a reattach rebuilds what a live run read. */
export type ExecEnd = { kind: 'exited'; code: number; stdout: string } | { kind: 'cancelled' } | { kind: 'failed'; failure: RuntimeFailure };

/** What a runtime retains of one operation of a handle. */
export const OpStateSchema = z.discriminatedUnion('state', [
  z.object({ op: OpIdSchema, state: z.literal('running') }),
  z.object({ op: OpIdSchema, state: z.literal('exited'), code: z.number().int(), stdout: z.string() }),
  z.object({ op: OpIdSchema, state: z.literal('cancelled') }),
  z.object({ op: OpIdSchema, state: z.literal('failed'), failure: RuntimeFailureSchema }),
]);

export type OpState = z.infer<typeof OpStateSchema>;

/** A reattach: the handle is gone, alive with what the runtime retains, or the runtime could not be asked. */
export type Reattached = { kind: 'gone' } | { kind: 'alive'; ops: OpState[]; display?: RuntimeDisplay } | { kind: 'failed'; failure: RuntimeFailure };

export interface ExecEvents {
  onAccepted?: () => void;
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
}

export type Initialized = { ok: true; can: DriverCan } | { ok: false; failure: RuntimeFailure };

/** A runtime's options, as a driver definition gives them; the runtime validates them at `init`. */
export type RuntimeOptions = Record<string, JsonValue>;

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
