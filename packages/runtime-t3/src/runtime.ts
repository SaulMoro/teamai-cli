import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import {
  CANCEL_FAILED, OpIdSchema, PromptResultSchema, RUNTIME_PROTOCOL, RuntimeHandleSchema, RuntimeRequestSchema, UNAVAILABLE_REASON_MAX, type RUNTIME_MODES,
  type ConfinedKept, type ConfinedPrompt, type OpId, type OpState, type PromptLease, type PromptResult, type RuntimeDisplay, type RuntimeFailure, type RuntimeMessage, type RuntimeRequest,
} from '@teamai/runtime-protocol';
import { JsonValueSchema, type JsonValue } from '@teamai/tool-core/json';
import { findOnPath } from '@teamai/tool-core/lookpath';
import { z } from 'zod';
import { addProviderInstance, isInstanceId, type NewInstance } from './add-instance.js';
import type { AddedProjects } from './added-projects.js';
import type { SignInAccess } from './auth.js';
import { parseOptions } from './options.js';
import type { Journal, LaunchRecord, PlaceRead, PlaceRecord, ThreadRecord } from './journal.js';
import { CLOCK_SLACK_MS, DRIVER_NAMES, DRIVERS, driverOf, isDefaultToolHome, sessionSince, toolOf, type Driver, type ToolId } from './sessions.js';
import { instanceToolHome, projectSettings, readSettings, type ModelSelection, type ProjectSettings, type T3RuntimeMode } from './settings.js';
import { driverOfProvider, runsOwnBinary, servedInstances, teamaiToolHome, tilde, type ServedInstances } from './tool-instances.js';
import { T3Error, USAGE_LIMIT_TITLE, type Environment, type Launch, type ListedThread, type NewThread, type StepMode, type Project, type Provider, type T3, type Waited } from './t3.js';
import type { T3Command } from './t3-command.js';

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
//             not (a judge's place is never collected), and remove a judge's copy, and each project teamai added
//             for a folder of its own that teamai has removed since
//
//  A thread the journal holds stays the runtime's to stop until it saw that thread stop: no failure path forgets it.
//

type RuntimeMode = (typeof RUNTIME_MODES)[number];

/** A mode the runtime runs steps in. In `recover` it only stops and closes what its journal holds. */
type WorkMode = Exclude<RuntimeMode, 'recover'>;

/** The option names an effort maps to in T3's model options, by provider. */
const EFFORT_OPTIONS = new Set(['effort', 'reasoningEffort', 'reasoning_effort', 'variant']);

/**
 * How long one `t3_thread_wait` holds; the runtime asks again until the run settles. A wait holds through a run that
 * waits for an approval, so an unattended run asks more often, to fail such a step soon after nobody can answer it.
 */
const WAIT_MS = { attended: 25_000, unattended: 5_000 } as const;

/**
 * How long a stop gets, from the moment the runtime reads the cancel, before it counts as not confirmed: a launch still
 * pending, the connection, looking a launch up, and T3's answer to the stop all count. T3 acknowledges a stop before the
 * run ends, and teamai ends a live prompt it cancelled lost when no outcome comes within 15 s.
 */
const STOP_WAIT_MS = 10_000;

/** How long `t3 project add` may take before an open gives up on it. */
const PROJECT_ADD_MS = 10_000;

/**
 * How long T3 gets to answer init's connection and what it runs: teamai gives init 15 s. An attended sign-in waits for
 * the person instead, and this bound starts once they approved.
 */
const INIT_WAIT_MS = 10_000;

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

/** The threads among `listed` of the tasks `threadId` delegated, at any depth: each names the thread that delegated it. */
function tasksOf(listed: ListedThread[], threadId: string): ListedThread[] {
  const tasks = new Set([threadId]);

  // Delegated tasks start after the thread that delegated them, so a pass per depth finds each one.
  for (let grew = true; grew;) {
    grew = false;

    for (const one of listed) {
      if (one.parentThreadId && tasks.has(one.parentThreadId) && !tasks.has(one.threadId)) {
        tasks.add(one.threadId);
        grew = true;
      }
    }
  }

  return listed.filter((one) => one.threadId !== threadId && tasks.has(one.threadId));
}

/**
 * Whether the thread, or a task it delegated at any depth, holds a request for a person. T3 holds a delegated task's
 * approval on the task's own thread, while the thread that delegated it runs on, waiting for the task.
 */
async function asksForApproval(t3: T3, threadId: string): Promise<{ by: 'thread' | 'task' } | undefined> {
  if ((await t3.thread(threadId)).pendingRequestCount > 0) return { by: 'thread' };

  for (const task of tasksOf(await t3.activeThreads(), threadId)) {
    if (task.status === 'waiting' || (await t3.thread(task.threadId)).pendingRequestCount > 0) return { by: 'task' };
  }

  return undefined;
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
  /**
   * Connects to the environment for a run in `mode`, signing in when it has no valid sign-in. `recover`
   * signs in never: it only stops what an earlier run left. A failure names why and what the person does about it.
   */
  connect(how: { mode: RuntimeMode; access: SignInAccess }): Promise<Connected | { ok: false; error: RuntimeFailure }>;
  /** Whether teamai's kept sign-in may change T3's settings, such as add a provider instance (`settings:write`). */
  mayWriteSettings(): boolean;
  /**
   * Widens teamai's kept sign-in so it may change T3's settings, to add a provider instance for `adding`: through the
   * `t3` command in any run, else, in an attended one, in T3's page. T3 grants `settings:write` only with Full access.
   * The connection runs on as it is; later connections use the wider sign-in. Says why it could not.
   */
  widen(how: { mode: WorkMode; adding: string[] }): Promise<{ ok: true; signIn: string } | { ok: false; why: string }>;
  /** The T3 thread the run was started from, when it was (T3 sets T3CODE_THREAD_ID in its sessions). */
  startedFrom?: string;
  /** T3 Code's data directory, where the member's settings are. */
  t3Home: string;
  /** The home of the user T3 Code runs as, where a provider instance with no `homePath` keeps its tool's sessions. */
  t3UserHome: string;
  /** The member's home as teamai runs, which the tool homes teamai gives are under. */
  home: string;
  /** The lock file that keeps two runtimes on this machine from adding the same T3 provider instance. */
  settingsLock: string;
  /** The `t3` command, which adds and removes a project as the member does. */
  t3Cli: T3Command;
  /** The projects teamai added for folders of its own, which it removes once it removed their folder. */
  added: AddedProjects;
  /** Where teamai started the runtime: the checkout of the run when `init` names none. */
  cwd: string;
}

/**
 * An op whose end this process owns, a prompt it follows or a cancel it retries: its place, its thread once launched, the
 * cancel's deadline, and a stop under way.
 */
interface Running {
  /** The place's handle and run, where the op's end is journaled and what a failed stop names. */
  handle: string;
  run: string;
  /** The thread's title, which a cancel that ends before T3 answered the launch names. */
  title: string;
  /** When teamai cancelled the op: the time, in ms since the epoch, by which the cancel ends. */
  cancelBy?: number;
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
  /** The provider instance each offered tool or tool instance runs on, by its name. */
  instances: Map<string, Provider>;
  /** The tool instances offered with no provider instance yet, which the first open that runs one adds. */
  pending: Map<string, NewInstance>;
  /** The mode `runtime_mode` sets; none: the member's T3 default for the place's project. */
  runtimeMode: StepMode | undefined;
  /** The run's checkout, as `init` names it, else the folder teamai started the runtime in. */
  checkout: string;
}

type Reach = { ok: true; reached: Reached } | { ok: false; failure: RuntimeFailure };

type PromptRequest = Extract<RuntimeRequest, { type: 'prompt' }>;

/**
 * Why a tool instance's provider instance cannot run: teamai could not add it, and whether a person approving its
 * sign-in would let it; or teamai added it, and T3 cannot run it yet, such as a tool not signed in in its home.
 */
type NotAdded = { ok: false; kind: 'not-added'; why: string; needsApproval: boolean } | { ok: false; kind: 'not-ready'; id: string; why: string };

/** What a prompt runs: a step on its attempt's worktree, or a judge confined to its directory. */
type Work = { kind: 'step'; place: PlaceRecord & { kind: 'worktree' } } | { kind: 'judge'; confined: ConfinedPrompt };

/** What `request` runs in `opened`: teamai opens a confined prompt's place with no view, and sends it nothing else. */
function workOf(request: PromptRequest, opened: PlaceRecord): Work | undefined {
  if (opened.kind === 'worktree') return request.confined ? undefined : { kind: 'step', place: opened };

  return request.confined ? { kind: 'judge', confined: request.confined } : undefined;
}

/** What a line that is no protocol request may still name: the request it fails, which then gets its own failure. */
const NamedSchema = z.object({ type: z.string().optional(), op: OpIdSchema.optional(), handle: RuntimeHandleSchema.optional() });

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

/** The T3 project whose folder is `folder`, among `projects`; one T3 deleted does not count. */
function projectOf(projects: Project[], folder: string): Project | undefined {
  return projects.find((candidate) => !candidate.deletedAt && realpath(candidate.workspaceRoot) === realpath(folder));
}

