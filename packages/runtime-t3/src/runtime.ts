import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import {
  CANCEL_FAILED, PromptResultSchema, RUNTIME_PROTOCOL, RuntimeRequestSchema, type RUNTIME_MODES,
  type ConfinedKept, type ConfinedPrompt, type OpId, type OpState, type PromptLease, type PromptResult, type RuntimeDisplay, type RuntimeFailure, type RuntimeMessage, type RuntimeRequest,
} from '@teamai/runtime-protocol';
import { JsonValueSchema, type JsonValue } from '@teamai/tool-core/json';
import { z } from 'zod';
import type { Journal, LaunchRecord, PlaceRead, PlaceRecord, ThreadRecord } from './journal.js';
import { DRIVER_NAMES, DRIVERS, driverOf, sessionSince, toolOf, type ToolId } from './sessions.js';
import { STEP_MODE_LABELS, T3Error, type Environment, type Launch, type NewThread, type StepMode, type Project, type Provider, type T3, type Waited } from './t3.js';

// ─── teamai-runtime-t3 ───
//
//  Runtime protocol 1 for T3 Code: each prompt step runs as a T3 thread of its own, on the worktree teamai prepared,
//  where the person can watch it, steer it or stop it. It runs no command: command steps and setup go to the next
//  runtime of the driver definition (`local` in teamai-t3).
//
//    init     connect to the environment, signing in when attended; offer the tools its provider instances run, and
//             to judge with them best effort (a confined prompt)
//    open     the checkout must be a T3 project; the place is that project and the attempt's worktree. With no view,
//             the place of a confined prompt, which needs no project
//    prompt   t3_thread_launch (existing_worktree, auto or a tighter runtime_mode, clientRequestId = op), then t3_thread_wait
//             until the run and the work it delegated settle; the result file and the tool's transcript end it
//             confined: an idle scratch thread, its folder filled with a read-only copy of `dir`, then briefed to read
//             only that; its last message is the reply
//    cancel   stop the thread                     reattach  the ops and the thread, from the journal
//    collect  nothing to copy: the worktree, the result and the transcript are already on this machine. Settle the
//             thread of each op that ended, once T3 holds no run of it, so it leaves the person's active threads
//    close    stop each thread the runtime has not seen stop, whichever process launched it, settle what collect did
//             not (a judge's place is never collected), and remove a judge's copy
//
//  A thread the journal holds stays the runtime's to stop until it saw that thread stop: no failure path forgets it.
//

type RuntimeMode = (typeof RUNTIME_MODES)[number];

/** A mode the runtime runs steps in. In `recover` it only stops and closes what its journal holds. */
type WorkMode = Exclude<RuntimeMode, 'recover'>;

/** The options a driver definition gives `t3`. teamai strips `max_parallel` and `credentials` before `init`. */

const OptionsSchema = z.object({
  /** The T3 environment the threads run in: `local`, the T3 Code server on this machine. */
  environment: z.literal('local'),
  /** A T3 provider instance to run every prompt on, by its id in T3 Settings → Providers; the tool's default one otherwise. */
  instance: z.string().min(1).optional(),
  /** Tightens the mode every step thread runs in, from `auto`; nothing widens it. */
  runtime_mode: z.enum(['auto-accept-edits', 'approval-required']).optional(),
}).strict();

/** The option names an effort maps to in T3's model options, by provider. */
const EFFORT_OPTIONS = new Set(['effort', 'reasoningEffort', 'reasoning_effort', 'variant']);

/**
 * How long one `t3_thread_wait` holds; the runtime asks again until the run settles. A wait holds through a run that
 * waits for an approval, so an unattended run asks more often, to fail such a step soon after nobody can answer it.
 */
const WAIT_MS = { attended: 25_000, unattended: 5_000 } as const;

/**
 * How long a stop gets, T3's answer to it included, before it counts as not confirmed: T3 acknowledges a stop before the
 * run ends, and teamai ends a live prompt it cancelled lost when no outcome comes within 15 s.
 */
const STOP_WAIT_MS = 10_000;

/** How often an interactive step's thread is checked once it is idle without a result: the person may still be in it. */
const IDLE_POLL_MS = 2_000;

/**
 * What a judge's thread keeps of its directory, which `finished` reports: best effort, since only the brief and the
 * copy's file modes keep the agent there, and read, since the copy is read-only.
 */
const JUDGE_KEPT: ConfinedKept = { level: 'best-effort', access: 'read' };

/**
 * The refusals of a repeated launch that prove T3 launched nothing for its clientRequestId: the checks a new launch runs
 * (the project, the worktree, the provider instance, the mode the sign-in allows), which T3 skips for a launch it accepted.
 */
const LAUNCHED_NOTHING: ReadonlySet<string> = new Set(['invalid_request', 'runtime_mode_escalation_denied']);

