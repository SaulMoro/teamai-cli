import { createHash } from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import {
  PromptResultSchema, RuntimeRequestSchema, type OpId, type OpState, type PromptResult, type RuntimeDisplay, type RuntimeFailure,
  type RuntimeMessage, type RuntimeRequest,
} from '@teamai/runtime-protocol';
import { z } from 'zod';
import { connect, DEFAULT_MODES, isPaseoTool, type Daemon, type PaseoTool } from './daemon.js';
import type { AgentCreate, AgentPrompt, Journal, Place } from './journal.js';

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
//

const OptionsSchema = z.object({
  /** The daemon's WebSocket address. */
  url: z.string().regex(/^wss?:\/\/\S+$/, 'The Paseo url is a ws:// or wss:// address, such as ws://127.0.0.1:6767/ws').default('ws://127.0.0.1:6767/ws'),
}).strict();

/** How long an attended step waits between looks at a permission request a person has not answered yet. */
const PERMISSION_POLL_MS = 1000;

/** How long a wait the daemon dropped, as a restart does, waits before it asks again. */
const RECONNECT_MS = 500;

/** The agent id a prompt's agent gets: a UUID derived from its op, so a restarted runtime finds the same agent. */
export function agentIdOf(op: OpId): string {
  const hex = createHash('sha256').update(`teamai-runtime-paseo/${op}`).digest('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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

export function serve({ input, write, journal }: Serving): Promise<void> {
  let daemon: Daemon | undefined;
  let mode: 'attended' | 'unattended' = 'attended';
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
        write({ op, event: 'finished', session: outcome.session, result: outcome.result, ...(outcome.usage && { usage: outcome.usage }) });

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

      return undefined;
    } catch (error) {
      return {
        code: 'cancel_failed',
        message: `Paseo did not cancel the ${record.tool} agent ${record.create.agentId}: ${error instanceof Error ? error.message : String(error)}. It may still run in the worktree; stop it in the Paseo app.`,
      };
    }
  };

  /** What the run's details show of a handle: the latest agent it runs, or the workspace before it runs one. */
  const displayOf = (handle: string, live: Daemon): RuntimeDisplay | undefined => {
    const place = journal.place(handle);

    if (!place) return undefined;
    const latest = journal.promptsOf(handle).flatMap(({ record }) => (record.kind === 'agent' ? [record] : [])).at(-1);

    if (!latest) return { label: `Paseo workspace ${place.workspace.name}`.slice(0, 80), fields: { workspace: place.workspace.id, daemon: `Paseo ${live.version}` } };

    return {
      label: latest.create.title.slice(0, 80),
      url: live.link(latest.create.agentId),
      fields: { agent: latest.create.agentId, workspace: place.workspace.id, model: latest.create.config.provider },
    };
  };

  async function init(request: Extract<RuntimeRequest, { type: 'init' }>): Promise<void> {
    const options = OptionsSchema.safeParse(request.options);

    if (!options.success) {
      const issue = options.error.issues[0];
      const key = issue?.code === 'unrecognized_keys' ? issue.keys[0] : issue?.path[0];
      write({ type: 'init', ok: false, error: { code: 'bad_option', message: `teamai-runtime-paseo takes option url only: ${issue?.message ?? 'bad options'}`, ...(key !== undefined && { key: String(key) }) } });

      return;
    }

    const connected = await connect(options.data.url);

    if ('code' in connected) {
      write({ type: 'init', ok: false, error: connected });

      return;
    }

    const tools = await connected.tools();

    if (tools.length === 0) {
      await connected.close();
      write({ type: 'init', ok: false, error: { code: 'tool_unavailable', message: `The Paseo daemon at ${connected.url} has none of claude, codex or opencode available. Sign in to one of them on the daemon's host.` } });

      return;
    }

    daemon = connected;
    mode = request.mode;
    write({
      type: 'init', ok: true, prompt: true,
      // tokens: Paseo reports a turn's usage without the tokens written to the prompt cache, so a budget would undercount.
      // unattended: a step that may run without asking never starts here, so no mode that bypasses approval is ever used.
      can: { exec: false, setup: false, hitl: false, unattended: false, env: false, tokens: false, max_turns: false, workspace: ['new', 'continue'], tools },
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

    // Only a confined prompt's place comes without a view, and this runtime answers no confined prompt.
    if (!request.view) {
      fail(request.op, { code: 'view_missing', message: 'teamai-runtime-paseo opens a place only on a worktree: it answers no confined prompt.' });

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
    journal.savePlace(handle, { run: request.run, attempt: request.attempt, workspace: { id: workspace.id, name: workspace.name }, cwd: workspace.directory });
    write({ op: request.op, event: 'accepted', handle });
    const display = displayOf(handle, live);
    write({ op: request.op, event: 'ready', ...(display && { display }) });
  }

  /** The create a new prompt sends, or the failure that keeps it from being sent. */
  async function createFor(live: Daemon, request: Extract<RuntimeRequest, { type: 'prompt' }>, tool: PaseoTool, place: Place): Promise<AgentCreate | RuntimeFailure> {
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
      prompt: lease.prompt,
      labels: { 'teamai-attempt': `${place.run}/${place.attempt}` },
      config: { provider: `${tool}/${model.id}`, modeId: DEFAULT_MODES[tool], ...(effort && { thinkingOptionId: effort }) },
    };
  }

  async function prompt(live: Daemon, request: Extract<RuntimeRequest, { type: 'prompt' }>): Promise<void> {
    const { op } = request;
    const known = journal.prompt(op);

    // A repeated id: the same acceptance, then the outcome it ended with, or a reconnect to its agent.
    if (known?.kind === 'refused') {
      send(op, known.outcome);

      return;
    }

    if (known) {
      write({ op, event: 'accepted' });

      if (known.outcome) send(op, known.outcome);
      else if (!waiting.has(op)) await follow(live, op, known);

      return;
    }

    const place = journal.place(request.handle);

    if (!place) {
      fail(op, { code: 'unknown_handle', message: `teamai-runtime-paseo has no place ${request.handle}; open the attempt first.` });

      return;
    }

    const { tool } = request.lease;

    if (!isPaseoTool(tool)) {
      fail(op, { code: 'tool_unavailable', message: `teamai-runtime-paseo runs claude, codex and opencode, not ${tool}.` });

      return;
    }

    const create = await createFor(live, request, tool, place);

    if ('code' in create) {
      journal.savePrompt(op, { kind: 'refused', handle: request.handle, outcome: { op, state: 'failed', failure: create } });
      fail(op, create);

      return;
    }

    const record: AgentPrompt = { kind: 'agent', handle: request.handle, tool, result: request.lease.result, cwd: place.cwd, create };
    journal.savePrompt(op, record);
    write({ op, event: 'accepted' });
    await follow(live, op, record);
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
          if (mode === 'attended') {
            // A person answers it in the Paseo app; the turn goes on once they do.
            await Promise.race([delay(PERMISSION_POLL_MS), stopped]);
            continue;
          }

          const asked = end.final?.pendingPermissions[0];
          const modeId = create.config.modeId;
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
          const result = readResult(record.result);
          const session = end.final?.runtimeInfo?.sessionId;

          if (end.final?.status === 'closed' && !result) {
            settle(op, {
              op, state: 'failed',
              failure: { code: 'daemon_restarted', message: `The Paseo daemon at ${live.url} stopped while the ${record.tool} agent worked, before it wrote a workflow result. Its work is kept in the worktree; run \`teamai workflow retry\` to run the step again.` },
            });

            return;
          }

          if (!result || !session) {
            settle(op, { op, state: 'failed', failure: { code: 'tool_failed', message: `${record.tool} did not write a valid workflow result` } });

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

  async function cancel(live: Daemon, op: OpId): Promise<void> {
    const record = journal.prompt(op);

    if (record?.kind !== 'agent' || record.outcome) return;
    journal.cancel(op);
    const following = waiting.get(op);

    // A prompt whose agent is still being created is cancelled once it exists.
    if (following && !following.created) return;
    const refused = await cancelAgent(live, record);

    settle(op, refused ? { op, state: 'failed', failure: refused } : { op, state: 'cancelled' });
    following?.stop();
  }

  async function answer(request: RuntimeRequest): Promise<void> {
    if (request.type === 'init') {
      await init(request);

      return;
    }

    const live = daemon;

    if (!live) {
      write({ event: 'error', message: `teamai-runtime-paseo got ${request.type} before a successful init` });

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
      case 'cancel':
        await cancel(live, request.op);

        return;
      case 'collect':
        // The worktree and the result directory already sit on this host, and the transcript stays in the tool's home.
        write({ event: 'collected', handle: request.handle });

        return;
      case 'reattach': {
        if (!journal.place(request.handle)) {
          write({ event: 'gone', handle: request.handle });

          return;
        }

        const ops = journal.promptsOf(request.handle).map(({ op, record }): OpState => record.outcome ?? { op, state: 'running' });
        const display = displayOf(request.handle, live);
        write({ event: 'alive', handle: request.handle, ops, ...(display && { display }) });

        return;
      }

      case 'close':
        journal.forget(request.handle);
        write({ event: 'closed', handle: request.handle });

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

        if ('op' in request) fail(request.op, { code: 'paseo_failed', message });
        else write({ event: 'error', message });
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
