import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  SessionInboundMessageSchema, WSInboundMessageSchema, WSOutboundMessageSchema, type CreationSnapshot, type WorkspaceDescriptorPayload,
} from '@getpaseo/protocol/messages';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';

// ─── A fake Paseo daemon ─────────────────────────────────
//
//  The part of Paseo 0.14.0's WebSocket protocol teamai-runtime-paseo speaks, as the real daemon answers it (recorded
//  against 0.14.0): hello, provider discovery and diagnostics, workspace open, agent create with an idempotency key and a caller-chosen
//  id, wait for finish, fetch and cancel. Every frame it sends and receives is checked against Paseo's own schemas.
//
//  It runs as its own process over a state directory, so a test restarts it as a person restarts Paseo:
//
//    agents.json         its agents, workspaces and create receipts, which a restart reads again; an agent that was
//                        running when it stopped comes back `closed`, as Paseo marks it
//    behaviour.json      how its next agents behave (`Behaviour`), and which version and models it offers
//    requests.jsonl      every agent create, cancel and workspace archive it received, for a test to read what crossed
//    stopped.jsonl       each agent a cancel or an archive stopped, once it stopped running, which may be after the answer
//    answers/<agent>     a person answered the agent's permission request in the app
//
//  An agent finds the result file the way a real one does, in teamai's prompt, and writes its output there.
//

const BehaviourSchema = z.object({
  /** The daemon's version in hello. */
  version: z.string().default('0.14.0'),
  /** Features hello leaves out. */
  missing: z.array(z.string()).default([]),
  /**
   * The models each provider offers; a provider absent here is unavailable. An empty list is OpenCode connected to no
   * model provider: installed, so available, with a catalog that fails.
   */
  models: z.record(z.string(), z.array(z.string())).default({ claude: ['claude-opus-5-5', 'claude-sonnet-5-5'], codex: ['gpt-6.1-sol'], opencode: ['opencode/beam-free'] }),
  /**
   * How a provider's diagnostic reports its sign-in; signed in when absent. Paseo calls a signed-out provider available
   * all the same. `unreported` leaves out the `Auth` row, as Codex's always does.
   */
  sign_in: z.record(z.string(), z.enum(['signed_out', 'unreported'])).default({}),
  /**
   * How `codex login status` answers on the daemon's host, which is this machine: the fake writes there a `codex` that
   * answers as Codex 0.166.0 does (recorded), or, `unknown`, as a codex that has no such command; its diagnostic's
   * resolved path names it. Absent, that path holds no codex.
   */
  codex_login: z.enum(['signed_in', 'signed_out', 'unknown']).optional(),
  /** The path Codex's diagnostic resolves, as it is, instead of the host's `codex` above. */
  codex_path: z.string().optional(),
  /** Directories the member already has open as Paseo workspaces, as the app opens a project. */
  member_workspaces: z.array(z.string()).default([]),
  /** The default mode the providers snapshot gives a provider, over Paseo 0.14.0's own; null: none, as OpenCode's. */
  default_modes: z.record(z.string(), z.string().nullable()).default({}),
  /** The output the agent writes to the result file; none written when absent. */
  output: z.unknown().optional(),
  /** The agent's last message, which a confined prompt's answer is. */
  reply: z.string().default('Done.'),
  /** A failure the agent writes to the result file instead. */
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
  /** The result file the agent writes, as it is, instead of one built from `output` or `failure`. */
  result: z.unknown().optional(),
  /** How long the agent works. */
  hold_ms: z.number().int().nonnegative().default(0),
  /** The agent works until this file exists. */
  release: z.string().optional(),
  /** A file the agent writes in its cwd as soon as it starts: its work. */
  touch: z.string().optional(),
  /** The agent asks for permission to run a command first, and waits for an answer. */
  ask_permission: z.boolean().default(false),
  /** The provider reports no session id once the agent is done. */
  no_session: z.boolean().default(false),
  /** The provider fails the agent with this error. */
  error: z.string().optional(),
  /** The daemon refuses a cancel with this error, and the agent goes on. */
  refuse_cancel: z.string().optional(),
  /** How long the daemon takes to answer a refused cancel. */
  refuse_cancel_ms: z.number().int().nonnegative().default(0),
  /** How long an agent goes on running after the daemon answered a cancel or an archive that stops it. */
  stop_lag_ms: z.number().int().nonnegative().default(0),
  /** The daemon refuses to archive a workspace with this error. */
  refuse_archive: z.string().optional(),
  /** The daemon answers every agent lookup with this error. */
  refuse_fetch: z.string().optional(),
  /** How long the daemon takes to list a provider's models, as a provider SDK that is slow to start does. */
  models_ms: z.number().int().nonnegative().default(0),
  /** How long the daemon takes to open a workspace, as a slow host does. */
  open_ms: z.number().int().nonnegative().default(0),
  /** How long the daemon takes to answer an open that makes a workspace, which exists before the answer; one that finds a workspace answers at once. */
  open_reply_ms: z.number().int().nonnegative().default(0),
  /** How long the daemon takes to create an agent, as a provider that is slow to start does. */
  create_ms: z.number().int().nonnegative().default(0),
  /** How long the daemon takes to archive a workspace. */
  archive_ms: z.number().int().nonnegative().default(0),
  /**
   * The daemon answers the create with this error at once, as a dropped connection does, yet creates and starts the agent
   * `create_ms` later: its answer came before the agent existed.
   */
  refuse_create_early: z.string().optional(),
  /** The daemon creates the agent and starts it, but its answer is lost: the create fails as a dropped connection does. */
  lose_create_reply: z.boolean().default(false),
});

