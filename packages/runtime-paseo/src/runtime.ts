import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import {
  CANCEL_FAILED, fitReason, isUsageLimitText, OpIdSchema, PromptResultSchema, PromptSessionSchema, RUN_DIR_ENV, RuntimeHandleSchema, RuntimeRequestSchema, type ConfinedKept, type ConfinedPrompt, type InitInstance, type OpId, type OpState, type PromptResult, type RuntimeDisplay,
  type RuntimeFailure, type RuntimeMessage, type RuntimeRequest,
} from '@teamai/runtime-protocol';
import { z } from 'zod';
import { loadClient } from './client.js';
import { CONFINED_MODES, CONFINED_OPTIONS, connect, daemonUrl, isPaseoTool, PASEO_TOOLS, paseoHome, type Creation, type Daemon, type Model, type PaseoTool, type ProviderToAdd, type Target } from './daemon.js';
import { parseOptions } from './options.js';
import { resolvedDir, type AgentCreate, type AgentPrompt, type Journal, type Place, type PromptRecord } from './journal.js';

/** A worktree place Paseo opened as a workspace. */
type WorktreePlace = Extract<Place, { kind: 'worktree' }> & { workspace: NonNullable<Place['workspace']> };

type ConfinedPlace = Extract<Place, { kind: 'confined' }>;

/**
 * A prompt this process follows: what wakes its waits when teamai stops it, whether its agent exists, and what ends its
 * entry in `creates` once no create of it can still be sent.
 */
interface Following {
  stop: () => void;
  stopped: Promise<'stopped'>;
  created: boolean;
  landed: () => void;
}

/** How a prompt's agent is launched: in which place and mode, with what prompt and options, and where its answer comes from. */
interface Launch {
  place: Place;
  /** Absent: the mode Paseo starts the tool in when it sets no default for it. */
  modeId: string | undefined;
  prompt: string;
  options?: AgentCreate['config']['options'];
  env?: AgentCreate['env'];
  answer: AgentPrompt['answer'];
  cwd: string;
  /** The Paseo agent the run was started from, which labels this one. */
  parent?: string;
}

// ─── teamai-runtime-paseo ────────────────────────────────
//
//  A prompt-only step runtime: each prompt step becomes an agent of a Paseo daemon, in a Paseo workspace that adopts
//  teamai's worktree, so a person sees and steers it in Paseo. It runs no command (`can.exec: false`): command steps
//  and setup go to the next runtime in the definition. teamai keeps the result file, the commit, the push and scoring.
//
//    open      accepted at once, handle: worktree/<run>/<attempt>; then workspaces.open(worktree), once per attempt,
//              and ready with the workspace
//    prompt    accepted once journaled pending, before Paseo is asked anything; then the tool's models, a judge's
//              workspace, and agents.create({ agentId: uuid(op), idempotencyKey: op, tool's default mode,
//              teamai's prompt }), and a display event with the agent once it exists; then wait: idle → the result file and the tool's session id, permission → a person answers it in the
//              app (attended) or the step fails naming the mode (unattended), closed without a result → the daemon
//              restarted, and the attempt fails with its work kept
//    cancel    recorded first, then the agent is cancelled: Paseo reports a cancelled agent as idle. A stop it cannot
//              confirm within 10 s ends cancel_failed, which a later cancel tries again
//    recover   init only to stop what it ran: no sign-in or tool check, and the daemon reached only for a cancel or close
//    confined  a judge: a fresh agent whose cwd is the prompt's directory, briefed to read only it, in a mode that asks
//              before it edits or runs anything; any request for permission ends it. Its answer is its last message,
//              reported best-effort: nothing stops a read outside the directory
//

/** How long an attended step waits between looks at a permission request a person has not answered yet. */
const PERMISSION_POLL_MS = 1000;

/** How often an interactive step's agent is looked at while it idles with no result: the person may still be in it. */
const IDLE_POLL_MS = 2_000;

/** What an interactive step's agent is told before teamai's prompt: the person works through the step with it. */
const INTERACTIVE_BRIEF = 'This step is interactive: work through it with the person in this Paseo agent. Write the result file only once they say the step is done.';

/** How long a wait the daemon dropped, as a restart does, waits before it asks again. */
const RECONNECT_MS = 500;

/**
 * How long a cancel or a close may take to confirm its agents stopped, from the moment it is read: Paseo forces a stop
 * after 2 s, and teamai waits 15 s for a cancel's outcome.
 */
const STOP_SETTLE_MS = 10_000;

/** How often a stopping agent is looked at. */
const STOP_POLL_MS = 250;

/** Whether an agent is stopped: gone, or no longer running. A lookup that failed or came late does not count as stopped. */
const isStopped = (agent: Awaited<ReturnType<Daemon['agent']>> | 'late' | undefined): boolean => agent === null || (agent !== undefined && agent !== 'late' && agent.status !== 'running' && agent.status !== 'initializing');

/** Resolves `late` once `deadline` passes, without keeping the process alive for it. */
const late = (deadline: number): Promise<'late'> => new Promise((resolve) => {
  setTimeout(() => resolve('late'), Math.max(0, deadline - Date.now())).unref();
});

/**
 * Whether the agent still runs at `deadline`. Paseo may answer what stops it before the agent's turn ends, so the work
 * counts as stopped only once Paseo reports the agent no longer running, or gone.
 */
async function isStillRunning(live: Daemon, agentId: string, deadline: number): Promise<boolean> {
  for (;;) {
    if (isStopped(await Promise.race([live.agent(agentId).catch(() => undefined), late(deadline)]))) return false;

    if (Date.now() >= deadline) return true;
    await delay(STOP_POLL_MS);
  }
}

/** Whether an op ended in a stop that may not have stopped it, which a later cancel tries again. */
const isFailedStop = (outcome: OpState | undefined): boolean => outcome?.state === 'failed' && outcome.failure.code === CANCEL_FAILED;

