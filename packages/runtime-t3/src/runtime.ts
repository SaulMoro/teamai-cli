import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import {
  PromptResultSchema, RUNTIME_PROTOCOL, RuntimeRequestSchema, type RUNTIME_MODES,
  type OpId, type OpState, type PromptLease, type PromptResult, type RuntimeDisplay, type RuntimeFailure, type RuntimeMessage, type RuntimeRequest,
} from '@teamai/runtime-protocol';
import { z } from 'zod';
import type { Journal, PlaceRecord, ThreadRecord } from './journal.js';
import { DRIVER_NAMES, DRIVERS, driverOf, sessionSince, toolOf, type ToolId } from './sessions.js';
import { STEP_MODE_LABELS, T3Error, type Environment, type Launch, type StepMode, type Project, type Provider, type T3, type Waited } from './t3.js';

// ─── teamai-runtime-t3 ───
//
//  Runtime protocol 1 for T3 Code: each prompt step runs as a T3 thread of its own, on the worktree teamai prepared,
//  where the person can watch it, steer it or stop it. It runs no command: command steps and setup go to the next
//  runtime of the driver definition (`local` in teamai-t3).
//
//    init     connect to the environment, signing in when attended; offer the tools its provider instances run
//    open     the checkout must be a T3 project; the place is that project and the attempt's worktree
//    prompt   t3_thread_launch (existing_worktree, auto or a tighter runtime_mode, clientRequestId = op), then t3_thread_wait
//             until the run and the work it delegated settle; the result file and the tool's transcript end it,
//             and the thread is settled
//    cancel   stop the thread                     reattach  the ops and the thread, from the journal
//    collect  nothing to copy: the worktree, the result and the transcript are already on this machine
//

/** The options a driver definition gives `t3`. teamai strips `max_parallel` and `credentials` before `init`. */
type RuntimeMode = (typeof RUNTIME_MODES)[number];

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

/** How often an interactive step's thread is checked once it is idle without a result: the person may still be in it. */
const IDLE_POLL_MS = 2_000;