export type Behaviour = z.input<typeof BehaviourSchema>;

/** The providers the fake runs, as Paseo names them. */
type Provider = 'claude' | 'codex' | 'opencode';

/** Each provider's modes, in Paseo's order, as Paseo 0.14.0 lists them (recorded): `dangerous` marks a mode that never asks. */
const MODES: Readonly<Record<Provider, Array<{ id: string; label: string; colorTier: string }>>> = {
  claude: [
    { id: 'plan', label: 'Plan Mode', colorTier: 'planning' }, { id: 'default', label: 'Always Ask', colorTier: 'safe' },
    { id: 'acceptEdits', label: 'Accept File Edits', colorTier: 'moderate' }, { id: 'auto', label: 'Auto mode', colorTier: 'moderate' },
    { id: 'bypassPermissions', label: 'Bypass', colorTier: 'dangerous' },
  ],
  codex: [{ id: 'auto', label: 'Default Permissions', colorTier: 'moderate' }, { id: 'auto-review', label: 'Auto-review', colorTier: 'moderate' }, { id: 'full-access', label: 'Full Access', colorTier: 'dangerous' }],
  opencode: [{ id: 'build', label: 'Build', colorTier: 'moderate' }, { id: 'plan', label: 'Plan', colorTier: 'planning' }],
};

/** The mode Paseo 0.14.0 starts each provider in, as its providers snapshot reports it (recorded): none for OpenCode. */
const DEFAULT_MODES: Readonly<Record<Provider, string | null>> = { claude: 'auto', codex: 'auto-review', opencode: null };

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

const modesOf = (provider: string): Array<{ id: string; label: string; colorTier: string }> => (isProvider(provider) ? MODES[provider] : []);

function now(): string {
  return new Date().toISOString();
}

