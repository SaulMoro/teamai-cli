import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { expandHome } from '@teamai/tool-core/home';
import { z } from 'zod';
import type { PaseoAgent, PaseoApi } from '@getpaseo/client';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import type { WebSocketFactory } from '@getpaseo/client/internal/daemon-client-transport-types';
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
 * The Paseo mode a tool answers a confined prompt in: one that reads without asking and asks before it edits or runs
 * anything, which ends the prompt. Each mode Paseo lists for Codex writes the workspace without asking, and Paseo
 * refuses any other, so Codex answers in `auto`, which asks before anything its sandbox does not allow, with its
 * sandbox set read-only (`CONFINED_OPTIONS`).
 */
export const CONFINED_MODES: Readonly<Record<PaseoTool, string>> = { claude: 'default', codex: 'auto', opencode: 'plan' };

/** The launch options a confined prompt starts with: for Codex, a sandbox that writes nothing, over its mode's own. */
export const CONFINED_OPTIONS: Readonly<Record<PaseoTool, { sandbox_mode: 'read-only' } | undefined>> = { claude: undefined, codex: { sandbox_mode: 'read-only' }, opencode: undefined };

/** The tools this runtime runs as Paseo agents: Paseo's providers that are teamai tools of the same name. */
export type PaseoTool = 'claude' | 'codex' | 'opencode';

export function isPaseoTool(tool: string): tool is PaseoTool {
  return Object.hasOwn(CONFINED_MODES, tool);
}

/**
 * The Paseo mode a step's agent starts in: the one Paseo sets as the tool's default, as the member's own agents start
 * in, or none, so Paseo starts the tool as it does when it sets no default (OpenCode). A default that never asks is
 * never taken: the step starts in the nearest mode before it in Paseo's list that asks, and `insteadOf` names the
 * default it passed over, for the start to say so once a runtime can.
 */
export type StepMode = { id?: undefined } | { id: string; insteadOf?: string };

/** A mode as Paseo lists it, in its order: `dangerous` is how Paseo marks one that never asks. */
type ListedMode = { id: string; colorTier?: string };

const isBypass = (mode: ListedMode): boolean => mode.colorTier === 'dangerous';

/** The mode a step of `tool` starts in, from Paseo's default and its list, or why the tool cannot be offered. */
function stepModeOf(tool: PaseoTool, defaultMode: string | null | undefined, modes: ListedMode[]): StepMode | { cannot: string } {
  if (defaultMode === null || defaultMode === undefined) return {};
  const at = modes.findIndex((mode) => mode.id === defaultMode);
  const listed = modes.map((mode) => mode.id).join(', ') || 'none';

  if (at === -1) return { cannot: `Paseo sets its default mode to ${defaultMode}, which it does not list for ${tool} (${listed}); run \`paseo provider ls\` on the daemon's host to see its modes` };
  const chosen = modes[at];

  if (chosen && !isBypass(chosen)) return { id: chosen.id };
  const tighter = modes.slice(0, at).findLast((mode) => !isBypass(mode));

  return tighter
    ? { id: tighter.id, insteadOf: defaultMode }
    : { cannot: `Paseo sets its default mode to ${defaultMode}, which never asks, and lists no mode before it that does (${listed})` };
}

const CONNECT_TIMEOUT_MS = 10_000;

export interface Model {
  id: string;
  /** The model Paseo starts the tool on when none is named. */
  isDefault: boolean;
  efforts: string[];
}

/** How an agent create ended: created, failed before it was sent, or failed once sent, when its agent may still start. */
export type Creation = { outcome: 'created' } | { outcome: 'unsent' | 'failed'; cause: string };

export type WaitEnd = Awaited<ReturnType<DaemonClient['waitForFinish']>>;

/**
 * A tool installed on the daemon's host: one it can run, with its modes and the one a step starts in, or why it cannot,
 * for a person to read.
 */
export type InstalledTool = { tool: PaseoTool; canRun: true; modes: string[]; stepMode: StepMode } | { tool: PaseoTool; canRun: false; reason: string };


/** How long `codex login status` may take, as Paseo gives `claude auth status` in Claude's diagnostic. */
const SIGN_IN_CHECK_TIMEOUT_MS = 5_000;

