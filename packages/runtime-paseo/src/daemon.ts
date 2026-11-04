import type { PaseoAgent, PaseoApi } from '@getpaseo/client';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import type { WebSocketFactory } from '@getpaseo/client/internal/daemon-client-transport-types';
import { execCommand } from '@teamai/tool-core/exec';
import type { RuntimeFailure } from '@teamai/runtime-protocol';
import { atLeast, OLDEST_PASEO, type PaseoClient } from './client.js';
import type { AgentCreate } from './journal.js';

// ─── The Paseo daemon ────────────────────────────────────
//
//  One connection to a Paseo daemon over its WebSocket protocol, through the @getpaseo/client the member's Paseo
//  installed (client.ts). Cancel and wait live on the client's internal driver, which is why the daemon must run the
//  version this runtime was tested against or later.
//

/** What this runtime needs of the daemon: agent creates with caller-chosen ids that a repeated key answers. */
const NEEDED_FEATURES = ['creationLifecycle', 'agentRequestReceipts'] as const;

/**
 * The Paseo mode each tool starts in, as `--driver local` launches it without `permissions: unattended`: the tool's
 * default, which asks before it edits or runs what its own rules do not allow. Never a bypass mode.
 */
export const DEFAULT_MODES: Readonly<Record<PaseoTool, string>> = { claude: 'default', codex: 'auto', opencode: 'build' };

/**
 * The Paseo mode a tool answers a confined prompt in: one that reads without asking and asks before it edits or runs
 * anything, which ends the prompt. Each mode Paseo lists for Codex writes the workspace without asking, and Paseo
 * refuses any other, so Codex answers in `auto`, which asks before anything its sandbox does not allow, with its
 * sandbox set read-only (`CONFINED_CODEX_OPTIONS`).
 */
export const CONFINED_MODES: Readonly<Record<PaseoTool, string>> = { claude: 'default', codex: 'auto', opencode: 'plan' };

/** The launch options a confined prompt starts with: for Codex, a sandbox that writes nothing, over its mode's own. */
export const CONFINED_OPTIONS: Readonly<Record<PaseoTool, { sandbox_mode: 'read-only' } | undefined>> = { claude: undefined, codex: { sandbox_mode: 'read-only' }, opencode: undefined };

/** The tools this runtime runs as Paseo agents: Paseo's providers that are teamai tools of the same name. */
export type PaseoTool = 'claude' | 'codex' | 'opencode';

export function isPaseoTool(tool: string): tool is PaseoTool {
  return Object.hasOwn(DEFAULT_MODES, tool);
}

const CONNECT_TIMEOUT_MS = 10_000;

export interface Model {
  id: string;
  /** The model Paseo starts the tool on when none is named. */
  isDefault: boolean;
  efforts: string[];
}

export type WaitEnd = Awaited<ReturnType<DaemonClient['waitForFinish']>>;

/** A tool installed on the daemon's host: one it can run, with its modes, or why it cannot, for a person to read. */
export type InstalledTool = { tool: PaseoTool; canRun: true; modes: string[] } | { tool: PaseoTool; canRun: false; reason: string };


/** How long `codex login status` may take, as Paseo gives `claude auth status` in Claude's diagnostic. */
const SIGN_IN_CHECK_TIMEOUT_MS = 5_000;

/** Whether `url` names a daemon on this machine: a loopback address, the only one whose host is surely this one. */
function isOnThisMachine(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[(.*)\]$/, '$1');

  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export interface Daemon {
  url: string;
  serverId: string;
  version: string;
  /** The tools whose provider the daemon has installed, each one it can run when signed in with the mode a step starts in. */
  installedTools(): Promise<InstalledTool[]>;
  models(tool: PaseoTool): Promise<Model[]>;
  /** Adopts a directory as a Paseo workspace; Paseo answers the same workspace for the same directory. */
  workspace(cwd: string): Promise<{ id: string; name: string; directory: string }>;
  /** Creates the agent in the workspace of `cwd`, or answers the one a repeated create made. */
  create(cwd: string, create: AgentCreate): Promise<void>;
  agent(agentId: string): Promise<PaseoAgent | null>;
  /** Waits until the agent's turn ends or needs a person. */
  wait(agentId: string): Promise<WaitEnd>;
  cancel(agentId: string): Promise<void>;
  /** Archives a workspace, which stops its agents; Paseo deletes only worktrees it created, so teamai's stays. */
  archive(workspaceId: string): Promise<void>;
  link(agentId: string): string;
  close(): Promise<void>;
}