/** The T3 project of the checkout `dir` belongs to, or none when it is no project, or no checkout. */
async function projectAt(t3: T3, dir: string): Promise<Project | undefined> {
  const [root, projects] = await Promise.all([mainCheckout(dir).catch(() => undefined), t3.projects()]);

  return root === undefined ? undefined : projectOf(projects, root);
}

/**
 * The usable instance of each tool: the one `instance` names; else the instance of the member's default model when it
 * runs that tool's own binary, then the one whose id is the provider's name, then the first of that provider that runs
 * its own binary. An instance the member turned off for the project is never used, and another instance that runs a
 * wrapper or a team tool's command never runs the base tool unless `instance` names it.
 */
function instancesOf({ providers, instance, project, binaryPathOf }: { providers: Provider[]; instance: string | undefined; project: ProjectSettings; binaryPathOf(instanceId: string): string | undefined }): { ok: true; instances: Map<ToolId, Provider> } | { ok: false; failure: RuntimeFailure } {
  const usable = providers.filter((provider) => (provider.constraints ?? []).length === 0 && project.instanceEnabled(provider.providerInstanceId) !== false);
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
    const own = usable.filter((provider) => provider.driverKind === driver && runsOwnBinary(binaryPathOf(provider.providerInstanceId), driver));

    // The instance named after the provider runs it whatever its Binary path, such as a Claude version file.
    const found = own.find((provider) => provider.providerInstanceId === project.defaultModel?.instanceId)
      ?? usable.find((provider) => provider.driverKind === driver && provider.providerInstanceId === driver) ?? own[0];

    if (found) tools.set(DRIVERS[driver].tool, found);
  }

  return { ok: true, instances: tools };
}

/**
 * The model selection `lease` asks of `provider`: its model, or the first T3 lists, and the effort as T3 names it. A
 * lease that names no model on the instance of the member's default asks for none, so T3 applies that default, its
 * options, and the member's fallback once its usage is spent.
 */
