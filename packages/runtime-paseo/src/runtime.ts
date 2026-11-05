import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import {
  PromptResultSchema, RUN_DIR_ENV, RuntimeRequestSchema, type ConfinedKept, type ConfinedPrompt, type OpId, type OpState, type PromptResult, type RuntimeDisplay,
  type RuntimeFailure, type RuntimeMessage, type RuntimeRequest,
} from '@teamai/runtime-protocol';
import { z } from 'zod';
import { loadClient } from './client.js';
import { CONFINED_MODES, CONFINED_OPTIONS, connect, DEFAULT_MODES, isPaseoTool, type Daemon, type PaseoTool } from './daemon.js';
import type { AgentCreate, AgentPrompt, Journal, Place } from './journal.js';

type WorktreePlace = Extract<Place, { kind: 'worktree' }>;

type ConfinedPlace = Extract<Place, { kind: 'confined' }>;

// ─── teamai-runtime-paseo ────────────────────────────────
//
//  A prompt-only step runtime: each prompt step becomes an agent of a Paseo daemon, in a Paseo workspace that adopts
//  teamai's worktree, so a person sees and steers it in Paseo. It runs no command (`can.exec: false`): command steps
//  and setup go to the next runtime in the definition. teamai keeps the result file, the commit, the push and scoring.
//
//    open      workspaces.open(worktree), once per attempt            handle: <workspace id>/<attempt>
//    prompt    agents.create({ agentId: uuid(op), idempotencyKey: op, tool's default mode, teamai's prompt })
//              then wait: idle → the result file and the tool's session id, permission → a person answers it in the
//              app (attended) or the step fails naming the mode (unattended), closed without a result → the daemon
//              restarted, and the attempt fails with its work kept
//    cancel    recorded first, then the agent is cancelled: Paseo reports a cancelled agent as idle
//    confined  a judge: a fresh agent whose cwd is the prompt's directory, briefed to read only it, in a mode that asks
//              before it edits or runs anything; any request for permission ends it. Its answer is its last message,
//              reported best-effort: nothing stops a read outside the directory
//

const OptionsSchema = z.object({
  /** The daemon's WebSocket address. */
  url: z.string().regex(/^wss?:\/\/\S+$/, 'The Paseo url is a ws:// or wss:// address, such as ws://127.0.0.1:6767/ws').default('ws://127.0.0.1:6767/ws'),
}).strict();

/** How long an attended step waits between looks at a permission request a person has not answered yet. */
const PERMISSION_POLL_MS = 1000;

/** How long a wait the daemon dropped, as a restart does, waits before it asks again. */
const RECONNECT_MS = 500;

/** How long an agent may go on running once Paseo answered the cancel or archive that stops it: Paseo forces a stop after 2 s. */
const STOP_SETTLE_MS = 10_000;

/** How often a stopping agent is looked at. */
const STOP_POLL_MS = 250;

/** Whether an agent is stopped: gone, or no longer running. A lookup that failed (undefined) does not count as stopped. */
const isStopped = (agent: Awaited<ReturnType<Daemon['agent']>> | undefined): boolean => agent === null || (agent !== undefined && agent.status !== 'running' && agent.status !== 'initializing');

/**
 * Whether the agent still runs `STOP_SETTLE_MS` after Paseo answered what stops it. Paseo may answer before the agent's
 * turn ends, so the work counts as stopped only once Paseo reports the agent no longer running, or gone.
 */
async function isStillRunning(live: Daemon, agentId: string): Promise<boolean> {
  const deadline = Date.now() + STOP_SETTLE_MS;

  for (;;) {
    if (isStopped(await live.agent(agentId).catch(() => undefined))) return false;

    if (Date.now() >= deadline) return true;
    await delay(STOP_POLL_MS);
  }
}

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
 * worktree, so the result file's directory and the run directory are added to it. OpenCode gets no grant.
 */