/** Where the fake listens: a TCP port on 127.0.0.1 (0 for any free one), or, with `socket`, that Unix socket instead. */
export async function startFakeDaemon({ state, port, socket: socketPath }: { state: string; port: number; socket?: string }): Promise<{ url: string; close(): Promise<void> }> {
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

      if (result && (does.result !== undefined || does.output !== undefined || does.failure)) {
        fs.mkdirSync(path.dirname(result), { recursive: true });
        fs.writeFileSync(result, JSON.stringify(does.result ?? (does.failure ? { failure: does.failure } : { output: does.output })));
      }

      Object.assign(agent, { status: 'idle', sessionId: does.no_session ? null : `fake-session-${agent.id}` });
    }

    changed(agent);
  };

  /** The agents a cancel or an archive is stopping, which no longer finish their turn. */
  const stopping = new Set<string>();

  /** Stops a running agent, once the stop lag has passed, and records when it stopped. */
  const stop = (agent: AgentRecord, status: 'idle' | 'closed'): void => {
    if (agent.status !== 'running' || stopping.has(agent.id)) return;
    stopping.add(agent.id);

    const end = (): void => {
      stopping.delete(agent.id);
      // Paseo reports a cancelled agent as idle, and an archived one as closed.
      Object.assign(agent, { status, permission: false, sessionId: `fake-session-${agent.id}` });
      fs.appendFileSync(path.join(state, 'stopped.jsonl'), `${JSON.stringify({ agentId: agent.id, status })}\n`);
      changed(agent);
    };

    const lag = behaviour().stop_lag_ms;

    if (lag === 0) {
      end();

      return;
    }

    timers.add(setTimeout(end, lag));
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

      if (stopping.has(agent.id)) return;

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

  const server = socketPath === undefined ? undefined : http.createServer();
  const wss = server ? new WebSocketServer({ server, path: '/ws' }) : new WebSocketServer({ host: '127.0.0.1', port, path: '/ws' });
  await new Promise<void>((resolve, reject) => {
    const listening = server ?? wss;
    listening.once('listening', resolve);
    listening.once('error', reject);
    server?.listen(socketPath);
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

  /** The requests `requests.jsonl` keeps. */
  const RECORDED = new Set<Inbound['type']>(['agent.create.request', 'cancel_agent_request', 'archive_workspace_request']);

  /** The requests already held for the delay `models_ms`, `open_ms`, `create_ms` or `archive_ms` gives them. */
  const held = new WeakSet<Inbound>();

  /** Opens the member's own workspaces once, as the app did before teamai came. */
  const openMembers = (): void => {
    for (const dir of behaviour().member_workspaces) {
      const cwd = path.resolve(dir);
      kept.workspaces[cwd] ??= `wks_${createHash('sha256').update(`member:${cwd}`).digest('hex').slice(0, 16)}`;
    }
  };

  function handle(message: Inbound, reply: (message: Reply) => void): void {
    openMembers();
    const { models_ms: listing, open_ms: opening, create_ms: creating, archive_ms: archiving } = behaviour();
    const holds: Partial<Record<Inbound['type'], number>> = { list_provider_models_request: listing, open_project_request: opening, 'agent.create.request': creating, archive_workspace_request: archiving };
    const hold = holds[message.type] ?? 0;

    // Recorded as it arrives, so a test sees a create the daemon still holds.
    if (!held.has(message) && RECORDED.has(message.type)) record(message);

    if (hold > 0 && !held.has(message)) {
      held.add(message);
      const early = message.type === 'agent.create.request' ? behaviour().refuse_create_early : undefined;

      if (message.type === 'agent.create.request' && early !== undefined) reply({ type: 'agent.create.response', payload: { requestId: message.requestId, agent: null, error: early } });
      timers.add(setTimeout(() => handle(message, early === undefined ? reply : () => {}), hold));

      return;
    }

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

        if (models.length === 0) {
          // As Paseo answers a provider whose catalog failed, such as OpenCode connected to no model provider.
          reply({ type: 'list_provider_models_response', payload: { requestId: message.requestId, provider: message.provider, error: `${message.provider} has no connected providers.`, fetchedAt: now() } });

          return;
        }

        reply({
          type: 'list_provider_models_response',
          payload: {
            requestId: message.requestId, provider: message.provider, error: null, fetchedAt: now(),
            models: models.map((id, index) => ({ provider: message.provider, id, label: id, isDefault: index === 0, thinkingOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] })),
          },
        });

        return;
      }

      case 'get_providers_snapshot_request': {
        // A full snapshot, as a daemon answers a client that names no hash it holds.
        const { models: offered, default_modes: defaults } = behaviour();

        const entries = Object.keys(MODES).filter(isProvider).map((provider) => ({
          provider, status: Object.hasOwn(offered, provider) ? 'ready' as const : 'unavailable' as const, enabled: true, source: 'builtin' as const, label: provider,
          modes: MODES[provider], defaultModeId: Object.hasOwn(defaults, provider) ? defaults[provider] : DEFAULT_MODES[provider],
        }));

        reply({ type: 'get_providers_snapshot_response', payload: { requestId: message.requestId, entries, generatedAt: now() } });

        return;
      }

      case 'provider_diagnostic_request': {
        const does = behaviour();
        const resolved = message.provider === 'codex' ? does.codex_path ?? hostCodex(state, does.codex_login) : `/usr/local/bin/${message.provider}`;
        reply({ type: 'provider_diagnostic_response', payload: { requestId: message.requestId, provider: message.provider, diagnostic: diagnosticOf(message.provider, does.sign_in[message.provider], resolved) } });

        return;
      }

      case 'list_provider_modes_request':
        reply({ type: 'list_provider_modes_response', payload: { requestId: message.requestId, provider: message.provider, modes: modesOf(message.provider), error: null, fetchedAt: now() } });

        return;
      case 'open_project_request': {
        if (!fs.existsSync(message.cwd)) {
          // As Paseo answers a directory that is gone.
          reply({ type: 'open_project_response', payload: { requestId: message.requestId, workspace: null, error: `Directory not found: ${message.cwd}`, errorCode: 'directory_not_found' } });

          return;
        }

        // As Paseo keys a directory's workspace: by its path, resolved but never through its links.
        const cwd = path.resolve(message.cwd);
        const made = kept.workspaces[cwd] === undefined;
        const id = kept.workspaces[cwd] ?? `wks_${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}`;
        kept.workspaces[cwd] = id;
        save();
        const answer = (): void => reply({ type: 'open_project_response', payload: { requestId: message.requestId, workspace: workspaceOf(id, cwd), error: null } });
        const late = made ? behaviour().open_reply_ms : 0;

        if (late > 0) timers.add(setTimeout(answer, late));
        else answer();

        return;
      }

      case 'fetch_workspaces_request': {
        const entries = Object.entries(kept.workspaces).map(([cwd, id]) => workspaceOf(id, cwd));
        reply({ type: 'fetch_workspaces_response', payload: { requestId: message.requestId, entries, pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } } });

        return;
      }

      case 'agent.create.request': {
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

        const modes = modesOf(message.config.provider);
        const { modeId } = message.config;

        // Paseo refuses a mode its provider does not list, a preset the provider would take included (recorded, 0.14.0).
        if (modeId && !modes.some((mode) => mode.id === modeId)) {
          reply({ type: 'agent.create.response', payload: { requestId: message.requestId, agent: null, error: `Invalid mode '${modeId}' for provider '${message.config.provider}'. Available modes: ${modes.map((mode) => mode.id).join(', ')}` } });

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
        reply({
          type: 'agent.create.response',
          payload: agent.behaviour.lose_create_reply
            ? { requestId: message.requestId, agent: null, error: 'Connection reset before the create was answered' }
            : { requestId: message.requestId, agent: snapshot(agent), creation: creation(agent), error: null },
        });
        work(agent);

        return;
      }

      case 'fetch_agent_request': {
        // As Paseo: an unknown agent is a null agent, not an error.
        const agent = kept.agents[message.agentId];
        const refused = behaviour().refuse_fetch;
        reply({ type: 'fetch_agent_response', payload: { requestId: message.requestId, agent: agent && !refused ? snapshot(agent) : null, project: null, error: refused ?? null } });

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
          reply({ type: 'wait_for_finish_response', payload: { requestId: message.requestId, status, final: snapshot(agent), error: agent.lastError ?? null, lastMessage: status === 'idle' ? agent.behaviour.reply : null } });

          return true;
        };

        const wait = (): void => {
          if (!answer()) waiters.set(agent.id, [...waiters.get(agent.id) ?? [], wait]);
        };

        wait();

        return;
      }

      case 'cancel_agent_request': {
        const agent = kept.agents[message.agentId];
        const { refuse_cancel: refused, refuse_cancel_ms: refusing } = behaviour();

        if (refused) {
          setTimeout(() => reply({ type: 'cancel_agent_response', payload: { requestId: message.requestId ?? '', agentId: message.agentId, agent: agent ? snapshot(agent) : null, error: refused } }), refusing);

          return;
        }

        if (agent) stop(agent, 'idle');

        reply({ type: 'cancel_agent_response', payload: { requestId: message.requestId ?? '', agentId: message.agentId, agent: agent ? snapshot(agent) : null, error: agent ? null : `Agent not found: ${message.agentId}` } });

        return;
      }

      case 'archive_workspace_request': {
        const refused = behaviour().refuse_archive;

        // Paseo deletes only worktrees it created, so archiving teamai's leaves the directory in place.
        if (!refused) {
          for (const [cwd, id] of Object.entries(kept.workspaces)) if (id === message.workspaceId) delete kept.workspaces[cwd];
          save();

          for (const agent of Object.values(kept.agents)) if (agent.workspaceId === message.workspaceId) stop(agent, 'closed');
        }

        reply({ type: 'archive_workspace_response', payload: { requestId: message.requestId, workspaceId: message.workspaceId, archivedAt: refused ? null : now(), error: refused ?? null } });

        return;
      }

      default:
        throw new Error(`The fake Paseo daemon does not answer ${message.type}`);
    }
  }

  const url = socketPath === undefined ? `ws://127.0.0.1:${z.object({ port: z.number() }).parse(wss.address()).port}/ws` : `ws+unix://${socketPath}:/ws`;

  return {
    url,
    close: async () => {
      for (const timer of timers) clearInterval(timer);

      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    },
  };
}