const TERMINAL: ReadonlySet<Waited['status']> = new Set(['completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);

export interface Connected {
  ok: true;
  t3: T3;
}

export interface ServeOptions {
  input: NodeJS.ReadableStream;
  write(message: RuntimeMessage): void;
  journal: Journal;
  /** Connects to the environment for a run in `mode`; a failure names why and what the person does about it. */
  connect(mode: RuntimeMode): Promise<Connected | { ok: false; error: RuntimeFailure }>;
  /** The T3 thread the run was started from, when it was (T3 sets T3CODE_THREAD_ID in its sessions). */
  startedFrom?: string;
}

/** A prompt this process follows: the thread once launched, and whether teamai cancelled it. */
interface Running {
  cancelled: boolean;
  thread?: string;
}

interface Session {
  t3: T3;
  mode: RuntimeMode;
  environment: Environment;
  /** The provider instance each offered tool runs on. */
  instances: Map<ToolId, Provider>;
  /** The mode every step thread launches in. */
  stepMode: StepMode;
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

/** The link T3 gives a thread, without the angle brackets it wraps links in, or the one it would give. */
function threadLink(environment: Environment, threadId: string, given: string | undefined): string {
  const link = given?.replace(/^<|>$/g, '');

  return link && /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(link) ? link : `t3-thread://v2/${environment.environmentId}/${threadId}`;
}

/** What the run's details show of a thread: its title, its link, its id and model. */
function threadDisplay(thread: ThreadRecord, environment: string): RuntimeDisplay {
  return { label: thread.title.slice(0, 80), url: thread.link, fields: { thread: thread.threadId.slice(0, 200), model: thread.model, environment } };
}

/** What the run's details show of a place before a thread runs in it. */
function placeDisplay(place: PlaceRecord, environment: Environment): RuntimeDisplay {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** The result the agent wrote, or why it does not count. */
function readResult(file: string): { ok: true; result: PromptResult } | { ok: false; why: string } {
  let text: string;

  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, why: 'ended without writing the result file' };
  }

  try {
    const parsed = PromptResultSchema.safeParse(JSON.parse(text));

    return parsed.success ? { ok: true, result: parsed.data } : { ok: false, why: 'wrote a result file that is not a workflow result' };
  } catch {
    return { ok: false, why: 'wrote a result file that is not JSON' };
  }
}

export function serve(options: ServeOptions): Promise<void> {
  const { write, journal } = options;
  let session: Session | undefined;
  /** The handle of each operation this process saw, so `cancel` (which names only the op) reaches its place. */
  const handleOf = new Map<OpId, string>();
  /** The prompts this process is running, by op; a repeated prompt joins the running one. */
  const running = new Map<OpId, Running>();
  /** Ops teamai cancelled before this process saw their prompt. */
  const cancelledEarly = new Set<OpId>();

  const place = (handle: string): PlaceRecord | undefined => journal.read(handle);

  const record = (handle: string, op: OpId, state: OpState): void => {
    const now = place(handle);

    if (now) journal.write({ ...now, ops: { ...now.ops, [op]: state } });
  };

  const fail = (op: OpId, failure: RuntimeFailure): void => write({ op, event: 'failed', failure });

  /** The terminal event of an operation that ended; a running one has none yet. */
  const answerEnded = (op: OpId, state: OpState): void => {
    switch (state.state) {
      case 'running':
        return;
      case 'finished':
        return write({ op, event: 'finished', session: state.session, result: state.result, ...(state.usage && { usage: state.usage }) });
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

  /** Stops a step's thread as its Stop button does; a failure is logged, and the thread may still run in T3. */
  const stopped = async (t3: T3, threadId: string): Promise<boolean> => {
    try {
      await t3.stop(threadId);

      return true;
    } catch (error) {
      process.stderr.write(`Could not stop ${threadId}: ${error instanceof Error ? error.message : String(error)}\n`);

      return false;
    }
  };

  // teamai quotes a keyed option failure (`key` set) inside a sentence of its own and ends it, so it brings no full stop.
  const init = async (request: Extract<RuntimeRequest, { type: 'init' }>): Promise<void> => {
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

      session = { t3: connected.t3, mode: request.mode, environment, instances: instances.instances, stepMode: parsed.data.runtime_mode ?? 'auto' };
      write({
        type: 'init', ok: true, prompt: true,
        can: {
          exec: false, setup: false, env: false, hitl: request.mode === 'attended', tokens: false, unattended: false, max_turns: false,
          workspace: ['new', 'continue'], tools: [...instances.instances.keys()],
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

    const known = place(handle);

    if (known) {
      write({ op: request.op, event: 'ready', display: placeDisplay(known, session.environment) });

      return;
    }

    const view = request.view;

    if (!view) {
      fail(request.op, { code: 'runtime_protocol', message: 'open came without a view, the place of a confined prompt, which runtime t3 does not answer.' });

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

    const opened: PlaceRecord = { handle, run: request.run, attempt: request.attempt, projectId: project.id, projectTitle: project.title, ops: {}, threads: {} };
    journal.write(opened);
    write({ op: request.op, event: 'ready', display: placeDisplay(opened, session.environment) });
  };

  /** Waits for the thread until the step is done, stopped or failed, and returns how it ended. */
  const follow = async (s: Session, request: Extract<RuntimeRequest, { type: 'prompt' }>, thread: ThreadRecord): Promise<OpState> => {
    const state = running.get(request.op);
    const where = `The T3 thread ${thread.link} ("${thread.title}")`;
    let errors = 0;

    for (;;) {
      let waited: Waited;

      try {
        waited = await s.t3.wait(thread.threadId, WAIT_MS[s.mode]);
        errors = 0;
      } catch (error) {
        // T3 restarting, or a dropped connection: the thread keeps running, so ask again a few times.
        if (++errors > 5) return { op: request.op, state: 'failed', failure: { code: 't3_unavailable', message: `${where} could not be followed: ${error instanceof Error ? error.message : String(error)}` } };
        await sleep(1_000 * errors);
        continue;
      }

      if (state?.cancelled) return { op: request.op, state: 'cancelled' };

      if (!TERMINAL.has(waited.status)) {
        // T3 keeps a run that asks for an approval running, with the request pending; nobody answers it unattended.
        if (s.mode === 'unattended' && (waited.status === 'waiting' || await s.t3.pendingRequests(thread.threadId) > 0)) {
          await stopped(s.t3, thread.threadId);

          return { op: request.op, state: 'failed', failure: { code: 'tool_failed', message: `${where} asked for an approval, and nobody is there to give it in an unattended run.` } };
        }

        // A wait that came back before its time on a run still going (waiting for the person, or idle) is asked again later.
        if (!waited.timedOut) await sleep(IDLE_POLL_MS);
        continue;
      }

      if (waited.status !== 'completed') return { op: request.op, state: 'failed', failure: { code: 'tool_failed', message: `${where} ended ${waited.status} before the step was done.` } };

      // An interactive step ends once the person said it is done and the agent wrote the result; until then the
      // thread idles between their turns.
      if (request.lease.interactive && !fs.existsSync(request.lease.result)) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

      const written = readResult(request.lease.result);

      if (!written.ok) return { op: request.op, state: 'failed', failure: { code: 'tool_failed', message: `${where} ${written.why} ${request.lease.result}.` } };
      const driver = driverOf(thread.tool);
      const id = driver && await sessionSince(driver, request.cwd, thread.launchedAt);

      if (!id) return { op: request.op, state: 'failed', failure: { code: 'tool_failed', message: `${where} finished, but ${thread.tool} kept no session for ${request.cwd}, so the step cannot be scored or resumed.` } };
      // A settled thread leaves the person's list of active threads; one that failed, waits or holds stays.

      try {
        await s.t3.settle(thread.threadId);
      } catch (error) {
        process.stderr.write(`Could not settle ${thread.link}: ${error instanceof Error ? error.message : String(error)}\n`);
      }

      return { op: request.op, state: 'finished', session: { tool: thread.tool, id }, result: written.result };
    }
  };

  const prompt = async (request: Extract<RuntimeRequest, { type: 'prompt' }>): Promise<void> => {
    handleOf.set(request.op, request.handle);
    write({ op: request.op, event: 'accepted' });
    const opened = place(request.handle);
    const ended = opened?.ops[request.op];

    if (ended && ended.state !== 'running') {
      answerEnded(request.op, ended);

      return;
    }

    if (running.has(request.op)) return;

    if (!session || !opened) {
      fail(request.op, { code: 'runtime_protocol', message: session ? `No open place ${request.handle}.` : 'prompt came before a successful init.' });

      return;
    }

    const s = session;

    const end = (state: OpState): void => {
      running.delete(request.op);
      record(request.handle, request.op, state);
      answerEnded(request.op, state);
    };

    if (cancelledEarly.delete(request.op)) {
      end({ op: request.op, state: 'cancelled' });

      return;
    }

    const lease = request.lease;
    const driver = driverOf(lease.tool);
    const instance = driver && s.instances.get(DRIVERS[driver].tool);

    if (!instance) {
      end({ op: request.op, state: 'failed', failure: { code: 'tool_unavailable', message: `T3 Code ${s.environment.label} runs ${[...s.instances.keys()].join(', ') || 'no tool this runtime runs'} here, not ${lease.tool}.` } });

      return;
    }

    if (lease.permissions === 'unattended') {
      // The offer says unattended: false, so teamai never sends one; a thread on the host never runs in full access.
      end({ op: request.op, state: 'failed', failure: { code: 'unattended_unsupported', message: 'Runtime t3 runs no step in unattended permissions on this machine.' } });

      return;
    }

    const selection = modelSelection(instance, lease);

    if (!selection.ok) {
      end({ op: request.op, state: 'failed', failure: selection.failure });

      return;
    }

    const state: Running = { cancelled: false };
    running.set(request.op, state);
    let thread = opened.threads[request.op];

    try {
      const title = `${lease.step} · teamai ${opened.run}`;
      const launchedAt = thread?.launchedAt ?? Date.now();

      // A repeated launch with the same clientRequestId is T3's lookup of the thread it launched for this op.
      const launched = await s.t3.launch({
        title, message: firstMessage(opened, lease, options.startedFrom && threadLink(s.environment, options.startedFrom, undefined)), projectId: opened.projectId, worktreePath: request.cwd,
        modelSelection: selection.selection, runtimeMode: s.stepMode, clientRequestId: request.op,
      });

      thread = { threadId: launched.threadId, title, link: threadLink(s.environment, launched.threadId, launched.link), model: selection.selection.model, tool: lease.tool, launchedAt };
      state.thread = thread.threadId;
      const now = place(request.handle) ?? opened;
      journal.write({ ...now, ops: { ...now.ops, [request.op]: { op: request.op, state: 'running' } }, threads: { ...now.threads, [request.op]: thread } });
    } catch (error) {
      // T3 caps a thread's mode at the access the member approved teamai with, and says so with this code.
      const tooNarrow = error instanceof T3Error && error.refusal?.code === 'runtime_mode_escalation_denied' ? error.refusal.message : undefined;

      end({
        op: request.op, state: 'failed', failure: tooNarrow === undefined
          ? { code: 't3_launch_failed', message: `T3 Code did not launch the step's thread: ${error instanceof Error ? error.message : String(error)}` }
          : {
            code: 'sign_in_too_narrow',
            message: `T3 Code refused to start the step's thread in ${s.stepMode} mode, because teamai's sign-in does not allow it (${tooNarrow}). Remove ~/.teamai/runtime-state/t3/credentials.json, start the workflow again, and approve teamai with ${STEP_MODE_LABELS[s.stepMode]} access or broader. Or set runtime_mode to a mode the sign-in allows.`,
          },
      });

      return;
    }

    if (state.cancelled) await stopped(s.t3, thread.threadId);

    try {
      end(await follow(s, request, thread));
    } catch (error) {
      // The thread may still run in T3, where the person finds it by the link.
      end({ op: request.op, state: 'failed', failure: { code: 't3_unavailable', message: `Lost track of the T3 thread ${thread.link}: ${error instanceof Error ? error.message : String(error)}` } });
    }
  };

  const cancel = async (op: OpId): Promise<void> => {
    const state = running.get(op);

    if (!state) {
      const handle = handleOf.get(op);
      const known = handle ? place(handle) : journal.placeOf(op);
      const left = known?.threads[op];

      // A runtime before this one launched the thread and died; teamai cancels before it reattaches.
      if (known && left && known.ops[op]?.state === 'running' && session) {
        if (!await stopped(session.t3, left.threadId)) return;
        record(known.handle, op, { op, state: 'cancelled' });
        answerEnded(op, { op, state: 'cancelled' });

        return;
      }

      const ended = known?.ops[op];

      if (ended) answerEnded(op, ended);
      else cancelledEarly.add(op);

      return;
    }

    state.cancelled = true;

    if (state.thread && session) await stopped(session.t3, state.thread);
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
      case 'collect':
        write({ event: 'collected', handle: request.handle });

        return;
      case 'reattach': {
        const known = place(request.handle);

        if (!known || !session) {
          write({ event: 'gone', handle: request.handle });

          return;
        }

        const threads = Object.values(known.threads).sort((a, b) => b.launchedAt - a.launchedAt);
        const latest = threads[0];
        write({ event: 'alive', handle: request.handle, ops: Object.values(known.ops), display: latest ? threadDisplay(latest, session.environment.label) : placeDisplay(known, session.environment) });

        return;
      }

      case 'close':
        journal.remove(request.handle);
        write({ event: 'closed', handle: request.handle });

        return;
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
          write({ event: 'error', message: `Runtime t3 failed on ${request.type}: ${error instanceof Error ? error.message : String(error)}` });
        }
      })();
    });

    // teamai is gone: a step still running keeps its thread in T3, which a later teamai reattaches, so this process
    // follows it no further.
    lines.on('close', () => resolve());
  });
}
