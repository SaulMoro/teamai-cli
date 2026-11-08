import { randomBytes } from 'node:crypto';
import { OpIdSchema, type ConfinedKept, type ExecRequestSchema, type InitCredentials, type InitInstance, type OpenRequestSchema, type OpId, type OpState, type PromptRequestSchema, type PromptResult, type PromptSessionSchema, type PromptUsageSchema, type RuntimeDisplay, type RuntimeFailure, type RuntimeMode, type RuntimeOptions } from '@teamai/runtime-protocol';
import type { z } from 'zod';
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

/** The command that runs step `step` of run `run` again. */
export function retryCommand({ run, step }: { run: string; step: string }): string {
  return `teamai workflow retry ${run} ${step}`;
}

/** The failure codes of a step that a retry fixes as it is: the usage limit reset, or the runtime's daemon is back. */
const RETRIED_CODES: ReadonlySet<string> = new Set(['usage_limited', 'daemon_restarted']);

/**
 * The message of a step's failure, ending with `Then run:` and the retry command when a retry fixes its code, which is
 * the runtime's own. A runtime never spells the run or the step itself.
 */
export function withRetry({ code, message }: { code: string; message: string }, retry: { run: string; step: string }): string {
  return RETRIED_CODES.has(code) ? `${message.replace(/\.?\s*$/, '.')} Then run: ${retryCommand(retry)}` : message;
}

/** A runtime's credential values, labelled for masking: each is masked as a team secret is, whatever its name looks like. */
export function credentialSecrets(use: string, values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [`${name} (credential of ${use})`, value]));
}

/** A new operation id. */
export function newOpId(): OpId {
  return OpIdSchema.parse(`op-${randomBytes(6).toString('hex')}`);
}

/** An open as the local loop sends it; the protocol's request without its type. */
export type OpenRequest = Omit<z.infer<typeof OpenRequestSchema>, 'type'>;

/** An exec as the local loop sends it; the protocol's request without its type. */
export type ExecRequest = Omit<z.infer<typeof ExecRequestSchema>, 'type'>;

/** A prompt as the local loop sends it to a runtime that launches agents its own way. */
export type PromptRequest = Omit<z.infer<typeof PromptRequestSchema>, 'type'>;

export type Opened = { kind: 'ready'; handle: string; display?: RuntimeDisplay } | { kind: 'failed'; failure: RuntimeFailure };

/**
 * Whether `failure` is teamai's, for a runtime that did not answer a request it was sent (`stdio.ts`): it timed out,
 * stopped, or broke the protocol, so it may hold what it was asked to make. Any other failure is the runtime's own
 * answer, or `runtime_not_sent`, for a request teamai never sent to a runtime that had stopped.
 */
export function isUnansweredFailure(failure: RuntimeFailure): boolean {
  return failure.code === 'runtime_unanswered' || failure.code === 'runtime_exited' || failure.code === 'runtime_protocol';
}

/**
 * The runtime stopped answering after it was sent an operation: what that operation started may still run there, so
 * nothing it holds, such as a login, is released.
 */
export type Lost = { kind: 'lost'; failure: RuntimeFailure };

/** How an exec ended. `exited` carries the complete stdout, so a reattach rebuilds what a live run read. */
export type ExecEnd = { kind: 'exited'; code: number; stdout: string } | { kind: 'cancelled' } | { kind: 'failed'; failure: RuntimeFailure } | Lost;

/**
 * How a prompt ended: finished with the tool's session, the result the agent wrote, its usage, whether it continued the
 * session the lease asked to resume and, for a confined prompt, what the runtime kept; cancelled; or failed.
 */
export type PromptEnd =
  | { kind: 'finished'; session: z.infer<typeof PromptSessionSchema>; result: PromptResult; usage?: z.infer<typeof PromptUsageSchema>; confined?: ConfinedKept; resumed?: true }
  | { kind: 'cancelled' }
  | { kind: 'failed'; failure: RuntimeFailure }
  | Lost;

/** A reattach: the handle is gone, alive with what the runtime retains, or the runtime could not be asked. */
export type Reattached = { kind: 'gone' } | { kind: 'alive'; ops: OpState[]; display?: RuntimeDisplay } | { kind: 'failed'; failure: RuntimeFailure };

/** What a runtime showed with an operation's acceptance: a display, or none. */
export interface Accepted {
  display?: RuntimeDisplay;
}

export interface ExecEvents {
  onAccepted?: (accepted: Accepted) => void;
  /**
   * A display the runtime gave apart from the acceptance, such as the agent it launched after it accepted a prompt. It
   * neither accepts nor ends the operation, and may come before the acceptance.
   */
  onDisplay?: (display: RuntimeDisplay) => void;
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
}

/** A runtime's offer: what it can, and whether it launches agents its own way, so prompt steps reach it as `prompt`. */
/** `unavailable`: the tools the runtime cannot run now, each with the runtime's reason and next step. */
/** `ownLogins`: the tools whose login the runtime's provider keeps: teamai copies none of their logins, nor sends the sign-ins it found for them. */
export type Initialized = { ok: true; can: DriverCan; launchesAgents: boolean; unavailable?: Record<string, string>; ownLogins?: string[] } | { ok: false; failure: RuntimeFailure };

/** One step runtime, as the local loop calls it. Expected failures are values; a runtime that dies fails what it had in flight. */
export interface StepRuntime {
  /** The runtime's name, as a driver definition's `use` names it. */
  readonly name: string;
  /**
   * Validates `options` (a bad key fails with `bad_option` naming it) and answers what the runtime offers, knowing the
   * names of the `credentials` its definition gives it, the tool `instances` the member may run, and the run's
   * `checkout`. In `recover` mode it only answers for the handles it recorded.
   */
  init(request: { options: RuntimeOptions; mode: RuntimeMode; credentials?: InitCredentials; instances?: InitInstance[]; checkout?: string }): Promise<Initialized>;
  /**
   * Opens the attempt's place. `onAccepted` runs with the handle before `open` settles, so teamai persists it; `open`
   * rejects with its error. A place made in steps (a runtime through another) is accepted at each, with the handle so far.
   */
  open(request: OpenRequest, onAccepted: (handle: string) => Promise<void>): Promise<Opened>;
  exec(request: ExecRequest, events: ExecEvents): Promise<ExecEnd>;
  /** Runs a prompt step on a runtime that launches agents its own way; any other answers it failed. */
  prompt(request: PromptRequest, events: Pick<ExecEvents, 'onAccepted' | 'onDisplay'>): Promise<PromptEnd>;
  /** Stops operation `op` and every process it started. Its `exec` or `prompt` then ends `cancelled`. */
  cancel(op: OpId): Promise<void>;
  /** Brings the place's work back to the host, deletions included, never committed; after success and after failure. */
  collect(handle: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  /** `credentials`: as the outer of a runtime through it, the prompt's credentials again, which it keeps only in memory. */
  reattach(handle: string, how?: { credentials: Record<string, string>; unset?: string[] }): Promise<Reattached>;
  /**
   * Ends the handle: the runtime may drop its retained outcomes. A failure says the place, and what runs in it, may
   * remain. `release` says the person let the attempt go, so the runtime forgets the place even when it cannot end it.
   */
  close(handle: string, how?: { release: true }): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  /** Ends this connection to the runtime. Operations the runtime keeps running stay its own. */
  dispose(): Promise<void>;
}