/**
 * A provider's diagnostic, as Paseo 0.14.0 formats it (recorded): Claude's `Auth` row quotes `claude auth status`, which
 * fails when signed out; OpenCode's quotes `opencode auth list`; Codex's has no `Auth` row.
 */
function diagnosticOf(provider: string, signIn: 'signed_out' | 'unreported' | undefined, resolved: string): string {
  const rows = [`  Binary: ${provider}`, `  Resolved path: ${resolved}`];
  const isSignedOut = signIn === 'signed_out';

  if (signIn !== 'unreported' && provider === 'claude') {
    rows.push(`  Auth: {\n  "loggedIn": ${String(!isSignedOut)},\n  "authMethod": "${isSignedOut ? 'none' : 'oauth_token'}",\n  "apiProvider": "firstParty"\n}${isSignedOut ? '\nCommand failed: /usr/local/bin/claude auth status' : ''}`);
  } else if (signIn !== 'unreported' && provider === 'opencode') {
    rows.push(`  Auth: \n    ${isSignedOut ? 'No authenticated integrations' : '●  Anthropic oauth'}`);
  }

  return [provider, ...rows, '  Status: Ready'].join('\n');
}

/**
 * The path of the daemon host's `codex`, which answers `codex login status` as `login` says, as Codex 0.166.0 does on
 * stderr (recorded); with no `login`, the path holds nothing.
 */
function hostCodex(state: string, login: 'signed_in' | 'signed_out' | 'unknown' | undefined): string {
  const file = path.join(state, 'host-bin', 'codex');
  fs.rmSync(file, { force: true });

  if (login) {
    const answers = { signed_in: ['Logged in using ChatGPT', 0], signed_out: ['Not logged in', 1], unknown: ['error: unrecognized subcommand: status', 2] } as const;
    const [answer, code] = answers[login];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n[ "$*" = "login status" ] || exit 2\necho '${answer}' >&2\nexit ${code}\n`, { mode: 0o755 });
  }

  return file;
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