const TERMINAL: ReadonlySet<string> = new Set<Waited['status']>(['completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);

/**
 * How the thread's work ended, once its run and the work the run delegated both settled: as the run that answered last,
 * or idle for a thread with no run. Undefined while either still goes, even when the run itself ended.
 */
function settledStatus(waited: Waited): Waited['status'] | undefined {
  if (waited.timedOut || (waited.status !== 'idle' && !TERMINAL.has(waited.status))) return undefined;

  return waited.resultRun?.status ?? waited.status;
}

export interface Connected {
  ok: true;
  t3: T3;
  /** Which sign-in the connection uses, as `signInOf` names it. */
  signIn: string;
}

export interface ServeOptions {
  input: NodeJS.ReadableStream;
  write(message: RuntimeMessage): void;
  journal: Journal;
  /** Connects to the environment for a run in `mode`; a failure names why and what the person does about it. */
  connect(mode: WorkMode): Promise<Connected | { ok: false; error: RuntimeFailure }>;
  /** The T3 thread the run was started from, when it was (T3 sets T3CODE_THREAD_ID in its sessions). */
  startedFrom?: string;
}

/** A prompt this process follows: its place, its thread once launched, whether teamai cancelled it, and a stop under way. */
interface Running {
  /** The place's handle and run, where the op's end is journaled and what a failed stop names. */
  handle: string;
  run: string;
  cancelled: boolean;
  thread?: ThreadRecord;
  /** Answers why T3 did not stop the thread, or nothing once it stopped; the stop, not the follow, ends the op then. */
  stopping?: Promise<string | undefined>;
}

/** What stopping, looking up and settling a thread need of T3: the connection, the environment links name, and the sign-in. */
interface Reached {
  t3: T3;
  environment: Environment;
  /** Which sign-in this runtime's calls go out under. */
  signIn: string;
}

/** A connection that runs steps, opened by `init` in a mode for new work. */
interface Session extends Reached {
  mode: WorkMode;
  /** The provider instance each offered tool runs on. */
  instances: Map<ToolId, Provider>;
  /** The mode every step thread launches in. */
  stepMode: StepMode;
}

type Reach = { ok: true; reached: Reached } | { ok: false; failure: RuntimeFailure };

type PromptRequest = Extract<RuntimeRequest, { type: 'prompt' }>;

/** What a prompt runs: a step on its attempt's worktree, or a judge confined to its directory. */
type Work = { kind: 'step'; place: PlaceRecord & { kind: 'worktree' } } | { kind: 'judge'; confined: ConfinedPrompt };

/** What `request` runs in `opened`: teamai opens a confined prompt's place with no view, and sends it nothing else. */
function workOf(request: PromptRequest, opened: PlaceRecord): Work | undefined {
  if (opened.kind === 'worktree') return request.confined ? undefined : { kind: 'step', place: opened };

  return request.confined ? { kind: 'judge', confined: request.confined } : undefined;
}

const execFileAsync = promisify(execFile);

/** The main checkout of the repository `worktree` belongs to. */
async function mainCheckout(worktree: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir']);

  return path.dirname(stdout.trim());
}

function realpath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** The usable instance of each tool: the one `instance` names, or T3's default one for the tool's provider. */
function instancesOf(providers: Provider[], instance: string | undefined): { ok: true; instances: Map<ToolId, Provider> } | { ok: false; failure: RuntimeFailure } {
  const usable = providers.filter((provider) => (provider.constraints ?? []).length === 0);
  const tools = new Map<ToolId, Provider>();

  if (instance !== undefined) {
    const named = providers.find((provider) => provider.providerInstanceId === instance);
    const tool = named && toolOf(named.driverKind);

    if (!named) return { ok: false, failure: { code: 'bad_option', key: 'instance', message: `T3 Code has no provider instance "${instance}". Add it in T3 Code under Settings → Providers, or remove \`instance\` to use the tool's default one. Instances here: ${providers.map((provider) => provider.providerInstanceId).join(', ') || 'none'}` } };

    if (!tool) return { ok: false, failure: { code: 'bad_option', key: 'instance', message: `T3 Code provider instance "${instance}" runs ${named.driverKind}, which this runtime does not run. It runs Claude and Codex instances` } };

    if ((named.constraints ?? []).length > 0) return { ok: false, failure: { code: 'bad_option', key: 'instance', message: `T3 Code provider instance "${instance}" cannot run now: ${(named.constraints ?? []).join(' ')} Enable it in T3 Code under Settings → Providers` } };
    tools.set(tool, named);

    return { ok: true, instances: tools };
  }

  for (const driver of DRIVER_NAMES) {
    const found = usable.find((provider) => provider.providerInstanceId === driver) ?? usable.find((provider) => provider.driverKind === driver);

    if (found) tools.set(DRIVERS[driver].tool, found);
  }

  return { ok: true, instances: tools };
}

/** The model selection `lease` asks of `provider`: its model, or the first T3 lists, and the effort as T3 names it. */
function modelSelection(provider: Provider, lease: PromptLease): { ok: true; selection: Launch['modelSelection'] } | { ok: false; failure: RuntimeFailure } {
  const name = lease.model?.name ?? provider.models[0]?.id;
  const model = provider.models.find((candidate) => candidate.id === name);
  const where = `T3 Code provider instance "${provider.providerInstanceId}" (${provider.displayName})`;

  if (!name || !model) return { ok: false, failure: { code: 'model_unavailable', message: `${where} has no model ${name ?? 'at all'}. Its models: ${provider.models.map((one) => one.id).join(', ') || 'none'}.` } };
  const effort = lease.model?.effort;

  if (effort === undefined) return { ok: true, selection: { instanceId: provider.providerInstanceId, model: model.id } };
  const option = model.options?.find((candidate) => EFFORT_OPTIONS.has(candidate.id) && candidate.values.includes(effort));

  if (!option) return { ok: false, failure: { code: 'model_unavailable', message: `${where} runs ${model.id} with no effort "${effort}".` } };

  return { ok: true, selection: { instanceId: provider.providerInstanceId, model: model.id, options: [{ id: option.id, value: effort }] } };
}

/**
 * The link that opens a thread in T3 Code's desktop app, from a browser, a terminal or `open`. T3 answers a launch
 * with its web UI's link instead.
 */
function threadLink(environment: Environment, threadId: string): string {
  return `t3code://threads/${environment.environmentId}/${encodeURIComponent(threadId)}`;
}

/** A thread as T3's own chat links it: a message in a T3 thread shows this as a link to that thread. */
function threadMention(environment: Environment, threadId: string): string {
  return `<t3-thread://v2/${environment.environmentId}/${threadId}>`;
}

/** What the run's details show of a thread: its title, its link, its id and model. */
function threadDisplay(thread: ThreadRecord, environment: Environment): RuntimeDisplay {
  return { label: thread.title.slice(0, 80), url: threadLink(environment, thread.threadId), fields: { thread: thread.threadId.slice(0, 200), model: thread.model, environment: environment.label } };
}

/** What the run's details show of a place before a thread runs in it. */
function placeDisplay(place: PlaceRecord, environment: Environment): RuntimeDisplay {
  if (place.kind === 'confined') return { label: 'T3 · judge', fields: { environment: environment.label } };

  return { label: `T3 · ${place.projectTitle}`.slice(0, 80), fields: { environment: environment.label, project: place.projectTitle } };
}

/** The thread's first message: which run and step it is, where the run started, then teamai's prompt. */
function firstMessage(place: PlaceRecord, lease: PromptLease, startedFrom: string | undefined): string {
  const origin = startedFrom ? ` It was started from the T3 thread ${startedFrom}.` : '';

  const interactive = lease.interactive
    ? '\n\nThis step is interactive: work through it with the person in this thread. Write the result file only once they say the step is done.'
    : '';

  return `This thread runs step "${lease.step}" of teamai workflow run ${place.run} (attempt ${place.attempt}).${origin}`
    + ` Work only in this worktree. Do not run teamai workflow commands: teamai commits, pushes and reports the step itself.${interactive}\n\n${lease.prompt}`;
}

/**
 * `text` with each mention of `dir`, and of a path under it, pointed at the same place under `copy`. teamai spells
 * `dir` exactly as the prompt names it; a sibling whose name only starts with the directory's stays as it is.
 */
function pointedAtCopy({ text, dir, copy }: { text: string; dir: string; copy: string }): string {
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // A name character, or a dot before one, continues another name; a dot that ends a sentence does not.
  return text.replace(new RegExp(`${escaped}(?![\\w-]|\\.[\\w-])`, 'g'), () => copy);
}

/**
 * A judge's first message: which step it runs, that its folder is all it may read, and the reply's shape, then
 * teamai's prompt with each mention of the directory pointed at the copy.
 */
function judgeMessage(place: PlaceRecord, lease: PromptLease, confined: ConfinedPrompt, copy: string): string {
  const reply = confined.schema === undefined
    ? 'Reply with the JSON value the prompt asks for and no other text.'
    : `Reply with one JSON value and no other text. teamai checks it against this JSON Schema, so it decides the reply's shape: ${JSON.stringify(confined.schema)}. Where the prompt below asks for a reply of another shape, give that value where this schema places it.`;

  return `This thread runs the confined step "${lease.step}" of teamai workflow run ${place.run} (attempt ${place.attempt}). Its folder, ${copy}, is a read-only copy of the directory the step reads.`
    + ' Read only the files in it: do not read, run or change anything outside it, and change nothing in it. Do not run teamai commands.'
    + ` ${reply}\n\n${pointedAtCopy({ text: lease.prompt, dir: confined.dir, copy })}`;
}

/** Sets the mode of every directory and file under `root`, `root` included; a symlink is left alone. */
function chmodTree(root: string, modes: { dir: number; file: number }): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const at = path.join(root, entry.name);

    if (entry.isDirectory()) chmodTree(at, modes);
    else if (entry.isFile()) fs.chmodSync(at, modes.file);
  }

  fs.chmodSync(root, modes.dir);
}

