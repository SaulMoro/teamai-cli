import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  SessionInboundMessageSchema, WSInboundMessageSchema, WSOutboundMessageSchema, type CreationSnapshot, type WorkspaceDescriptorPayload,
} from '@getpaseo/protocol/messages';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';

// ─── A fake Paseo daemon ─────────────────────────────────
//
//  The part of Paseo 0.14.0's WebSocket protocol teamai-runtime-paseo speaks, as the real daemon answers it (recorded
//  against 0.14.0): hello, provider discovery, workspace open, agent create with an idempotency key and a caller-chosen
//  id, wait for finish, fetch and cancel. Every frame it sends and receives is checked against Paseo's own schemas.
//
//  It runs as its own process over a state directory, so a test restarts it as a person restarts Paseo:
//
//    agents.json         its agents, workspaces and create receipts, which a restart reads again; an agent that was
//                        running when it stopped comes back `closed`, as Paseo marks it
//    behaviour.json      how its next agents behave (`Behaviour`), and which version and models it offers
//    requests.jsonl      every agent create, cancel and workspace archive it received, for a test to read what crossed
//    answers/<agent>     a person answered the agent's permission request in the app
//
//  An agent finds the result file the way a real one does, in teamai's prompt, and writes its output there.
//

const BehaviourSchema = z.object({
  /** The daemon's version in hello. */
  version: z.string().default('0.14.0'),
  /** Features hello leaves out. */
  missing: z.array(z.string()).default([]),
  /** The models each provider offers; a provider absent here is unavailable. */
  models: z.record(z.string(), z.array(z.string())).default({ claude: ['claude-opus-5-5', 'claude-sonnet-5-5'], codex: ['gpt-6.1-sol'], opencode: ['opencode/beam-free'] }),
  /** The output the agent writes to the result file; none written when absent. */
  output: z.unknown().optional(),
  /** A failure the agent writes to the result file instead. */
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
  /** How long the agent works. */
  hold_ms: z.number().int().nonnegative().default(0),
  /** The agent works until this file exists. */
  release: z.string().optional(),
  /** A file the agent writes in its cwd as soon as it starts: its work. */
  touch: z.string().optional(),
  /** The agent asks for permission to run a command first, and waits for an answer. */
  ask_permission: z.boolean().default(false),
  /** The provider fails the agent with this error. */
  error: z.string().optional(),
  /** The daemon refuses a cancel with this error, and the agent goes on. */
  refuse_cancel: z.string().optional(),
  /** How long the daemon takes to answer a refused cancel. */
  refuse_cancel_ms: z.number().int().nonnegative().default(0),
  /** The daemon refuses to archive a workspace with this error. */
  refuse_archive: z.string().optional(),
});

export type Behaviour = z.input<typeof BehaviourSchema>;

/** The providers the fake runs, as Paseo names them. */
type Provider = 'claude' | 'codex' | 'opencode';

const MODES: Readonly<Record<Provider, Array<{ id: string; label: string }>>> = {
  claude: [{ id: 'plan', label: 'Plan Mode' }, { id: 'default', label: 'Always Ask' }, { id: 'acceptEdits', label: 'Accept File Edits' }, { id: 'bypassPermissions', label: 'Bypass' }],
  codex: [{ id: 'auto', label: 'Default Permissions' }, { id: 'full-access', label: 'Full Access' }],
  opencode: [{ id: 'build', label: 'Build' }, { id: 'plan', label: 'Plan' }],
};

const FEATURES = ['creationLifecycle', 'agentRequestReceipts', 'ownedSubscriptions', 'workspaceRequestReceipts'];

const AgentRecordSchema = z.object({
  id: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  thinking: z.string().nullable(),
  modeId: z.string().nullable(),
  cwd: z.string(),
  workspaceId: z.string(),
  title: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
  status: z.enum(['initializing', 'idle', 'running', 'error', 'closed']),
  createdAt: z.string(),
  updatedAt: z.string(),
  sessionId: z.string().nullable(),
  lastError: z.string().optional(),
  permission: z.boolean(),
  behaviour: BehaviourSchema,
  prompt: z.string(),
});