function stepGrant(tool: PaseoTool, result: string, runDir: string): AgentCreate['config']['options'] {
  switch (tool) {
    case 'claude':
      return { allowedTools: [`Edit(/${result})`, `Edit(/${runDir}/**)`] };

    case 'codex':
      return { sandbox_workspace_write: { writable_roots: [path.dirname(result), runDir] } };

    case 'opencode':
      return undefined;

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

export interface Serving {
  input: Readable;
  write(message: RuntimeMessage): void;
  journal: Journal;
}

/** What init offered of an installed tool: its steps and judges, its steps only, or nothing, with why not. */
type Offer = { runs: 'steps-and-judges' } | { runs: 'steps'; noJudge: string } | { runs: 'nothing'; reason: string };

export function serve({ input, write, journal }: Serving): Promise<void> {
  let daemon: Daemon | undefined;
  let mode: 'attended' | 'unattended' = 'attended';
  /** In recover mode, the daemon's url: the runtime connects to it only once a cancel or close needs it. */
  let recoverAt: string | undefined;
  /** The connection a recover-mode cancel or close is making, which the next one shares. */
  let reaching: Promise<Daemon | RuntimeFailure> | undefined;

  /**
   * The daemon a cancel or close needs: the one init connected to, or, in recover mode, one connected on first need, so
   * a daemon that is down or a tool signed out since never keeps teamai from stopping what it ran. Undefined: init did
   * not connect to one.
   */
  const reach = (): Promise<Daemon | RuntimeFailure | undefined> => {
    if (daemon) return Promise.resolve(daemon);
    const url = recoverAt;

    if (url === undefined) return Promise.resolve(undefined);

    reaching ??= (async () => {
      const client = await loadClient(process.env);
      const connected = 'code' in client ? client : await connect(url, client);

      if ('code' in connected) reaching = undefined;
      else daemon = connected;

      return connected;
    })();

    return reaching;
  };

  /** What init offered of each tool the daemon has installed. */
  let offers = new Map<PaseoTool, Offer>();

  /**
   * Why a new step or judge on `tool` is refused, or undefined when init offered it. teamai holds a step whose `tool` was
   * not offered, but not one that takes its tool from the definition's default, so the runtime refuses it here too.
   */
  const notOffered = (tool: PaseoTool, isJudge: boolean): RuntimeFailure | undefined => {
    const offer = offers.get(tool) ?? { runs: 'nothing', reason: 'the daemon has not installed it' };
    const reason = offer.runs === 'nothing' ? offer.reason : offer.runs === 'steps' && isJudge ? offer.noJudge : undefined;

    return reason === undefined ? undefined : { code: 'tool_unavailable', message: `teamai-runtime-paseo did not offer ${tool}: ${reason}.` };
  };

  /** The prompts this process follows, each with what stops its wait when teamai cancels it, once its agent exists. */
  const waiting = new Map<OpId, { stop: () => void; created: boolean }>();
  /** The requests this process is answering. */
  const answering = new Set<Promise<void>>();
  /** teamai closed stdin: a prompt's agent goes on in Paseo, and this process stops following it. */
  let closing = false;

  const fail = (op: OpId, failure: RuntimeFailure): void => write({ op, event: 'failed', failure });

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

  /** Records how a prompt ended and tells teamai, once. */
  const settle = (op: OpId, outcome: OpState): void => {
    const record = journal.prompt(op);

    if (record?.kind !== 'agent' || record.outcome) return;
    journal.savePrompt(op, { ...record, outcome });
    waiting.delete(op);
    send(op, outcome);
  };

  /** Cancels a prompt's agent in Paseo, or says why Paseo did not, since the agent may then still change the worktree. */
  const cancelAgent = async (live: Daemon, record: AgentPrompt): Promise<RuntimeFailure | undefined> => {
    try {
      await live.cancel(record.create.agentId);
    } catch (error) {
      return {
        code: 'cancel_failed',
        message: `Paseo did not cancel the ${record.tool} agent ${record.create.agentId}: ${error instanceof Error ? error.message : String(error)}. It may still run in the worktree; stop it in the Paseo app.`,
      };
    }

    if (!(await isStillRunning(live, record.create.agentId))) return undefined;

    return {
      code: 'cancel_failed',
      message: `Paseo cancelled the ${record.tool} agent ${record.create.agentId}, but it still ran ${STOP_SETTLE_MS / 1000} s later. It may still change the worktree; stop it in the Paseo app.`,
    };
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

    return { label: `Paseo workspace ${place.workspace.name}`.slice(0, 80), fields: { workspace: place.workspace.id, daemon: `Paseo ${live.version}` } };
  };

  /** Why a stop cannot be done with no daemon: its connection's own failure, or, with none, that no daemon is reached. */
  const withoutDaemon = (failure: RuntimeFailure | undefined, cannot: string, then: string): RuntimeFailure => (failure
    ? { code: failure.code, message: `${failure.message} Until then teamai-runtime-paseo cannot ${cannot}; ${then}.` }
    : { code: 'daemon_unreachable', message: `teamai-runtime-paseo reaches no Paseo daemon, so it cannot ${cannot}. Start the daemon with \`paseo start\`, then ${then}.` });

  /** Accepts a prompt whose agent exists, showing that agent. */
  const accept = (op: OpId, record: AgentPrompt, live: Daemon): void => {
    const place = journal.place(record.handle);
    write({ op, event: 'accepted', ...(place && { display: agentDisplay(record, place.workspace?.id, live) }) });
  };

  async function init(request: Extract<RuntimeRequest, { type: 'init' }>): Promise<void> {
    const options = OptionsSchema.safeParse(request.options);

    if (!options.success) {
      const issue = options.error.issues[0];
      const key = issue?.code === 'unrecognized_keys' ? issue.keys[0] : issue?.path[0];
      write({ type: 'init', ok: false, error: { code: 'bad_option', message: `teamai-runtime-paseo takes option url only: ${issue?.message ?? 'bad options'}`, ...(key !== undefined && { key: String(key) }) } });

      return;
    }

    if (request.mode === 'recover') {
      // Only to stop what it ran: no sign-in or tool check, and no connection until a cancel or close needs one.
      recoverAt = options.data.url;
      write({ type: 'init', ok: true, can: {} });

      return;
    }

    const client = await loadClient(process.env);

    if ('code' in client) {
      write({ type: 'init', ok: false, error: client });

      return;
    }

    const connected = await connect(options.data.url, client);

    if ('code' in connected) {
      write({ type: 'init', ok: false, error: connected });

      return;
    }

    const installed = await connected.installedTools();
    const tools = installed.flatMap((entry) => (entry.canRun ? [entry] : []));

    if (tools.length === 0) {
      await connected.close();

      const reasons = installed.flatMap((entry) => (entry.canRun ? [] : [`${entry.tool}: ${entry.reason}.`]));

      const message = reasons.length === 0
        ? `The Paseo daemon at ${connected.url} has none of claude, codex or opencode installed. Install one on the daemon's host, and sign in to it there.`
        : `The Paseo daemon at ${connected.url} runs no tool teamai-runtime-paseo can use. ${reasons.join(' ')}`;

      write({ type: 'init', ok: false, error: { code: 'tool_unavailable', message } });

      return;
    }

    daemon = connected;
    mode = request.mode;

    offers = new Map(installed.map((entry): [PaseoTool, Offer] => {
      if (!entry.canRun) return [entry.tool, { runs: 'nothing', reason: entry.reason }];
      const confinedMode = CONFINED_MODES[entry.tool];

      return [entry.tool, entry.modes.includes(confinedMode) ? { runs: 'steps-and-judges' } : { runs: 'steps', noJudge: `has no ${confinedMode} mode, which teamai judges it in` }];
    }));
    const judges = tools.flatMap(({ tool }) => (offers.get(tool)?.runs === 'steps-and-judges' ? [tool] : []));

    write({
      type: 'init', ok: true, prompt: true,
      ...(judges.length > 0 && { confinedPrompt: true }),
      can: {
        // tokens: Paseo reports a turn's usage without the tokens written to the prompt cache, so a budget would undercount.
        // unattended: a step that may run without asking never starts here, so no mode that bypasses approval is ever used.
        exec: false, setup: false, hitl: false, unattended: false, env: false, tokens: false, max_turns: false, workspace: ['new', 'continue'], tools: tools.map(({ tool }) => tool),
        ...(judges.length > 0 && { confined: [{ ...CONFINED_KEPT, tools: judges }] }),
      },
    });
  }

  async function open(live: Daemon, request: Extract<RuntimeRequest, { type: 'open' }>): Promise<void> {
    const known = journal.handleOf(request);

    if (known) {
      write({ op: request.op, event: 'accepted', handle: known });
      const display = displayOf(known, live);
      write({ op: request.op, event: 'ready', ...(display && { display }) });

      return;
    }

    // A confined prompt's place comes without a view: its workspace adopts the prompt's directory once the prompt comes.
    if (!request.view) {
      const handle = `confined/${request.run}/${request.attempt}`;
      journal.savePlace(handle, { kind: 'confined', run: request.run, attempt: request.attempt });
      write({ op: request.op, event: 'accepted', handle });
      const display = displayOf(handle, live);
      write({ op: request.op, event: 'ready', ...(display && { display }) });

      return;
    }

    let workspace: Awaited<ReturnType<Daemon['workspace']>>;

    try {
      workspace = await live.workspace(request.view.worktree);
    } catch (error) {
      fail(request.op, { code: 'workspace_failed', message: `Paseo could not open the worktree as a workspace: ${error instanceof Error ? error.message : String(error)}` });

      return;
    }

    // A handle per attempt: two attempts on one worktree share its workspace, and keep their own prompts.
    const handle = `${workspace.id}/${request.attempt}`;
    journal.savePlace(handle, { kind: 'worktree', run: request.run, attempt: request.attempt, workspace: { id: workspace.id, name: workspace.name }, cwd: workspace.directory, runDir: request.view.runDir });
    write({ op: request.op, event: 'accepted', handle });
    const display = displayOf(handle, live);
    write({ op: request.op, event: 'ready', ...(display && { display }) });
  }

  /** The create a new prompt sends, in `launch`'s mode with its prompt and options, or the failure that keeps it from being sent. */
  async function createFor(
    live: Daemon,
    request: Extract<RuntimeRequest, { type: 'prompt' }>,
    tool: PaseoTool,
    launch: { place: Place; modeId: string; prompt: string; options?: AgentCreate['config']['options']; env?: AgentCreate['env'] },
  ): Promise<AgentCreate | RuntimeFailure> {
    const { place } = launch;
    const { lease } = request;
    const models = await live.models(tool);
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
      prompt: launch.prompt,
      labels: { 'teamai-attempt': `${place.run}/${place.attempt}` },
      ...(launch.env && { env: launch.env }),
      config: { provider: `${tool}/${model.id}`, modeId: launch.modeId, ...(effort && { thinkingOptionId: effort }), ...(launch.options && { options: launch.options }) },
    };
  }

  /** Records a prompt refused before any agent was created, so a repeated id ends the same, and says why. */
  const refuse = (op: OpId, handle: string, failure: RuntimeFailure): void => {
    journal.savePrompt(op, { kind: 'refused', handle, outcome: { op, state: 'failed', failure } });
    fail(op, failure);
  };

  /** A workflow prompt step: an agent in the worktree, in the tool's default mode, that writes teamai's result file. */
  async function work(live: Daemon, request: Extract<RuntimeRequest, { type: 'prompt' }>, place: WorktreePlace): Promise<void> {
    const { op, lease } = request;
    const { tool } = lease;

    if (!isPaseoTool(tool)) {
      fail(op, { code: 'tool_unavailable', message: `teamai-runtime-paseo runs claude, codex and opencode, not ${tool}.` });

      return;
    }

    const unoffered = notOffered(tool, false);

    if (unoffered) {
      refuse(op, request.handle, unoffered);

      return;
    }

    const create = await createFor(live, request, tool, {
      place, modeId: DEFAULT_MODES[tool], prompt: lease.prompt, env: { [RUN_DIR_ENV]: place.runDir },
      options: stepGrant(tool, lease.result, place.runDir),
    });

    if ('code' in create) {
      refuse(op, request.handle, create);

      return;
    }

    const record: AgentPrompt = { kind: 'agent', handle: request.handle, tool, answer: { kind: 'result-file', file: lease.result }, cwd: place.cwd, create };
    journal.savePrompt(op, record);
    await follow(live, op, record);
  }

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

    if (!isPaseoTool(tool)) {
      refuse(op, request.handle, { code: 'tool_unavailable', message: `teamai-runtime-paseo runs a confined prompt on claude, codex or opencode, not ${tool}.` });

      return;
    }

    const unoffered = notOffered(tool, true);

    if (unoffered) {
      refuse(op, request.handle, unoffered);

      return;
    }

    const modeId = CONFINED_MODES[tool];

    let workspace = place.workspace && { ...place.workspace, directory: confined.dir };

    if (!workspace) {
      try {
        workspace = await live.workspace(confined.dir);
      } catch (error) {
        refuse(op, request.handle, { code: 'workspace_failed', message: `Paseo could not open the confined prompt's directory as a workspace: ${error instanceof Error ? error.message : String(error)}` });

        return;
      }

      journal.savePlace(request.handle, { ...place, workspace: { id: workspace.id, name: workspace.name } });
    }

    const create = await createFor(live, request, tool, { place, modeId, prompt: confinedBrief(tool, confined, lease.prompt), options: CONFINED_OPTIONS[tool] });

    if ('code' in create) {
      refuse(op, request.handle, create);

      return;
    }

    const record: AgentPrompt = { kind: 'agent', handle: request.handle, tool, answer: { kind: 'reply', kept: CONFINED_KEPT }, cwd: workspace.directory, create };
    journal.savePrompt(op, record);
    await follow(live, op, record);
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
      accept(op, known, live);

      if (known.outcome) send(op, known.outcome);

      return;
    }

    if (known) {
      await follow(live, op, known);

      return;
    }

    const place = journal.place(request.handle);
    const { confined } = request;

    if (confined && place?.kind === 'confined') {
      await judge(live, request, confined, place);

      return;
    }

    if (!confined && place?.kind === 'worktree') {
      await work(live, request, place);

      return;
    }

    fail(op, {
      code: 'unknown_handle',
      message: confined
        ? `teamai-runtime-paseo has no confined prompt's place ${request.handle}; open the attempt with no view first.`
        : `teamai-runtime-paseo has no worktree place ${request.handle}; open the attempt on its worktree first.`,
    });
  }

  /** Makes sure the prompt's agent exists, then waits for it to end, and settles the prompt. */
  async function follow(live: Daemon, op: OpId, record: AgentPrompt): Promise<void> {
    const { create } = record;
    let stop: () => void = () => {};

    const stopped = new Promise<'stopped'>((resolve) => {
      stop = () => resolve('stopped');
    });

    const following = { stop, created: false };
    waiting.set(op, following);

    try {
      // The agent of a repeated prompt is found by its id; a create a runtime died before sending is sent again.
      if (!(await live.agent(create.agentId))) await live.create(record.cwd, create);
      following.created = true;
    } catch (error) {
      settle(op, { op, state: 'failed', failure: { code: 'agent_create_failed', message: `Paseo could not create the ${record.tool} agent: ${error instanceof Error ? error.message : String(error)}` } });

      return;
    }

    accept(op, record, live);

    // A cancel that came before the agent existed, or to a runtime since killed, is sent now that it does.
    if (journal.isCancelled(op)) {
      const refused = await cancelAgent(live, record);
      settle(op, refused ? { op, state: 'failed', failure: refused } : { op, state: 'cancelled' });

      return;
    }

    for (;;) {
      if (closing) return;

      // Whoever sends the cancel settles the prompt once Paseo answers it.
      if (journal.isCancelled(op)) return;

      const end = await Promise.race([live.wait(create.agentId).catch(() => ({ dropped: true })), stopped]);

      if (end === 'stopped') continue;

      if ('dropped' in end) {
        await delay(RECONNECT_MS);
        continue;
      }

      if (journal.isCancelled(op)) continue;

      switch (end.status) {
        case 'timeout':
          continue;
        case 'permission': {
          const asked = end.final?.pendingPermissions[0];
          const modeId = create.config.modeId;

          if (record.answer.kind === 'reply') {
            const refused = await cancelAgent(live, record);
            settle(op, {
              op, state: 'failed',
              failure: {
                code: 'tool_failed',
                message: `The ${record.tool} agent asked for permission${asked ? ` (${asked.title ?? asked.name})` : ''} in Paseo mode ${modeId}. A confined prompt only reads its directory, so it ends rather than ask.${refused ? ` ${refused.message}` : ''}`,
              },
            });

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
              code: 'tool_failed',
              message: `The ${record.tool} agent asked for permission${asked ? ` (${asked.title ?? asked.name})` : ''} in Paseo mode ${modeId}, which asks before it runs what it does not allow, and an unattended run has nobody to answer. Run the workflow attended to answer it in the Paseo app, or run this step on a runtime that offers unattended.${refused ? ` ${refused.message}` : ''}`,
            },
          });

          return;
        }

        case 'error':
          settle(op, { op, state: 'failed', failure: { code: 'tool_failed', message: `The ${record.tool} agent failed in Paseo: ${end.error ?? 'no error given'}` } });

          return;
        case 'idle': {
          const session = end.final?.runtimeInfo?.sessionId;

          if (record.answer.kind === 'reply') {
            const output = parseReply(end.lastMessage);

            if (end.final?.status === 'closed' && output === undefined) {
              settle(op, {
                op, state: 'failed',
                failure: { code: 'daemon_restarted', message: `The Paseo daemon at ${live.url} stopped while the ${record.tool} agent answered the confined prompt, before it replied. Run \`teamai workflow retry\` to ask again.` },
              });

              return;
            }

            if (output === undefined) {
              settle(op, { op, state: 'failed', failure: { code: 'tool_failed', message: `The ${record.tool} agent replied with no JSON value.` } });

              return;
            }

            if (!session) {
              settle(op, { op, state: 'failed', failure: noSession(record.tool) });

              return;
            }

            settle(op, { op, state: 'finished', session: { tool: record.tool, id: session }, result: { output }, confined: record.answer.kept });

            return;
          }

          const result = readResult(record.answer.file);

          if (end.final?.status === 'closed' && !result) {
            settle(op, {
              op, state: 'failed',
              failure: { code: 'daemon_restarted', message: `The Paseo daemon at ${live.url} stopped while the ${record.tool} agent worked, before it wrote a workflow result. Its work is kept in the worktree; run \`teamai workflow retry\` to run the step again.` },
            });

            return;
          }

          if (!result) {
            settle(op, { op, state: 'failed', failure: { code: 'tool_failed', message: `${record.tool} did not write a valid workflow result` } });

            return;
          }

          if (!session) {
            settle(op, { op, state: 'failed', failure: noSession(record.tool) });

            return;
          }

          settle(op, { op, state: 'finished', session: { tool: record.tool, id: session }, result });

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
    const record = journal.prompt(op);

    if (record?.kind !== 'agent' || record.outcome) return;
    journal.cancel(op);
    const following = waiting.get(op);

    // A prompt whose agent is still being created is cancelled once it exists.
    if (following && !following.created) return;
    const live = await reach();

    const refused = live && !('code' in live)
      ? await cancelAgent(live, record)
      : { ...withoutDaemon(live, `cancel the ${record.tool} agent ${record.create.agentId}, which may still run in the worktree`, 'cancel the run again'), code: 'cancel_failed' };

    settle(op, refused ? { op, state: 'failed', failure: refused } : { op, state: 'cancelled' });
    following?.stop();
  }

  /** Cancels a prompt's agent that is still running, or says why it may still run; one already stopped needs nothing. */
  const stopAgent = async (live: Daemon, record: AgentPrompt): Promise<RuntimeFailure | undefined> => {
    if (isStopped(await live.agent(record.create.agentId).catch(() => undefined))) return undefined;

    return cancelAgent(live, record);
  };

  /**
   * Stops what an attempt's place runs, its failed prompts' agents included, since a failed cancel leaves its agent
   * running, or says why something may still run. The last attempt on a Paseo workspace archives it, which stops what
   * still runs there; an attempt that shares it stops only its own agents.
   */
  async function stopPlace(live: Daemon, handle: string, place: Place): Promise<RuntimeFailure | undefined> {
    // A confined prompt's place before its prompt came: no workspace, so no agent.
    if (!place.workspace) return undefined;
    const agents = journal.promptsOf(handle).flatMap(({ record }) => (record.kind === 'agent' ? [record] : []));

    if (!journal.handlesIn(place.workspace.id).every((other) => other === handle)) {
      const refusals = (await Promise.all(agents.map((record) => stopAgent(live, record)))).flatMap((failure) => (failure ? [failure.message] : []));

      return refusals.length > 0 ? { code: 'close_failed', message: refusals.join(' ') } : undefined;
    }

    try {
      await live.archive(place.workspace.id);
    } catch (error) {
      return { code: 'close_failed', message: `Paseo did not archive workspace ${place.workspace.name} (${place.workspace.id}): ${error instanceof Error ? error.message : String(error)}. Its agents may still run; archive it in the Paseo app.` };
    }

    const running = (await Promise.all(agents.map(async ({ create: { agentId } }) => ((await isStillRunning(live, agentId)) ? [agentId] : [])))).flat();

    if (running.length === 0) return undefined;

    return {
      code: 'close_failed',
      message: `Paseo archived workspace ${place.workspace.name} (${place.workspace.id}), but agent ${running.join(', ')} still ran ${STOP_SETTLE_MS / 1000} s later. It may still change the worktree; stop it in the Paseo app.`,
    };
  }

  /**
   * Ends an attempt's place once nothing it started runs. A place whose agent may still run is kept, so teamai can close
   * it again: one the runtime cannot stop, or any place while it reaches no daemon, as after a restart whose init failed.
   */
  async function closePlace(handle: string): Promise<void> {
    const place = journal.place(handle);
    // A place with no Paseo workspace has no agent to stop: it closes without the daemon.
    const live = place?.workspace && (await reach());

    const failure = place?.workspace && (live && !('code' in live)
      ? await stopPlace(live, handle, place)
      : withoutDaemon(live, `stop the agents of ${handle} or archive its workspace`, 'close the attempt again'));

    if (failure) {
      write({ event: 'close_failed', handle, failure });

      return;
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

        const ops = journal.promptsOf(request.handle).map(({ op, record }): OpState => record.outcome ?? { op, state: 'running' });
        const display = live && displayOf(request.handle, live);
        write({ event: 'alive', handle: request.handle, ops, ...(display && { display }) });

        return;
      }

      case 'close':
        await closePlace(request.handle);

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

  const lines = readline.createInterface({ input });

  lines.on('line', (line) => {
    let request: RuntimeRequest;

    try {
      request = RuntimeRequestSchema.parse(JSON.parse(line));
    } catch (error) {
      write({ event: 'error', message: `teamai-runtime-paseo could not read a request: ${error instanceof Error ? error.message : String(error)}` });

      return;
    }

    const answered = (async () => {
      try {
        await answer(request);
      } catch (error) {
        const message = `Paseo failed: ${error instanceof Error ? error.message : String(error)}`;

        // Each request gets its own failure, since an error line would fail every request teamai is waiting on. A close
        // that failed keeps its place.
        if ('op' in request) fail(request.op, { code: 'paseo_failed', message });
        else if (request.type === 'close') write({ event: 'close_failed', handle: request.handle, failure: { code: 'paseo_failed', message } });
        else if (request.type === 'init') write({ type: 'init', ok: false, error: { code: 'paseo_failed', message } });
        else write({ event: 'failed', handle: request.handle, failure: { code: 'paseo_failed', message } });
      }
    })();

    answering.add(answered);
    void answered.finally(() => answering.delete(answered));
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