const READ_ONLY = { dir: 0o555, file: 0o444 };

const WRITABLE = { dir: 0o755, file: 0o644 };

/**
 * Fills `copy`, the judge thread's folder, with what `dir` holds, then makes it read-only. Whatever an earlier attempt
 * left there goes first. A symlink would reach outside `dir`, so none is copied.
 */
function copyReadOnly({ dir, copy }: { dir: string; copy: string }): void {
  chmodTree(copy, WRITABLE);

  for (const name of fs.readdirSync(copy)) fs.rmSync(path.join(copy, name), { recursive: true, force: true });
  fs.cpSync(dir, copy, { recursive: true, filter: (source) => !fs.lstatSync(source).isSymbolicLink() });
  chmodTree(copy, READ_ONLY);
}

/** teamai could not copy a judge's directory into its thread's folder: a fault on this machine, not in T3. */
class JudgeCopyFailed extends Error {}

/** The JSON value a judge replied with, in a fenced block or bare, or undefined when it is none. */
function replyValue(text: string): JsonValue | undefined {
  try {
    const parsed = JsonValueSchema.safeParse(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** What `promise` gave within `ms`, or that it had not by then; it may still settle later. */
async function within<TValue>(promise: Promise<TValue>, ms: number): Promise<{ answered: true; value: TValue } | { answered: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ answered: false }>((resolve) => { timer = setTimeout(() => resolve({ answered: false }), ms); });

  try {
    return await Promise.race([promise.then((value) => ({ answered: true as const, value })), late]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** The result the agent wrote, or why it does not count. */
function readResult(file: string): { ok: true; result: PromptResult } | { ok: false; why: string } {
  let text: string;

  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, why: `ended without writing the result file ${file}` };
  }

  try {
    const parsed = PromptResultSchema.safeParse(JSON.parse(text));

    return parsed.success ? { ok: true, result: parsed.data } : { ok: false, why: `wrote a result file that is not a workflow result ${file}` };
  } catch {
    return { ok: false, why: `wrote a result file that is not JSON ${file}` };
  }
}

export function serve(options: ServeOptions): Promise<void> {
  const { write, journal } = options;
  let session: Session | undefined;
  /**
   * Opened in recover mode: the connection a cancel or a close makes once it needs T3, which init never does, so a
   * stop starts whatever the sign-in or T3 Code's state. A failed one is tried again by the next request.
   */
  let recovering: { connecting?: Promise<Reach> } | undefined;
  /** The handle of each operation this process saw, so `cancel` (which names only the op) reaches its place. */
  const handleOf = new Map<OpId, string>();
  /** The prompts this process is running, by op; a repeated prompt joins the running one. */
  const running = new Map<OpId, Running>();
  /** Ops teamai cancelled before this process saw their prompt. */
  const cancelledEarly = new Set<OpId>();

  /** The place's record, to write to; a record that cannot be read is never written over. */
  const place = (handle: string): PlaceRecord | undefined => {
    const read = journal.read(handle);

    return read.kind === 'found' ? read.place : undefined;
  };

  /** Connects in recover mode as an unattended run does: with the sign-in teamai keeps, never asking for one. */
  const connectToRecover = async (): Promise<Reach> => {
    const connected = await options.connect('unattended');

    if (!connected.ok) return { ok: false, failure: connected.error };

    try {
      return { ok: true, reached: { t3: connected.t3, environment: await connected.t3.environment(), signIn: connected.signIn } };
    } catch (error) {
      await connected.t3.close().catch(() => {});

      return { ok: false, failure: { code: 't3_unavailable', message: `T3 Code did not say which environment it runs: ${error instanceof Error ? error.message : String(error)}` } };
    }
  };

  /** T3, for a request that needs it: the session init opened, or in recover mode a connection made now. */
  const reach = async (): Promise<Reach> => {
    if (session) return { ok: true, reached: session };

    if (!recovering) return { ok: false, failure: { code: 't3_unavailable', message: 'Runtime t3 did not start, so it has no connection to T3 Code.' } };
    const connecting = recovering.connecting ?? connectToRecover();
    recovering.connecting = connecting;
    const reached = await connecting;

    if (!reached.ok && recovering.connecting === connecting) delete recovering.connecting;

    return reached;
  };

  /** `known` with the thread of `op` ended: the runtime saw it stop. */
  const endedIn = (known: PlaceRecord, op: OpId): PlaceRecord => {
    const thread = known.threads[op];

    return thread && !thread.ended ? { ...known, threads: { ...known.threads, [op]: { ...thread, ended: {} } } } : known;
  };

  /** Journals how an op ended, and, when the runtime saw it stop, that its thread ended, in one write. */
  const record = (handle: string, state: OpState, { threadEnded }: { threadEnded: boolean }): void => {
    const now = place(handle);

    if (!now) return;
    const withOp = { ...now, ops: { ...now.ops, [state.op]: state } };
    journal.write(threadEnded ? endedIn(withOp, state.op) : withOp);
  };

  /** What a request that needs a place answers when its record is there but cannot be read: it may hold live threads. */
  const unreadable = (handle: string, read: Extract<PlaceRead, { kind: 'unreadable' }>): RuntimeFailure => ({
    code: 'journal_unreadable',
    message: `Runtime t3 cannot read its record of ${handle}, ${read.file} (${read.why.replace(/\.$/, '')}), so it cannot tell which T3 threads it launched there, and it keeps the place. Stop that run's threads in T3 Code (their titles end with "teamai" and the run id), then delete the file and cancel the run again.`,
  });

  /**
   * What a lost launch answers once the member signed in again: T3 finds a launch only under the sign-in that sent it,
   * so nothing here can find or stop its thread, and the place stays until the person did.
   */
  const launchUnconfirmed = (known: PlaceRecord, launch: LaunchRecord): RuntimeFailure => {
    const where = known.kind === 'worktree' ? `in the T3 project "${known.projectTitle}"` : 'under No project in T3 Code';

    return {
      code: 'launch_unconfirmed',
      message: `teamai launched the T3 thread "${launch.title}" ${where} under an earlier T3 Code sign-in, and T3 Code never answered, so it may still run. T3 Code finds that launch only under the sign-in that sent it, so teamai cannot find or stop it. In T3 Code, stop "${launch.title}" with its Stop button if it runs, then delete ${journal.file(known.handle)} and run teamai workflow cancel ${known.run} again.`,
    };
  };

  const fail = (op: OpId, failure: RuntimeFailure): void => write({ op, event: 'failed', failure });

  /** The terminal event of an operation that ended; a running one has none yet. */
  const answerEnded = (op: OpId, state: OpState): void => {
    switch (state.state) {
      case 'running':
        return;
      case 'finished':
        return write({ op, event: 'finished', session: state.session, result: state.result, ...(state.usage && { usage: state.usage }), ...(state.confined && { confined: state.confined }) });
      case 'cancelled':
        return write({ op, event: 'cancelled' });
      case 'failed':
        return write({ op, event: 'failed', failure: state.failure });
      case 'exited':
        return write({ op, event: 'exited', code: state.code, stdout: state.stdout });
      default: {
        const unhandled: never = state;

        return unhandled;
      }
    }
  };

  /**
   * Stops a step's thread as its Stop button does, and waits up to STOP_WAIT_MS for its run, and the work it delegated,
   * to settle. Answers why it did not stop, logged, while the thread may still run.
   */
  const whyNotStopped = async (t3: T3, threadId: string): Promise<string | undefined> => {
    const deadline = Date.now() + STOP_WAIT_MS;
    let why: string;

    try {
      const stopped = await within(t3.stop(threadId), STOP_WAIT_MS);

      if (stopped.answered) {
        // T3 answers the stop before the run ends, and stops the delegated work apart, so the thread has stopped only
        // once both settled. T3 answers a thread with nothing left to settle at once.
        const left = Math.max(deadline - Date.now(), 0);
        const waited = await within(t3.wait(threadId, left), left + 1_000);

        if (waited.answered && settledStatus(waited.value) !== undefined) return undefined;

        why = !waited.answered
          ? `T3 Code did not answer whether its run ended within ${STOP_WAIT_MS / 1_000} s`
          : TERMINAL.has(waited.value.status)
          ? `T3 Code stopped its run, but the work it delegated had not settled ${STOP_WAIT_MS / 1_000} s later`
          : `T3 Code acknowledged the stop, but its run was still ${waited.value.status} ${STOP_WAIT_MS / 1_000} s later`;
      } else {
        why = `T3 Code did not answer the stop within ${STOP_WAIT_MS / 1_000} s`;
      }
    } catch (error) {
      if (error instanceof T3Error && error.threadGone) return undefined;
      why = error instanceof Error ? error.message : String(error);
    }

    process.stderr.write(`Could not stop ${threadId}: ${why}\n`);

    return why;
  };

  /** That a thread still runs after T3 Code did not stop it, and what the person does about it. */
  const stillRuns = (s: Reached, thread: ThreadRecord, why: string): string =>
    `The T3 thread ${threadLink(s.environment, thread.threadId)} ("${thread.title}") still runs, and T3 Code did not stop it: ${why.replace(/\.$/, '')}. Stop it in T3 Code with its Stop button`;

  /** A stop the runtime could not confirm: the op's thread may still run, until a later cancel stops it. */
  const unconfirmed = (op: OpId, message: string): OpState => ({ op, state: 'failed', failure: { code: CANCEL_FAILED, message } });

  /**
   * Ends a prompt this process runs, once: a later end, such as a follow that saw the run end after a stop ended the
   * prompt, writes nothing.
   */
  const endRunning = (state: Running, ended: OpState, { threadEnded }: { threadEnded: boolean }): void => {
    if (running.get(ended.op) !== state) return;
    running.delete(ended.op);
    record(state.handle, ended, { threadEnded });
    answerEnded(ended.op, ended);
  };

  /**
   * Stops the thread of a prompt this process runs, and answers why it did not stop. A stop ends the prompt cancelled. A
   * cancel T3 did not carry out ends it cancel_failed, while its thread may still run; a close leaves it followed.
   */
  const stopRunning = async ({ s, state, op, thread, cancelling }: { s: Reached; state: Running; op: OpId; thread: ThreadRecord; cancelling: boolean }): Promise<string | undefined> => {
    const stopping = whyNotStopped(s.t3, thread.threadId);
    state.stopping = stopping;
    const why = await stopping;

    if (state.stopping === stopping) delete state.stopping;

    if (why === undefined) endRunning(state, { op, state: 'cancelled' }, { threadEnded: true });
    else if (cancelling) endRunning(state, unconfirmed(op, `${stillRuns(s, thread, why)}, then run teamai workflow cancel ${state.run} again.`), { threadEnded: false });

    return why;
  };

  // teamai quotes a keyed option failure (`key` set) inside a sentence of its own and ends it, so it brings no full stop.
  const init = async (request: Extract<RuntimeRequest, { type: 'init' }>): Promise<void> => {
    if (request.mode === 'recover') {
      recovering = {};
      write({ type: 'init', ok: true, can: {} });

      return;
    }

    const parsed = OptionsSchema.safeParse(request.options);

    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const key = issue?.code === 'unrecognized_keys' ? issue.keys[0] : issue?.path[0]?.toString();

      const message = key === 'runtime_mode'
        ? `runtime_mode ${JSON.stringify(request.options['runtime_mode'])} is not one runtime t3 takes. A step thread runs in auto, T3's Auto mode; runtime_mode only tightens it, to auto-accept-edits or approval-required. Remove it, or set one of those two`
        : `Runtime t3 takes { environment: local, instance?, runtime_mode? }: ${issue?.message ?? 'bad options'}`;

      write({ type: 'init', ok: false, error: { code: 'bad_option', message, ...(key && { key }) } });

      return;
    }

    const connected = await options.connect(request.mode);

    if (!connected.ok) {
      write({ type: 'init', ok: false, error: connected.error });

      return;
    }

    try {
      const [environment, providers] = await Promise.all([connected.t3.environment(), connected.t3.providers()]);
      const instances = instancesOf(providers, parsed.data.instance);

      if (!instances.ok) {
        write({ type: 'init', ok: false, error: instances.failure });

        return;
      }

      session = { t3: connected.t3, mode: request.mode, environment, instances: instances.instances, stepMode: parsed.data.runtime_mode ?? 'auto', signIn: connected.signIn };
      const tools = [...instances.instances.keys()];
      write({
        type: 'init', ok: true, prompt: true, confinedPrompt: true,
        can: {
          exec: false, setup: false, env: false, hitl: request.mode === 'attended', tokens: false, unattended: false, max_turns: false,
          workspace: ['new', 'continue'], tools, ...(tools.length > 0 && { confined: [{ ...JUDGE_KEPT, tools }] }),
        },
      });
    } catch (error) {
      write({ type: 'init', ok: false, error: { code: 't3_unavailable', message: `T3 Code did not answer what it runs: ${error instanceof Error ? error.message : String(error)}` } });
    }
  };

  const open = async (request: Extract<RuntimeRequest, { type: 'open' }>): Promise<void> => {
    const handle = `t3-${request.run}-${request.attempt}`;
    handleOf.set(request.op, handle);
    write({ op: request.op, event: 'accepted', handle });

    if (!session) {
      fail(request.op, { code: 'runtime_protocol', message: 'open came before a successful init.' });

      return;
    }

    const known = journal.read(handle);

    // Opening it afresh would forget the threads it holds.
    if (known.kind === 'unreadable') {
      fail(request.op, unreadable(handle, known));

      return;
    }

    if (known.kind === 'found') {
      write({ op: request.op, event: 'ready', display: placeDisplay(known.place, session.environment) });

      return;
    }

    const view = request.view;

    // A confined prompt's place: its thread runs in a scratch folder of its own, in no project.
    if (!view) {
      const confined: PlaceRecord = { kind: 'confined', handle, run: request.run, attempt: request.attempt, ops: {}, threads: {}, launches: {} };
      journal.write(confined);
      write({ op: request.op, event: 'ready', display: placeDisplay(confined, session.environment) });

      return;
    }

    let root: string;
    let projects: Project[];

    try {
      [root, projects] = await Promise.all([mainCheckout(view.worktree), session.t3.projects()]);
    } catch (error) {
      fail(request.op, { code: 'open_failed', message: `Could not match the worktree ${view.worktree} to a T3 Code project: ${error instanceof Error ? error.message : String(error)}` });

      return;
    }

    const project = projects.find((candidate) => !candidate.deletedAt && realpath(candidate.workspaceRoot) === realpath(root));

    if (!project) {
      fail(request.op, { code: 'not_a_t3_project', message: `${root} is not a project in T3 Code ${session.environment.label}. Add it in T3 Code (Add project, then pick that folder), then start the workflow again.` });

      return;
    }

    const opened: PlaceRecord = { kind: 'worktree', handle, run: request.run, attempt: request.attempt, projectId: project.id, projectTitle: project.title, ops: {}, threads: {}, launches: {} };
    journal.write(opened);
    write({ op: request.op, event: 'ready', display: placeDisplay(opened, session.environment) });
  };

  /** A judge's result: its last message, as the JSON value it replied with. */
  const judged = async (s: Session, thread: ThreadRecord): Promise<{ ok: true; result: PromptResult } | { ok: false; why: string }> => {
    const reply = await s.t3.lastReply(thread.threadId);
    const output = reply === undefined ? undefined : replyValue(reply);

    return output === undefined ? { ok: false, why: 'replied with no JSON value' } : { ok: true, result: { output } };
  };

  /** Launches a step's thread on the attempt's worktree with its first message, and returns its id. */
  const launchStep = async (s: Session, request: PromptRequest, opened: PlaceRecord & { kind: 'worktree' }, thread: NewThread): Promise<string> => {
    const message = firstMessage(opened, request.lease, options.startedFrom && threadMention(s.environment, options.startedFrom));

    return (await s.t3.launch({ ...thread, message, projectId: opened.projectId, worktreePath: request.cwd })).threadId;
  };

  /**
   * Launches a judge's thread idle in a scratch folder, unless the journal holds it (`known`), fills the folder with a
   * read-only copy of its directory, then briefs it. The copy is journaled before it is made, so close removes it
   * whatever happens next. A thread that already ran, after a restart, was copied and briefed then.
   */
  const launchJudge = async ({ s, request, confined, opened, journalThread, thread, known }: {
    s: Session;
    request: PromptRequest;
    confined: ConfinedPrompt;
    opened: PlaceRecord;
    journalThread: (threadId: string, copy: string) => ThreadRecord;
    thread: NewThread;
    known: ThreadRecord | undefined;
  }): Promise<ThreadRecord> => {
    const threadId = known?.threadId ?? (await s.t3.launchScratch(thread)).threadId;
    const shell = await s.t3.thread(threadId);

    if (shell.worktreePath === null) throw new Error(`T3 Code gave the thread ${threadId} no folder.`);
    const launched = known ?? journalThread(threadId, shell.worktreePath);

    if (shell.runCount === 0) {
      try {
        copyReadOnly({ dir: confined.dir, copy: shell.worktreePath });
      } catch (error) {
        throw new JudgeCopyFailed(`teamai could not copy ${confined.dir} into the judge thread's folder ${shell.worktreePath}, so the judge did not start: ${error instanceof Error ? error.message : String(error)}`);
      }

      await s.t3.send(threadId, judgeMessage(opened, request.lease, confined, shell.worktreePath), `${request.op}:brief`);
    }

    return launched;
  };

  /**
   * Waits for the thread until the step is done, stopped or failed, and returns how it ended, and whether the runtime
   * saw the thread stop on the way: only then does the thread end with the op.
   */
  const follow = async (s: Session, request: PromptRequest, thread: ThreadRecord, state: Running): Promise<{ state: OpState; threadEnded: boolean } | undefined> => {
    const where = `The T3 thread ${threadLink(s.environment, thread.threadId)} ("${thread.title}")`;
    const stopped = (ended: OpState) => ({ state: ended, threadEnded: true });
    let errors = 0;

    for (;;) {
      // A stop teamai asked for ended the op.
      if (running.get(request.op) !== state) return undefined;
      let waited: Waited;

      try {
        waited = await s.t3.wait(thread.threadId, WAIT_MS[s.mode]);
        errors = 0;
      } catch (error) {
        // T3 restarting, or a dropped connection: the thread keeps running, so ask again a few times.
        if (++errors > 5) return { state: { op: request.op, state: 'failed', failure: { code: 't3_unavailable', message: `${where} could not be followed: ${error instanceof Error ? error.message : String(error)}` } }, threadEnded: false };

        await sleep(1_000 * errors);
        continue;
      }

      // A stop under way decides how the op ends; once it did not stop the thread, it is followed as before.
      if (state.stopping) {
        await state.stopping;
        continue;
      }

      // A run that ended while the work it delegated still goes has not ended the step.
      const ended = settledStatus(waited);

      if (ended === undefined || ended === 'idle') {
        // T3 keeps a run that asks for an approval running, with the request pending; nobody answers it unattended.
        if (s.mode === 'unattended' && (waited.status === 'waiting' || (await s.t3.thread(thread.threadId)).pendingRequestCount > 0)) {
          const why = await whyNotStopped(s.t3, thread.threadId);
          const asked = `${where} asked for an approval, and nobody is there to give it in an unattended run.`;

          if (why === undefined) return stopped({ op: request.op, state: 'failed', failure: { code: 'tool_failed', message: asked } });

          // The thread may still run, so the op ends as a stop the runtime could not confirm, which a later cancel retries.
          return { state: unconfirmed(request.op, `${asked} It still runs, and T3 Code did not stop it: ${why.replace(/\.$/, '')}. Stop it in T3 Code with its Stop button.`), threadEnded: false };
        }

        // A wait that came back before its time on a run still going (waiting for the person, or idle) is asked again later.
        if (!waited.timedOut) await sleep(IDLE_POLL_MS);
        continue;
      }

      // From here on, the thread's run and the work it delegated settled.
      if (ended !== 'completed') return stopped({ op: request.op, state: 'failed', failure: { code: 'tool_failed', message: `${where} ended ${ended} before the step was done.` } });

      // An interactive step ends once the person said it is done and the agent wrote the result; until then the
      // thread idles between their turns.
      if (request.lease.interactive && !fs.existsSync(request.lease.result)) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

      const written = request.confined ? await judged(s, thread) : readResult(request.lease.result);

      if (!written.ok) return stopped({ op: request.op, state: 'failed', failure: { code: 'tool_failed', message: `${where} ${written.why}.` } });
      const cwd = thread.copy ?? request.cwd;
      const driver = driverOf(thread.tool);
      const id = driver && await sessionSince(driver, cwd, thread.launchedAt);

      if (!id) return stopped({ op: request.op, state: 'failed', failure: { code: 'tool_failed', message: `${where} finished, but ${thread.tool} kept no session for ${cwd}, so the step cannot be scored or resumed.` } });

      return stopped({ op: request.op, state: 'finished', session: { tool: thread.tool, id }, result: written.result, ...(request.confined && { confined: JUDGE_KEPT }) });
    }
  };

  const prompt = async (request: PromptRequest): Promise<void> => {
    handleOf.set(request.op, request.handle);
    const read = journal.read(request.handle);
    const opened = read.kind === 'found' ? read.place : undefined;
    const ended = opened?.ops[request.op];

    /** The acceptance shows the step's thread when the journal holds it already, so the run details link it during the run. */
    const accept = (thread: ThreadRecord | undefined): void => {
      write({ op: request.op, event: 'accepted', ...(thread && session && { display: threadDisplay(thread, session.environment) }) });
    };

    if (ended && ended.state !== 'running') {
      accept(opened?.threads[request.op]);
      answerEnded(request.op, ended);

      return;
    }

    if (running.has(request.op)) {
      accept(opened?.threads[request.op]);

      return;
    }

    if (!session || !opened) {
      accept(undefined);
      fail(request.op, read.kind === 'unreadable' ? unreadable(request.handle, read) : { code: 'runtime_protocol', message: session ? `No open place ${request.handle}.` : 'prompt came before a successful init.' });

      return;
    }

    const s = session;

    const end = (state: OpState, threadEnded = false): void => {
      running.delete(request.op);
      record(request.handle, state, { threadEnded });
      answerEnded(request.op, state);
    };

    /**
     * Ends an op this process launched no thread for. A thread the journal holds for it, which another process may have
     * launched, or a launch T3 never answered, stays the runtime's to stop.
     */
    const refuse = (state: OpState): void => {
      accept(undefined);
      end(state);
    };

    if (cancelledEarly.delete(request.op)) {
      refuse({ op: request.op, state: 'cancelled' });

      return;
    }

    const lease = request.lease;
    const driver = driverOf(lease.tool);
    const instance = driver && s.instances.get(DRIVERS[driver].tool);

    if (!instance) {
      refuse({ op: request.op, state: 'failed', failure: { code: 'tool_unavailable', message: `T3 Code ${s.environment.label} runs ${[...s.instances.keys()].join(', ') || 'no tool this runtime runs'} here, not ${lease.tool}.` } });

      return;
    }

    if (lease.permissions === 'unattended') {
      // The offer says unattended: false, so teamai never sends one; a thread on the host never runs in full access.
      refuse({ op: request.op, state: 'failed', failure: { code: 'unattended_unsupported', message: 'Runtime t3 runs no step in unattended permissions on this machine.' } });

      return;
    }

    const credentials = Object.keys(request.credentials);

    // The offer says env: false, so teamai sends none: the thread's tool runs in T3 Code's environment, on its sign-in.
    if (credentials.length > 0) {
      refuse({
        op: request.op, state: 'failed', failure: {
          code: 'credentials_unsupported',
          message: `Runtime t3 got credentials ${credentials.join(', ')}, but a T3 thread runs its tool in T3 Code's environment, on T3 Code's own sign-in, and this runtime cannot pass it a value (its init offers can.env: false). Remove the credentials from the runtime, or run the step on a runtime that offers can.env.`,
        },
      });

      return;
    }

    const selection = modelSelection(instance, lease);

    if (!selection.ok) {
      refuse({ op: request.op, state: 'failed', failure: selection.failure });

      return;
    }

    const work = workOf(request, opened);

    if (!work) {
      refuse({ op: request.op, state: 'failed', failure: { code: 'runtime_protocol', message: opened.kind === 'confined' ? `${request.handle} is a confined prompt's place, and this prompt is not confined.` : `A confined prompt came to ${request.handle}, which was opened with a view.` } });

      return;
    }

    let thread = opened.threads[request.op];
    const pending = opened.launches[request.op];

    // Launching again under this sign-in would start the step a second time, beside the thread T3 may run.
    if (!thread && pending && pending.signIn !== s.signIn) {
      refuse({ op: request.op, state: 'failed', failure: launchUnconfirmed(opened, pending) });

      return;
    }

    const state: Running = { handle: request.handle, run: opened.run, cancelled: false };
    running.set(request.op, state);
    const finish = (outcome: OpState, threadEnded = false): void => endRunning(state, outcome, { threadEnded });

    try {
      const title = `${lease.step} · teamai ${opened.run}`;
      const launchedAt = thread?.launchedAt ?? pending?.launchedAt ?? Date.now();
      const newThread: NewThread = { title, modelSelection: selection.selection, runtimeMode: s.stepMode, clientRequestId: request.op };

      // T3 may launch the thread and still fail to answer, so the launch is journaled before it is sent.
      if (!thread) {
        const launch: LaunchRecord = { title, modelSelection: selection.selection, runtimeMode: s.stepMode, tool: lease.tool, launchedAt, signIn: s.signIn, ...(work.kind === 'step' && { worktreePath: request.cwd }) };
        const now = place(request.handle) ?? opened;
        journal.write({ ...now, ops: { ...now.ops, [request.op]: { op: request.op, state: 'running' } }, launches: { ...now.launches, [request.op]: launch } });
      }

      // Accepted before T3 launches anything, which may take longer than teamai waits for an acceptance.
      accept(thread);

      /** Journals the op running on `threadId`, with the judge's copy once its folder is known, in place of its launch. */
      const journalThread = (threadId: string, copy: string | undefined): ThreadRecord => {
        const launched: ThreadRecord = { threadId, title, model: selection.selection.model, tool: lease.tool, launchedAt, ...(copy && { copy }) };
        const now = place(request.handle) ?? opened;
        const { [request.op]: _answered, ...launches } = now.launches;
        journal.write({ ...now, ops: { ...now.ops, [request.op]: { op: request.op, state: 'running' } }, threads: { ...now.threads, [request.op]: launched }, launches });
        state.thread = launched;
        write({ op: request.op, event: 'display', display: threadDisplay(launched, s.environment) });

        return launched;
      };

      // A thread the journal holds is reconnected to by its id: T3 answers a repeated launch with it only under the
      // sign-in that sent the launch, and would start the step again under another.
      if (thread) state.thread = thread;
      thread = work.kind === 'judge'
        ? await launchJudge({ s, request, confined: work.confined, opened, journalThread, thread: newThread, known: thread })
        : thread ?? journalThread(await launchStep(s, request, work.place, newThread), undefined);
    } catch (error) {
      // T3 caps a thread's mode at the access the member approved teamai with, and says so with this code.
      const tooNarrow = error instanceof T3Error && error.refusal?.code === 'runtime_mode_escalation_denied' ? error.refusal.message : undefined;
      finish({
        op: request.op, state: 'failed', failure: error instanceof JudgeCopyFailed
          ? { code: 'judge_copy_failed', message: error.message }
          : tooNarrow === undefined
          ? { code: 't3_launch_failed', message: `T3 Code did not launch the step's thread: ${error instanceof Error ? error.message : String(error)}` }
          : {
            code: 'sign_in_too_narrow',
            message: `T3 Code refused to start the step's thread in ${s.stepMode} mode, because teamai's sign-in does not allow it (${tooNarrow}). Remove ~/.teamai/runtime-state/t3/credentials.json, start the workflow again, and approve teamai with ${STEP_MODE_LABELS[s.stepMode]} access or broader. Or set runtime_mode to a mode the sign-in allows.`,
          },
      });

      return;
    }

    // teamai cancelled the prompt while T3 launched its thread.
    if (state.cancelled) {
      await stopRunning({ s, state, op: request.op, thread, cancelling: true });

      return;
    }

    try {
      const followed = await follow(s, request, thread, state);

      if (followed) finish(followed.state, followed.threadEnded);
    } catch (error) {
      // The thread may still run in T3, where the person finds it by the link.
      finish({ op: request.op, state: 'failed', failure: { code: 't3_unavailable', message: `Lost track of the T3 thread ${threadLink(s.environment, thread.threadId)}: ${error instanceof Error ? error.message : String(error)}` } });
    }
  };

  /**
   * Finds the thread of a launch T3 never answered by repeating it with the same clientRequestId and no message: T3
   * answers a launch it accepted with that thread and starts nothing more, and launches an idle thread otherwise. A
   * launch a new launch's check refuses launched nothing. Answers the place as journaled then, or why a launch another
   * sign-in sent cannot be looked up; throws while T3 does not say.
   */
  const resolveLaunch = async (s: Reached, known: PlaceRecord, op: OpId, launch: LaunchRecord): Promise<{ ok: true; place: PlaceRecord } | { ok: false; failure: RuntimeFailure }> => {
    if (launch.signIn !== s.signIn) return { ok: false, failure: launchUnconfirmed(known, launch) };
    const newThread: NewThread = { title: launch.title, modelSelection: launch.modelSelection, runtimeMode: launch.runtimeMode, clientRequestId: op };
    let threadId: string | undefined;

    try {
      threadId = (known.kind === 'worktree' && launch.worktreePath !== undefined
        ? await s.t3.launch({ ...newThread, projectId: known.projectId, worktreePath: launch.worktreePath })
        : await s.t3.launchScratch(newThread)).threadId;
    } catch (error) {
      // T3 answers a launch it accepted before any check a new launch needs, so only such a check's refusal proves it
      // launched nothing. Any other answer, such as orchestration_error, may come from the lookup itself.
      if (!(error instanceof T3Error && error.refusal !== undefined && LAUNCHED_NOTHING.has(error.refusal.code))) throw error;
    }

    const now = place(known.handle) ?? known;
    const { [op]: _resolved, ...launches } = now.launches;
    const thread: ThreadRecord | undefined = threadId === undefined ? undefined : { threadId, title: launch.title, model: launch.modelSelection.model, tool: launch.tool, launchedAt: launch.launchedAt };
    const resolved: PlaceRecord = { ...now, launches, ...(thread && { threads: { ...now.threads, [op]: thread } }) };
    journal.write(resolved);

    return { ok: true, place: resolved };
  };

  const cancel = async (op: OpId): Promise<void> => {
    const state = running.get(op);

    if (state) {
      state.cancelled = true;

      // Without a thread yet, the prompt stops it once T3 answers the launch.
      if (state.thread && session) await stopRunning({ s: session, state, op, thread: state.thread, cancelling: true });

      return;
    }

    const handle = handleOf.get(op);
    let known = handle ? place(handle) : journal.placeOf(op);
    const retained = known?.ops[op];

    // A runtime before this one launched the thread and died, maybe before T3 answered the launch, or a stop failed
    // before; teamai cancels before it reattaches.
    if (!known || !(retained?.state === 'running' || (retained?.state === 'failed' && retained.failure.code === CANCEL_FAILED))) {
      if (retained) answerEnded(op, retained);
      else cancelledEarly.add(op);

      return;
    }

    const { handle: at, run } = known;

    // From reading this cancel until its stop is confirmed or fails again, the op runs: a stop that failed before is not
    // this cancel's outcome.
    if (retained.state === 'failed') record(at, { op, state: 'running' }, { threadEnded: false });

    const answer = (ended: OpState, threadEnded: boolean): void => {
      record(at, ended, { threadEnded });
      answerEnded(op, ended);
    };

    const reached = await reach();

    if (!reached.ok) return answer(unconfirmed(op, `teamai could not reach T3 Code to stop the T3 thread of ${op}, so it may still run (${reached.failure.message.replace(/\.$/, '')}). Run teamai workflow cancel ${run} again once T3 Code answers.`), false);
    const s = reached.reached;
    const launch = known.launches[op];

    if (launch) {
      let resolved: Awaited<ReturnType<typeof resolveLaunch>>;

      try {
        resolved = await resolveLaunch(s, known, op, launch);
      } catch (error) {
        return answer(unconfirmed(op, `teamai launched the T3 thread "${launch.title}" and T3 Code never answered, so it may run, and T3 Code did not say whether it launched it when teamai looked: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}. Run teamai workflow cancel ${run} again once T3 Code answers.`), false);
      }

      // The launch stays journaled, so close keeps the place and says the same.
      if (!resolved.ok) return answer(unconfirmed(op, resolved.failure.message), false);
      known = resolved.place;
    }

    const left = known.threads[op];
    const why = left && await whyNotStopped(s.t3, left.threadId);

    if (left && why !== undefined) return answer(unconfirmed(op, `${stillRuns(s, left, why)}, then run teamai workflow cancel ${run} again.`), false);
    answer({ op, state: 'cancelled' }, true);
  };

  /**
   * Settles each thread of `handle` that ended and that T3 holds no run of, once: a thread the runtime has not seen
   * stop, or one the person started again, stays. A settle T3 refuses is said once on stderr and fails nothing.
   */
  const settleEnded = async (handle: string, s: Reached): Promise<void> => {
    const known = place(handle);

    if (!known) return;

    for (const [op, thread] of Object.entries(known.threads)) {
      if (!thread.ended || thread.ended.settlement) continue;
      let outcome: NonNullable<NonNullable<ThreadRecord['ended']>['settlement']>;

      try {
        const { status } = await s.t3.thread(thread.threadId);

        if (status !== null && status !== 'idle' && !TERMINAL.has(status)) continue;
        await s.t3.settle(thread.threadId);
        outcome = 'settled';
      } catch (error) {
        // A thread T3 no longer has is in nobody's active threads.
        outcome = error instanceof T3Error && error.threadGone ? 'settled' : 'failed';

        if (outcome === 'failed') process.stderr.write(`teamai could not settle the T3 thread ${threadLink(s.environment, thread.threadId)} ("${thread.title}"), so it stays in T3 Code's active threads: ${error instanceof Error ? error.message : String(error)}\n`);
      }

      const now = place(handle);

      if (now?.threads[op]) journal.write({ ...now, threads: { ...now.threads, [op]: { ...now.threads[op], ended: { settlement: outcome } } } });
    }
  };

  /**
   * Ends the place. Each launch T3 never answered is looked up, and each thread the runtime has not seen stop is stopped
   * first; while one cannot be, the place stays, with a judge's copy, and close fails.
   */
  const close = async (handle: string): Promise<void> => {
    const read = journal.read(handle);
    const failClose = (failure: RuntimeFailure): void => write({ event: 'close_failed', handle, failure });

    if (read.kind === 'unreadable') return failClose(unreadable(handle, read));
    let known = read.kind === 'found' ? read.place : undefined;

    if (known) {
      // Every launch and thread is journaled with its op.
      for (const { op } of Object.values(known.ops)) {
        const launch = known.launches[op];

        if (!launch) continue;
        const lookUp = `teamai launched the T3 thread "${launch.title}" and T3 Code never answered, so it may run`;

        const reached = await reach();

        // Nothing here can find the thread without T3 Code.
        if (!reached.ok) return failClose({ code: 't3_unavailable', message: `${lookUp}, and teamai could not reach T3 Code to look for it (${reached.failure.code}). Open T3 Code, then run teamai workflow cancel ${known.run} again.` });

        let resolved: Awaited<ReturnType<typeof resolveLaunch>>;

        try {
          resolved = await resolveLaunch(reached.reached, known, op, launch);
        } catch (error) {
          return failClose({ code: 't3_unavailable', message: `${lookUp}, and T3 Code did not say whether it launched it when teamai looked: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}. Run teamai workflow cancel ${known.run} again once T3 Code answers.` });
        }

        if (!resolved.ok) return failClose(resolved.failure);
        known = resolved.place;
      }

      for (const { op } of Object.values(known.ops)) {
        const thread = known.threads[op];

        if (!thread || thread.ended) continue;

        const reached = await reach();

        // Nothing here can stop the thread, or tell that it ended, without T3 Code.
        if (!reached.ok) return failClose({ code: 't3_unavailable', message: `The T3 thread "${thread.title}" (${thread.threadId}) may still run, and teamai could not reach T3 Code to stop it (${reached.failure.code}). Open T3 Code, then run teamai workflow cancel ${known.run} again.` });
        const s = reached.reached;
        const live = running.get(op);
        // A prompt still running here ends cancelled once its thread stopped, and is followed on while it did not.
        const why = live ? await stopRunning({ s, state: live, op, thread, cancelling: false }) : await whyNotStopped(s.t3, thread.threadId);

        if (why !== undefined) return failClose({ code: 'thread_still_runs', message: `${stillRuns(s, thread, why)}.` });

        const now = place(handle);

        if (now) journal.write(endedIn(now, op));
      }

      // Every thread of the place has ended now. Without T3 Code, they stay unsettled.
      const unsettled = Object.values(place(handle)?.threads ?? {}).some((thread) => thread.ended && !thread.ended.settlement);
      const reached = unsettled ? await reach() : undefined;

      if (reached?.ok) await settleEnded(handle, reached.reached);
    }

    // A judge's copy is the thread's scratch folder, so the thread loses its folder with it.
    for (const thread of Object.values(known?.threads ?? {})) {
      if (thread.copy && fs.existsSync(thread.copy)) {
        chmodTree(thread.copy, WRITABLE);
        fs.rmSync(thread.copy, { recursive: true, force: true });
      }
    }

    journal.remove(handle);
    write({ event: 'closed', handle });
  };

  const handleRequest = async (request: RuntimeRequest): Promise<void> => {
    switch (request.type) {
      case 'init':
        return init(request);
      case 'open':
        return open(request);
      case 'exec':
        write({ op: request.op, event: 'accepted' });
        fail(request.op, { code: 'exec_unsupported', message: 'Runtime t3 runs prompt steps as T3 Code threads and runs no command (can.exec: false).' });

        return;
      case 'prompt':
        return prompt(request);
      case 'cancel':
        return cancel(request.op);
      case 'collect': {
        const read = journal.read(request.handle);

        if (read.kind === 'unreadable') {
          write({ event: 'collect_failed', handle: request.handle, failure: unreadable(request.handle, read) });

          return;
        }

        // In recover mode nothing is settled before close, which connects only when it needs T3.
        if (session) await settleEnded(request.handle, session);
        write({ event: 'collected', handle: request.handle });

        return;
      }

      case 'reattach': {
        // The journal alone answers: only a place it no longer holds is gone, whether or not T3 Code can be reached. One
        // whose record cannot be read may hold live threads, so the reattach fails, saying why.
        const read = journal.read(request.handle);

        if (read.kind === 'missing') {
          write({ event: 'gone', handle: request.handle });

          return;
        }

        if (read.kind === 'unreadable') {
          write({ event: 'failed', handle: request.handle, failure: unreadable(request.handle, read) });

          return;
        }

        const known = read.place;

        const latest = Object.values(known.threads).sort((a, b) => b.launchedAt - a.launchedAt)[0];
        const display = session && (latest ? threadDisplay(latest, session.environment) : placeDisplay(known, session.environment));
        write({ event: 'alive', handle: request.handle, ops: Object.values(known.ops), ...(display && { display }) });

        return;
      }

      case 'close':
        return close(request.handle);
      default: {
        const unhandled: never = request;

        return unhandled;
      }
    }
  };

  /**
   * Answers a request that threw with a failure of its own: teamai fails every request it waits on when a line names
   * none. A cancel that threw did not confirm a stop.
   */
  const failRequest = (request: RuntimeRequest, why: string): void => {
    switch (request.type) {
      case 'init':
        return write({ type: 'init', ok: false, error: { code: 'runtime_error', message: `Runtime t3 could not start: ${why}` } });
      case 'open':
      case 'exec':
      case 'prompt':
        return fail(request.op, { code: 'runtime_error', message: `Runtime t3 could not carry out ${request.type} of ${request.op}: ${why}` });
      case 'cancel':
        return fail(request.op, { code: CANCEL_FAILED, message: `Runtime t3 could not carry out the cancel of ${request.op}, so its T3 thread may still run: ${why.replace(/\.$/, '')}. Run teamai workflow cancel again.` });
      case 'reattach':
      case 'collect':
      case 'close':
        return write({ event: 'failed', handle: request.handle, failure: { code: 'runtime_error', message: `Runtime t3 could not carry out ${request.type} of ${request.handle}: ${why}` } });
      default: {
        const unhandled: never = request;

        return unhandled;
      }
    }
  };

  return new Promise((resolve) => {
    const lines = readline.createInterface({ input: options.input });

    lines.on('line', (text) => {
      let request: RuntimeRequest;

      try {
        request = RuntimeRequestSchema.parse(JSON.parse(text));
      } catch (error) {
        write({ event: 'error', message: `Not a protocol ${RUNTIME_PROTOCOL} request: ${error instanceof Error ? error.message : String(error)}` });

        return;
      }

      void (async () => {
        try {
          await handleRequest(request);
        } catch (error) {
          failRequest(request, error instanceof Error ? error.message : String(error));
        }
      })();
    });

    // teamai is gone: a step still running keeps its thread in T3, which a later teamai reattaches, so this process
    // follows it no further.
    lines.on('close', () => resolve());
  });
}