/**
 * `<codex> login status`, killed whole when it does not answer in time: an npm `codex` is a shim that starts the native
 * binary, and killing the shim alone leaves that running. On POSIX it runs in a process group of its own; on Windows,
 * where cross-spawn runs a `.cmd` through cmd.exe, taskkill ends the tree under the process it started.
 */
function codexLoginStatus(codex: string): Promise<{ code: number; answer: string }> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const child = spawn(codex, ['login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'], detached: !isWindows, windowsHide: true });
    let answer = '';

    const timer = setTimeout(() => {
      try {
        if (child.pid === undefined) child.kill('SIGKILL');
        // A taskkill that cannot run leaves the process teamai started to be killed on its own, as on POSIX.
        else if (isWindows) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => { if (error) child.kill('SIGKILL'); });
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }

      reject(new Error(`no answer in ${SIGN_IN_CHECK_TIMEOUT_MS} ms`));
    }, SIGN_IN_CHECK_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8').on('data', (text: string) => { answer += text; });
    child.stderr?.setEncoding('utf8').on('data', (text: string) => { answer += text; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, answer });
    });
  });
}

/**
 * Whether teamai may run the Codex the daemon resolves, as the member. It must be an absolute path, since a relative one
 * would resolve on teamai's PATH rather than the daemon's, to a file named `codex`, or on Windows to the binary
 * `codex.exe` or npm's `codex.cmd`, in any case.
 */
export function isCodexExecutable(resolved: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return path.win32.isAbsolute(resolved) && /^codex\.(?:exe|cmd)$/i.test(path.win32.basename(resolved));

  return path.posix.isAbsolute(resolved) && path.posix.basename(resolved) === 'codex';
}

/** The daemon's address when Paseo's config names none, as Paseo listens by default. */
const DEFAULT_URL = 'ws://127.0.0.1:6767/ws';

const PaseoConfigSchema = z.object({ daemon: z.object({ listen: z.string().min(1).optional() }).optional() });

/** A path as Paseo expands it: `~` and `~/…` under the member's home, then resolved. */

/**
 * The WebSocket address of a daemon that listens at `listen`, read as Paseo reads its own `daemon.listen`: a Unix socket
 * path (`/…`, `~/…` or `unix://…`), a port alone on 127.0.0.1, or `host:port`. A daemon that listens on every
 * interface is reached on 127.0.0.1. Or why this runtime cannot reach it.
 */
function urlOfListen(listen: string): { url: string } | { cannot: string } {
  const trimmed = listen.trim();

  if (trimmed.startsWith('pipe://') || trimmed.startsWith('\\\\.\\pipe\\')) return { cannot: `it listens on the Windows named pipe ${trimmed}, which teamai-runtime-paseo cannot reach` };

  if (trimmed.startsWith('unix://')) return { url: `ws+unix://${path.resolve(expandHome(trimmed.slice('unix://'.length)))}:/ws` };

  if (trimmed.startsWith('/') || trimmed.startsWith('~')) return { url: `ws+unix://${path.resolve(expandHome(trimmed))}:/ws` };

  if (/^\d+$/.test(trimmed)) return { url: `ws://127.0.0.1:${trimmed}/ws` };
  const at = trimmed.lastIndexOf(':');
  const port = trimmed.slice(at + 1);

  if (at === -1 || !/^\d+$/.test(port)) return { cannot: `"${listen}" is neither a port, a host and port, nor a socket path` };
  const host = trimmed.slice(0, at).replace(/^\[(.*)\]$/, '$1');
  const reached = host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  return { url: `ws://${reached.includes(':') ? `[${reached}]` : reached}:${port}/ws` };
}

/**
 * The address of the daemon the member's Paseo runs: the one `daemon.listen` names in Paseo's own config,
 * `$PASEO_HOME/config.json` (`PASEO_HOME` defaults to `~/.paseo`), or Paseo's default address when that config names
 * none. A config that cannot be read fails, rather than send teamai's steps to another daemon.
 */
