import { createPaseoApi, type PaseoAgent, type PaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import type { WebSocketFactory } from '@getpaseo/client/internal/daemon-client-transport-types';
import { buildAgentDeepLink } from '@getpaseo/protocol/agent-deep-link';
import type { RuntimeFailure } from '@teamai/runtime-protocol';
import WebSocket from 'ws';
import type { AgentCreate } from './journal.js';

// ─── The Paseo daemon ────────────────────────────────────
//
//  One connection to a Paseo daemon over its WebSocket protocol, through @getpaseo/client. Cancel and wait live on the
//  client's internal driver, which is why the client is pinned to the version this runtime was tested against.
//

/** The client version this runtime is built and tested against; an older daemon lacks what it relies on. */
export const PINNED_CLIENT = '0.14.0';

/** What this runtime needs of the daemon: agent creates with caller-chosen ids that a repeated key answers. */
const NEEDED_FEATURES = ['creationLifecycle', 'agentRequestReceipts'] as const;

/**
 * The Paseo mode each tool starts in, as `--driver local` launches it without `permissions: unattended`: the tool's
 * default, which asks before it edits or runs what its own rules do not allow. Never a bypass mode.
 */
export const DEFAULT_MODES: Readonly<Record<PaseoTool, string>> = { claude: 'default', codex: 'auto', opencode: 'build' };

/** The tools this runtime runs as Paseo agents: Paseo's providers that are teamai tools of the same name. */
export type PaseoTool = 'claude' | 'codex' | 'opencode';

export function isPaseoTool(tool: string): tool is PaseoTool {
  return Object.hasOwn(DEFAULT_MODES, tool);
}

const CONNECT_TIMEOUT_MS = 10_000;

/** Whether `version` is `floor` or later, comparing major, minor and patch. */
function atLeast(version: string, floor: string): boolean {
  const parts = (text: string): number[] => text.split(/[.-]/).slice(0, 3).map(Number);
  const [have, need] = [parts(version), parts(floor)];

  for (let index = 0; index < 3; index += 1) {
    if ((have[index] ?? 0) !== (need[index] ?? 0)) return (have[index] ?? 0) > (need[index] ?? 0);
  }

  return true;
}

export interface Model {
  id: string;
  /** The model Paseo starts the tool on when none is named. */
  isDefault: boolean;
  efforts: string[];
}

export type WaitEnd = Awaited<ReturnType<DaemonClient['waitForFinish']>>;

export interface Daemon {
  url: string;
  serverId: string;
  version: string;
  /** The tools whose provider the daemon has, with the mode a step starts in. */
  tools(): Promise<PaseoTool[]>;
  models(tool: PaseoTool): Promise<Model[]>;
  /** Adopts a directory as a Paseo workspace; Paseo answers the same workspace for the same directory. */
  workspace(cwd: string): Promise<{ id: string; name: string; directory: string }>;
  /** Creates the agent in the workspace of `cwd`, or answers the one a repeated create made. */
  create(cwd: string, create: AgentCreate): Promise<void>;
  agent(agentId: string): Promise<PaseoAgent | null>;
  /** Waits until the agent's turn ends or needs a person. */
  wait(agentId: string): Promise<WaitEnd>;
  cancel(agentId: string): Promise<void>;
  link(agentId: string): string;
  close(): Promise<void>;
}

/** A WebSocket from `ws`, as the client binds one: Node 20 has no WebSocket of its own. */
const nodeWebSocket: WebSocketFactory = (target, options) => {
  const socket = new WebSocket(target, options?.protocols, { headers: options?.headers });
  socket.binaryType = 'arraybuffer';

  return {
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    on: (event, listener) => {
      socket.on(event, listener);
    },
    off: (event, listener) => {
      socket.off(event, listener);
    },
  };
};

/** Connects to the daemon at `url` and checks it runs what this runtime needs, or says why it cannot be used. */
export async function connect(url: string): Promise<Daemon | RuntimeFailure> {
  const client = new DaemonClient({
    url,
    clientId: 'teamai-runtime-paseo',
    clientType: 'cli',
    webSocketFactory: nodeWebSocket,
    // A daemon restart mid-step drops the connection; the client reconnects and a pending wait is asked again.
    reconnect: { enabled: true, baseDelayMs: 250, maxDelayMs: 2000 },
    suppressSendErrors: true,
  });

  let timer: NodeJS.Timeout | undefined;

  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), CONNECT_TIMEOUT_MS);
  });

  try {
    const connected = await Promise.race([client.connect().then(() => 'connected' as const), timedOut]);

    if (connected === 'timeout') throw new Error(`no answer in ${CONNECT_TIMEOUT_MS / 1000} s`);
  } catch (error) {
    await client.close().catch(() => {});

    return { code: 'daemon_unreachable', message: `No Paseo daemon answers at ${url} (${error instanceof Error ? error.message : String(error)}). Start it with \`paseo start\`, or set the runtime's url option to the daemon's address.` };
  } finally {
    clearTimeout(timer);
  }

  const info = client.getLastServerInfoMessage();
  const version = info?.version ?? 'unknown';
  const missing = NEEDED_FEATURES.filter((feature) => info?.features?.[feature] !== true);

  if (!info || !atLeast(version, PINNED_CLIENT) || missing.length > 0) {
    await client.close().catch(() => {});
    const lacks = missing.length > 0 ? `, and lacks ${missing.join(', ')}` : '';

    return { code: 'daemon_version', message: `The Paseo daemon at ${url} runs version ${version}${lacks}; teamai-runtime-paseo needs Paseo ${PINNED_CLIENT} or later. Update Paseo, then restart its daemon.` };
  }

  const api: PaseoApi = createPaseoApi(client);
  const serverId = info.serverId;

  return {
    url,
    serverId,
    version,
    async tools() {
      const { providers } = await api.providers.listAvailable();
      const available = providers.filter((entry) => entry.available).map((entry) => entry.provider).filter(isPaseoTool);

      // A provider whose default mode is gone would start in some other mode: it is not offered.
      const offered = await Promise.all(available.map(async (tool) => {
        const { modes = [] } = await api.providers.listModes(tool);

        return modes.some((mode) => mode.id === DEFAULT_MODES[tool]) ? [tool] : [];
      }));

      return offered.flat();
    },
    async models(tool) {
      const { models = [] } = await api.providers.listModels(tool);

      return models.map((model) => ({ id: model.id, isDefault: model.isDefault === true, efforts: (model.thinkingOptions ?? []).map((option) => option.id) }));
    },
    async workspace(cwd) {
      const opened = await api.workspaces.open({ cwd });
      const current = opened.current();

      return { id: opened.id, name: current?.projectDisplayName ?? opened.name ?? opened.id, directory: opened.directory ?? cwd };
    },
    async create(cwd, create) {
      // Paseo keeps a create's env in plain text and applies it again on resume, so it gets none: tools use the daemon
      // host's own logins.
      await (await api.workspaces.open({ cwd })).agents.create(create);
    },
    async agent(agentId) {
      return (await client.fetchAgent(agentId))?.agent ?? null;
    },
    wait: (agentId) => client.waitForFinish(agentId, 0),
    cancel: (agentId) => client.cancelAgent(agentId),
    link: (agentId) => buildAgentDeepLink({ serverId, agentId }),
    async close() {
      await api.dispose().catch(() => {});
      await client.close().catch(() => {});
    },
  };
}