function modelSelection({ provider, lease, defaultModel, appliedByT3 }: {
  provider: Provider; lease: PromptLease; defaultModel: ModelSelection | undefined;
  /** Whether T3 applies `defaultModel` to a launch that names no model: not on a project teamai added for the checkout's. */
  appliedByT3: boolean;
}): { ok: true; selection: Launch['modelSelection'] } | { ok: false; failure: RuntimeFailure } {
  if (!lease.model && defaultModel?.instanceId === provider.providerInstanceId) return { ok: true, selection: appliedByT3 ? undefined : defaultModel };
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

/** Where a step's thread is bound in its place: the attempt's worktree of the project, or the project's own folder. */
function workspaceOf(place: PlaceRecord & { kind: 'worktree' }, worktreePath: string): Launch['workspace'] {
  return place.binding === 'root' ? { type: 'root' } : { type: 'existing_worktree', worktreePath };
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

/** The person released the judge's place while T3 launched its thread, so the thread is left idle and unbriefed. */
class JudgeReleased extends Error {}

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
/** Whether `folder` is gone. One teamai cannot look at, such as one on a volume that is not mounted, may still be in use. */
function isGone(folder: string): boolean {
  try {
    fs.statSync(folder);

    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
  }
}

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
  /** The ops whose end this process owns, by op: prompts it runs and cancels it retries. A repeated prompt joins one. */
  const running = new Map<OpId, Running>();
  /** Ops teamai cancelled before this process saw their prompt. */
  const cancelledEarly = new Set<OpId>();
  /** The ends this process answered but could not journal, until the op runs here again: they stand in for the record's. */
  const unkept = new Map<OpId, OpState>();
  /** Ops whose cancel failed on a record it could not read, which may have been another place's. */
  const cancelledUnread = new Set<OpId>();
  /** The open and the launches under way in each place: a close waits for them before it reads what they made. */
  const working = new Map<string, Set<Promise<unknown>>>();
  /** The places a close forgot as the person released them: an open or a launch that ends later records nothing there. */
  const released = new Set<string>();

  /** A line for the person, about the operation or the place it names: teamai shows it as it runs. */
  const notice = (message: string, about: { op?: OpId; handle?: string }): void => write({ event: 'notice', ...about, message });

  let saidFullAccess = false;

  /** The mode a thread inherits from the member's T3 default: theirs, or auto; never full access, which it says once. */
  const inheritedMode = (mode: T3RuntimeMode | undefined, about: { op: OpId; handle: string }): StepMode => {
    if (mode !== 'full-access') return mode ?? 'auto';

    if (!saidFullAccess) notice('T3\'s default mode is Full access; teamai starts its threads in Auto unless runtime_mode says full-access.', about);
    saidFullAccess = true;

    return 'auto';
  };

  /** The mode a thread of `work` starts in: `runtime_mode`, else the member's default; a judge never in full access. */
  const launchMode = (work: Work, mode: T3RuntimeMode | undefined, about: { op: OpId; handle: string }): StepMode => {
    const set = session?.runtimeMode;

    if (set === 'full-access' && work.kind === 'judge') return 'auto';

    return set ?? inheritedMode(mode, about);
  };

  /** `work`, counted as under way in `handle` until it settles. */
  const track = <TValue>(handle: string, work: Promise<TValue>): Promise<TValue> => {
    const under = working.get(handle) ?? new Set();
    working.set(handle, under);
    under.add(work);

    const done = (): void => {
      under.delete(work);

      if (under.size === 0 && working.get(handle) === under) working.delete(handle);
    };

    work.then(done, done);

    return work;
  };

  /** The handle of the place `open` makes for a run's attempt. */
  const handleFor = ({ run, attempt }: { run: string; attempt: string }): string => `t3-${run}-${attempt}`;

  /** The place's record, to write to; a record that cannot be read is never written over. */
  const place = (handle: string): PlaceRecord | undefined => {
    const read = journal.read(handle);

    return read.kind === 'found' ? read.place : undefined;
  };

  /** Connects in recover mode: with the sign-in teamai keeps, never signing in, since it only stops what an earlier run left. */
  const connectToRecover = async (): Promise<Reach> => {
    const connected = await options.connect({ mode: 'recover', access: 'auto' });

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
   * Stops a step's thread as its Stop button does, and waits until `deadline` for its run, and the work it delegated, to
   * settle. Answers why it did not stop, logged, while the thread may still run.
   */
  const whyNotStopped = async (t3: T3, threadId: string, deadline: number): Promise<string | undefined> => {
    let why: string;

    try {
      const stopped = await within(t3.stop(threadId), Math.max(deadline - Date.now(), 0));

      if (stopped.answered) {
        // T3 answers the stop before the run ends, and stops the delegated work apart, so the thread has stopped only
        // once both settled. T3 answers a thread with nothing left to settle at once; a wait that runs out answers a
        // second before the deadline, so its answer still comes in time.
        const left = Math.max(deadline - Date.now(), 0);
        const waited = await within(t3.wait(threadId, Math.max(left - 1_000, 0)), left);

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
   * prompt, writes nothing. An end the journal cannot keep is still answered, since nothing would answer it later.
   */
  const endRunning = (state: Running, ended: OpState, { threadEnded }: { threadEnded: boolean }): void => {
    if (running.get(ended.op) !== state) return;
    running.delete(ended.op);

    try {
      record(state.handle, ended, { threadEnded });
    } catch (error) {
      unkept.set(ended.op, ended);
      process.stderr.write(`Runtime t3 could not record how ${ended.op} ended, so only this process reports that end: ${error instanceof Error ? error.message : String(error)}\n`);
    }

    answerEnded(ended.op, ended);
  };

  /**
   * Stops the thread of a prompt this process runs, and answers why it did not stop. A stop ends the prompt cancelled. A
   * cancel T3 did not carry out ends it cancel_failed, while its thread may still run; a close leaves it followed.
   */
  const stopRunning = async ({ s, state, op, thread, cancelling, deadline }: { s: Reached; state: Running; op: OpId; thread: ThreadRecord; cancelling: boolean; deadline: number }): Promise<string | undefined> => {
    const stopping = whyNotStopped(s.t3, thread.threadId, deadline);
    state.stopping = stopping;
    const why = await stopping;

    if (state.stopping === stopping) delete state.stopping;

    if (why === undefined) endRunning(state, { op, state: 'cancelled' }, { threadEnded: true });
    else if (cancelling) endRunning(state, unconfirmed(op, `${stillRuns(s, thread, why)}, then run teamai workflow cancel ${state.run} again.`), { threadEnded: false });

    return why;
  };

  /**
   * The provider instance teamai adds for each of `missing` on the first open that runs it: named after the instance,
   * running its command from PATH, in the home teamai gives it when that is not its tool's own (Claude reads its own
   * config file elsewhere once its home is set at all). It may when its kept sign-in may change T3's settings, or can come to:
   * through the `t3` command, or in an attended run through T3's page. Else why not, for `unavailable`.
   */
  const toBeAdded = ({ missing, mode, taken }: { missing: ServedInstances['missing']; mode: WorkMode; taken(id: string): boolean }) => {
    const pending = new Map<string, NewInstance>();
    const reasons: Record<string, string> = {};
    const reason = (message: string): string => message.slice(0, UNAVAILABLE_REASON_MAX);
    const mayAdd = options.mayWriteSettings() || options.t3Cli.isInstalled() || mode === 'attended';

    for (const { instance: { name }, instance, driver, command } of missing) {
      const binaryPath = path.isAbsolute(command) ? (fs.existsSync(command) ? command : null) : findOnPath(command);
      const toolHome = teamaiToolHome(instance, driver, options.home);
      const homePath = toolHome === path.join(options.home, DRIVERS[driver].home) ? undefined : toolHome;
      const setting = `with driver ${DRIVERS[driver].label} and Binary path ${binaryPath ?? `the absolute path of ${command} (command -v ${command})`}${homePath ? `, and Home path ${tilde(homePath, options.home)}` : ''}`;

      if (binaryPath === null) {
        reasons[name] = reason(`No T3 Code provider instance runs ${name}, and teamai cannot add one: ${command} is not on PATH here. Install ${command}, or add one in T3 Code under Settings → Providers, ${setting}, or map one with instances: { ${name}: <its id> } in the definition's t3 options.`);
      } else if (!isInstanceId(name)) {
        reasons[name] = reason(`No T3 Code provider instance runs ${name}, and teamai cannot add one: T3 Code takes no provider instance named "${name}" (a letter, then letters, digits, _ or -). Add one in T3 Code under Settings → Providers, ${setting}, and map it with instances: { ${name}: <its id> } in the definition's t3 options.`);
      } else if (taken(name)) {
        reasons[name] = reason(`No T3 Code provider instance runs ${name}, and teamai cannot add one: T3 Code already has a provider instance "${name}" that runs another command. Point its Binary path at ${command}, or map another with instances: { ${name}: <its id> } in the definition's t3 options.`);
      } else if (!mayAdd) {
        reasons[name] = reason(`No T3 Code provider instance runs ${name}, and teamai's T3 Code sign-in may not add one, which an unattended run with no t3 command cannot ask for. Run a step on ${name} once from a terminal, so teamai can ask you to approve its sign-in, or add one in T3 Code under Settings → Providers, ${setting}.`);
      } else {
        pending.set(name, { id: name, driver, displayName: name, command, binaryPath, ...(homePath && { homePath }) });
      }
    }

    return { pending, reasons };
  };

  /** The widening of teamai's kept sign-in under way, which every instance added at once waits for. */
  let widening: ReturnType<ServeOptions['widen']> | undefined;

  /** The adding of each instance under way, by name, so the opens of parallel steps add it once. */
  const adding = new Map<string, Promise<NotAdded | { ok: true }>>();

  /** How long T3 gets to list an instance it was given, from its settings changing to its own check of it. */
  const ADD_WAIT_MS = 20_000;

  /** Adds the provider instance of `name` teamai offered to add, then waits until T3 can run it. */
  const addInstance = async (s: Session, name: string, instance: NewInstance, about: { op: OpId }): Promise<NotAdded | { ok: true }> => {
    if (!options.mayWriteSettings()) {
      widening ??= options.widen({ mode: s.mode, adding: [...s.pending.keys()] }).finally(() => { widening = undefined; });
      const widened = await widening;

      if (!widened.ok) return { ok: false, kind: 'not-added', why: widened.why, needsApproval: true };
      // The connection sends the wider sign-in from now on, so a launch is recorded under it.
      s.signIn = widened.signIn;
    }

    const added = await addProviderInstance({ t3Home: options.t3Home, lockFile: options.settingsLock, userHome: options.t3UserHome, instance });

    switch (added.kind) {
      case 'added':
        notice(`Added the T3 Code provider instance "${added.id}" (driver ${DRIVERS[instance.driver].label}, Binary path ${instance.binaryPath}${instance.homePath ? `, Home path ${tilde(instance.homePath, options.home)}` : ''}), so ${name} runs on T3 Code. It stays for later runs; remove it in T3 Code under Settings → Providers.`, about);
        break;
      case 'found':
        break;
      case 'failed':
        return { ok: false, kind: 'not-added', why: added.why, needsApproval: false };
      default: {
        const unhandled: never = added;

        return unhandled;
      }
    }

    // T3 reloads its settings once they change, then checks the instance before it can run.
    const deadline = Date.now() + ADD_WAIT_MS;
    let listed: Provider | undefined;

    for (;;) {
      try {
        listed = (await s.t3.providers()).find((provider) => provider.providerInstanceId === added.id);
      } catch (error) {
        return { ok: false, kind: 'not-ready', id: added.id, why: `T3 Code did not say which provider instances it runs (${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')})` };
      }

      if ((listed && (listed.constraints ?? []).length === 0) || Date.now() > deadline) break;
      await sleep(250);
    }

    if (!listed || (listed.constraints ?? []).length > 0) {
      return { ok: false, kind: 'not-ready', id: added.id, why: listed ? (listed.constraints ?? []).join(' ') : `it has not listed it within ${ADD_WAIT_MS / 1_000} s` };
    }

    s.instances.set(name, listed);
    s.pending.delete(name);

    return { ok: true };
  };

  /** The provider instance of `name` exists once this settles, when teamai offered to add it; a failure says why. */
  const instanceFor = (s: Session, name: string, about: { op: OpId }): Promise<NotAdded | { ok: true }> | undefined => {
    const instance = s.pending.get(name);

    if (!instance) return adding.get(name);

    // A failure nobody expected still answers the open, and leaves nothing for the process to die of.
    const going = adding.get(name) ?? addInstance(s, name, instance, about).catch((error) => ({
      ok: false, kind: 'not-added', why: error instanceof Error ? error.message : String(error), needsApproval: false,
    } satisfies NotAdded));

    adding.set(name, going);
    // A later open tries again, once the person fixed what failed.
    void going.then((done) => { if (!done.ok && adding.get(name) === going) adding.delete(name); });

    return going;
  };

  /** What a step whose instance cannot run is told: why, and what the person does about it. */
  const notAdded = (s: Session, name: string, instance: NewInstance | undefined, failure: NotAdded): string => {
    const home = instance?.homePath ? tilde(instance.homePath, options.home) : undefined;
    const setting = instance ? `, with driver ${DRIVERS[instance.driver].label} and Binary path ${instance.binaryPath}${home ? `, and Home path ${home}` : ''}` : '';
    const why = failure.why.replace(/\.$/, '');

    switch (failure.kind) {
      case 'not-added':
        if (!failure.needsApproval) return `teamai could not add a T3 Code provider instance for ${name}: ${why}. Add one in T3 Code under Settings → Providers${setting}.`;

        return s.mode === 'attended'
          ? `teamai could not add a T3 Code provider instance for ${name}: ${why}. Start the workflow again and approve teamai with Full access in the page T3 Code opens, or add one in T3 Code under Settings → Providers${setting}.`
          : `teamai could not add a T3 Code provider instance for ${name}: ${why}. Run a step on ${name} once from a terminal, so teamai can ask you to approve its sign-in, or add one in T3 Code under Settings → Providers${setting}.`;
      case 'not-ready':
        return `T3 Code cannot run the provider instance "${failure.id}" for ${name} yet: ${why}.${home ? ` It runs in ${home}.` : ''} Fix that, then retry the step; the instance is in T3 Code under Settings → Providers.`;
      default: {
        const unhandled: never = failure;

        return unhandled;
      }
    }
  };

  // teamai quotes a keyed option failure (`key` set) inside a sentence of its own and ends it, so it brings no full stop.
  const init = async (request: Extract<RuntimeRequest, { type: 'init' }>): Promise<void> => {
    if (request.mode === 'recover') {
      recovering = {};
      write({ type: 'init', ok: true, can: {} });

      return;
    }

    const parsed = parseOptions(request.options);

    if (!parsed.ok) {
      write({ type: 'init', ok: false, error: parsed.failure });

      return;
    }

    // The checkout whose project's settings the offer follows.
    const checkout = request.checkout ?? options.cwd;
    const unanswered = (): void => write({ type: 'init', ok: false, error: { code: 't3_unavailable', message: `T3 Code did not answer what it runs within ${INIT_WAIT_MS / 1_000} s. Check that T3 Code is open and responding, then start the workflow again.` } });
    const answerBy = Date.now() + INIT_WAIT_MS;
    const connecting = options.connect({ mode: request.mode, access: parsed.options.runtime_mode === 'full-access' ? 'full-access' : 'auto' });
    const reaching = request.mode === 'attended' ? { answered: true as const, value: await connecting } : await within(connecting, INIT_WAIT_MS);

    if (!reaching.answered) {
      // A connection that comes after init failed is closed, not kept.
      void connecting.then((late) => (late.ok ? late.t3.close() : undefined)).catch(() => {});

      return unanswered();
    }

    const connected = reaching.value;

    if (!connected.ok) {
      write({ type: 'init', ok: false, error: connected.error });

      return;
    }

    try {
      const asking = await within(Promise.all([connected.t3.environment(), connected.t3.providers(), projectAt(connected.t3, checkout)]), Math.max((request.mode === 'attended' ? Date.now() + INIT_WAIT_MS : answerBy) - Date.now(), 0));

      if (!asking.answered) {
        void connected.t3.close().catch(() => {});

        return unanswered();
      }

      const [environment, providers, here] = asking.value;
      const settings = readSettings(options.t3Home);
      const project = projectSettings(settings, here);
      const binaryPathOf = (instanceId: string): string | undefined => settings.providerInstances?.[instanceId]?.config?.binaryPath?.trim() || undefined;
      const instances = instancesOf({ providers, instance: parsed.options.instance, project, binaryPathOf });

      if (!instances.ok) {
        write({ type: 'init', ok: false, error: instances.failure });

        return;
      }

      // The tool instances teamai gave, and each tool `instances` maps to a provider instance of its own.
      const mapped = parsed.options.instances;
      const named = [...request.instances ?? [], ...Object.keys(mapped ?? {}).filter((name) => driverOf(name) !== undefined).map((tool) => ({ name: tool, tool }))];
      const homeOf = (provider: Provider, driver: Driver): string => instanceToolHome(settings, { instanceId: provider.providerInstanceId, driver, userHome: options.t3UserHome });

      const served = servedInstances({
        instances: named, mapped,
        lookup: {
          providers, binaryPathOf, homeOf,
          isUsable: (provider) => (provider.constraints ?? []).length === 0 && project.instanceEnabled(provider.providerInstanceId) !== false,
          homeFor: (instance, driver) => teamaiToolHome(instance, driver, options.home),
          shown: (home) => tilde(home, options.home),
        },
      });

      const toAdd = toBeAdded({ missing: served.missing, mode: request.mode, taken: (id) => settings.providerInstances?.[id] !== undefined });
      const unavailable = { ...Object.fromEntries(Object.entries(served.unavailable)), ...toAdd.reasons };

      // A step that never names a misspelt key would never show its reason.
      for (const message of served.notices) notice(message, {});

      // T3 runs an instance in its provider instance's home, where it signs in and keeps its sessions.
      for (const instance of request.instances ?? []) {
        const provider = served.served.get(instance.name);
        const driver = provider && driverOfProvider(provider);

        if (!provider || !driver) continue;
        const theirs = homeOf(provider, driver);
        const ours = teamaiToolHome(instance, driver, options.home);

        if (theirs !== ours) {
          notice(`T3 Code provider instance "${provider.providerInstanceId}" runs ${instance.name} in ${tilde(theirs, options.t3UserHome)}, while teamai gives ${instance.name} the home ${tilde(ours, options.home)}: on T3 it signs in and keeps its sessions there. To use the same home, set the instance's Home path in T3 Code under Settings → Providers to ${tilde(ours, options.home)}.`, {});
        }
      }

      // A tool `instances` maps to an instance that cannot run it is not offered on its default instance instead.
      const runs = new Map<string, Provider>([...instances.instances, ...served.served].filter(([tool]) => unavailable[tool] === undefined));
      session = { t3: connected.t3, mode: request.mode, environment, instances: runs, pending: toAdd.pending, runtimeMode: parsed.options.runtime_mode, signIn: connected.signIn, checkout };
      // An instance teamai adds on its first open is offered as well: the open adds it, or fails saying why.
      const tools = [...runs.keys(), ...toAdd.pending.keys()];
      // A step that names no tool runs on the member's effective T3 default, when its instance is the one offered.
      // When that instance runs a wrapper no tool instance here runs, its provider's own tool, which runs on its own instance.
      const defaultProvider = providers.find((provider) => provider.providerInstanceId === project.defaultModel?.instanceId && (provider.constraints ?? []).length === 0);
      const defaultDriver = defaultProvider && driverOfProvider(defaultProvider);
      const onWrapper = defaultProvider !== undefined && defaultDriver !== undefined && !runsOwnBinary(binaryPathOf(defaultProvider.providerInstanceId), defaultDriver);
      const defaultTool = [...runs].find(([, provider]) => provider === defaultProvider)?.[0] ?? (onWrapper && runs.has(DRIVERS[defaultDriver].tool) ? DRIVERS[defaultDriver].tool : undefined);
      write({
        type: 'init', ok: true, prompt: true, confinedPrompt: true,
        // Full access is the member's opt-in, and teamai records the isolation of these steps as none.
        ...(parsed.options.runtime_mode === 'full-access' && tools.length > 0 && { permissions: Object.fromEntries(tools.map((tool) => [tool, 'full-access' as const])) }),
        ...(Object.keys(unavailable).length > 0 && { unavailable }),
        can: {
          exec: false, setup: false, env: false, hitl: request.mode === 'attended', tokens: false, unattended: false, max_turns: false,
          // No role: a T3 thread runs its tool in the provider instance's own home, with the member's own assets, and
          // this runtime cannot point it at the tool home teamai delivers a role into.
          workspace: ['read-only', 'new', 'continue', 'clone', 'team'], tools, ...(defaultTool && { default_tool: defaultTool }),
          ...(tools.length > 0 && { confined: [{ ...JUDGE_KEPT, tools }] }),
        },
      });
    } catch (error) {
      write({ type: 'init', ok: false, error: { code: 't3_unavailable', message: `T3 Code did not answer what it runs: ${error instanceof Error ? error.message : String(error)}` } });
    }
  };

  const open = async (request: Extract<RuntimeRequest, { type: 'open' }>): Promise<void> => {
    const handle = handleFor(request);
    handleOf.set(request.op, handle);
    released.delete(handle);
    write({ op: request.op, event: 'accepted', handle });

    if (!session) {
      fail(request.op, { code: 'runtime_protocol', message: 'open came before a successful init.' });

      return;
    }

    // The provider instance of a tool instance teamai offered to add, on the first open that runs it.
    const instance = request.tool === undefined ? undefined : session.pending.get(request.tool);
    const ready = request.tool === undefined ? undefined : instanceFor(session, request.tool, { op: request.op });

    if (request.tool !== undefined && ready) {
      const done = await ready;

      if (!done.ok) {
        fail(request.op, { code: 'open_failed', message: notAdded(session, request.tool, instance, done) });

        return;
      }
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

    const s = session;
    let root: string;
    let projects: Project[];
    let runCheckout: string | undefined;

    try {
      [root, projects, runCheckout] = await Promise.all([mainCheckout(view.worktree), s.t3.projects(), mainCheckout(s.checkout).catch(() => undefined)]);
    } catch (error) {
      fail(request.op, { code: 'open_failed', message: `Could not match the worktree ${view.worktree} to a T3 Code project: ${error instanceof Error ? error.message : String(error)}` });

      return;
    }

    /**
     * The project of `folder`, added as the member adds one when T3 has none, saying so first; or why it could not be.
     * `added`: teamai added it for a folder of its own, not the checkout the run started in, so it removes the project
     * once the folder is gone. A checkout it cannot tell counts as the run's.
     */
    const projectFor = async (folder: string, { title, why }: { title?: string; why: string }): Promise<{ ok: true; project: Project } | { ok: false; reason: string }> => {
      const listed = projectOf(projects, folder);

      if (listed) return { ok: true, project: listed };
      notice(why, { op: request.op, handle });

      let refused: string | undefined;

      const signal = AbortSignal.timeout(PROJECT_ADD_MS);

      try {
        await options.t3Cli.run({ name: 'project add', args: ['project', 'add', '--base-dir', options.t3Home, ...(title ? ['--title', title] : []), folder], signal });
      } catch (error) {
        // A step opening beside this one may have added the folder first, which T3 refuses to add again.
        refused = signal.aborted
          ? `t3 project add did not finish within ${PROJECT_ADD_MS / 1_000} s`
          : (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
      }

      try {
        projects = await s.t3.projects();
      } catch (error) {
        return { ok: false, reason: refused ?? (error instanceof Error ? error.message : String(error)).replace(/\.$/, '') };
      }

      const added = projectOf(projects, folder);

      if (added && runCheckout !== undefined && realpath(folder) !== realpath(runCheckout)) options.added.add({ id: added.id, folder: realpath(folder) });

      if (added) return { ok: true, project: added };

      return { ok: false, reason: refused ?? 't3 project add finished, and T3 Code still lists no such project' };
    };

    const checkout = await projectFor(root, { why: `Adding ${root} to T3 Code as a project, so its steps can run there.` });

    if (!checkout.ok) {
      fail(request.op, { code: 'not_a_t3_project', message: `${root} is not a project in T3 Code ${s.environment.label}, and teamai could not add it (${checkout.reason}). Add it in T3 Code (Add project), or run t3 project add ${root}, then start the workflow again.` });

      return;
    }

    const settings = readSettings(options.t3Home);
    const scripts = projectSettings(settings, checkout.project).scripts;
    // The step's folder is the project's own: the checkout itself, a clone, a team repo's clone.
    const own = realpath(view.worktree) === realpath(root);
    let project = checkout.project;
    let binding: 'existing_worktree' | 'root' = own ? 'root' : 'existing_worktree';

    // T3 runs the project's setup script in every worktree a thread binds, and its output would be committed as the
    // step's work. On a project of its own, the worktree is the project's folder, which T3 runs no setup script in.
    if (!own && scripts.setup !== undefined) {
      const separate = await projectFor(view.worktree, {
        title: `${checkout.project.title} · teamai ${request.run}`,
        why: `T3 Code runs the setup script "${scripts.setup}" of ${checkout.project.title} in each worktree a thread opens on, so teamai adds the step's worktree ${view.worktree} to T3 Code as a project of its own, where that script does not run.`,
      });

      if (!separate.ok) {
        fail(request.op, { code: 'open_failed', message: `T3 Code runs the setup script "${scripts.setup}" of ${checkout.project.title} in each worktree a thread opens on, and teamai could not add the step's worktree ${view.worktree} as a project of its own, where it does not run (${separate.reason}). Run t3 project add ${view.worktree}, or turn off "Run on worktree creation" for "${scripts.setup}" in the project's settings in T3 Code, then start the workflow again.` });

        return;
      }

      project = separate.project;
      binding = 'root';
    }

    const settle = project === checkout.project ? scripts.settle : projectSettings(settings, project).scripts.settle;

    const opened: PlaceRecord = {
      kind: 'worktree', handle, run: request.run, attempt: request.attempt, projectId: project.id, projectTitle: project.title, binding,
      ...(settle !== undefined && { settleScript: settle }), settingsProjectId: checkout.project.id, ops: {}, threads: {}, launches: {},
    };

    if (released.has(handle)) {
      fail(request.op, { code: 'open_failed', message: `teamai released ${handle} while T3 Code was still opening it, so the runtime does not keep it.` });

      return;
    }

    journal.write(opened);
    write({ op: request.op, event: 'ready', display: placeDisplay(opened, s.environment) });
  };

  /** A judge's result: its last message, as the JSON value it replied with. */
  const judged = async (s: Session, thread: ThreadRecord): Promise<{ ok: true; result: PromptResult } | { ok: false; why: string }> => {
    const reply = await s.t3.lastReply(thread.threadId);
    const output = reply === undefined ? undefined : replyValue(reply);

    return output === undefined ? { ok: false, why: 'replied with no JSON value' } : { ok: true, result: { output } };
  };

  /** Launches a step's thread on the attempt's folder with its first message, and returns it with the model it runs. */
  const launchStep = async (s: Session, request: PromptRequest, opened: PlaceRecord & { kind: 'worktree' }, thread: NewThread): Promise<{ threadId: string; model: string | undefined }> => {
    const message = firstMessage(opened, request.lease, options.startedFrom && threadMention(s.environment, options.startedFrom));
    const launched = await s.t3.launch({ ...thread, message, projectId: opened.projectId, workspace: workspaceOf(opened, request.cwd) });

    return { threadId: launched.threadId, model: launched.modelSelection?.model };
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
    journalThread: (threadId: string, copy: string, model: string | undefined) => ThreadRecord;
    thread: NewThread;
    known: ThreadRecord | undefined;
  }): Promise<ThreadRecord> => {
    const scratch = known ? undefined : await s.t3.launchScratch(thread);
    const threadId = known?.threadId ?? scratch?.threadId ?? '';
    const shell = await s.t3.thread(threadId);

    if (shell.worktreePath === null) throw new Error(`T3 Code gave the thread ${threadId} no folder.`);
    const launched = known ?? journalThread(threadId, shell.worktreePath, scratch?.modelSelection?.model);

    if (shell.runCount === 0 && released.has(request.handle)) throw new JudgeReleased('teamai released the place while T3 Code launched the judge thread, so it did not brief that thread, and the judge did not start.');

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

  /** The T3 provider instance `thread` runs on: the one its launch named, else the one the session picked for its tool. */
  const instanceIdOf = (s: Session, thread: ThreadRecord): string | undefined => thread.instanceId ?? s.instances.get(thread.tool)?.providerInstanceId;

  /**
   * What a failed run of `thread` says of the usage limit it stopped on: the tool, its instance and T3's own message,
   * which carries the reset time when the provider gave one. Undefined for any other failure, or when T3 does not say.
   */
  const usageLimitOf = async (s: Session, thread: ThreadRecord, runId: string | undefined): Promise<string | undefined> => {
    const error = await s.t3.lastError(thread.threadId, runId).catch(() => undefined);

    if (error?.title !== USAGE_LIMIT_TITLE) return undefined;

    const instanceId = instanceIdOf(s, thread);
    const instance = [...s.instances.values()].find((one) => one.providerInstanceId === instanceId);
    const reset = error.text.trim() || 'T3 Code gave no reset time';

    if (!instance) return `${thread.tool} reached its usage limit in T3 Code: ${reset}`;

    return `${thread.tool} reached its usage limit on T3 Code provider instance "${instance.providerInstanceId}" (${instance.displayName}): ${reset}`;
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
        if (++errors > 5) return { state: unconfirmed(request.op, `${where} could not be followed, so it may still run: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}. Run teamai workflow cancel ${state.run} to stop it.`), threadEnded: false };

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
        const asking = s.mode === 'unattended' ? (waited.status === 'waiting' ? { by: 'thread' } : await asksForApproval(s.t3, thread.threadId)) : undefined;

        if (asking) {
          const why = await whyNotStopped(s.t3, thread.threadId, Date.now() + STOP_WAIT_MS);

          const asked = asking.by === 'task'
            ? `${where} delegated a task that asked for an approval, and nobody is there to give it in an unattended run.`
            : `${where} asked for an approval, and nobody is there to give it in an unattended run.`;

          if (why === undefined) return stopped({ op: request.op, state: 'failed', failure: { code: 'tool_failed', message: asked } });

          // The thread may still run, so the op ends as a stop the runtime could not confirm, which a later cancel retries.
          return { state: unconfirmed(request.op, `${asked} It still runs, and T3 Code did not stop it: ${why.replace(/\.$/, '')}. Stop it in T3 Code with its Stop button.`), threadEnded: false };
        }

        // A wait that came back before its time on a run still going (waiting for the person, or idle) is asked again later.
        if (!waited.timedOut) await sleep(IDLE_POLL_MS);
        continue;
      }

      // From here on, the thread's run and the work it delegated settled. A run the provider stopped on its usage limit
      // fails the step as such, so teamai says to retry once the limit resets.
      if (ended === 'failed') {
        const limited = await usageLimitOf(s, thread, waited.resultRun?.runId);

        if (limited) return stopped({ op: request.op, state: 'failed', failure: { code: 'usage_limited', message: limited } });
      }

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
      const served = s.instances.get(thread.tool);
      const driver = served ? driverOfProvider(served) : driverOf(thread.tool);
      // The session is in the tool home of the instance the thread runs on, which is the scoring and resume store.
      const instanceId = instanceIdOf(s, thread);
      const toolHome = driver && instanceId !== undefined ? instanceToolHome(readSettings(options.t3Home), { instanceId, driver, userHome: options.t3UserHome }) : undefined;
      const id = driver && toolHome !== undefined ? await sessionSince({ driver, toolHome, cwd, since: thread.launchedAt }) : undefined;

      if (!driver || toolHome === undefined || !id) return stopped({ op: request.op, state: 'failed', failure: { code: 'tool_failed', message: `${where} finished, but ${thread.tool} kept no session for ${cwd}${toolHome === undefined ? '' : ` in ${toolHome}`}, so the step cannot be scored or resumed.` } });
      // teamai reads a tool instance's session only in the home named here: it knows no default home for it.
      const kept = { tool: thread.tool, id, ...((thread.tool !== DRIVERS[driver].tool || !isDefaultToolHome(driver, toolHome)) && { home: toolHome }) };

      return stopped({ op: request.op, state: 'finished', session: kept, result: written.result, ...(request.confined && { confined: JUDGE_KEPT }) });
    }
  };

  const prompt = async (request: PromptRequest): Promise<void> => {
    handleOf.set(request.op, request.handle);
    const read = journal.read(request.handle);
    const opened = read.kind === 'found' ? read.place : undefined;
    const ended = unkept.get(request.op) ?? opened?.ops[request.op];

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
      // A record that cannot be read may hold the op's thread, which may still run.
      fail(request.op, read.kind === 'unreadable' ? { ...unreadable(request.handle, read), code: CANCEL_FAILED } : { code: 'runtime_protocol', message: session ? `No open place ${request.handle}.` : 'prompt came before a successful init.' });

      return;
    }

    const s = session;

    const end = (state: OpState, threadEnded = false): void => {
      running.delete(request.op);
      record(request.handle, state, { threadEnded });
      answerEnded(request.op, state);
    };

    let thread = opened.threads[request.op];
    const pending = opened.launches[request.op];

    /**
     * Ends an op this process launched no thread for. A thread the journal holds for it, which another process may have
     * launched, or a launch T3 never answered, stays the runtime's to stop: while it may still run, the op ends as a stop
     * the runtime could not confirm, with the refusal as its cause, so a later cancel stops it.
     */
    const refuse = (state: OpState): void => {
      accept(undefined);

      if (state.state !== 'failed' || (thread ? thread.ended : !pending)) return end(state);
      const { code, message } = state.failure;
      const held = thread ? `The T3 thread ${threadLink(s.environment, thread.threadId)} ("${thread.title}")` : `The T3 thread "${pending?.title}", whose launch T3 Code never answered,`;

      end(unconfirmed(request.op, code === 'launch_unconfirmed' ? message : `${message.replace(/\.$/, '')} (${code}). ${held} may still run: run teamai workflow cancel ${opened.run} to stop it.`));
    };

    if (cancelledEarly.delete(request.op)) {
      // The mark says only that teamai cancelled the op before this process saw it: a thread or launch the journal holds
      // for it ends the op cancelled once the cancel confirmed its stop, never on the mark alone.
      if ((thread && !thread.ended) || pending) {
        accept(thread);
        await cancel(request.op);
      } else {
        refuse({ op: request.op, state: 'cancelled' });
      }

      return;
    }

    // A record that holds the op was the one its cancel could not read, and the prompt reconnects to what it holds. One
    // that holds nothing of it says the cancel failed on another place's record, so the cancel stands.
    if (cancelledUnread.delete(request.op) && !ended) {
      refuse({ op: request.op, state: 'cancelled' });

      return;
    }

    const lease = request.lease;
    // The open adds a tool instance's provider instance; one teamai opened with no tool adds it here.
    const toAdd = s.pending.get(lease.tool);
    const added = await instanceFor(s, lease.tool, { op: request.op });

    if (added && !added.ok) {
      refuse({ op: request.op, state: 'failed', failure: { code: 'tool_unavailable', message: notAdded(s, lease.tool, toAdd, added) } });

      return;
    }

    const instance = s.instances.get(lease.tool);

    if (!instance) {
      refuse({ op: request.op, state: 'failed', failure: { code: 'tool_unavailable', message: `T3 Code ${s.environment.label} runs ${[...s.instances.keys()].join(', ') || 'no tool this runtime runs'} here, not ${lease.tool}.` } });

      return;
    }

    if (lease.permissions === 'unattended') {
      // The offer says unattended: false, so teamai never sends one: an unattended lease needs a strict sandbox, which a
      // thread on the host is not, even in full access.
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

    const settingsProjectId = opened.kind === 'worktree' ? opened.settingsProjectId ?? opened.projectId : undefined;
    const project = projectSettings(readSettings(options.t3Home), settingsProjectId === undefined ? undefined : { id: settingsProjectId });
    const selection = modelSelection({ provider: instance, lease, defaultModel: project.defaultModel, appliedByT3: opened.kind !== 'worktree' || settingsProjectId === opened.projectId });

    if (!selection.ok) {
      refuse({ op: request.op, state: 'failed', failure: selection.failure });

      return;
    }

    const work = workOf(request, opened);

    if (!work) {
      refuse({ op: request.op, state: 'failed', failure: { code: 'runtime_protocol', message: opened.kind === 'confined' ? `${request.handle} is a confined prompt's place, and this prompt is not confined.` : `A confined prompt came to ${request.handle}, which was opened with a view.` } });

      return;
    }

    // Launching again under this sign-in would start the step a second time, beside the thread T3 may run.
    if (!thread && pending && pending.signIn !== s.signIn) {
      refuse({ op: request.op, state: 'failed', failure: launchUnconfirmed(opened, pending) });

      return;
    }

    // A launch T3 never answered is sent again as it was journaled: T3 checks the mode before it looks the launch up,
    // so a repeat in another mode would not find the thread it launched.
    const launch: LaunchRecord = pending ?? {
      title: `${lease.step} · teamai ${opened.run}`, ...(selection.selection && { modelSelection: selection.selection }), runtimeMode: launchMode(work, project.defaultMode, { op: request.op, handle: request.handle }), tool: lease.tool,
      launchedAt: thread?.launchedAt ?? Date.now(), signIn: s.signIn, ...(work.kind === 'step' && opened.kind === 'worktree' && opened.binding === 'existing_worktree' && { worktreePath: request.cwd }),
    };

    const { title, launchedAt } = launch;

    // T3 may launch the thread and still fail to answer, so the launch is journaled before it is sent. One it cannot
    // journal fails the request before the op runs here, as nothing was launched.
    if (!thread) {
      const now = place(request.handle) ?? (released.has(request.handle) ? undefined : opened);

      if (now) journal.write({ ...now, ops: { ...now.ops, [request.op]: { op: request.op, state: 'running' } }, launches: { ...now.launches, [request.op]: launch } });
    }

    const state: Running = { handle: request.handle, run: opened.run, title };
    running.set(request.op, state);
    unkept.delete(request.op);
    const finish = (outcome: OpState, threadEnded = false): void => endRunning(state, outcome, { threadEnded });

    try {
      const newThread: NewThread = { title, ...(launch.modelSelection && { modelSelection: launch.modelSelection }), runtimeMode: launch.runtimeMode, clientRequestId: request.op };

      // Accepted before T3 launches anything, which may take longer than teamai waits for an acceptance.
      accept(thread);

      /** Journals the op running on `threadId`, with the judge's copy once its folder is known, in place of its launch. */
      const journalThread = (threadId: string, copy: string | undefined, model: string | undefined): ThreadRecord => {
        const launched: ThreadRecord = { threadId, title, model: model ?? launch.modelSelection?.model ?? 'default', tool: launch.tool, instanceId: instance.providerInstanceId, launchedAt, ...(copy && { copy }) };
        const now = place(request.handle) ?? (released.has(request.handle) ? undefined : opened);

        if (now) {
          const { [request.op]: _answered, ...launches } = now.launches;
          // A cancel that ended the op while T3 had not answered the launch keeps that outcome.
          journal.write({ ...now, ops: { ...now.ops, [request.op]: now.ops[request.op] ?? { op: request.op, state: 'running' } }, threads: { ...now.threads, [request.op]: launched }, launches });
        }

        state.thread = launched;
        write({ op: request.op, event: 'display', display: threadDisplay(launched, s.environment) });

        return launched;
      };

      // A thread the journal holds is reconnected to by its id: T3 answers a repeated launch with it only under the
      // sign-in that sent the launch, and would start the step again under another.
      if (thread) state.thread = thread;
      const known = thread;

      // A close that comes meanwhile waits for the launch, so it stops the thread the launch started.
      thread = await track(request.handle, work.kind === 'judge'
        ? launchJudge({ s, request, confined: work.confined, opened, journalThread, thread: newThread, known })
        : known ? Promise.resolve(known) : launchStep(s, request, work.place, newThread).then(({ threadId, model }) => journalThread(threadId, undefined, model)));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      // Only a check a new launch runs proves T3 launched nothing; a judge's copy fails before its idle thread is briefed.
      const refused = !state.thread && error instanceof T3Error && error.refusal !== undefined && LAUNCHED_NOTHING.has(error.refusal.code) ? error.refusal : undefined;

      if (error instanceof JudgeCopyFailed) finish({ op: request.op, state: 'failed', failure: { code: 'judge_copy_failed', message: why } });
      else if (error instanceof JudgeReleased) finish({ op: request.op, state: 'failed', failure: { code: 'released', message: why } });
      // T3 caps a thread's mode at the access the member approved teamai with, and says so with this code.
      else if (refused?.code === 'runtime_mode_escalation_denied') {
        finish({
          op: request.op, state: 'failed', failure: {
            code: 'sign_in_too_narrow',
            message: launch.runtimeMode === 'full-access'
              ? `T3 Code refused to start the step's thread in ${launch.runtimeMode} mode, because teamai's sign-in does not allow it (${refused.message}). Remove ~/.teamai/runtime-state/t3/credentials.json and start the workflow again; teamai signs in again; approve it with Full access if T3 Code asks. Or set runtime_mode to a mode the sign-in allows.`
              : `T3 Code refused to start the step's thread in ${launch.runtimeMode} mode, because teamai's sign-in does not allow it (${refused.message}). Remove ~/.teamai/runtime-state/t3/credentials.json and start the workflow again; teamai signs in again; approve it with Auto access if T3 Code asks. Or set runtime_mode to a mode the sign-in allows.`,
          },
        });
      } else if (refused) finish({ op: request.op, state: 'failed', failure: { code: 't3_launch_failed', message: `T3 Code did not launch the step's thread: ${why}` } });
      else finish(unconfirmed(request.op, `teamai launched the T3 thread "${title}", and T3 Code did not confirm the launch, so it may run: ${why.replace(/\.$/, '')}. Run teamai workflow cancel ${opened.run} to find and stop it.`));

      return;
    }

    // teamai cancelled the prompt while T3 launched its thread. Past the cancel's deadline the op has ended, and the stop
    // is sent all the same; the thread stays journaled for a later cancel or close.
    if (state.cancelBy !== undefined) {
      await stopRunning({ s, state, op: request.op, thread, cancelling: true, deadline: state.cancelBy });

      return;
    }

    try {
      const followed = await follow(s, request, thread, state);

      if (followed) finish(followed.state, followed.threadEnded);
    } catch (error) {
      // The thread may still run in T3, where the person finds it by the link.
      finish(unconfirmed(request.op, `Lost track of the T3 thread ${threadLink(s.environment, thread.threadId)}, so it may still run: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}. Run teamai workflow cancel ${opened.run} to stop it.`));
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
    const newThread: NewThread = { title: launch.title, ...(launch.modelSelection && { modelSelection: launch.modelSelection }), runtimeMode: launch.runtimeMode, clientRequestId: op };
    let threadId: string | undefined;
    let model: string | undefined;

    try {
      const launched = known.kind === 'worktree'
        ? await s.t3.launch({ ...newThread, projectId: known.projectId, workspace: workspaceOf(known, launch.worktreePath ?? '') })
        : await s.t3.launchScratch(newThread);

      threadId = launched.threadId;
      model = launched.modelSelection?.model;
    } catch (error) {
      // T3 answers a launch it accepted before any check a new launch needs, so only such a check's refusal proves it
      // launched nothing. Any other answer, such as orchestration_error, may come from the lookup itself.
      if (!(error instanceof T3Error && error.refusal !== undefined && LAUNCHED_NOTHING.has(error.refusal.code))) throw error;
    }

    // A close may have removed the place while T3 answered: its record is not written again.
    const now = place(known.handle);
    const base = now ?? known;
    const { [op]: _resolved, ...launches } = base.launches;

    const thread: ThreadRecord | undefined = threadId === undefined ? undefined : {
      threadId, title: launch.title, model: model ?? launch.modelSelection?.model ?? 'default', tool: launch.tool, launchedAt: launch.launchedAt,
      ...(launch.modelSelection && { instanceId: launch.modelSelection.instanceId }),
    };

    const resolved: PlaceRecord = { ...base, launches, ...(thread && { threads: { ...base.threads, [op]: thread } }) };

    if (now) journal.write(resolved);

    return { ok: true, place: resolved };
  };

  const cancel = async (op: OpId): Promise<void> => {
    const state = running.get(op);

    if (state) {
      if (state.cancelBy === undefined) {
        const by = Date.now() + STOP_WAIT_MS;
        state.cancelBy = by;

        // Without a thread yet, the prompt stops it once T3 answers the launch, and a stop ends by the deadline itself;
        // a launch T3 has not answered by then ends the op.
        setTimeout(() => {
          if (running.get(op) === state && !state.stopping) endRunning(state, unconfirmed(op, `teamai cancelled the step while T3 Code launched its thread "${state.title}", and the launch had not finished ${STOP_WAIT_MS / 1_000} s later, so the thread may run. Run teamai workflow cancel ${state.run} again.`), { threadEnded: false });
        }, by - Date.now());
      }

      if (state.thread && session) await stopRunning({ s: session, state, op, thread: state.thread, cancelling: true, deadline: state.cancelBy });

      return;
    }

    const handle = handleOf.get(op);
    const read = handle ? journal.read(handle) : journal.placeOf(op);

    // A record that cannot be read may hold the op's thread: that is no proof it launched nothing.
    if (read.kind === 'unreadable') {
      cancelledUnread.add(op);

      return fail(op, { ...unreadable(handle ?? decodeURIComponent(path.basename(read.file, '.json')), read), code: CANCEL_FAILED });
    }

    let known = read.kind === 'found' ? read.place : undefined;
    const retained = unkept.get(op) ?? known?.ops[op];

    // A runtime before this one launched the thread and died, maybe before T3 answered the launch, or a stop failed
    // before; teamai cancels before it reattaches.
    if (!known || !(retained?.state === 'running' || (retained?.state === 'failed' && retained.failure.code === CANCEL_FAILED))) {
      if (retained) answerEnded(op, retained);
      else cancelledEarly.add(op);

      return;
    }

    const { handle: at, run } = known;
    const deadline = Date.now() + STOP_WAIT_MS;
    const left = (): number => Math.max(deadline - Date.now(), 0);

    // From reading this cancel until its stop is confirmed or fails again, the op runs: a stop that failed before is not
    // this cancel's outcome.
    if (retained.state === 'failed') record(at, { op, state: 'running' }, { threadEnded: false });

    // This cancel owns the op's end as a prompt this process runs would, before anything is awaited: a prompt teamai
    // resends meanwhile joins it rather than following the thread, and only one end is written. It is installed once
    // the op is journaled running, so a record that cannot be written leaves no owner behind to swallow the next cancel.
    const owner: Running = { handle: at, run, title: (known.threads[op] ?? known.launches[op])?.title ?? op, cancelBy: deadline, thread: known.threads[op] };
    running.set(op, owner);
    unkept.delete(op);

    const answer = (ended: OpState, threadEnded: boolean): void => endRunning(owner, ended, { threadEnded });

    const reaching = await within(reach(), left());
    const reached: Reach = reaching.answered ? reaching.value : { ok: false, failure: { code: 't3_unavailable', message: `T3 Code did not answer within ${STOP_WAIT_MS / 1_000} s` } };

    if (!reached.ok) return answer(unconfirmed(op, `teamai could not reach T3 Code to stop the T3 thread of ${op}, so it may still run (${reached.failure.message.replace(/\.$/, '')}). Run teamai workflow cancel ${run} again once T3 Code answers.`), false);
    const s = reached.reached;
    const launch = known.launches[op];

    if (launch) {
      const lookUp = `teamai launched the T3 thread "${launch.title}" and T3 Code never answered, so it may run`;
      let resolved: Awaited<ReturnType<typeof resolveLaunch>>;

      try {
        // A lookup that answers late still journals the thread it found, unless a close removed the place meanwhile.
        const resolving = await within(resolveLaunch(s, known, op, launch), left());

        if (!resolving.answered) return answer(unconfirmed(op, `${lookUp}, and T3 Code did not say within ${STOP_WAIT_MS / 1_000} s whether it launched it when teamai looked. Run teamai workflow cancel ${run} again once T3 Code answers.`), false);
        resolved = resolving.value;
      } catch (error) {
        return answer(unconfirmed(op, `${lookUp}, and T3 Code did not say whether it launched it when teamai looked: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}. Run teamai workflow cancel ${run} again once T3 Code answers.`), false);
      }

      // The launch stays journaled, so close keeps the place and says the same.
      if (!resolved.ok) return answer(unconfirmed(op, resolved.failure.message), false);
      known = resolved.place;
    }

    const owned = known.threads[op];

    if (!owned) return answer({ op, state: 'cancelled' }, true);
    owner.thread = owned;
    await stopRunning({ s, state: owner, op, thread: owned, cancelling: true, deadline });
  };

  /**
   * Settles the threads of the tasks `thread` delegated, at any depth, that T3 holds no run of: T3 leaves them unsettled
   * when it settles the thread that delegated them. A list or a settle T3 refuses is said in a notice and fails nothing.
   */
  const settleTasks = async (handle: string, s: Reached, thread: ThreadRecord): Promise<void> => {
    const link = `${threadLink(s.environment, thread.threadId)} ("${thread.title}")`;
    let tasks: ListedThread[];

    try {
      // The tasks it delegated started after it, so only threads that changed since its launch can be theirs.
      tasks = tasksOf(await s.t3.unsettledThreadsSince(thread.launchedAt - CLOCK_SLACK_MS), thread.threadId);
    } catch (error) {
      return notice(`teamai could not list the tasks the T3 thread ${link} delegated, so they stay in T3 Code's active threads: ${error instanceof Error ? error.message : String(error)}`, { handle });
    }

    for (const task of tasks) {
      if (task.status !== null && task.status !== 'idle' && !TERMINAL.has(task.status)) continue;

      try {
        await s.t3.settle(task.threadId);
      } catch (error) {
        if (!(error instanceof T3Error && error.threadGone)) notice(`teamai could not settle the T3 thread ${threadLink(s.environment, task.threadId)}, a task ${link} delegated, so it stays in T3 Code's active threads: ${error instanceof Error ? error.message : String(error)}`, { handle });
      }
    }
  };

  /**
   * Settles each thread of `handle` that ended and that T3 holds no run of, once, with the tasks it delegated: a thread
   * the runtime has not seen stop, or one the person started again, stays. A settle T3 refuses is said once, in a
   * notice, and fails nothing.
   */
  const settleEnded = async (handle: string, s: Reached): Promise<void> => {
    const known = place(handle);

    if (!known) return;
    const script = known.kind === 'worktree' ? known.settleScript : undefined;

    for (const [op, thread] of Object.entries(known.threads)) {
      if (!thread.ended || thread.ended.settlement) continue;
      let outcome: NonNullable<NonNullable<ThreadRecord['ended']>['settlement']>;

      if (script !== undefined) {
        // T3 would run the script in the step's folder, before teamai commits it, so the thread stays where it is.
        notice(`teamai leaves the T3 thread ${threadLink(s.environment, thread.threadId)} ("${thread.title}") in T3 Code's active threads: settling it would run the project's script "${script}" in the step's folder.`, { handle });
        outcome = 'skipped';
      } else {
        try {
          const { status } = await s.t3.thread(thread.threadId);

          if (status !== null && status !== 'idle' && !TERMINAL.has(status)) continue;
          await s.t3.settle(thread.threadId);
          await settleTasks(handle, s, thread);
          outcome = 'settled';
        } catch (error) {
          // A thread T3 no longer has is in nobody's active threads.
          outcome = error instanceof T3Error && error.threadGone ? 'settled' : 'failed';

          if (outcome === 'failed') notice(`teamai could not settle the T3 thread ${threadLink(s.environment, thread.threadId)} ("${thread.title}"), so it stays in T3 Code's active threads: ${error instanceof Error ? error.message : String(error)}`, { handle });
        }
      }

      const now = place(handle);

      if (now?.threads[op]) journal.write({ ...now, threads: { ...now.threads, [op]: { ...now.threads[op], ended: { settlement: outcome } } } });
    }
  };

  /**
   * Removes, with its threads, each project teamai added for a folder of its own that is gone, as far as `deadline`
   * allows: its threads point at nothing. One T3 no longer has is forgotten; one T3 does not remove stays listed for
   * the next close, and is said in a notice about `handle`.
   */
  const removeGoneProjects = async (handle: string, deadline: number): Promise<void> => {
    for (const project of options.added.list()) {
      if (!isGone(project.folder) || deadline <= Date.now()) continue;

      try {
        await options.t3Cli.run({ name: 'project remove', args: ['project', 'remove', '--base-dir', options.t3Home, '--force', project.id], signal: AbortSignal.timeout(deadline - Date.now()) });
        options.added.drop(project.id);
      } catch (error) {
        const reaching = await within(reach(), Math.max(deadline - Date.now(), 0));
        const listing = reaching.answered && reaching.value.ok ? await within(reaching.value.reached.t3.projects().catch(() => undefined), Math.max(deadline - Date.now(), 0)) : undefined;
        const listed = listing?.answered ? listing.value : undefined;

        if (listed && !listed.some((one) => one.id === project.id && !one.deletedAt)) options.added.drop(project.id);
        else notice(`teamai could not remove the T3 project it added for ${project.folder}, which teamai has removed, so its threads stay in T3 Code (${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}). Remove it in T3 Code, or run t3 project remove --force ${project.id}.`, { handle });
      }
    }
  };

  /**
   * Ends the place within STOP_WAIT_MS. Each launch T3 never answered is looked up, and each thread the runtime has not
   * seen stop is stopped first, all at once; while one cannot be, or T3 Code does not answer in time, the place stays,
   * with a judge's copy, and close fails. A lookup or settle that answers late still journals what it found while the
   * place's record is there. With `release`, the person checked that nothing of the attempt runs and let it go: a close
   * that fails still forgets the place, its record and a judge's copy, and says why it failed.
   */
  const close = async (handle: string, { release }: { release: boolean }): Promise<void> => {
    // A released place is forgotten, so its failure no longer says it is kept: the cancel before named its threads.
    const failClose = (failure: RuntimeFailure): void => {
      if (!release) return write({ event: 'close_failed', handle, failure });
      forget(handle);
      write({
        event: 'close_failed', handle,
        failure: { code: failure.code, message: `Runtime t3 forgot ${handle}, as you released it, though T3 Code did not confirm it closed (${failure.code}). If one of its T3 threads still runs, stop it in T3 Code with its Stop button.` },
      });
    };

    const deadline = Date.now() + STOP_WAIT_MS;
    const left = (): number => Math.max(deadline - Date.now(), 0);
    const late = `T3 Code did not answer within ${STOP_WAIT_MS / 1_000} s`;
    const under = [...(working.get(handle) ?? [])];

    // An open or a launch still under way would make what close then never sees: a record, or a thread it starts.
    if (under.length > 0 && !(await within(Promise.allSettled(under), left())).answered) {
      return failClose({ code: 't3_unavailable', message: `teamai was still opening ${handle} or launching a T3 thread in it, and ${late} of the close, so teamai keeps the place. Run teamai workflow cancel again once T3 Code answers.` });
    }

    const read = journal.read(handle);

    if (read.kind === 'unreadable') return failClose(unreadable(handle, read));
    let known = read.kind === 'found' ? read.place : undefined;

    /** T3, or why not: a connection that does not come by the deadline counts as none. */
    const reachInTime = async (): Promise<Reach> => {
      const reaching = await within(reach(), left());

      return reaching.answered ? reaching.value : { ok: false, failure: { code: 't3_unavailable', message: late } };
    };

    if (known) {
      const { run } = known;
      const looked = known;

      // Every launch and thread is journaled with its op.
      const launches = Object.values(looked.ops).flatMap(({ op }) => {
        const launch = looked.launches[op];

        return launch ? [{ op, launch }] : [];
      });

      if (launches.length > 0) {
        const lookUp = (launch: LaunchRecord) => `teamai launched the T3 thread "${launch.title}" and T3 Code never answered, so it may run`;
        const reached = await reachInTime();

        // Nothing here can find the thread without T3 Code.
        if (!reached.ok) return failClose({ code: 't3_unavailable', message: `${lookUp(launches[0].launch)}, and teamai could not reach T3 Code to look for it (${reached.failure.code}). Open T3 Code, then run teamai workflow cancel ${run} again.` });

        const lookups = await Promise.all(launches.map(async ({ op, launch }): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
          try {
            const resolving = await within(resolveLaunch(reached.reached, looked, op, launch), left());

            if (!resolving.answered) return { ok: false, failure: { code: 't3_unavailable', message: `${lookUp(launch)}, and T3 Code did not say within ${STOP_WAIT_MS / 1_000} s whether it launched it when teamai looked. Run teamai workflow cancel ${run} again once T3 Code answers.` } };

            return resolving.value.ok ? { ok: true } : resolving.value;
          } catch (error) {
            return { ok: false, failure: { code: 't3_unavailable', message: `${lookUp(launch)}, and T3 Code did not say whether it launched it when teamai looked: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}. Run teamai workflow cancel ${run} again once T3 Code answers.` } };
          }
        }));

        const refused = lookups.find((one) => !one.ok);

        if (refused && !refused.ok) return failClose(refused.failure);
        known = place(handle) ?? known;
      }

      const resolved = known;

      const owned = Object.values(resolved.ops).flatMap(({ op }) => {
        const thread = resolved.threads[op];

        return thread && !thread.ended ? [{ op, thread }] : [];
      });

      if (owned.length > 0) {
        const reached = await reachInTime();
        const [{ thread: first }] = owned;

        // Nothing here can stop a thread, or tell that it ended, without T3 Code.
        if (!reached.ok) return failClose({ code: 't3_unavailable', message: `The T3 thread "${first.title}" (${first.threadId}) may still run, and teamai could not reach T3 Code to stop it (${reached.failure.code}). Open T3 Code, then run teamai workflow cancel ${run} again.` });
        const s = reached.reached;

        const stops = await Promise.all(owned.map(async ({ op, thread }) => {
          const live = running.get(op);
          // A prompt still running here ends cancelled once its thread stopped, and is followed on while it did not.
          const why = live ? await stopRunning({ s, state: live, op, thread, cancelling: false, deadline }) : await whyNotStopped(s.t3, thread.threadId, deadline);

          if (why !== undefined) return { thread, why };
          const now = place(handle);

          if (now) journal.write(endedIn(now, op));

          return undefined;
        }));

        const still = stops.find((stop) => stop !== undefined);

        if (still) return failClose({ code: 'thread_still_runs', message: `${stillRuns(s, still.thread, still.why)}.` });
      }

      // Every thread of the place has ended now. Without T3 Code, they stay unsettled.
      if (Object.values(place(handle)?.threads ?? {}).some((thread) => thread.ended && !thread.ended.settlement)) {
        const reaching = await within(reach(), left());
        const settling = reaching.answered && reaching.value.ok ? await within(settleEnded(handle, reaching.value.reached), left()) : undefined;

        if (!reaching.answered || settling?.answered === false) return failClose({ code: 't3_unavailable', message: `${late} while teamai settled the place's ended threads, so it keeps the place. Run teamai workflow cancel ${run} again once T3 Code answers.` });
      }

      known = place(handle) ?? known;
    }

    removeCopies(known);
    await removeGoneProjects(handle, deadline);
    journal.remove(handle);
    write({ event: 'closed', handle });
  };

  /** A judge's copy is the thread's scratch folder, so the thread loses its folder with it. */
  const removeCopies = (known: PlaceRecord | undefined): void => {
    for (const thread of Object.values(known?.threads ?? {})) {
      if (thread.copy && fs.existsSync(thread.copy)) {
        chmodTree(thread.copy, WRITABLE);
        fs.rmSync(thread.copy, { recursive: true, force: true });
      }
    }
  };

  /** Forgets a place the person released: its record, readable or not, and a judge's copy. */
  const forget = (handle: string): void => {
    released.add(handle);
    removeCopies(place(handle));
    journal.remove(handle);
  };

  const handleRequest = async (request: RuntimeRequest): Promise<void> => {
    switch (request.type) {
      case 'init':
        return init(request);
      case 'open':
        return track(handleFor(request), open(request));
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
        write({ event: 'alive', handle: request.handle, ops: Object.values(known.ops).map(({ op }) => unkept.get(op) ?? known.ops[op]), ...(display && { display }) });

        return;
      }

      case 'close':
        return close(request.handle, { release: request.release === true });
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
        const message = `Not a protocol ${RUNTIME_PROTOCOL} request: ${error instanceof Error ? error.message : String(error)}`;
        let named: z.infer<typeof NamedSchema> = {};

        try {
          named = NamedSchema.catch({}).parse(JSON.parse(text));
        } catch {
          // Not JSON: it names nothing.
        }

        // teamai fails every request it waits on for an error line, so one is written only for a line that names none. An
        // op this process saw, or one a record holds or may hold, already has its outcome or gets it from what runs it.
        if (named.op !== undefined && (handleOf.has(named.op) || running.has(named.op) || cancelledEarly.has(named.op) || cancelledUnread.has(named.op) || journal.placeOf(named.op).kind !== 'missing')) {
          process.stderr.write(`Dropped a line that names ${named.op}, which runtime t3 already runs or answered: ${message}\n`);
        } else if (named.op !== undefined) fail(named.op, { code: named.type === 'cancel' ? CANCEL_FAILED : 'runtime_protocol', message });
        else if (named.handle !== undefined) write({ event: 'failed', handle: named.handle, failure: { code: 'runtime_protocol', message } });
        else if (named.type === 'init') write({ type: 'init', ok: false, error: { code: 'runtime_protocol', message } });
        else write({ event: 'error', message });

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