export function daemonUrl(env: NodeJS.ProcessEnv): { url: string } | RuntimeFailure {
  const file = path.join(path.resolve(expandHome(env.PASEO_HOME || '~/.paseo')), 'config.json');

  const cannot = (why: string): RuntimeFailure => ({
    code: 'paseo_config',
    message: `teamai-runtime-paseo could not read the Paseo daemon's address from ${file}: ${why}. Fix that file, or set the runtime's url option to the daemon's address.`,
  });

  let text: string;

  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { url: DEFAULT_URL };

    return cannot(error instanceof Error ? error.message : String(error));
  }

  let config: z.infer<typeof PaseoConfigSchema>;

  try {
    const parsed = PaseoConfigSchema.safeParse(JSON.parse(text));

    if (!parsed.success) return cannot(`its daemon section is not what Paseo writes (${parsed.error.issues[0]?.message ?? 'unexpected shape'})`);
    config = parsed.data;
  } catch (error) {
    return cannot(error instanceof Error ? error.message : String(error));
  }

  const listen = config.daemon?.listen;

  if (listen === undefined) return { url: DEFAULT_URL };
  const address = urlOfListen(listen);

  return 'cannot' in address ? cannot(address.cannot) : address;
}

/** Whether `url` names a daemon on this machine: a Unix socket, or a loopback address, the only one whose host is surely this one. */
function isOnThisMachine(url: string): boolean {
  if (url.startsWith('ws+unix://')) return true;
  const host = new URL(url).hostname.replace(/^\[(.*)\]$/, '$1');

  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export interface Daemon {
  url: string;
  serverId: string;
  version: string;
  /** The tools whose provider the daemon has installed, each one it can run when signed in and Paseo gives it a mode a step can start in. */
  installedTools(): Promise<InstalledTool[]>;
  models(tool: PaseoTool): Promise<Model[]>;
  /** Adopts a directory as a Paseo workspace; Paseo answers the same workspace for the same directory. */
  workspace(cwd: string): Promise<{ id: string; name: string; directory: string }>;
  /**
   * Creates the agent in the workspace of `cwd`, or answers the one a repeated create made. A create that failed says
   * whether it was sent: one Paseo refused may still start its agent, and only one never sent proves none started.
   */
  create(cwd: string, create: AgentCreate): Promise<Creation>;
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

        if (!isCodexExecutable(resolved)) {
          return `Paseo resolves it to "${resolved}", which is not an absolute path to a codex; run \`paseo provider diagnostic codex\` on the daemon's host to see why`;
        }

        let status: Awaited<ReturnType<typeof codexLoginStatus>>;

        try {
          status = await codexLoginStatus(resolved);
        } catch (error) {
          return `\`${resolved} login status\` did not answer (${error instanceof Error ? error.message : String(error)}); run it on the daemon's host to see why`;
        }

        // Codex 0.166.0 prints "Logged in using …" with exit 0 when signed in, and "Not logged in" with exit 1 when not.
        const { answer } = status;

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
      // The snapshot carries each provider's default mode, which the member's own agents start in.
      const [{ providers }, { entries }] = await Promise.all([api.providers.listAvailable(), api.providers.snapshot()]);
      const installed = providers.filter((entry) => entry.available).map((entry) => entry.provider).filter(isPaseoTool);

      return Promise.all(installed.map(async (tool): Promise<InstalledTool> => {
        const reason = await signInProblem(tool);

        if (reason !== undefined) return { tool, canRun: false, reason };
        const modes = (await api.providers.listModes(tool)).modes ?? [];
        const stepMode = stepModeOf(tool, entries.find((entry) => entry.provider === tool)?.defaultModeId, modes);

        return 'cannot' in stepMode ? { tool, canRun: false, reason: stepMode.cannot } : { tool, canRun: true, modes: modes.map((mode) => mode.id), stepMode };
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
      let workspace: Awaited<ReturnType<PaseoApi['workspaces']['open']>>;

      try {
        workspace = await api.workspaces.open({ cwd });
      } catch (error) {
        return { outcome: 'unsent', cause: error instanceof Error ? error.message : String(error) };
      }

      try {
        await workspace.agents.create(create);

        return { outcome: 'created' };
      } catch (error) {
        return { outcome: 'failed', cause: error instanceof Error ? error.message : String(error) };
      }
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