type AgentRecord = z.infer<typeof AgentRecordSchema>;

const StateSchema = z.object({
  agents: z.record(z.string(), AgentRecordSchema),
  workspaces: z.record(z.string(), z.string()),
  receipts: z.record(z.string(), z.object({ agentId: z.string(), fingerprint: z.string() })),
});

type Inbound = z.infer<typeof SessionInboundMessageSchema>;

type Outbound = z.input<typeof WSOutboundMessageSchema>;

type Reply = Extract<Outbound, { type: 'session' }>['message'];

const isProvider = (provider: string): provider is Provider => Object.hasOwn(MODES, provider);

const modesOf = (provider: string): Array<{ id: string; label: string }> => (isProvider(provider) ? MODES[provider] : []);

function now(): string {
  return new Date().toISOString();
}

export async function startFakeDaemon({ state, port }: { state: string; port: number }): Promise<{ url: string; close(): Promise<void> }> {
  fs.mkdirSync(path.join(state, 'answers'), { recursive: true });
  const stateFile = path.join(state, 'agents.json');
  const kept = fs.existsSync(stateFile) ? StateSchema.parse(JSON.parse(fs.readFileSync(stateFile, 'utf8'))) : { agents: {}, workspaces: {}, receipts: {} };

  // A restart ends every agent that was working: Paseo keeps nothing that tells completed apart from killed.
  for (const agent of Object.values(kept.agents)) {
    if (agent.status === 'running' || agent.status === 'initializing') Object.assign(agent, { status: 'closed', permission: false, updatedAt: now() });
  }

  const save = (): void => {
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(kept));
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  };

  save();

  const behaviour = (): z.infer<typeof BehaviourSchema> => {
    const file = path.join(state, 'behaviour.json');

    return BehaviourSchema.parse(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
  };

  const waiters = new Map<string, Array<() => void>>();
  const timers = new Set<NodeJS.Timeout>();

  const changed = (agent: AgentRecord): void => {
    agent.updatedAt = now();
    save();

    for (const wake of waiters.get(agent.id)?.splice(0) ?? []) wake();
  };

  const snapshot = (agent: AgentRecord) => {
    const shown = {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    model: agent.model,
    features: [],
    thinkingOptionId: agent.thinking,
    effectiveThinkingOptionId: agent.thinking,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    lastUserMessageAt: agent.createdAt,
    status: agent.status,
    activeTurn: agent.status === 'running' ? { turnId: 'foreground-turn-1', startedAt: agent.createdAt } : null,
    capabilities: {
      supportsStreaming: true, supportsSessionPersistence: true, supportsSessionListing: true, supportsDynamicModes: true, supportsMcpServers: true,
      supportsReasoningStream: true, supportsToolInvocations: true, supportsRewindConversation: false, supportsRewindFiles: false, supportsRewindBoth: false,
    },
    currentModeId: agent.modeId,
    availableModes: modesOf(agent.provider),
    pendingPermissions: agent.permission ? [{ id: `perm-${agent.id}`, provider: agent.provider, name: 'Bash', kind: 'tool' as const, title: 'Run npm test' }] : [],
    persistence: null,
    runtimeInfo: { provider: agent.provider, sessionId: agent.sessionId, model: agent.model, modeId: agent.modeId },
    title: agent.title,
    labels: agent.labels,
    requiresAttention: agent.permission || agent.status !== 'running',
    attentionReason: agent.permission ? 'permission' as const : agent.status === 'error' ? 'error' as const : agent.status === 'running' ? null : 'finished' as const,
    attentionTimestamp: null,
    archivedAt: null,
    };

    return agent.lastError === undefined ? shown : { ...shown, lastError: agent.lastError };
  };

  const finish = (agent: AgentRecord): void => {
    const { behaviour: does } = agent;

    if (does.error !== undefined) {
      Object.assign(agent, { status: 'error', lastError: does.error });
    } else {
      // A real agent reads where to write its result in teamai's prompt.
      const result = /Write the workflow result as JSON to (.+?)\.(?:\s|$)/.exec(agent.prompt)?.[1];

      if (result && (does.output !== undefined || does.failure)) {
        fs.mkdirSync(path.dirname(result), { recursive: true });
        fs.writeFileSync(result, JSON.stringify(does.failure ? { failure: does.failure } : { output: does.output }));
      }

      Object.assign(agent, { status: 'idle', sessionId: `fake-session-${agent.id}` });
    }

    changed(agent);
  };

  /** Runs an agent's turn: its work, a permission it waits on, then its hold or release, then its end. */
  const work = (agent: AgentRecord): void => {
    const { behaviour: does } = agent;

    if (does.touch) fs.writeFileSync(path.join(agent.cwd, does.touch), 'work in progress\n');
    const started = Date.now();

    const tick = setInterval(() => {
      if (agent.status !== 'running') {
        clearInterval(tick);
        timers.delete(tick);

        return;
      }

      if (agent.permission) {
        if (!fs.existsSync(path.join(state, 'answers', agent.id))) return;
        agent.permission = false;
        changed(agent);
      }

      if (Date.now() - started < does.hold_ms || (does.release && !fs.existsSync(does.release))) return;
      clearInterval(tick);
      timers.delete(tick);
      finish(agent);
    }, 20);

    timers.add(tick);
  };

  const wss = new WebSocketServer({ host: '127.0.0.1', port, path: '/ws' });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  wss.on('connection', (socket: WebSocket) => {
    const send = (message: Outbound): void => {
      // A frame Paseo's client would reject fails here, where the fake wrote it.
      socket.send(JSON.stringify(WSOutboundMessageSchema.parse(message)));
    };

    const reply = (message: Reply): void => send({ type: 'session', message });

    socket.on('message', (data) => {
      const frame = WSInboundMessageSchema.parse(JSON.parse(String(data)));

      if (frame.type === 'ping') {
        send({ type: 'pong' });

        return;
      }

      if (frame.type === 'hello') {
        const does = behaviour();
        reply({
          type: 'status',
          payload: {
            status: 'server_info', protocolVersion: 1, serverId: 'srv_fake0001', hostname: 'fake-host', version: does.version, sourceId: 'owner',
            permissions: ['daemon.read', 'workspace.read', 'workspace.write', 'workspace.manage'], desktopManaged: false,
            features: Object.fromEntries(FEATURES.flatMap((feature) => (does.missing.includes(feature) ? [] : [[feature, true]]))),
          },
        });

        return;
      }

      if (frame.type !== 'session') return;
      handle(frame.message, reply);
    });
  });

  const record = (message: Inbound): void => {
    fs.appendFileSync(path.join(state, 'requests.jsonl'), `${JSON.stringify(message)}\n`);
  };

  function handle(message: Inbound, reply: (message: Reply) => void): void {
    switch (message.type) {
      case 'list_available_providers_request': {
        const offered = behaviour().models;
        reply({
          type: 'list_available_providers_response',
          payload: { requestId: message.requestId, providers: Object.keys(MODES).map((provider) => ({ provider, available: Object.hasOwn(offered, provider), error: null })), error: null, fetchedAt: now() },
        });

        return;
      }

      case 'list_provider_models_request': {
        const models = behaviour().models[message.provider] ?? [];
        reply({
          type: 'list_provider_models_response',
          payload: {
            requestId: message.requestId, provider: message.provider, error: null, fetchedAt: now(),
            models: models.map((id, index) => ({ provider: message.provider, id, label: id, isDefault: index === 0, thinkingOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] })),
          },
        });

        return;
      }

      case 'list_provider_modes_request':
        reply({ type: 'list_provider_modes_response', payload: { requestId: message.requestId, provider: message.provider, modes: modesOf(message.provider), error: null, fetchedAt: now() } });

        return;
      case 'open_project_request': {
        const cwd = fs.realpathSync(message.cwd);
        const id = kept.workspaces[cwd] ?? `wks_${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}`;
        kept.workspaces[cwd] = id;
        save();
        reply({ type: 'open_project_response', payload: { requestId: message.requestId, workspace: workspaceOf(id, cwd), error: null } });

        return;
      }

      case 'fetch_workspaces_request': {
        const entries = Object.entries(kept.workspaces).map(([cwd, id]) => workspaceOf(id, cwd));
        reply({ type: 'fetch_workspaces_response', payload: { requestId: message.requestId, entries, pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } } });

        return;
      }

      case 'agent.create.request': {
        record(message);
        const { requestId: _requestId, ...intent } = message;
        const fingerprint = JSON.stringify(intent);
        const key = message.idempotencyKey;

        if (key === undefined) throw new Error('The fake Paseo daemon takes only agent creates with an idempotency key');
        const receipt = kept.receipts[key];

        const creation = (agent: AgentRecord): CreationSnapshot => ({
          kind: 'agent', idempotencyKey: key, revision: 3, phase: 'completed', error: null, workspaceId: agent.workspaceId, agentId: agent.id, agent: snapshot(agent),
        });

        if (receipt) {
          const agent = kept.agents[receipt.agentId];

          if (receipt.fingerprint !== fingerprint || !agent) {
            reply({ type: 'agent.create.response', payload: { requestId: message.requestId, agent: null, error: 'agent_request_key_conflict' } });

            return;
          }

          reply({ type: 'agent.create.response', payload: { requestId: message.requestId, agent: snapshot(agent), creation: creation(agent), error: null } });

          return;
        }

        const id = message.agentId ?? crypto.randomUUID();
        const [model, thinking] = [message.config.model ?? null, message.config.thinkingOptionId ?? null];

        const agent: AgentRecord = {
          id, provider: message.config.provider, model, thinking, modeId: message.config.modeId ?? null, cwd: fs.realpathSync(message.config.cwd),
          workspaceId: message.workspaceId ?? '', title: message.config.title ?? null, labels: message.labels, status: 'running', createdAt: now(), updatedAt: now(),
          sessionId: null, permission: false, behaviour: behaviour(), prompt: message.initialPrompt ?? '',
        };

        agent.permission = agent.behaviour.ask_permission;
        kept.agents[id] = agent;

        kept.receipts[key] = { agentId: id, fingerprint };
        save();
        reply({ type: 'agent.create.update', payload: creation(agent) });
        reply({ type: 'agent.create.response', payload: { requestId: message.requestId, agent: snapshot(agent), creation: creation(agent), error: null } });
        work(agent);

        return;
      }

      case 'fetch_agent_request': {
        // As Paseo: an unknown agent is a null agent, not an error.
        const agent = kept.agents[message.agentId];
        reply({ type: 'fetch_agent_response', payload: { requestId: message.requestId, agent: agent ? snapshot(agent) : null, project: null, error: null } });

        return;
      }

      case 'wait_for_finish_request': {
        const agent = kept.agents[message.agentId];

        if (!agent) {
          reply({ type: 'wait_for_finish_response', payload: { requestId: message.requestId, status: 'error', final: null, error: `Agent not found: ${message.agentId}`, lastMessage: null } });

          return;
        }

        // As Paseo: a turn waiting on a person answers `permission`; an ended one, closed included, `idle` or `error`.
        const answer = (): boolean => {
          if (agent.status === 'running' && !agent.permission) return false;
          const status = agent.permission ? 'permission' : agent.status === 'error' ? 'error' : 'idle';
          reply({ type: 'wait_for_finish_response', payload: { requestId: message.requestId, status, final: snapshot(agent), error: agent.lastError ?? null, lastMessage: status === 'idle' ? 'Done.' : null } });

          return true;
        };

        const wait = (): void => {
          if (!answer()) waiters.set(agent.id, [...waiters.get(agent.id) ?? [], wait]);
        };

        wait();

        return;
      }

      case 'cancel_agent_request': {
        record(message);
        const agent = kept.agents[message.agentId];
        const { refuse_cancel: refused, refuse_cancel_ms: refusing } = behaviour();

        if (refused) {
          setTimeout(() => reply({ type: 'cancel_agent_response', payload: { requestId: message.requestId ?? '', agentId: message.agentId, agent: agent ? snapshot(agent) : null, error: refused } }), refusing);

          return;
        }

        // Paseo reports a cancelled agent as idle.
        if (agent?.status === 'running') {
          Object.assign(agent, { status: 'idle', permission: false, sessionId: `fake-session-${agent.id}` });
          changed(agent);
        }

        reply({ type: 'cancel_agent_response', payload: { requestId: message.requestId ?? '', agentId: message.agentId, agent: agent ? snapshot(agent) : null, error: agent ? null : `Agent not found: ${message.agentId}` } });

        return;
      }

      case 'archive_workspace_request': {
        record(message);
        const refused = behaviour().refuse_archive;

        // Paseo deletes only worktrees it created, so archiving teamai's leaves the directory in place.
        if (!refused) {
          for (const [cwd, id] of Object.entries(kept.workspaces)) if (id === message.workspaceId) delete kept.workspaces[cwd];
          save();
        }

        reply({ type: 'archive_workspace_response', payload: { requestId: message.requestId, workspaceId: message.workspaceId, archivedAt: refused ? null : now(), error: refused ?? null } });

        return;
      }

      default:
        throw new Error(`The fake Paseo daemon does not answer ${message.type}`);
    }
  }

  const { port: listening } = z.object({ port: z.number() }).parse(wss.address());

  return {
    url: `ws://127.0.0.1:${listening}/ws`,
    close: async () => {
      for (const timer of timers) clearInterval(timer);

      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function workspaceOf(id: string, cwd: string): WorkspaceDescriptorPayload {
  const name = path.basename(cwd);

  return {
    id, projectId: `prj_${id.slice(4)}`, projectDisplayName: name, projectCustomName: null, projectCustomIconRevision: null, projectRootPath: cwd, workspaceDirectory: cwd,
    setupStatus: null, projectKind: 'git', workspaceKind: 'local_checkout', name: 'main', title: null, pinnedAt: null, background: false, archivingAt: null,
    status: 'done', statusEnteredAt: null, activityAt: null, createdAt: now(), diffStat: null, scripts: [],
    project: { projectKey: `prj_${id.slice(4)}`, projectName: name, workspaceName: 'main', checkout: { cwd, currentBranch: 'main', remoteUrl: null, worktreeRoot: cwd, isGit: true, isPaseoOwnedWorktree: false, mainRepoRoot: null } },
  };
}

// Run as a process: `fake-daemon --state <dir> [--port <n>]` prints `{"url":…}` once it listens, and ends when its stdin closes.
if (process.argv[1] && /fake-daemon\.(?:ts|mjs|js)$/.test(process.argv[1])) {
  const arg = (name: string): string | undefined => {
    const at = process.argv.indexOf(name);

    return at === -1 ? undefined : process.argv[at + 1];
  };

  const state = arg('--state');

  if (!state) throw new Error('fake-daemon needs --state <dir>');
  const daemon = await startFakeDaemon({ state, port: Number(arg('--port') ?? 0) });
  process.stdout.write(`${JSON.stringify({ url: daemon.url })}\n`);
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
}