/** The agent id a prompt's agent gets: a UUID derived from its op, so a restarted runtime finds the same agent. */
export function agentIdOf(op: OpId): string {
  const hex = createHash('sha256').update(`teamai-runtime-paseo/${op}`).digest('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** What this runtime keeps of a confined prompt: its agent is briefed to read only the directory, and cannot write without asking. */
const CONFINED_KEPT: ConfinedKept = { level: 'best-effort', access: 'read' };

/** The prompt a confined prompt's agent gets: the brief that confines it, the step's prompt, and the shape of its answer. */
function confinedBrief(tool: PaseoTool, confined: ConfinedPrompt, prompt: string): string {
  const reply = confined.schema === undefined
    ? 'Reply with only the JSON answer, and no other text.'
    : `Reply with only the JSON answer that matches this JSON Schema, and no other text: ${JSON.stringify(confined.schema)}. Where the prompt above names another schema, this one decides the shape of your reply.`;

  return `Answer from the files in ${confined.dir} alone. ${CONFINED_READING[tool]}: asking for a permission ends this run.\n\n${prompt}\n\n${reply}`;
}

/** How a confined prompt's agent reads its directory. Codex has no file tools: it reads with shell commands, which its read-only sandbox runs without asking. */
const CONFINED_READING: Readonly<Record<PaseoTool, string>> = {
  claude: 'List and read them with your file tools, such as Glob, Grep and Read. Change no file and run no shell command',
  codex: 'List and read them with read-only shell commands, such as ls, cat and rg, which your sandbox runs without asking. Change no file and use no other tool',
  opencode: 'List and read them with your file tools, such as Glob, Grep and Read. Change no file and run no shell command',
};

/**
 * What a step's agent may write without asking besides its worktree: teamai's result file, as teamai's own launch allows
 * it on a POSIX host, and the run's scratch directory, which the place gives read-write at its own path. Claude's
 * default mode asks before any write, so those two are allowed, and only they. Codex's `auto` sandbox writes the
 * worktree, so the result file's directory and the run directory are added to it. OpenCode asks before it touches a
 * directory outside its project (`external_directory: ask`), so the same two are allowed by OpenCode's own rule, which
 * Paseo sets on the agent's session.
 */
function stepGrant(tool: PaseoTool, result: string, runDir: string): AgentCreate['config']['options'] {
  switch (tool) {
    case 'claude':
      return { allowedTools: [`Edit(/${result})`, `Edit(/${runDir}/**)`] };

    case 'codex':
      return { sandbox_workspace_write: { writable_roots: [path.dirname(result), runDir] } };

    case 'opencode':
      return { permission: { external_directory: { [`${path.dirname(result)}/*`]: 'allow', [`${runDir}/*`]: 'allow' } } };

    default: {
      const unhandled: never = tool;

      return unhandled;
    }
  }
}

/** The failure of an agent that ended with no session in Paseo: teamai records and scores a pass by its session. */
const noSession = (tool: string): RuntimeFailure => ({
  code: 'tool_failed', message: `Paseo reported no session for the ${tool} agent, so teamai cannot record or score its pass. Run \`teamai workflow retry\` to run it again.`,
});

/**
 * The failure of an agent that stopped on its tool's usage limit, saying what the tool said, or undefined when it did
 * not: the tool's own line starts the text, so a reply that only mentions a limit is not one.
 */
function usageLimited(tool: string, said: string | null | undefined): RuntimeFailure | undefined {
  const text = said?.trim();

  return text && isUsageLimitText(text) ? { code: 'usage_limited', message: `The ${tool} agent hit its usage limit in Paseo: ${text}` } : undefined;
}

/**
 * The failure of an agent whose last message is its tool's usage-limit line, or undefined. The tool writes that line
 * alone, so a message that goes on past its first line is the agent's own, as when it reports a limit it hit elsewhere.
 */
function usageLimitedReply(tool: string, said: string | null | undefined): RuntimeFailure | undefined {
  return said?.trim().includes('\n') ? undefined : usageLimited(tool, said);
}

/** A confined prompt's answer: the JSON value its agent replied with. */
const ReplySchema = z.json();

/** The JSON value a confined prompt's agent replied with, in a code fence or not, or undefined when it replied with none. */
function parseReply(text: string | null): z.infer<typeof ReplySchema> | undefined {
  if (!text) return undefined;

  try {
    const parsed = ReplySchema.safeParse(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The result the agent wrote, or undefined when it wrote none teamai can read. */
function readResult(file: string): PromptResult | undefined {
  try {
    const parsed = PromptResultSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a step waits for the daemon to show the agent its run was started from, before naming it by its id alone. */
const PARENT_LOOKUP_MS = 5_000;

/**
 * How a step's first line names Paseo agent `parent`, which the run was started from: its link when the daemon holds it.
 * An agent this daemon does not know, or does not show within 5 s, is named by its id alone, never linked to a server
 * that does not hold it.
 */
async function parentNamed(live: Daemon, parent: string): Promise<string> {
  const known = await Promise.race([live.agent(parent), delay(PARENT_LOOKUP_MS).then(() => null)]).catch(() => null);

  return known ? live.link(parent) : parent;
}

/**
 * What the person reads once teamai added a Paseo provider for instance `name`: what it holds, that it stays, and how to
 * remove it: in the Paseo app, or, as Paseo's CLI cannot unset one provider (0.14 refuses `config unset` on a dynamic
 * key), by editing the config of the Paseo home the member's Paseo uses and reloading the daemon.
 */
function addedNotice(url: string, { id, entry }: ProviderToAdd, name: string): string {
  const runs = entry.command ? entry.command[0] : `${entry.extends}'s own command`;
  const home = Object.entries(entry.env ?? {}).map(([variable, dir]) => `, with ${variable}=${dir}`).join('');
  const paseoDir = paseoHome(process.env);
  const homeFlag = process.env.PASEO_HOME ? ` --home ${paseoDir}` : '';

  return `teamai added the Paseo provider ${id} to the daemon at ${url} for its ${name} steps: it extends ${entry.extends} and runs ${runs}${home}. It stays for later runs; to remove it, choose Remove provider on ${id} in the Paseo app's provider settings, or delete agents.providers.${id} from ${path.join(paseoDir, 'config.json')}, then run \`paseo daemon reload${homeFlag}\`. Paseo cannot show its agents' logs once it is gone, so read them first.`;
}

export interface Serving {
  input: Readable;
  write(message: RuntimeMessage): void;
  /** Writes a line for a person, never for teamai: stderr. */
  note(text: string): void;
  journal: Journal;
  /** The Paseo agent the run was started from, when it was (Paseo sets PASEO_AGENT_ID in its agents). */
  startedFrom?: string;
}

/** What a request line names, read without the rest of the request, so a line that cannot be read is answered on its own. */
const NamedSchema = z.object({
  type: z.string().catch('request'),
  op: OpIdSchema.optional().catch(undefined),
  handle: RuntimeHandleSchema.optional().catch(undefined),
});

/** What init offered of an installed tool: its steps and judges, its steps only, or nothing, with why not. */
type Offer = { runs: 'steps-and-judges' } | { runs: 'steps'; noJudge: string } | { runs: 'nothing'; reason: string };

export function serve({ input, write: emit, note, journal, startedFrom }: Serving): Promise<void> {
  /** How many lines ended each op in this process: a request that throws ends its op only when nothing else did meanwhile. */
  const ends = new Map<OpId, number>();

  const write = (message: RuntimeMessage): void => {
    if ('op' in message && 'event' in message && (message.event === 'finished' || message.event === 'failed' || message.event === 'cancelled')) ends.set(message.op, (ends.get(message.op) ?? 0) + 1);
    emit(message);
  };

  let daemon: Daemon | undefined;
  let mode: 'attended' | 'unattended' = 'attended';
  /**
   * In recover mode, the daemon's url, or why it could not be read: the runtime connects to it only once a cancel or
   * close needs it.
   */
  let recoverAt: { url: string } | RuntimeFailure | undefined;
  /** The connection a recover-mode cancel or close is making, which the next one shares. */
  let reaching: Promise<Daemon | RuntimeFailure> | undefined;

  /**
   * The daemon a stop needs by `deadline`: the one init connected to, or, in recover mode, one connected on first need,
   * so a daemon that is down or a tool signed out since never keeps teamai from stopping what it ran, or why none
   * answered by then. Undefined: init did not connect to one. A connection that misses a stop's deadline is not shared
   * with the next stop, which connects afresh, so a daemon that is back by then is reached.
   */
  const reachBy = async (deadline: number): Promise<Daemon | RuntimeFailure | undefined> => {
    if (daemon) return daemon;

    if (!recoverAt || 'code' in recoverAt) return recoverAt;
    const { url } = recoverAt;

    const shared = reaching;
    const abandon = new AbortController();

    const connecting = shared ?? (async () => {
      const client = await loadClient(process.env);
      const connected = 'code' in client ? client : await connect(url, client, abandon.signal);

      if (!('code' in connected)) daemon = connected;

      return connected;
    })();

    reaching = connecting;
    const reached = await Promise.race([connecting, late(deadline)]);

    // A connection that failed, or missed this deadline, is not the next stop's; a later one may have replaced it. One
    // this stop began, and it ran out of time for, is dropped then, so none goes on past the stop that wanted it.
    if ((reached === 'late' || 'code' in reached) && reaching === connecting) reaching = undefined;

    // One this stop joined failed, as when the stop that began it ran out of time first: this stop connects again within
    // its own deadline, so a daemon that is back by then is reached.
    if (reached !== 'late' && 'code' in reached && shared && Date.now() < deadline) return reachBy(deadline);

    if (reached !== 'late') return reached;

    if (!shared) abandon.abort();

    return { code: 'daemon_unreachable', message: `No Paseo daemon answered at ${url} within ${STOP_SETTLE_MS / 1000} s. Start it with \`paseo start\`, or set the runtime's url option to the daemon's address.` };
  };

  /** What init offered of each tool and team instance the daemon has installed, by the name a step gives it. */
  let offers = new Map<string, Offer>();
  /** How Paseo runs each offered tool or instance, by its name. */
  let targets = new Map<string, Target>();
  /** The Paseo mode each offered tool's steps start in, which init read from Paseo; none for a tool Paseo starts as it does. */
  let modeIds = new Map<string, string>();
  /**
   * The Claude home each offered Claude or instance of it keeps its sessions in, when Paseo reports one: each finished
   * prompt on it names that home, so teamai reads the session there whatever HOME or tool root it runs with.
   */
  let sessionHomes = new Map<string, string>();
  /** The home each team instance keeps its sessions in, as teamai resolved it, by its name. */
  let homeDirs = new Map<string, string>();
  /** The tool home each offered tool or instance runs in when its Paseo provider's env sets one, by its name. */
  let providerHomes = new Map<string, string>();

  /**
   * Why a new step or judge on `tool` is refused, or undefined when init offered it. teamai holds a step whose `tool` was
   * not offered, but not one that takes its tool from the definition's default, so the runtime refuses it here too.
   */
  const notOffered = (tool: string, isJudge: boolean): RuntimeFailure | undefined => {
    const offer = offers.get(tool) ?? { runs: 'nothing', reason: 'the daemon has not installed it' };
    const reason = offer.runs === 'nothing' ? offer.reason : offer.runs === 'steps' && isJudge ? offer.noJudge : undefined;

    return reason === undefined ? undefined : { code: 'tool_unavailable', message: `teamai-runtime-paseo did not offer ${tool}: ${reason}.` };
  };

  /**
   * The prompts this process follows from their acceptance, each with what wakes its waits when teamai stops it, whether
   * its agent exists, and its create, which settles once no create of it can still be sent.
   */
  const waiting = new Map<OpId, Following>();
  /** The prompts whose stop this process runs, and settles; one another process stops is settled when it journals the end. */
  const stopping = new Set<OpId>();
  /**
   * The prompts whose place a close is stopping: the close settles them once their agents stopped, so their own wait,
   * which may see the agent stop first, leaves the end to it, and goes on following if the close fails.
   */
  const closeStops = new Set<OpId>();
  /** The worktrees this process is opening as Paseo workspaces, by handle: a close waits for its open to end. */
  const opens = new Map<string, Promise<void>>();
  /** The last open this process runs on each directory, by its resolved path: the next one there waits for it. */
  const turns = new Map<string, Promise<void>>();

  /** Runs `task` once every open this process began before on `directory` has ended. */
  function inTurn<T>(directory: string, task: () => Promise<T>): Promise<T> {
    const key = resolvedDir(directory);
    const turn = (turns.get(key) ?? Promise.resolve()).then(task);
    const ended = turn.then(() => undefined, () => undefined);
    turns.set(key, ended);
    void ended.then(() => {
      if (turns.get(key) === ended) turns.delete(key);
    });

    return turn;
  }

  /** The requests this process is answering. */
  const answering = new Set<Promise<void>>();
  /** teamai closed stdin: a prompt's agent goes on in Paseo, and this process stops following it. */
  let closing = false;

  const fail = (op: OpId, failure: RuntimeFailure): void => write({ op, event: 'failed', failure });

  /** The team instances init offered whose Paseo provider teamai adds at the first open or prompt that runs them, by name. */
  let toAdd = new Map<string, { planned: ProviderToAdd; instance: InitInstance }>();
  /** The adds this process runs, by instance name: two opens of one instance wait for the same add. */
  const adding = new Map<string, Promise<RuntimeFailure | undefined>>();

  /**
   * Adds the Paseo provider of instance `name` when init offered it before it existed, once across the runtimes on this
   * journal, and says so once on `op`; or why the instance cannot run, which fails `op`. Nothing for any other tool.
   */
  const ensureProvider = (live: Daemon, name: string, op: OpId): Promise<RuntimeFailure | undefined> => {
    const pending = toAdd.get(name);

    if (!pending) return Promise.resolve(undefined);
    const { planned, instance } = pending;
    const cannot = (why: string): RuntimeFailure => ({ code: 'tool_unavailable', message: `teamai-runtime-paseo cannot run ${name} on the Paseo daemon at ${live.url}: ${why}. Then run the step again.` });

    const running = adding.get(name) ?? (async (): Promise<RuntimeFailure | undefined> => {
      let release: () => void;

      try {
        release = await journal.holdProviders(live.url);
      } catch (error) {
        adding.delete(name);

        return cannot(`it could not hold the daemon's providers in ${journal.root} to add one for it (${error instanceof Error ? error.message : String(error)}); make that directory writable`);
      }

      try {
        const added = await live.addProvider(planned, instance);

        // A provider it added stays, so the person is told how to remove it: one the instance runs on, or one Paseo
        // would not remove again when the instance cannot run on it.
        if (added.added) write({ event: 'notice', op, message: addedNotice(live.url, planned, name) });

        if ('cannot' in added) return cannot(added.cannot);
        toAdd.delete(name);
        const target = targets.get(name);

        if (target) targets.set(name, { ...target, provider: added.provider });

        if (added.home !== undefined) sessionHomes.set(name, added.home);

        if (added.providerHome !== undefined) providerHomes.set(name, added.providerHome);

        return undefined;
      } finally {
        adding.delete(name);
        release();
      }
    })();

    adding.set(name, running);

    return running;
  };

  const send = (op: OpId, outcome: OpState): void => {
    switch (outcome.state) {
      case 'finished':
        write({ op, event: 'finished', session: outcome.session, result: outcome.result, ...(outcome.usage && { usage: outcome.usage }), ...(outcome.confined && { confined: outcome.confined }) });

        return;
      case 'cancelled':
        write({ op, event: 'cancelled' });

        return;
      case 'failed':
        fail(op, outcome.failure);

        return;
      case 'running':
      case 'exited':
        throw new Error(`A Paseo prompt never ends ${outcome.state}`);
      default: {
        const unhandled: never = outcome;
        throw new Error(`Unknown outcome ${JSON.stringify(unhandled)}`);
      }
    }
  };

  /**
   * The creates of the prompts this process launched, each settled once no create of it can still be sent. Kept apart
   * from `waiting`, which a prompt leaves once it ends: one a cancel ended because its create took too long still has
   * that create pending, and a retried cancel and a close wait for it.
   */
  const creates = new Map<OpId, Promise<void>>();

  /** Follows a prompt from here on: a cancel and a close find it, and wait for its create. */
  const track = (op: OpId): Following => {
    let stop = (): void => {};

    const stopped = new Promise<'stopped'>((resolve) => {
      stop = () => resolve('stopped');
    });

    let resolve = (): void => {};

    const creating = new Promise<void>((settled) => {
      resolve = settled;
    });

    creates.set(op, creating);

    const landed = (): void => {
      resolve();

      if (creates.get(op) === creating) creates.delete(op);
    };

    const following: Following = { stop, stopped, created: false, landed };
    waiting.set(op, following);

    return following;
  };

  /**
   * Records how a prompt ended and tells teamai, once. A prompt's own launch or follow, its `owner`, ends it only while it
   * still holds it in `waiting`: a cancel that took it over ends it instead.
   */
  const settle = (op: OpId, outcome: OpState, owner?: Following): void => {
    if (owner && waiting.get(op) !== owner) return;
    const record = journal.prompt(op);

    if (!record || record.kind === 'refused') return;

    // Another process ended it first, as a recover-mode cancel does: a prompt this one follows ends as that one recorded.
    if (record.outcome) {
      if (waiting.delete(op)) send(op, record.outcome);

      return;
    }

    journal.savePrompt(op, { ...record, outcome });
    waiting.delete(op);
    send(op, outcome);
  };

  /** Records whether a prompt sent its create, on its record as it stands: one a close removed is not written again. */
  const dispatch = (op: OpId, dispatched: AgentPrompt['dispatched']): void => {
    const current = journal.prompt(op);

    if (current?.kind === 'agent' && current.dispatched !== dispatched) journal.savePrompt(op, { ...current, dispatched });
  };

  /**
   * Cancels a prompt's agent in Paseo and confirms it stopped by `deadline`, or says why it may still run, since the
   * agent may then still change the worktree.
   */
  const cancelAgent = async (live: Daemon, record: AgentPrompt, deadline = Date.now() + STOP_SETTLE_MS): Promise<RuntimeFailure | undefined> => {
    const cancelling = (async (): Promise<{ refused?: string }> => {
      try {
        await live.cancel(record.create.agentId);

        return {};
      } catch (error) {
        return { refused: error instanceof Error ? error.message : String(error) };
      }
    })();

    const answered = await Promise.race([cancelling, late(deadline)]);

    if (answered === 'late') {
      return {
        code: 'cancel_failed',
        message: `Paseo did not answer the cancel of the ${record.tool} agent ${record.create.agentId} within ${STOP_SETTLE_MS / 1000} s. It may still run in the worktree; stop it in the Paseo app.`,
      };
    }

    if (answered.refused !== undefined) {
      return {
        code: 'cancel_failed',
        message: `Paseo did not cancel the ${record.tool} agent ${record.create.agentId}: ${answered.refused}. It may still run in the worktree; stop it in the Paseo app.`,
      };
    }

    if (!(await isStillRunning(live, record.create.agentId, deadline))) return undefined;

    return {
      code: 'cancel_failed',
      message: `Paseo cancelled the ${record.tool} agent ${record.create.agentId}, but it still ran ${STOP_SETTLE_MS / 1000} s later. It may still change the worktree; stop it in the Paseo app.`,
    };
  };

  /**
   * A finished prompt's session: its tool and id, and the home it lives in when the runtime can tell. `createdAt`: when
   * Paseo created its agent.
   */
  const sessionOf = (live: Daemon, { tool, id, createdAt }: { tool: string; id: string; createdAt: string | undefined }): z.infer<typeof PromptSessionSchema> => {
    const target = targets.get(tool);
    const created = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
    const since = Number.isNaN(created) ? undefined : created;
    const home = target && live.sessionHome(target.tool, id, { claudeHome: sessionHomes.get(tool), providerHome: providerHomes.get(tool), homeDir: homeDirs.get(tool) ?? '.codex', since });

    return { tool, id, ...(home !== undefined && { home }) };
  };

  /** What the run's details show of a prompt's agent: its title, a link that opens it in Paseo, and where it runs. */
  const agentDisplay = (record: AgentPrompt, workspace: string | undefined, live: Daemon): RuntimeDisplay => ({
    label: record.create.title.slice(0, 80),
    url: live.link(record.create.agentId),
    fields: { agent: record.create.agentId, ...(workspace && { workspace }), model: record.create.config.provider },
  });

  /** What the run's details show of a handle: the latest agent it runs, or the workspace before it runs one. */
  const displayOf = (handle: string, live: Daemon): RuntimeDisplay | undefined => {
    const place = journal.place(handle);

    if (!place) return undefined;
    const latest = journal.promptsOf(handle).flatMap(({ record }) => (record.kind === 'agent' ? [record] : [])).at(-1);

    if (latest) return agentDisplay(latest, place.workspace?.id, live);

    if (place.kind === 'confined') return { label: 'Paseo confined prompt, best-effort', fields: { daemon: `Paseo ${live.version}` } };

    // A worktree Paseo has not opened yet shows nothing until it has.
    if (!place.workspace) return undefined;

    return { label: `Paseo workspace ${place.workspace.name}`.slice(0, 80), fields: { workspace: place.workspace.id, daemon: `Paseo ${live.version}` } };
  };

  /** Why a stop cannot be done with no daemon: its connection's own failure, or, with none, that no daemon is reached. */
  const withoutDaemon = (failure: RuntimeFailure | undefined, cannot: string, then: string): RuntimeFailure => (failure
    ? { code: failure.code, message: `${failure.message} Until then teamai-runtime-paseo cannot ${cannot}; ${then}.` }
    : { code: 'daemon_unreachable', message: `teamai-runtime-paseo reaches no Paseo daemon, so it cannot ${cannot}. Start the daemon with \`paseo start\`, then ${then}.` });

  /** What the run's details show of a prompt's agent, once it exists. */
  const shownOf = (record: AgentPrompt, live: Daemon): RuntimeDisplay | undefined => {
    const place = journal.place(record.handle);

    return place && agentDisplay(record, place.workspace?.id, live);
  };

  /** Accepts a prompt, showing its agent when that is known to exist; one still to be created is shown once it is. */
  const accept = (op: OpId, record: PromptRecord, live: Daemon, { exists }: { exists: boolean }): void => {
    const display = exists && record.kind === 'agent' && shownOf(record, live);
    write({ op, event: 'accepted', ...(display && { display }) });
  };

  async function init(request: Extract<RuntimeRequest, { type: 'init' }>): Promise<void> {
    const parsed = parseOptions(request.options);

    if (!parsed.ok) {
      write({ type: 'init', ok: false, error: parsed.failure });

      return;
    }

    const { options } = parsed;

    const instances = request.instances ?? [];
    const runsAs = new Set<string>([...PASEO_TOOLS, ...instances.flatMap((instance) => (isPaseoTool(instance.tool) ? [instance.name] : []))]);
    // teamai passes every instance the member may run, so a provider for one it did not pass, such as a team tool this
    // machine has not accepted, leaves that name unavailable rather than failing the other tools.
    const foreign = Object.keys(options.providers ?? {}).filter((name) => !runsAs.has(name));

    // The daemon the definition names, else the one the member's Paseo config names.
    const address = options.url === undefined ? daemonUrl(process.env) : { url: options.url };

    if (request.mode === 'recover') {
      // Only to stop what it ran: no sign-in or tool check, and no connection until a cancel or close needs one. A config
      // it cannot read fails each stop that needs the daemon, naming why, never the init that stops nothing.
      recoverAt = address;
      write({ type: 'init', ok: true, can: {} });

      return;
    }

    if ('code' in address) {
      write({ type: 'init', ok: false, error: address });

      return;
    }

    const { url } = address;

    const client = await loadClient(process.env);

    if ('code' in client) {
      write({ type: 'init', ok: false, error: client });

      return;
    }

    const connected = await connect(url, client);

    if ('code' in connected) {
      write({ type: 'init', ok: false, error: connected });

      return;
    }

    const modes = Object.fromEntries(Object.entries(options.mode ?? {}).filter(([tool]) => isPaseoTool(tool)));
    const installed = await connected.installedTools({ modes, instances, providers: options.providers ?? {} });
    const tools = installed.flatMap((entry) => (entry.kind === 'unavailable' ? [] : [entry]));

    // It starts though it can run no tool, so the run's command steps still go to the next runtime: each tool it cannot
    // run is named with why, which teamai shows on a step on that tool.
    const unavailable = Object.fromEntries([...PASEO_TOOLS, ...installed.map(({ name }) => name).filter((name) => !isPaseoTool(name))].flatMap((name): Array<[string, string]> => {
      const entry = installed.find((candidate) => candidate.name === name);

      if (entry && entry.kind !== 'unavailable') return [];
      const reason = entry ? entry.reason : `it is not installed where the daemon finds its tools; install ${name} on the daemon's PATH and sign in to it there`;

      return [[name, fitReason(`The Paseo daemon at ${connected.url} cannot run ${name}: ${reason}.`)]];
    }).concat(foreign.map((name): [string, string] => {
      const passed = instances.find((instance) => instance.name === name);

      const why = passed
        ? `it extends ${passed.tool}, which Paseo does not run. Remove ${name} from the providers option.`
        : `the runtime's providers option names it, and teamai passed no tool instance ${name} here; a team tool runs here once its command is accepted on this machine. If it is no team tool, remove ${name} from the providers option.`;

      return [name, fitReason(`The Paseo daemon at ${connected.url} cannot run ${name}: ${why}`)];
    })));

    daemon = connected;
    mode = request.mode;

    // A tool whose Paseo default never asks starts its steps in a tighter mode, which the person is told once.
    for (const entry of tools) {
      const { stepMode } = entry;

      if (stepMode.kind === 'tightened') {
        write({ event: 'notice', message: `Paseo starts ${entry.name} in mode ${stepMode.insteadOf} by default, which never asks before it acts; teamai starts its ${entry.name} steps in mode ${stepMode.id}, the nearest one before it in Paseo's list that asks.` });
      }
    }

    // A provider that moves a tool's home away from teamai's own for it: its steps sign in and keep sessions there.
    for (const entry of tools) {
      const { name, provider } = entry;
      const providerHome = entry.kind === 'runs' ? entry.providerHome : undefined;

      if (providerHome && path.resolve(providerHome.dir) !== path.resolve(providerHome.teamaiHome)) {
        write({ event: 'notice', message: `Paseo provider ${provider} runs ${name} with ${providerHome.variable}=${providerHome.dir}, not teamai's home for it (${providerHome.teamaiHome}): its steps sign in and keep their sessions in ${providerHome.dir}, where teamai reads them.` });
      }
    }

    targets = new Map(tools.map(({ name, tool, provider }) => [name, { name, tool, provider }]));
    homeDirs = new Map(instances.flatMap((instance) => (instance.home ? [[instance.name, instance.home.dir]] : [])));
    modeIds = new Map(tools.flatMap(({ name, stepMode }) => (stepMode.kind === 'unset' ? [] : [[name, stepMode.id]])));
    sessionHomes = new Map(tools.flatMap((entry) => (entry.kind === 'runs' && entry.home !== undefined ? [[entry.name, entry.home]] : [])));
    providerHomes = new Map(tools.flatMap((entry) => (entry.kind === 'runs' && entry.providerHome !== undefined ? [[entry.name, entry.providerHome.dir]] : [])));
    toAdd = new Map(tools.flatMap((entry) => {
      const instance = instances.find((candidate) => candidate.name === entry.name);

      return entry.kind === 'to-add' && instance ? [[entry.name, { planned: entry.toAdd, instance }]] : [];
    }));
    offers = new Map(installed.map((entry): [string, Offer] => {
      if (entry.kind === 'unavailable') return [entry.name, { runs: 'nothing', reason: entry.reason }];
      const confinedMode = CONFINED_MODES[entry.tool];

      return [entry.name, entry.modes.includes(confinedMode) ? { runs: 'steps-and-judges' } : { runs: 'steps', noJudge: `has no ${confinedMode} mode, which teamai judges it in` }];
    }));
    const judges = tools.flatMap(({ name }) => (offers.get(name)?.runs === 'steps-and-judges' ? [name] : []));
    // The tools the member opted into a mode that never asks: teamai warns once and records their steps' isolation none.
    const permissions = Object.fromEntries(tools.flatMap(({ name, stepMode }) => (stepMode.kind === 'bypass' ? [[name, 'full-access' as const]] : [])));

    write({
      type: 'init', ok: true, prompt: true,
      ...(judges.length > 0 && { confinedPrompt: true }),
      ...(Object.keys(unavailable).length > 0 && { unavailable }),
      ...(Object.keys(permissions).length > 0 && { permissions }),
      can: {
        // tokens: Paseo reports a turn's usage without the tokens written to the prompt cache, so a budget would undercount.
        // unattended: a step that may run without asking needs a strict sandbox, which the daemon's host is not, so none
        // starts here, not even in a mode the member opted into that never asks.
        // hitl: in an attended run, a person works through an interactive step in its agent in the Paseo app.
        // role: Paseo runs a project's worktree setup only in a worktree it creates itself, or when asked to run it; this
        // runtime only opens the copy teamai prepared, so nothing delivers the member's own assets over the role's.
        exec: false, setup: false, hitl: mode === 'attended', unattended: false, env: false, tokens: false, max_turns: false, workspace: ['read-only', 'new', 'continue', 'clone', 'team'], role: true, tools: tools.map(({ name }) => name),
        ...(judges.length > 0 && { confined: [{ ...CONFINED_KEPT, tools: judges }] }),
      },
    });
  }

  async function open(live: Daemon, request: Extract<RuntimeRequest, { type: 'open' }>): Promise<void> {
    const { op, run, attempt, view } = request;
    let handle = journal.handleOf(request);

    // A handle per attempt, kept before Paseo opens anything, so the open is accepted at once: two attempts on one
    // worktree share its workspace, and keep their own prompts. A confined prompt's place comes without a view: its
    // workspace adopts the prompt's directory once the prompt comes.
    if (!handle) {
      handle = `${view ? 'worktree' : 'confined'}/${run}/${attempt}`;
      journal.savePlace(handle, view ? { kind: 'worktree', run, attempt, cwd: view.worktree, runDir: view.runDir } : { kind: 'confined', run, attempt });
    }

    write({ op, event: 'accepted', handle });

    // The first open that runs a team instance init offered before its provider existed adds that provider.
    if (request.tool !== undefined) {
      const failure = await ensureProvider(live, request.tool, op);

      if (failure) {
        fail(op, failure);

        return;
      }
    }

    const opened = handle;
    const place = journal.place(opened);

    if (place?.kind === 'worktree' && !place.workspace) {
      // One open at a time on a directory, in this runtime and across those on this journal, decides whether the
      // workspace there is the member's: an open in flight has made teamai's own before it journals it.
      const opening = inTurn(place.cwd, async (): Promise<RuntimeFailure | undefined> => {
        const unjournaled = (why: string): RuntimeFailure => ({
          code: 'workspace_failed',
          message: `teamai-runtime-paseo could not journal its open of ${place.cwd} before asking Paseo, so it opened nothing: ${why}. Make ${journal.root} writable, then run the step again.`,
        });

        const unopened = (why: string): RuntimeFailure => ({ code: 'workspace_failed', message: `Paseo could not open the worktree as a workspace: ${why}` });
        // A close the person released while Paseo was slow to answer forgot the attempt, and nothing journals it again.
        const isReleased = (): boolean => journal.place(opened) === undefined;
        const releasedBefore: RuntimeFailure = { code: 'workspace_failed', message: `The attempt was released before Paseo opened ${place.cwd}, so nothing was opened there.` };
        const releasedAfter: RuntimeFailure = { code: 'workspace_failed', message: `The attempt was released while Paseo opened ${place.cwd}; archive its workspace in the Paseo app if no other attempt runs there.` };
        let release: () => void;
        let member = place.member;

        try {
          release = await journal.holdOpen(place.cwd);
        } catch (error) {
          return unjournaled(error instanceof Error ? error.message : String(error));
        }

        try {
          // Read under the hold, which every way out of this block releases.
          try {
            member ??= journal.memberOn(place.cwd, handle);
          } catch (error) {
            return unjournaled(error instanceof Error ? error.message : String(error));
          }

          if (member === undefined) {
            let isOpenThere: boolean;

            try {
              isOpenThere = await live.isOpen(place.cwd);
            } catch (error) {
              return unopened(error instanceof Error ? error.message : String(error));
            }

            // An open that took this one's hold over while Paseo was slow to answer decided first, and may have made
            // teamai's own workspace there since, which Paseo then answers open.
            try {
              member = journal.memberOn(place.cwd, handle) ?? isOpenThere;
            } catch (error) {
              return unjournaled(error instanceof Error ? error.message : String(error));
            }
          }

          if (isReleased()) return releasedBefore;

          try {
            journal.savePlace(opened, { ...place, member });
          } catch (error) {
            return unjournaled(error instanceof Error ? error.message : String(error));
          }

          try {
            const workspace = await live.workspace(place.cwd);

            if (isReleased()) return releasedAfter;
            journal.savePlace(opened, { ...place, member, workspace: { id: workspace.id, name: workspace.name }, cwd: workspace.directory });

            return undefined;
          } catch (error) {
            return unopened(error instanceof Error ? error.message : String(error));
          }
        } finally {
          release();
        }
      });

      opens.set(handle, opening.then(() => undefined));
      const failure = await opening;
      opens.delete(handle);

      if (failure) {
        fail(op, failure);

        return;
      }
    }

    const display = displayOf(handle, live);
    write({ op, event: 'ready', ...(display && { display }) });
  }

  /** The create a new prompt sends, on one of `models`, in `how`'s mode with its prompt and options, or the failure that keeps it from being sent. */
  function createFor(live: Daemon, request: Extract<RuntimeRequest, { type: 'prompt' }>, { name: tool, provider }: Target, models: Model[], how: Launch): AgentCreate | RuntimeFailure {
    const { place } = how;
    const { lease } = request;
    const offered = models.map((candidate) => candidate.id).join(', ') || 'none';
    // The step's model, or the agent definition's, which teamai sends as the lease's; else the tool's default. A step that
    // names a model runs on it, or fails: it never runs on the default instead.
    const model = lease.model ? models.find((candidate) => candidate.id === lease.model?.name) : models.find((candidate) => candidate.isDefault) ?? models[0];

    if (!model) {
      return { code: 'model_unavailable', message: `The Paseo daemon at ${live.url} has no ${tool} model${lease.model ? ` ${lease.model.name}` : ''}. It offers: ${offered}.` };
    }

    const effort = lease.model?.effort;

    if (effort && !model.efforts.includes(effort)) {
      return { code: 'model_unavailable', message: `The Paseo daemon at ${live.url} has no effort ${effort} for ${tool} model ${model.id}. It offers: ${model.efforts.join(', ') || 'none'}.` };
    }

    return {
      agentId: agentIdOf(request.op),
      idempotencyKey: request.op,
      title: `teamai ${lease.step} · ${place.run}`,
      prompt: how.prompt,
      // `paseo ls --label teamai-run=<run>` lists a run's agents, and `teamai-step` one step's.
      // `teamai-parent` lists the step and judge agents of runs started from that Paseo agent.
      labels: { 'teamai-attempt': `${place.run}/${place.attempt}`, 'teamai-run': place.run, 'teamai-step': lease.step, ...(how.parent && { 'teamai-parent': how.parent }) },
      ...(how.env && { env: how.env }),
      config: { provider: `${provider}/${model.id}`, ...(how.modeId !== undefined && { modeId: how.modeId }), ...(effort && { thinkingOptionId: effort }), ...(how.options && { options: how.options }) },
    };
  }

  /**
   * Accepts a new prompt before Paseo is asked anything, which may take long: a model listing alone may take 90 s, and
   * teamai waits 15 s for the acceptance. It is journaled pending and followed from here, so a cancel or a close finds it.
   */
  const begin = (op: OpId, handle: string): Following => {
    journal.savePrompt(op, { kind: 'pending', handle });
    const following = track(op);
    write({ op, event: 'accepted' });

    return following;
  };

  /**
   * Whether a prompt whose create is not sent yet goes on to send it: not once teamai went away, nor once it was
   * cancelled, here or by another process, or its place closes, which ends it cancelled with no agent.
   */
  const goesOn = (op: OpId, following: Following): boolean => {
    if (closing || waiting.get(op) !== following) return false;

    if (!journal.isCancelled(op)) return true;
    settle(op, { op, state: 'cancelled' }, following);

    return false;
  };

  /** The tool's models, or why Paseo did not list them, or `stopped` once the prompt is stopped: a listing changes nothing in Paseo, so no stop waits for it. */
  const listModels = async (live: Daemon, provider: string, following: Following): Promise<Model[] | RuntimeFailure | 'stopped'> => {
    try {
      return await Promise.race([live.models(provider), following.stopped]);
    } catch (error) {
      return { code: 'paseo_failed', message: `Paseo failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  /**
   * Creates a pending prompt's agent on one of the tool's models, and follows it. Its agent record is journaled before
   * the cancel marker is read, so a cancel, here or in another process, either finds that record and stops the agent, or
   * is seen here, and no create is sent.
   */
  async function launch(live: Daemon, request: Extract<RuntimeRequest, { type: 'prompt' }>, following: Following, target: Target, how: Launch): Promise<void> {
    const { op } = request;
    // Accepted already: a provider no open added yet for a team instance is added now, which may wait on another runtime.
    // A cancel or a close meanwhile ends the prompt at once; the add goes on for the instance's later steps.
    const unadded = await Promise.race([ensureProvider(live, target.name, op), following.stopped]);

    if (!goesOn(op, following) || unadded === 'stopped') return;

    if (unadded) {
      settle(op, { op, state: 'failed', failure: unadded }, following);

      return;
    }

    const on = targets.get(target.name) ?? target;
    const models = await listModels(live, on.provider, following);

    if (!goesOn(op, following) || models === 'stopped') return;
    const create = 'code' in models ? models : createFor(live, request, on, models, how);

    if ('code' in create) {
      settle(op, { op, state: 'failed', failure: create }, following);

      return;
    }

    const record: AgentPrompt = { kind: 'agent', handle: request.handle, tool: target.name, answer: how.answer, cwd: how.cwd, create };
    journal.savePrompt(op, record);

    if (!goesOn(op, following)) return;
    await follow(live, op, record, following);
  }

  /** Records a prompt refused before any agent was created, so a repeated id ends the same, and says why. */
  const refuse = (op: OpId, handle: string, failure: RuntimeFailure): void => {
    journal.savePrompt(op, { kind: 'refused', handle, outcome: { op, state: 'failed', failure } });
    fail(op, failure);
  };

  /** How a step's first line names the Paseo agent the run was started from, once looked up. */
  let parent: Promise<string> | undefined;

  /** A workflow prompt step: an agent in the worktree, in the tool's default mode, that writes teamai's result file. */
  async function work(live: Daemon, request: Extract<RuntimeRequest, { type: 'prompt' }>, place: WorktreePlace): Promise<void> {
    const { op, lease } = request;
    const { tool } = lease;

    if (!isPaseoTool(tool) && !offers.has(tool)) {
      fail(op, { code: 'tool_unavailable', message: `teamai-runtime-paseo runs claude, codex, opencode and the team's instances of them, not ${tool}.` });

      return;
    }

    const unoffered = notOffered(tool, false);
    const target = targets.get(tool);

    if (unoffered || !target) {
      refuse(op, request.handle, unoffered ?? { code: 'tool_unavailable', message: `teamai-runtime-paseo did not offer ${tool}.` });

      return;
    }

    const following = begin(op, request.handle);

    try {
      // Looked up once per process; a stop meanwhile does not wait for it, and the launch then ends the prompt.
      parent ??= startedFrom === undefined ? undefined : parentNamed(live, startedFrom);
      const named = parent && await Promise.race([parent, following.stopped]);
      const origin = named && named !== 'stopped' ? `This agent runs step "${lease.step}" of teamai workflow run ${place.run}, started from the Paseo agent ${named}.` : undefined;
      const brief = [origin, lease.interactive && INTERACTIVE_BRIEF, lease.prompt].filter(Boolean).join('\n\n');

      await launch(live, request, following, target, {
        place, modeId: modeIds.get(tool), prompt: brief, env: { [RUN_DIR_ENV]: place.runDir }, ...(startedFrom && { parent: startedFrom }),
        options: stepGrant(target.tool, lease.result, place.runDir), answer: { kind: 'result-file', file: lease.result, ...(lease.interactive && { interactive: true }) }, cwd: place.cwd,
      });
    } finally {
      following.landed();
    }
  }

  /**
   * Opens a confined prompt's directory as its place's workspace, and journals it there. It is kept with the worktree
   * opens, so a close waits for it and archives the workspace, though the prompt that asked for it was stopped.
   */
  const adopt = (live: Daemon, handle: string, place: ConfinedPlace, dir: string): Promise<Awaited<ReturnType<Daemon['workspace']>> | RuntimeFailure> => {
    const adopting = (async () => {
      try {
        const workspace = await live.workspace(dir);

        // A place the person released meanwhile stays forgotten.
        if (journal.place(handle) !== undefined) journal.savePlace(handle, { ...place, workspace: { id: workspace.id, name: workspace.name } });

        return workspace;
      } catch (error) {
        return { code: 'workspace_failed', message: `Paseo could not open the confined prompt's directory as a workspace: ${error instanceof Error ? error.message : String(error)}` };
      }
    })();

    const settled = adopting.then(() => undefined);
    opens.set(handle, settled);
    void settled.then(() => {
      if (opens.get(handle) === settled) opens.delete(handle);
    });

    return adopting;
  };

  /** A confined prompt: a fresh agent whose cwd is its directory, briefed to read only it, that answers in its last message. */
  async function judge(live: Daemon, request: Extract<RuntimeRequest, { type: 'prompt' }>, confined: ConfinedPrompt, place: ConfinedPlace): Promise<void> {
    const { op, lease } = request;

    if (confined.level !== CONFINED_KEPT.level) {
      refuse(op, request.handle, {
        code: 'confined_level',
        message: `teamai-runtime-paseo keeps a confined prompt best-effort: its agent is briefed to read only ${confined.dir}, and nothing stops it reading elsewhere. It does not run one at ${confined.level}.`,
      });

      return;
    }

    const { tool } = lease;

    if (!isPaseoTool(tool) && !offers.has(tool)) {
      refuse(op, request.handle, { code: 'tool_unavailable', message: `teamai-runtime-paseo runs a confined prompt on claude, codex, opencode or the team's instances of them, not ${tool}.` });

      return;
    }

    const unoffered = notOffered(tool, true);
    const target = targets.get(tool);

    if (unoffered || !target) {
      refuse(op, request.handle, unoffered ?? { code: 'tool_unavailable', message: `teamai-runtime-paseo did not offer ${tool}.` });

      return;
    }

    const following = begin(op, request.handle);

    try {
      let workspace = place.workspace && { ...place.workspace, directory: confined.dir };

      if (!workspace) {
        const adopted = await Promise.race([adopt(live, request.handle, place, confined.dir), following.stopped]);

        if (!goesOn(op, following) || adopted === 'stopped') return;

        if ('code' in adopted) {
          settle(op, { op, state: 'failed', failure: adopted }, following);

          return;
        }

        workspace = adopted;
      }

      await launch(live, request, following, target, {
        place, modeId: CONFINED_MODES[target.tool], prompt: confinedBrief(target.tool, confined, lease.prompt), options: CONFINED_OPTIONS[target.tool],
        answer: { kind: 'reply', kept: CONFINED_KEPT }, cwd: workspace.directory, ...(startedFrom && { parent: startedFrom }),
      });
    } finally {
      following.landed();
    }
  }

  async function prompt(live: Daemon, request: Extract<RuntimeRequest, { type: 'prompt' }>): Promise<void> {
    const { op } = request;
    const known = journal.prompt(op);

    // A repeated id: the same acceptance, then the outcome it ended with, or a reconnect to its agent.
    if (known?.kind === 'refused') {
      send(op, known.outcome);

      return;
    }

    if (known?.outcome || (known && waiting.has(op))) {
      accept(op, known, live, { exists: Boolean(known.outcome) || waiting.get(op)?.created === true });

      if (known.outcome) send(op, known.outcome);

      return;
    }

    if (known?.kind === 'agent') {
      const following = track(op);
      accept(op, known, live, { exists: false });
      await follow(live, op, known, following);

      return;
    }

    // New, or pending in a runtime that died before it sent a create: launched from the start.
    const place = journal.place(request.handle);
    const { confined } = request;

    if (confined && place?.kind === 'confined') {
      await judge(live, request, confined, place);

      return;
    }

    if (!confined && place?.kind === 'worktree' && place.workspace) {
      await work(live, request, { ...place, workspace: place.workspace });

      return;
    }

    fail(op, {
      code: 'unknown_handle',
      message: confined
        ? `teamai-runtime-paseo has no confined prompt's place ${request.handle}; open the attempt with no view first.`
        : `teamai-runtime-paseo has no worktree place ${request.handle} that Paseo opened; open the attempt on its worktree first.`,
    });
  }

  /** Makes sure the prompt's agent exists, then waits for it to end, and settles the prompt. */
  async function follow(live: Daemon, op: OpId, record: AgentPrompt, following: Following): Promise<void> {
    const { create } = record;
    const { stopped } = following;

    try {
      // The agent of a repeated prompt is found by its id; a create a runtime died before sending is sent again. A lookup
      // that fails throws: an earlier runtime may have created the agent.
      let creation: Creation = { outcome: 'created' };

      if (!(await live.agent(create.agentId))) {
        // Journaled before it is sent, and kept until Paseo shows the agent: a create that failed may still start it.
        dispatch(op, 'unconfirmed');
        creation = await live.create(record.cwd, create);
      }

      // Only a create never sent, by this process or an earlier one, proves no agent started.
      if (creation.outcome === 'unsent' && record.dispatched === undefined) {
        dispatch(op, undefined);
        settle(op, { op, state: 'failed', failure: { code: 'agent_create_failed', message: `Paseo could not create the ${record.tool} agent: ${creation.cause}` } }, following);

        return;
      }

      // Paseo may have created the agent though the create failed, as when its answer was lost: one it shows is followed,
      // and one it does not show may still start.
      if (creation.outcome !== 'created' && !(await live.agent(create.agentId).catch(() => null))) {
        settle(op, {
          op, state: 'failed',
          failure: { code: CANCEL_FAILED, message: `Paseo could not create the ${record.tool} agent ${create.agentId} (${creation.cause}), and does not show it, though it may still start. It may still run in the worktree; stop it in the Paseo app.` },
        }, following);

        return;
      }

      dispatch(op, 'confirmed');
      following.created = true;
    } finally {
      following.landed();
    }

    const display = shownOf(record, live);

    if (display) write({ op, event: 'display', display });

    // A cancel that came to a runtime since killed is sent now that the agent exists; one this process reads stops it itself.
    if (journal.isCancelled(op) && !stopping.has(op)) {
      const refused = await cancelAgent(live, record);
      settle(op, refused ? { op, state: 'failed', failure: refused } : { op, state: 'cancelled' }, following);

      return;
    }

    for (;;) {
      // teamai went away, or a cancel took the prompt over and ended it.
      if (closing || waiting.get(op) !== following) return;

      if (closeStops.has(op)) {
        await Promise.race([delay(STOP_POLL_MS), stopped]);
        continue;
      }

      // Whoever runs the stop settles the prompt once it is confirmed or refused: this process, or another one, such as
      // a recover-mode cancel, whose outcome this one waits to read. A cancel marker alone proves nothing stopped.
      if (journal.isCancelled(op)) {
        if (stopping.has(op)) return;
        const ended = journal.prompt(op);

        if (ended?.kind === 'agent' && ended.outcome) {
          settle(op, ended.outcome, following);

          return;
        }

        await Promise.race([delay(STOP_POLL_MS), stopped]);
        continue;
      }

      const end = await Promise.race([live.wait(create.agentId).catch(() => ({ dropped: true })), stopped]);

      if (end === 'stopped') continue;

      if ('dropped' in end) {
        await delay(RECONNECT_MS);
        continue;
      }

      if (journal.isCancelled(op) || closeStops.has(op)) continue;

      switch (end.status) {
        case 'timeout':
          continue;
        case 'permission': {
          const asked = end.final?.pendingPermissions[0];
          const inMode = create.config.modeId === undefined ? 'in the mode Paseo starts it in' : `in Paseo mode ${create.config.modeId}`;

          if (record.answer.kind === 'reply') {
            const refused = await cancelAgent(live, record);
            settle(op, {
              op, state: 'failed',
              failure: {
                // A stop that is not confirmed is the one failure whose agent may still run.
                code: refused ? 'cancel_failed' : 'tool_failed',
                message: `The ${record.tool} agent asked for permission${asked ? ` (${asked.title ?? asked.name})` : ''} ${inMode}. A confined prompt only reads its directory, so it ends rather than ask.${refused ? ` ${refused.message}` : ''}`,
              },
            }, following);

            return;
          }

          if (mode === 'attended') {
            // A person answers it in the Paseo app; the turn goes on once they do.
            await Promise.race([delay(PERMISSION_POLL_MS), stopped]);
            continue;
          }

          const refused = await cancelAgent(live, record);
          settle(op, {
            op, state: 'failed',
            failure: {
              code: refused ? 'cancel_failed' : 'tool_failed',
              message: `The ${record.tool} agent asked for permission${asked ? ` (${asked.title ?? asked.name})` : ''} ${inMode}, which asks before it runs what it does not allow, and an unattended run has nobody to answer. Run the workflow attended to answer it in the Paseo app, or run this step on a runtime that offers unattended.${refused ? ` ${refused.message}` : ''}`,
            },
          }, following);

          return;
        }

        case 'error':
          settle(op, { op, state: 'failed', failure: usageLimited(record.tool, end.error) ?? { code: 'tool_failed', message: `The ${record.tool} agent failed in Paseo: ${end.error ?? 'no error given'}` } }, following);

          return;
        case 'idle': {
          const session = end.final?.runtimeInfo?.sessionId;

          if (record.answer.kind === 'reply') {
            const output = parseReply(end.lastMessage);

            if (end.final?.status === 'closed' && output === undefined) {
              settle(op, {
                op, state: 'failed',
                failure: { code: 'daemon_restarted', message: `The Paseo daemon at ${live.url} stopped while the ${record.tool} agent answered the confined prompt, before it replied.` },
              }, following);

              return;
            }

            if (output === undefined) {
              settle(op, { op, state: 'failed', failure: usageLimitedReply(record.tool, end.lastMessage) ?? { code: 'tool_failed', message: `The ${record.tool} agent replied with no JSON value.` } }, following);

              return;
            }

            if (!session) {
              settle(op, { op, state: 'failed', failure: noSession(record.tool) }, following);

              return;
            }

            settle(op, { op, state: 'finished', session: sessionOf(live, { tool: record.tool, id: session, createdAt: end.final?.createdAt }), result: { output }, confined: record.answer.kept }, following);

            return;
          }

          const result = readResult(record.answer.file);

          if (end.final?.status === 'closed' && !result) {
            settle(op, {
              op, state: 'failed',
              failure: { code: 'daemon_restarted', message: `The Paseo daemon at ${live.url} stopped while the ${record.tool} agent worked, before it wrote a workflow result. Its work is kept in the worktree.` },
            }, following);

            return;
          }

          // An interactive step ends once the person said it is done and the agent wrote the result; until then the agent
          // idles between their turns. A result file it wrote that is not a workflow result fails the step, as any step.
          if (!result && record.answer.interactive && !fs.existsSync(record.answer.file)) {
            await Promise.race([delay(IDLE_POLL_MS), stopped]);
            continue;
          }

          if (!result) {
            // A tool that stopped on its usage limit says so in its last message, and writes no result.
            settle(op, { op, state: 'failed', failure: usageLimitedReply(record.tool, end.lastMessage) ?? { code: 'tool_failed', message: `${record.tool} did not write a valid workflow result` } }, following);

            return;
          }

          if (!session) {
            settle(op, { op, state: 'failed', failure: noSession(record.tool) }, following);

            return;
          }

          settle(op, { op, state: 'finished', session: sessionOf(live, { tool: record.tool, id: session, createdAt: end.final?.createdAt }), result }, following);

          return;
        }

        default: {
          const unhandled: never = end.status;
          throw new Error(`Unknown wait status ${String(unhandled)}`);
        }
      }
    }
  }

  async function cancel(op: OpId): Promise<void> {
    const deadline = Date.now() + STOP_SETTLE_MS;
    // A prompt that already ended, as one whose end teamai lost, answers that end again and stops nothing. Only a stop that
    // failed is tried again; until it is confirmed or fails again, reattach reports the prompt running.
    const unrecorded = unkept.get(op);

    if (unrecorded) {
      send(op, unrecorded);

      return;
    }

    const found = journal.prompt(op);

    if (!found) return;
    const { outcome } = found;

    if (found.kind === 'refused' || (outcome && !isFailedStop(outcome))) {
      if (outcome) send(op, outcome);

      return;
    }

    if (outcome) journal.savePrompt(op, { ...found, outcome: undefined });
    journal.cancel(op);
    const following = waiting.get(op);
    const endsBefore = ends.get(op) ?? 0;
    stopping.add(op);

    try {
      // A prompt that has not sent its create sees the cancel, and sends none. One whose agent is still being created is
      // stopped once it exists, within the same deadline: past it, the agent may still start.
      following?.stop();
      const creating = creates.get(op);
      const joined = creating && (await Promise.race([creating, late(deadline)]));
      const record = journal.prompt(op);

      // It ended meanwhile: a create Paseo refused, or a prompt that saw the cancel before it sent a create.
      if (!record || record.kind === 'refused' || record.outcome) return;

      // No create was sent, and none will be: whoever launches it reads the cancel after it journals the agent.
      if (record.kind === 'pending') {
        settle(op, { op, state: 'cancelled' });

        return;
      }

      if (joined === 'late') {
        settle(op, {
          op, state: 'failed',
          failure: { code: CANCEL_FAILED, message: `Paseo did not finish creating the ${record.tool} agent ${record.create.agentId} within ${STOP_SETTLE_MS / 1000} s, so it may still start in the worktree; cancel the run again.` },
        });

        return;
      }

      const live = await reachBy(deadline);

      const refused = live && !('code' in live)
        ? await cancelAgent(live, record, deadline)
        : { ...withoutDaemon(live, `cancel the ${record.tool} agent ${record.create.agentId}, which may still run in the worktree`, 'cancel the run again'), code: 'cancel_failed' };

      settle(op, refused ? { op, state: 'failed', failure: refused } : { op, state: 'cancelled' });
    } finally {
      stopping.delete(op);
      // Another process recorded its end while this one cancelled it, as the runtime a prompt was resent to does when it
      // sees the agent stop: this cancel answers with that end, since teamai waits for one, and the follow here sends none.
      const recorded = (ends.get(op) ?? 0) === endsBefore ? journal.prompt(op) : undefined;

      if (recorded && recorded.kind !== 'refused' && recorded.outcome) {
        waiting.delete(op);
        send(op, recorded.outcome);
      }
    }

    following?.stop();
  }

  /** Cancels a prompt's agent that is still running, or says why it may still run; one already stopped needs nothing. */
  const stopAgent = async (live: Daemon, record: AgentPrompt, deadline: number): Promise<RuntimeFailure | undefined> => {
    if (isStopped(await Promise.race([live.agent(record.create.agentId).catch(() => undefined), late(deadline)]))) return undefined;

    return cancelAgent(live, record, deadline);
  };

  /**
   * Stops what an attempt's place runs, its failed prompts' agents included, since a failed cancel leaves its agent
   * running, or says why something may still run. The last attempt on a Paseo workspace archives it, which stops what
   * still runs there; an attempt that shares it stops only its own agents, as does one on a workspace the member had
   * open, which teamai never archives.
   */
  async function stopPlace(live: Daemon, handle: string, place: Place, deadline: number): Promise<RuntimeFailure | undefined> {
    // A confined prompt's place before its prompt came: no workspace, so no agent.
    if (!place.workspace) return undefined;
    const agents = journal.promptsOf(handle).flatMap(({ record }) => (record.kind === 'agent' ? [record] : []));

    /** Stops this handle's agents and leaves the workspace open, for another handle or the member who works there too. */
    const stopOwn = async (): Promise<RuntimeFailure | undefined> => {
      const refusals = (await Promise.all(agents.map((record) => stopAgent(live, record, deadline)))).flatMap((failure) => (failure ? [failure.message] : []));

      return refusals.length > 0 ? { code: 'close_failed', message: refusals.join(' ') } : undefined;
    };

    if ((place.kind === 'worktree' && place.member) || !journal.handlesIn({ id: place.workspace.id, ...(place.kind === 'worktree' && { directory: place.cwd }) }).every((other) => other === handle)) return stopOwn();

    const { id: workspaceId, name } = place.workspace;

    // The member may work there too, as when they open the same directory in the app, which answers this workspace: an
    // archive would stop their agents, so the close stops only its own and leaves the workspace to them.
    const listing = (async (): Promise<{ ids: string[] } | { unlisted: string }> => {
      try {
        return { ids: await live.memberAgentsIn(workspaceId) };
      } catch (error) {
        return { unlisted: error instanceof Error ? error.message : String(error) };
      }
    })();

    const listed = await Promise.race([listing, late(deadline)]);

    if (listed === 'late' || 'unlisted' in listed) {
      const why = listed === 'late' ? `did not answer within ${STOP_SETTLE_MS / 1000} s` : `failed: ${listed.unlisted}`;

      return { code: 'close_failed', message: `Paseo's list of the agents in workspace ${name} (${workspaceId}) ${why}, so teamai cannot tell whether the member works there, and archived nothing. Close the step again; if it still fails, archive the workspace in the Paseo app.` };
    }

    if (listed.ids.length > 0) return stopOwn();

    const archiving = (async (): Promise<{ refused?: string }> => {
      try {
        await live.archive(workspaceId);

        return {};
      } catch (error) {
        return { refused: error instanceof Error ? error.message : String(error) };
      }
    })();

    const archived = await Promise.race([archiving, late(deadline)]);

    if (archived === 'late') {
      return { code: 'close_failed', message: `Paseo did not answer the archive of workspace ${name} (${workspaceId}) within ${STOP_SETTLE_MS / 1000} s. Its agents may still run; archive it in the Paseo app.` };
    }

    if (archived.refused !== undefined) {
      return { code: 'close_failed', message: `Paseo did not archive workspace ${name} (${workspaceId}): ${archived.refused}. Its agents may still run; archive it in the Paseo app.` };
    }

    const running = (await Promise.all(agents.map(async ({ create: { agentId } }) => ((await isStillRunning(live, agentId, deadline)) ? [agentId] : [])))).flat();

    if (running.length === 0) return undefined;

    return {
      code: 'close_failed',
      message: `Paseo archived workspace ${place.workspace.name} (${place.workspace.id}), but agent ${running.join(', ')} still ran ${STOP_SETTLE_MS / 1000} s later. It may still change the worktree; stop it in the Paseo app.`,
    };
  }

  /**
   * Why a close keeps a place: a create it sent that Paseo has not shown the agent of, as when the create failed, may still
   * start that agent. A lookup that finds the agent confirms it, so the close stops it; one that finds none, fails or
   * comes late proves nothing. Only the person can tell a create Paseo refused, so the failure names how to release the attempt.
   */
  const unseen = async (live: Daemon, handle: string, place: Place, deadline: number): Promise<RuntimeFailure | undefined> => {
    const sent = journal.promptsOf(handle).flatMap(({ op, record }) => (record.kind === 'agent' && record.dispatched === 'unconfirmed' ? [{ op, record }] : []));

    const missing = (await Promise.all(sent.map(async ({ op, record }) => {
      const agent = await Promise.race([live.agent(record.create.agentId).catch(() => undefined), late(deadline)]);

      if (!agent || agent === 'late') return [record];
      dispatch(op, 'confirmed');

      return [];
    }))).flat();

    if (missing.length === 0) return undefined;

    return {
      code: 'close_failed',
      message: missing.map((record) => [
        `Paseo does not show the ${record.tool} agent ${record.create.agentId} yet, though its create was sent, so it may still start in the worktree.`,
        `Once it appears, run teamai workflow cancel ${place.run} again, which stops it.`,
        `If it never appears in Paseo, the create was refused: check that nothing of the attempt runs in the worktree, then run teamai workflow cancel ${place.run} --release ${place.attempt}.`,
      ].join(' ')).join(' '),
    };
  };

  /** Forgets a place the person released though its close failed: its prompts' follows stop, and its record goes. */
  function forgetReleased(handle: string): void {
    for (const { op } of journal.promptsOf(handle)) {
      const following = waiting.get(op);
      waiting.delete(op);
      following?.stop();
    }

    journal.forget(handle);
  }

  /**
   * Ends an attempt's place once nothing it started runs. A place whose agent may still run is kept, so teamai can close
   * it again: one the runtime cannot stop, or any place while it reaches no daemon, as after a restart whose init failed.
   * A place the person released (`release`) is forgotten either way, so it no longer counts on its workspace or directory.
   */
  async function closePlace(handle: string, { release }: { release: boolean }): Promise<void> {
    // Its agents' prompts are the close's to end, once their agents stopped; a close that fails leaves them to their wait.
    const stops = journal.promptsOf(handle).flatMap(({ op, record }) => (record.kind === 'agent' && !record.outcome && !closeStops.has(op) ? [op] : []));

    for (const op of stops) closeStops.add(op);

    try {
      await stopAndForget(handle, { release });
    } finally {
      for (const op of stops) closeStops.delete(op);
    }
  }

  /** `closePlace`, once the prompts whose agents it stops are its own to end. */
  async function stopAndForget(handle: string, { release }: { release: boolean }): Promise<void> {
    const deadline = Date.now() + STOP_SETTLE_MS;
    const prompts = journal.promptsOf(handle);

    const closeFailed = (failure: RuntimeFailure): void => {
      if (release) forgetReleased(handle);
      write({ event: 'close_failed', handle, failure });
    };

    // A prompt that has not sent its create yet ends cancelled, and never sends it: the place it would run in closes.
    for (const { op, record } of prompts) {
      if (record.kind === 'pending' && !record.outcome) {
        journal.cancel(op);
        waiting.get(op)?.stop();
      }
    }

    const opening = opens.get(handle);

    // A place whose worktree, or judge's directory, Paseo is still opening is closed once its workspace is known, so the
    // workspace is archived.
    if (opening && (await Promise.race([opening, late(deadline)])) === 'late') {
      closeFailed({ code: 'close_failed', message: `Paseo did not open the worktree of ${handle} as a workspace within ${STOP_SETTLE_MS / 1000} s; close the attempt again.` });

      return;
    }

    // A prompt is accepted before Paseo creates its agent: the close waits until none can still send a create, so one
    // being created is stopped once it exists.
    const creating = prompts.flatMap(({ op }) => creates.get(op) ?? []);

    if (creating.length > 0 && (await Promise.race([Promise.all(creating), late(deadline)])) === 'late') {
      closeFailed({ code: 'close_failed', message: `Paseo did not finish creating an agent of ${handle} within ${STOP_SETTLE_MS / 1000} s, so it may still start in the worktree; close the attempt again.` });

      return;
    }

    const place = journal.place(handle);
    // A place with no Paseo workspace has no agent to stop: it closes without the daemon.
    const live = place?.workspace && (await reachBy(deadline));

    const failure = place?.workspace && (live && !('code' in live)
      ? (await unseen(live, handle, place, deadline)) ?? (await stopPlace(live, handle, place, deadline))
      : withoutDaemon(live, `stop the agents of ${handle} or archive its workspace`, 'close the attempt again'));

    if (failure) {
      closeFailed(failure);

      return;
    }

    // Its agents stopped: a prompt that has not ended ends cancelled, once, before its record goes. One this process
    // already ended, and no request of which is still answered, was ended by a failure its record could not keep.
    for (const { op, record } of journal.promptsOf(handle)) {
      if (record.outcome || ((ends.get(op) ?? 0) > 0 && !inFlight.has(op))) continue;
      const following = waiting.get(op);
      settle(op, { op, state: 'cancelled' });
      following?.stop();
    }

    journal.forget(handle);
    write({ event: 'closed', handle });
  }

  async function answer(request: RuntimeRequest): Promise<void> {
    if (request.type === 'init') {
      await init(request);

      return;
    }

    const live = daemon;

    // What teamai asks to stop a place is answered without a daemon from init too, in recover mode or after an init that
    // could not reach one: reattach and collect from the journal, and a cancel or close reaches the daemon only to stop.
    switch (request.type) {
      case 'collect':
        // The worktree and the result directory already sit on this host, and the transcript stays in the tool's home.
        write({ event: 'collected', handle: request.handle });

        return;
      case 'reattach': {
        // From the journal alone: gone only when it records no place, and a record it cannot read throws, never gone.
        if (!journal.place(request.handle)) {
          write({ event: 'gone', handle: request.handle });

          return;
        }

        const ops = journal.promptsOf(request.handle).map(({ op, record }): OpState => record.outcome ?? unkept.get(op) ?? { op, state: 'running' });
        const display = live && displayOf(request.handle, live);
        write({ event: 'alive', handle: request.handle, ops, ...(display && { display }) });

        return;
      }

      case 'close':
        await closePlace(request.handle, { release: request.release === true });

        return;
      case 'cancel':
        await cancel(request.op);

        return;
      default:
        break;
    }

    // A recover-mode process may have reached the daemon for a stop, and still takes no new work.
    if (!live || recoverAt !== undefined) {
      fail(request.op, {
        code: 'not_started',
        message: recoverAt === undefined
          ? `teamai-runtime-paseo got ${request.type} before a successful init.`
          : `teamai-runtime-paseo opened in recover mode only stops what it ran: it got ${request.type}.`,
      });

      return;
    }

    switch (request.type) {
      case 'open':
        await open(live, request);

        return;
      case 'exec':
        fail(request.op, { code: 'exec_unsupported', message: 'teamai-runtime-paseo runs no command (can.exec is false): a command step goes to the next runtime in the definition.' });

        return;
      case 'prompt':
        await prompt(live, request);

        return;
      default: {
        const unhandled: never = request;
        throw new Error(`Unknown request ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /** The agent a prompt journaled, named for a person, or undefined when it journaled none; one that cannot be read may exist. */
  const agentNamed = (op: OpId): string | undefined => {
    try {
      const record = journal.prompt(op);

      return record?.kind === 'agent' ? `The ${record.tool} agent ${record.create.agentId}` : undefined;
    } catch {
      return 'Its agent';
    }
  };

  /** The outcomes this process sent but could not record, until a later prompt or cancel of the op: a reattach here reports them. */
  const unkept = new Map<OpId, OpState>();

  /**
   * Records the outcome a failed prompt or cancel request sends, so a reattach or a repeated prompt reports it, when the
   * prompt's record can still be read and written. One that cannot is only sent, once, and only a reattach in this
   * process reports it.
   */
  const keep = (op: OpId, outcome: OpState): void => {
    try {
      const record = journal.prompt(op);

      if (record && record.kind !== 'refused' && !record.outcome) journal.savePrompt(op, { ...record, outcome });
    } catch {
      unkept.set(op, outcome);
    }
  };

  /** The ops of the requests this process is answering, each with how many. */
  const inFlight = new Map<OpId, number>();

  /** Whether `op` is one this runtime runs or ran: an answer of its own would end it a second time. One it cannot tell is. */
  const holdsOp = (op: OpId): boolean => {
    if (inFlight.has(op) || creates.has(op)) return true;

    try {
      return journal.prompt(op) !== undefined;
    } catch {
      return true;
    }
  };

  /** Whether `handle` is a place this runtime holds or is opening. One it cannot tell is. */
  const holdsHandle = (handle: string): boolean => {
    if (opens.has(handle)) return true;

    try {
      return journal.place(handle) !== undefined;
    } catch {
      return true;
    }
  };

  /**
   * Answers a request line it cannot read: on its own op or handle when this runtime holds neither, so no other request
   * fails. One it holds already has its answer coming, and a failure would end it twice, so that line is dropped with a
   * note on stderr. A line that names neither gets the error line, the only answer it can have.
   */
  const unreadable = (line: string, reason: string): void => {
    let named: z.infer<typeof NamedSchema> = { type: 'request' };

    try {
      named = NamedSchema.catch({ type: 'request' }).parse(JSON.parse(line));
    } catch {
      // Not JSON: it names nothing.
    }

    const { type, op, handle } = named;
    const subject = op ?? handle;

    if (subject === undefined) {
      write({ event: 'error', message: `teamai-runtime-paseo could not read a request: ${reason}` });

      return;
    }

    if (op ? holdsOp(op) : handle !== undefined && holdsHandle(handle)) {
      note(`teamai-runtime-paseo dropped a ${type} request it could not read for ${subject}, which it already holds, so as not to answer it twice: ${reason}`);

      return;
    }

    const failure = { code: 'bad_request', message: `teamai-runtime-paseo could not read the ${type} request for ${subject}: ${reason}` };

    if (op) fail(op, failure);
    else if (handle !== undefined) write({ event: 'failed', handle, failure });
  };

  const lines = readline.createInterface({ input });

  lines.on('line', (line) => {
    let request: RuntimeRequest;

    try {
      request = RuntimeRequestSchema.parse(JSON.parse(line));
    } catch (error) {
      unreadable(line, error instanceof Error ? error.message : String(error));

      return;
    }

    const endsBefore = 'op' in request ? (ends.get(request.op) ?? 0) : 0;

    if ('op' in request) inFlight.set(request.op, (inFlight.get(request.op) ?? 0) + 1);

    // A prompt sent again, or a cancel that tries a failed stop again, may end the op otherwise, so the outcome it could
    // not record is no longer its state. A cancel of any other end answers that end.
    if (request.type === 'prompt' || (request.type === 'cancel' && isFailedStop(unkept.get(request.op)))) unkept.delete(request.op);

    const answered = (async () => {
      try {
        await answer(request);
      } catch (error) {
        const message = `Paseo failed: ${error instanceof Error ? error.message : String(error)}`;

        // Each request gets its own failure, since an error line would fail every request teamai is waiting on. A prompt
        // whose agent exists, or may, ends as an unconfirmed stop, since the agent may still run. A close that failed
        // keeps its place.
        if (request.type === 'prompt' || request.type === 'cancel') {
          // Ended meanwhile, by this request or another: a second line would end it twice.
          if ((ends.get(request.op) ?? 0) !== endsBefore) return;
          // This line is the op's one end: its follow, taken from `waiting`, ends nothing after it.
          const following = waiting.get(request.op);
          waiting.delete(request.op);
          following?.stop();
          const agent = agentNamed(request.op);
          const failure = agent ? { code: CANCEL_FAILED, message: `${message.replace(/\.$/, '')}. ${agent} may still run in the worktree; stop it in the Paseo app.` } : { code: 'paseo_failed', message };

          keep(request.op, { op: request.op, state: 'failed', failure });
          fail(request.op, failure);
        } else if ('op' in request) fail(request.op, { code: 'paseo_failed', message });
        else if (request.type === 'close') {
          // A released place is forgotten though its close failed; a journal that cannot remove it is named.
          let kept = '';

          try {
            if (request.release) forgetReleased(request.handle);
          } catch (forgetting) {
            kept = ` teamai-runtime-paseo could not forget the released attempt either (${forgetting instanceof Error ? forgetting.message : String(forgetting)}); make ${journal.root} readable and writable, then release it again.`;
          }

          write({ event: 'close_failed', handle: request.handle, failure: { code: 'paseo_failed', message: `${message}${kept}` } });
        }
        else if (request.type === 'init') write({ type: 'init', ok: false, error: { code: 'paseo_failed', message } });
        else write({ event: 'failed', handle: request.handle, failure: { code: 'paseo_failed', message } });
      }
    })();

    answering.add(answered);
    void answered.finally(() => {
      answering.delete(answered);

      if (!('op' in request)) return;
      const left = (inFlight.get(request.op) ?? 1) - 1;

      if (left > 0) inFlight.set(request.op, left);
      else inFlight.delete(request.op);
    });
  });

  // teamai is gone once stdin ends: the requests in flight get their answers, and an agent goes on in Paseo, which keeps
  // how it ended for the next reattach.
  return new Promise((resolve) => {
    lines.on('close', () => {
      closing = true;

      for (const following of waiting.values()) following.stop();
      void Promise.allSettled(answering).then(async () => {
        await daemon?.close();
        resolve();
      });
    });
  });
}