/** A WebSocket from the client's `ws`, as the client binds one: Node 20 has no WebSocket of its own. */
const nodeWebSocket = (WebSocket: PaseoClient['WebSocket']): WebSocketFactory => (target, options) => {
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

/** Connects to the daemon at `url` through the installed `paseo` client and checks it runs what this runtime needs, or says why it cannot be used. */
export async function connect(url: string, paseo: PaseoClient): Promise<Daemon | RuntimeFailure> {
  const client: DaemonClient = new paseo.DaemonClient({
    url,
    clientId: 'teamai-runtime-paseo',
    clientType: 'cli',
    webSocketFactory: nodeWebSocket(paseo.WebSocket),
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

  if (!info || !atLeast(version, OLDEST_PASEO) || missing.length > 0) {
    await client.close().catch(() => {});
    const lacks = missing.length > 0 ? `, and lacks ${missing.join(', ')}` : '';

    return { code: 'daemon_version', message: `The Paseo daemon at ${url} runs version ${version}${lacks}; teamai-runtime-paseo needs Paseo ${OLDEST_PASEO} or later. Update Paseo, then restart its daemon.` };
  }

  const api: PaseoApi = paseo.createPaseoApi(client);
  const serverId = info.serverId;

  const models = async (tool: PaseoTool): Promise<Model[]> => {
    const { models: listed = [] } = await api.providers.listModels(tool);

    return listed.map((model) => ({ id: model.id, isDefault: model.isDefault === true, efforts: (model.thinkingOptions ?? []).map((option) => option.id) }));
  };

  /**
   * Why the daemon cannot run `tool`, or undefined when it can. Paseo calls a tool available once its binary is on PATH,
   * signed in or not, so each tool's sign-in is read from what Paseo reports of it.
   */
  const signInProblem = async (tool: PaseoTool): Promise<string | undefined> => {
    switch (tool) {
      case 'claude': {
        // Claude's diagnostic quotes `claude auth status`, which reports a login and an API key alike as logged in.
        const loggedIn = /"loggedIn":\s*(true|false)\b/.exec((await api.providers.diagnostic('claude')).diagnostic)?.[1];

        if (loggedIn === 'true') return undefined;

        return loggedIn === 'false'
          ? 'signed out; run `claude auth login` on the daemon\'s host'
          : 'Paseo does not report whether it is signed in; run `paseo provider diagnostic claude` on the daemon\'s host to see its Auth line';
      }

      case 'opencode':
        // Paseo lists OpenCode's models from the providers it reaches, its free ones included, and none when it reaches none.
        return (await models(tool)).length > 0 ? undefined : 'reaches no model provider; run `opencode auth login` on the daemon\'s host, then `paseo restart`';

      case 'codex': {
        // Paseo reports no Codex sign-in, so teamai asks Codex itself, which it can only where the daemon runs. It asks the
        // codex the daemon's diagnostic resolves on the daemon's PATH, which may not be the one on teamai's.
        if (!isOnThisMachine(url)) return `teamai checks Codex's sign-in only on a daemon at a loopback address, and ${url} is not one`;
        const resolved = /^\s*Resolved path: (.+)$/m.exec((await api.providers.diagnostic('codex')).diagnostic)?.[1]?.trim();

        if (resolved === undefined || resolved === 'not found') return 'Paseo reports no path for it; run `paseo provider diagnostic codex` on the daemon\'s host to see why';
        let status: Awaited<ReturnType<typeof execCommand>>;

        try {
          status = await execCommand(resolved, ['login', 'status'], { timeoutMs: SIGN_IN_CHECK_TIMEOUT_MS });
        } catch (error) {
          return `\`${resolved} login status\` did not answer (${error instanceof Error ? error.message : String(error)}); run it on the daemon's host to see why`;
        }

        // Codex 0.166.0 prints "Logged in using …" with exit 0 when signed in, and "Not logged in" with exit 1 when not.
        const answer = `${status.stdout}\n${status.stderr}`;

        if (status.code === 0 && /^Logged in\b/m.test(answer)) return undefined;

        if (status.code === 1 && /^Not logged in\b/m.test(answer)) return 'signed out; run `codex login` on the daemon\'s host';
        const said = answer.trim().split('\n')[0]?.slice(0, 120) ?? '';

        return `\`${resolved} login status\` gave no sign-in answer (exit ${status.code}${said ? `: ${said}` : ''}); run it on the daemon's host to see why`;
      }

      default: {
        const unhandled: never = tool;

        return unhandled;
      }
    }
  };

  return {
    url,
    serverId,
    version,
    async installedTools() {
      const { providers } = await api.providers.listAvailable();
      const installed = providers.filter((entry) => entry.available).map((entry) => entry.provider).filter(isPaseoTool);

      return Promise.all(installed.map(async (tool): Promise<InstalledTool> => {
        const reason = await signInProblem(tool);

        if (reason !== undefined) return { tool, canRun: false, reason };

        // A provider whose default mode is gone would start in some other mode: it is not offered.
        const modes = (await api.providers.listModes(tool)).modes?.map((mode) => mode.id) ?? [];

        return modes.includes(DEFAULT_MODES[tool]) ? { tool, canRun: true, modes } : { tool, canRun: false, reason: `has no ${DEFAULT_MODES[tool]} mode, which teamai starts it in` };
      }));
    },
    models,
    async workspace(cwd) {
      const opened = await api.workspaces.open({ cwd });
      const current = opened.current();

      return { id: opened.id, name: current?.projectDisplayName ?? opened.name ?? opened.id, directory: opened.directory ?? cwd };
    },
    async create(cwd, create) {
      // Paseo keeps a create's env in plain text and applies it again on resume, so it carries no secret, only the run
      // directory's name: tools use the daemon host's own logins.
      await (await api.workspaces.open({ cwd })).agents.create(create);
    },
    async agent(agentId) {
      return (await client.fetchAgent(agentId))?.agent ?? null;
    },
    wait: (agentId) => client.waitForFinish(agentId, 0),
    cancel: (agentId) => client.cancelAgent(agentId),
    async archive(workspaceId) {
      // Paseo answers a refused archive with its error rather than throwing it.
      const { error } = await api.workspaces.archive(workspaceId);

      if (error) throw new Error(error);
    },
    link: (agentId) => paseo.buildAgentDeepLink({ serverId, agentId }),
    async close() {
      await api.dispose().catch(() => {});
      await client.close().catch(() => {});
    },
  };
}
