import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';
import { expandHome, getUserHome } from '@teamai/tool-core/home';
import { findOnPath } from '@teamai/tool-core/lookpath';
import { z } from 'zod';
import type { PaseoAgent, PaseoApi } from '@getpaseo/client';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import type { WebSocketFactory } from '@getpaseo/client/internal/daemon-client-transport-types';
import { RUN_DIR_ENV, type InitInstance, type RuntimeFailure } from '@teamai/runtime-protocol';
import { atLeast, OLDEST_PASEO, type PaseoClient } from './client.js';
import { paseoKeyOf, type AgentCreate } from './journal.js';

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

/** The tools this runtime runs, in the order it offers them. */
export const PASEO_TOOLS: readonly PaseoTool[] = Object.keys(CONFINED_MODES).filter(isPaseoTool);

/**
 * The Paseo mode a step's agent starts in: `unset`, so Paseo starts the tool as it does when it sets no default
 * (OpenCode); `asks`, Paseo's default for the tool, as the member's own agents start in, or the one the runtime's `mode`
 * option names; `tightened`, the nearest mode that asks before a default that never does, which `insteadOf` names for
 * the start to say so; `bypass`, a mode that never asks, taken only when the `mode` option names it.
 */
export type StepMode = { kind: 'unset' } | { kind: 'asks'; id: string } | { kind: 'tightened'; id: string; insteadOf: string } | { kind: 'bypass'; id: string };

/** The Paseo mode the runtime's `mode` option names for each tool it sets. */
export type ConfiguredModes = Partial<Record<PaseoTool, string>>;

/** A mode as Paseo lists it, in its order: `dangerous` is how Paseo marks one that never asks. */
type ListedMode = { id: string; colorTier?: string };

const isBypass = (mode: ListedMode): boolean => mode.colorTier === 'dangerous';

/**
 * The mode a step of `tool` starts in: the one the runtime's `mode` option names, else from Paseo's default and its
 * list, or why the tool cannot be offered.
 */
function stepModeOf(tool: PaseoTool, { defaultMode, configured, modes }: { defaultMode: string | null | undefined; configured: string | undefined; modes: ListedMode[] }): StepMode | { cannot: string } {
  const listed = modes.map((mode) => mode.id).join(', ') || 'none';

  if (configured !== undefined) {
    const named = modes.find((mode) => mode.id === configured);

    if (!named) return { cannot: `the runtime's mode option names ${configured} for it, which Paseo does not list for ${tool} (${listed}); name one of those` };

    return { kind: isBypass(named) ? 'bypass' : 'asks', id: named.id };
  }

  if (defaultMode === null || defaultMode === undefined) return { kind: 'unset' };
  const at = modes.findIndex((mode) => mode.id === defaultMode);

  if (at === -1) return { cannot: `Paseo sets its default mode to ${defaultMode}, which it does not list for ${tool} (${listed}); run \`paseo provider ls\` on the daemon's host to see its modes` };
  const chosen = modes[at];

  if (chosen && !isBypass(chosen)) return { kind: 'asks', id: chosen.id };
  const tighter = modes.slice(0, at).findLast((mode) => !isBypass(mode));

  return tighter
    ? { kind: 'tightened', id: tighter.id, insteadOf: defaultMode }
    : { cannot: `Paseo sets its default mode to ${defaultMode}, which never asks, and lists no mode before it that does (${listed})` };
}

const CONNECT_TIMEOUT_MS = 10_000;

/** What Paseo said of a request it failed: the daemon's own error, without the request details the client adds to it. */
const PaseoSaidSchema = z.union([
  z.object({ userMessage: z.string().min(1) }).transform(({ userMessage }) => userMessage),
  z.instanceof(Error).transform(({ message }) => message),
  z.unknown().transform(String),
]);

/**
 * How long a question an open asks Paseo may go unanswered: an open holds its directory meanwhile, and the two it asks
 * end well within the minute after which another open takes that hold over (`HOLD_STALE_MS`).
 */
const OPEN_QUESTION_TIMEOUT_MS = 20_000;

/**
 * What `asking` answers, or a failure once it gave no answer in `OPEN_QUESTION_TIMEOUT_MS`. Paseo still answers a
 * question teamai gave up on, so `later` says what a person does about what that answer leaves.
 */
async function answeredInTime<T>(asking: Promise<T>, later = ''): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${OPEN_QUESTION_TIMEOUT_MS / 1000} s; check that its daemon answers with \`paseo ls\`, then run the step again${later}`)), OPEN_QUESTION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([asking, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** The config directory `claude auth status` reports in Claude's diagnostic, when it reports an absolute one. */
function claudeHomeIn(diagnostic: string): string | undefined {
  const quoted = /"configDirectory":\s*("(?:[^"\\]|\\.)*")/.exec(diagnostic)?.[1];

  if (quoted === undefined) return undefined;

  try {
    const home = z.string().safeParse(JSON.parse(quoted));

    return home.success && path.isAbsolute(home.data) ? home.data : undefined;
  } catch {
    return undefined;
  }
}

/** The names under `dir`, newest first by name, as Codex's dated session folders sort; none when it cannot be read. */
const newestFirst = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir).toSorted().toReversed();
  } catch {
    return [];
  }
};

/** Whether the Codex home `home` holds the rollout of thread `threadId`: under `sessions/<yyyy>/<mm>/<dd>/`, or archived. */
function holdsRollout(home: string, threadId: string): boolean {
  const isRollout = (name: string): boolean => name.startsWith('rollout-') && name.endsWith(`-${threadId}.jsonl`);

  if (newestFirst(path.join(home, 'archived_sessions')).some(isRollout)) return true;
  const sessions = path.join(home, 'sessions');

  return newestFirst(sessions).some((year) => newestFirst(path.join(sessions, year)).some((month) => newestFirst(path.join(sessions, year, month))
    .some((day) => newestFirst(path.join(sessions, year, month, day)).some(isRollout))));
}

/**
 * The Codex home on this machine that holds the rollout of thread `threadId`, or undefined when none it can see does.
 * Paseo reports no Codex home, so the homes the daemon's Codex likely writes are looked in: the one its Paseo provider's
 * env sets, then the runtime's `CODEX_HOME`,
 * then `homeDir` (`.codex`, or a team instance's) in the account's home, where a daemon the Paseo app started runs, then
 * in `$HOME`.
 */
function codexHomeHolding(threadId: string, { providerHome, homeDir }: { providerHome: string | undefined; homeDir: string }): string | undefined {
  // The home a Paseo provider's env sets is the one its Codex writes.
  const homes: string[] = providerHome === undefined ? [] : [providerHome];
  // CODEX_HOME moves the Codex home, not a team instance's own.
  const moved = homeDir === '.codex' ? process.env.CODEX_HOME : undefined;

  if (moved && path.isAbsolute(moved)) homes.push(moved);

  try {
    homes.push(path.join(os.userInfo().homedir, homeDir));
  } catch {
    // No account entry for this user: its home is only $HOME.
  }

  homes.push(path.join(getUserHome(), homeDir));

  return [...new Set(homes)].find((home) => holdsRollout(home, threadId));
}

/**
 * The data directory of the daemon's OpenCode on this machine, its `XDG_DATA_HOME`, or undefined when none it can see
 * holds OpenCode's store. OpenCode 2 keeps every session in one database there, `opencode/opencode.db`, which names no
 * session in a file, so the directory is the first that holds that database: the one the provider's env sets, then the
 * runtime's `XDG_DATA_HOME`, then `.local/share` in `$HOME`, then in the account's home, where a daemon the Paseo app
 * started runs.
 */
function openCodeDataHome(providerHome: string | undefined): string | undefined {
  const homes = [providerHome, process.env.XDG_DATA_HOME, path.join(getUserHome(), '.local', 'share')];

  try {
    homes.push(path.join(os.userInfo().homedir, '.local', 'share'));
  } catch {
    // No account entry for this user: its home is only $HOME.
  }

  return homes.find((home): home is string => home !== undefined && path.isAbsolute(home) && fs.existsSync(path.join(home, 'opencode', 'opencode.db')));
}

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
 * What a step names as its tool, as Paseo runs it: `name`, a teamai tool or a team instance of one; `tool`, the tool it
 * is or extends, whose modes, grants and sign-in rule it takes; `provider`, the Paseo provider that runs it.
 */
export interface Target {
  name: string;
  tool: PaseoTool;
  provider: string;
}

/**
 * A tool or instance installed on the daemon's host: one it can run, with its modes and the one a step starts in, or
 * why it cannot, for a person to read.
 */
export type InstalledTool = (Target & { canRun: true; modes: string[]; stepMode: StepMode; home?: string; providerHome?: ProviderHome; toAdd?: ProviderToAdd }) | Unavailable;

/**
 * The tool home a Paseo custom provider's env sets for what it runs: `variable`, the one that moves that tool's home;
 * `dir`, the absolute directory it names; `teamaiHome`, the one teamai keeps that tool or instance's home in.
 */
export interface ProviderHome {
  variable: string;
  dir: string;
  teamaiHome: string;
}

/** The variable that moves `tool`'s home, which a Paseo provider's env may set: OpenCode's is its data directory's. */
function homeVariableOf(tool: PaseoTool): string {
  switch (tool) {
    case 'claude':
      return 'CLAUDE_CONFIG_DIR';
    case 'codex':
      return 'CODEX_HOME';
    case 'opencode':
      return 'XDG_DATA_HOME';
    default: {
      const unhandled: never = tool;

      return unhandled;
    }
  }
}

/** The directory under `$HOME` `tool`'s home is in when nothing moves it. */
function homeDirOf(tool: PaseoTool): string {
  switch (tool) {
    case 'claude':
      return '.claude';
    case 'codex':
      return '.codex';
    case 'opencode':
      return path.join('.local', 'share');
    default: {
      const unhandled: never = tool;

      return unhandled;
    }
  }
}

/** A tool or instance the daemon cannot run, and why, before or after a provider is found for it. */
type Unavailable = Pick<Target, 'name' | 'tool'> & { canRun: false; reason: string };

/**
 * How Paseo runs an instance on the provider teamai added for it, or why it cannot; `added` says whether this call added
 * that provider, which stays though the instance cannot run on it, as when it is signed out there.
 */
export type Added = { provider: string; added: boolean; home?: string; providerHome?: string } | { cannot: string; added: boolean };

/** What a definition and teamai choose of the tools a runtime offers: each tool's mode, the team's instances, and providers named for either. */
export interface ToolChoices {
  modes: ConfiguredModes;
  instances: readonly InitInstance[];
  /** A Paseo provider id for a tool or an instance name, over the one the runtime finds. */
  providers: Readonly<Record<string, string>>;
}

/**
 * The custom providers of the daemon's `agents.providers`, as much of each as tells which tool it extends, what it runs,
 * and its env, of which only the home variables are kept: the rest may hold a secret.
 */
const CustomProvidersSchema = z.record(z.string(), z.object({ extends: z.string().optional(), command: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }));

type CustomProviders = z.infer<typeof CustomProvidersSchema>;

/**
 * `providers` with only the variables of each env that move a tool's home, the shipped tools' and `variables`: the rest
 * may hold a secret, and none is kept.
 */
function keptOf(providers: CustomProviders, variables: readonly string[]): CustomProviders {
  const kept = new Set([...PASEO_TOOLS.map(homeVariableOf), ...variables]);

  return Object.fromEntries(Object.entries(providers).map(([id, entry]) => [id, {
    ...entry, ...(entry.env && { env: Object.fromEntries(Object.entries(entry.env).filter(([name]) => kept.has(name))) }),
  }]));
}

/** Whether a provider whose command starts with `executable` runs `command`: the same name, or an absolute path to it. */
const runsCommand = (executable: string | undefined, command: string): boolean => executable !== undefined
  && (executable === command || (path.isAbsolute(executable) && !path.isAbsolute(command) && path.basename(executable) === command));

/** Why the custom provider the runtime's providers option names cannot run `tool`, or undefined when it extends it. */
const namedProblem = (named: string, tool: PaseoTool, custom: CustomProviders): string | undefined => (custom[named]?.extends === tool
  ? undefined
  : `the runtime's providers option names ${named}, which the daemon's agents.providers does not hold as a provider that extends ${tool}`);

/**
 * A Paseo custom provider teamai adds for a team instance no provider runs: `id`, the instance's name; `entry`, what
 * `agents.providers` holds of it, which extends the instance's tool, runs its command from teamai's PATH (none for an
 * instance with only a home of its own: the tool's own), and sets the tool's home only for an instance with a home of
 * its own.
 */
export interface ProviderToAdd {
  id: string;
  entry: { extends: PaseoTool; label: string; command?: [string]; env?: Record<string, string> };
}

/** How Paseo names a custom provider: lowercase letters, digits and dashes, starting with a letter. */
const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;

/** The provider that runs a team instance, why none can, or the one teamai adds for it. */
type ProviderFound = { provider: string } | { cannot: string } | { add: ProviderToAdd };

/**
 * The Paseo provider that runs team instance `instance` of `tool`: the one `named` gives, which must extend `tool` and
 * run the instance's command, else the one custom provider that does, and, for an instance with only a home of its own,
 * the one that runs the tool's own command with that home. With none, the one teamai adds, when it can: on a daemon on
 * this machine, under the instance's name, with its command found on teamai's PATH. Or why it cannot, with how to set one
 * up. `home` is the absolute home the instance sets with `variable`, when it has one of its own.
 */
function providerOf(instance: InitInstance, tool: PaseoTool, { custom, named, home, variable, onThisMachine }: {
  custom: CustomProviders; named: string | undefined; home: string | undefined; variable: string; onThisMachine: boolean;
}): ProviderFound {
  const { command, name } = instance;

  if (named !== undefined) {
    const problem = namedProblem(named, tool, custom);
    const runs = custom[named]?.command?.[0];

    if (problem !== undefined) return { cannot: problem };

    return command === undefined || runsCommand(runs, command)
      ? { provider: named }
      : { cannot: `the runtime's providers option names ${named}, which runs ${runs ?? 'its tool\'s own command'} rather than its command ${command}; name a provider whose command is ${command}` };
  }

  // A provider with no command of its own runs the tool's.
  const runsOwn = (entry: CustomProviders[string]): boolean => (command === undefined
    ? (entry.command?.[0] === undefined || runsCommand(entry.command[0], tool)) && home !== undefined && entry.env?.[variable] === home
    : runsCommand(entry.command?.[0], command));

  if (command === undefined && home === undefined) {
    return { cannot: `the team instance names neither a command nor a home for Paseo to run ${tool} with; add a Paseo provider on the daemon's host that extends ${tool}, then name it in the runtime's providers option` };
  }

  const shownHome = instance.home ? `~/${instance.home.dir}` : '';
  const subject = command === undefined ? `no Paseo provider runs ${tool} in its home ${shownHome}` : `no Paseo provider runs its command ${command}`;
  const setUp = command === undefined ? `with env ${JSON.stringify({ [variable]: shownHome })}` : `with command ${JSON.stringify([command])}`;
  const matches = Object.entries(custom).flatMap(([id, entry]) => (entry.extends === tool && runsOwn(entry) ? [id] : []));
  const [only, second] = matches;

  if (second !== undefined) {
    return { cannot: `Paseo providers ${matches.slice(0, -1).join(', ')} and ${matches.at(-1) ?? ''} both run ${command === undefined ? `${tool} in its home ${shownHome}` : `its command ${command}`}; name the one to use in the runtime's providers option, such as providers: { ${name}: ${only ?? ''} }` };
  }

  if (only !== undefined) return { provider: only };

  if (!onThisMachine) {
    return { cannot: `${subject}, and teamai adds one only on a daemon on this machine; add one on the daemon's host that extends ${tool} ${setUp} (\`paseo daemon config set agents.providers …\`, then \`paseo daemon reload\`), or name one in the runtime's providers option` };
  }

  if (!PROVIDER_ID.test(name)) {
    return { cannot: `${subject}, and teamai cannot add one named ${name}, since Paseo names a provider with lowercase letters, digits and dashes only, starting with a letter; add one on the daemon's host that extends ${tool} ${setUp}, and name it in the runtime's providers option` };
  }

  const taken = custom[name];

  if (taken !== undefined) {
    const runs = command === undefined ? `${tool} in ${taken.env?.[variable] ?? `${tool}'s own home`}` : taken.command?.[0] ?? `${tool}'s own command`;
    const point = command === undefined ? `set ${variable} to ${shownHome} in its env` : `point that provider at ${command}`;

    return { cannot: `${subject}, and the Paseo provider ${name} runs ${runs} instead, so teamai adds none under that name; ${point}, or name the provider to use in the runtime's providers option` };
  }

  const found = command === undefined ? undefined : findOnPath(command);

  if (command !== undefined && found === null) {
    return { cannot: `${subject}, and teamai adds one only for a command on its PATH; install ${command} there, or name a Paseo provider that runs it in the runtime's providers option` };
  }

  return {
    add: {
      id: name,
      entry: { extends: tool, label: name, ...(found && { command: [found] }), ...(home !== undefined && { env: { [variable]: home } }) },
    },
  };
}

/**
 * What a tool's sign-in check found: why the daemon cannot run it, or that it can, with the tool home it keeps its
 * sessions in when Paseo reports it (Claude's `configDirectory`).
 */
type SignIn = { canRun: false; problem: string } | { canRun: true; home?: string };


/** How long `codex login status` may take, as Paseo gives `claude auth status` in Claude's diagnostic. */
const SIGN_IN_CHECK_TIMEOUT_MS = 5_000;

/**
 * The tool home a tool or team instance runs in on the daemon's host, when it is not the tool's own: the one its Paseo
 * provider's env sets, else a team instance's own. `shown` is how a sign-in step names it.
 */
interface RunsIn {
  variable: string;
  dir: string;
  shown: string;
}

/** How a person signs a tool in on the daemon's host, such as `codex login`: for a team instance, its own command in its own home. */
function signInStep({ runsIn, command, login }: { runsIn: RunsIn | undefined; command: string; login: string }): string {
  return `${runsIn ? `${runsIn.variable}=${runsIn.shown} ` : ''}${command} ${login}`;
}

/**
 * `<codex> login status`, killed whole when it does not answer in time: an npm `codex` is a shim that starts the native
 * binary, and killing the shim alone leaves that running. On POSIX it runs in a process group of its own; on Windows,
 * where cross-spawn runs a `.cmd` through cmd.exe, taskkill ends the tree under the process it started.
 */
function codexLoginStatus(codex: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; answer: string }> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const child = spawn(codex, ['login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'], detached: !isWindows, windowsHide: true, ...(env && { env }) });
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
 * `codex.exe` or npm's `codex.cmd`, in any case; for a team instance, named as the command its provider runs.
 */
export function isCodexExecutable(resolved: string, platform: NodeJS.Platform = process.platform, name = 'codex'): boolean {
  if (platform === 'win32') {
    const base = path.win32.basename(resolved).toLowerCase();

    return path.win32.isAbsolute(resolved) && (base === `${name.toLowerCase()}.exe` || base === `${name.toLowerCase()}.cmd`);
  }

  return path.posix.isAbsolute(resolved) && path.posix.basename(resolved) === name;
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

/** The member's Paseo home: `PASEO_HOME`, or `~/.paseo` as Paseo defaults it. */
export const paseoHome = (env: NodeJS.ProcessEnv): string => path.resolve(expandHome(env.PASEO_HOME || '~/.paseo'));

/**
 * The address of the daemon the member's Paseo runs: the one `daemon.listen` names in Paseo's own config,
 * `$PASEO_HOME/config.json` (`PASEO_HOME` defaults to `~/.paseo`), or Paseo's default address when that config names
 * none. A config that cannot be read fails, rather than send teamai's steps to another daemon.
 */
export function daemonUrl(env: NodeJS.ProcessEnv): { url: string } | RuntimeFailure {
  const file = path.join(paseoHome(env), 'config.json');

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
  /**
   * The tools whose provider the daemon has installed, and the team instances of them, each one it can run when signed
   * in and Paseo gives it a mode a step can start in.
   */
  installedTools(choices: ToolChoices): Promise<InstalledTool[]>;
  /**
   * Adds `toAdd` to the daemon's `agents.providers` for team instance `instance`, keeping every other entry, unless a
   * provider that runs the instance is there by now, and checks the instance's sign-in on it. Paseo saves and applies the
   * entry at once. Callers hold the daemon's providers across runtimes (`Journal.holdProviders`).
   */
  addProvider(toAdd: ProviderToAdd, instance: InitInstance): Promise<Added>;
  models(provider: string): Promise<Model[]>;
  /** Whether Paseo has an active workspace on a directory, as one the member opened in the app; fails with no answer in 20 s. */
  isOpen(cwd: string): Promise<boolean>;
  /** The agents of a workspace that no archive closed and teamai did not start (they carry no `teamai-attempt` label): the member's. */
  memberAgentsIn(workspaceId: string): Promise<string[]>;
  /** Adopts a directory as a Paseo workspace; Paseo answers the same workspace for the same directory. Fails with no answer in 20 s. */
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
  /**
   * The tool home a finished session of `tool` lives in, when the runtime can tell: Claude's from Paseo's diagnostic at
   * init, Codex's found by the session's rollout on a daemon on this machine, under `homeDir` of a home there (`.codex`,
   * or a team instance's own), and OpenCode's data directory on a daemon on this machine, its `XDG_DATA_HOME`. The home a
   * Paseo provider's env sets comes first.
   */
  sessionHome(tool: PaseoTool, sessionId: string, where: { claudeHome: string | undefined; providerHome: string | undefined; homeDir: string }): string | undefined;
  close(): Promise<void>;
}

/**
 * Whether Paseo has an active workspace that an open of `cwd` finds, reading every page of its workspaces: one on the
 * same path, and not a background one, which Paseo leaves out of that match.
 */
async function isOpenIn(api: PaseoApi, cwd: string): Promise<boolean> {
  const wanted = paseoKeyOf(cwd);

  for (let cursor: string | undefined; ;) {
    const listed = await api.workspaces.list({ page: { limit: 200, ...(cursor !== undefined && { cursor }) } });

    if (listed.entries.some((entry) => entry.archivingAt === null && !entry.background && paseoKeyOf(entry.workspaceDirectory) === wanted)) return true;
    const next = listed.pageInfo.nextCursor;

    if (!listed.pageInfo.hasMore || !next) return false;
    cursor = next;
  }
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

/**
 * Connects to the daemon at `url` through the installed `paseo` client and checks it runs what this runtime needs, or says
 * why it cannot be used. It waits at most 10 s for the daemon's answer, and stops waiting once `abandoned` aborts.
 */
export async function connect(url: string, paseo: PaseoClient, abandoned?: AbortSignal): Promise<Daemon | RuntimeFailure> {
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

  const timedOut = new Promise<'timeout' | 'abandoned'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), CONNECT_TIMEOUT_MS);
    abandoned?.addEventListener('abort', () => resolve('abandoned'), { once: true });
  });

  try {
    const connected = abandoned?.aborted ? 'abandoned' : await Promise.race([client.connect().then(() => 'connected' as const), timedOut]);

    if (connected === 'timeout') throw new Error(`no answer in ${CONNECT_TIMEOUT_MS / 1000} s`);

    if (connected === 'abandoned') throw new Error('the stop that asked for it ran out of time');
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
  /** The custom providers `installedTools` read last, by id. */
  let custom = new Map<string, CustomProviders[string]>();

  const models = async (provider: string): Promise<Model[]> => {
    const { models: listed = [] } = await api.providers.listModels(provider);

    return listed.map((model) => ({ id: model.id, isDefault: model.isDefault === true, efforts: (model.thinkingOptions ?? []).map((option) => option.id) }));
  };

  /**
   * Why the daemon cannot run `tool`, or the tool home it runs it with when Paseo reports one. Paseo calls a tool
   * available once its binary is on PATH, signed in or not, so each tool's sign-in is read from what Paseo reports of it.
   */
  const signIn = async ({ tool, provider }: Target, { runsIn, command }: { runsIn: RunsIn | undefined; command: string | undefined }): Promise<SignIn> => {
    switch (tool) {
      case 'claude': {
        // Claude's diagnostic quotes `claude auth status`, which reports a login and an API key alike as logged in, and,
        // from Claude Code 2.1, the config directory the daemon's Claude keeps its sessions under.
        const { diagnostic } = await api.providers.diagnostic(provider);
        const loggedIn = /"loggedIn":\s*(true|false)\b/.exec(diagnostic)?.[1];

        if (loggedIn === 'true') {
          const home = claudeHomeIn(diagnostic);

          return { canRun: true, ...(home !== undefined && { home }) };
        }

        return {
          canRun: false,
          problem: loggedIn === 'false'
            ? `signed out; run \`${signInStep({ runsIn, command: command ?? 'claude', login: 'auth login' })}\` on the daemon's host`
            : `Paseo does not report whether it is signed in; run \`paseo provider diagnostic ${provider}\` on the daemon's host to see its Auth line`,
        };
      }

      case 'opencode': {
        // Paseo 0.15 runs OpenCode on OpenCode's own background server when one runs on its host, and its diagnostic then
        // names only that server. That server refuses an agent any environment, and each step's agent gets TEAMAI_RUN_DIR.
        const shared = /^OpenCode server: (\S+)/.exec((await api.providers.diagnostic(provider)).diagnostic)?.[1];

        if (shared !== undefined) {
          return { canRun: false, problem: `Paseo runs it on OpenCode's background server at ${shared}, which takes no environment for an agent, and teamai gives each step ${RUN_DIR_ENV}; stop that server with \`opencode service stop\` on the daemon's host, then \`paseo restart\`` };
        }

        // Paseo lists OpenCode's models from the providers it reaches, its free ones included, and none when it reaches none.
        return (await models(provider)).length > 0 ? { canRun: true } : { canRun: false, problem: 'reaches no model provider; run `opencode auth login` on the daemon\'s host, then `paseo restart`' };
      }

      case 'codex': {
        // Paseo reports no Codex sign-in, so teamai asks Codex itself, which it can only where the daemon runs. It asks the
        // codex the daemon's diagnostic resolves on the daemon's PATH, which may not be the one on teamai's.
        if (!isOnThisMachine(url)) return { canRun: false, problem: `teamai checks Codex's sign-in only on a daemon at a loopback address, and ${url} is not one` };
        const resolved = /^\s*Resolved path: (.+)$/m.exec((await api.providers.diagnostic(provider)).diagnostic)?.[1]?.trim();

        if (resolved === undefined || resolved === 'not found') return { canRun: false, problem: `Paseo reports no path for it; run \`paseo provider diagnostic ${provider}\` on the daemon's host to see why` };
        // A custom provider, an instance's or one the providers option names, runs its own command, which answers as Codex does.
        const executable = path.basename(custom.get(provider)?.command?.[0] ?? 'codex');

        if (!isCodexExecutable(resolved, process.platform, executable)) {
          return { canRun: false, problem: `Paseo resolves it to "${resolved}", which is not an absolute path to a ${executable}; run \`paseo provider diagnostic ${provider}\` on the daemon's host to see why` };
        }

        let status: Awaited<ReturnType<typeof codexLoginStatus>>;

        try {
          // An instance's Codex, or one whose provider moves its home, keeps its sign-in in that home.
          status = await codexLoginStatus(resolved, runsIn && { ...process.env, [runsIn.variable]: runsIn.dir });
        } catch (error) {
          return { canRun: false, problem: `\`${resolved} login status\` did not answer (${error instanceof Error ? error.message : String(error)}); run it on the daemon's host to see why` };
        }

        // Codex 0.166.0 prints "Logged in using …" with exit 0 when signed in, and "Not logged in" with exit 1 when not.
        const { answer } = status;

        if (status.code === 0 && /^Logged in\b/m.test(answer)) return { canRun: true };

        if (status.code === 1 && /^Not logged in\b/m.test(answer)) return { canRun: false, problem: `signed out; run \`${signInStep({ runsIn, command: command ?? 'codex', login: 'login' })}\` on the daemon's host` };
        const said = answer.trim().split('\n')[0]?.slice(0, 120) ?? '';

        return { canRun: false, problem: `\`${resolved} login status\` gave no sign-in answer (exit ${status.code}${said ? `: ${said}` : ''}); run it on the daemon's host to see why` };
      }

      default: {
        const unhandled: never = tool;

        return unhandled;
      }
    }
  };

  /** The variable that moves an instance's home, and the absolute home it sets with it when it has one of its own. */
  const ownHome = (instance: InitInstance, tool: PaseoTool) => ({
    variable: instance.home?.env ?? homeVariableOf(tool),
    home: instance.home ? path.join(getUserHome(), instance.home.dir) : undefined,
  });

  return {
    url,
    serverId,
    version,
    async installedTools({ modes: configured, instances, providers: named }) {
      // The snapshot carries each provider's default mode, which the member's own agents start in.
      const [{ providers }, { entries }] = await Promise.all([api.providers.listAvailable(), api.providers.snapshot()]);
      const available = new Set(providers.filter((entry) => entry.available).map((entry) => entry.provider));
      const teamInstances = instances.flatMap((instance) => (isPaseoTool(instance.tool) && !isPaseoTool(instance.name) ? [{ instance, tool: instance.tool }] : []));
      // Read only when an instance or a named provider needs it: a provider's env may hold a secret, and none is kept.
      let unread: string | undefined;
      let parsed: ReturnType<typeof CustomProvidersSchema.safeParse> | undefined;

      try {
        parsed = teamInstances.length > 0 || Object.keys(named).length > 0 ? CustomProvidersSchema.safeParse((await api.config.get()).config.providers) : undefined;
      } catch (error) {
        // Only what needs a custom provider is left out: each tool on its own provider still runs.
        unread = `Paseo did not answer with its providers (${PaseoSaidSchema.parse(error)}); run \`paseo daemon config get agents.providers --json\` on the daemon's host to see why`;
      }

      const customs = keptOf(parsed?.success ? parsed.data : {}, instances.flatMap((instance) => (instance.home?.env === undefined ? [] : [instance.home.env])));
      custom = new Map(Object.entries(customs));

      /** The modes Paseo lists for `provider`, and the one a step of `tool` starts in there, or why it cannot be offered. */
      const modesOf = async (tool: PaseoTool, provider: string): Promise<{ modes: string[]; stepMode: StepMode } | { cannot: string }> => {
        let modes: ListedMode[];

        try {
          modes = (await api.providers.listModes(provider)).modes ?? [];
        } catch (error) {
          return { cannot: `Paseo failed to list its modes (${PaseoSaidSchema.parse(error)}); run \`paseo provider ls\` on the daemon's host to see why` };
        }

        const stepMode = stepModeOf(tool, { defaultMode: entries.find((entry) => entry.provider === provider)?.defaultModeId, configured: configured[tool], modes });

        return 'cannot' in stepMode ? stepMode : { modes: modes.map((mode) => mode.id), stepMode };
      };

      // Each tool on its own provider or the one the definition names, each instance on the one that runs its command.
      const builtins = PASEO_TOOLS.flatMap((tool): Array<Target | Unavailable> => {
        const provider = named[tool];

        if (provider === undefined) return available.has(tool) ? [{ name: tool, tool, provider: tool }] : [];
        const problem = unread ?? namedProblem(provider, tool, customs);

        return [problem === undefined ? { name: tool, tool, provider } : { name: tool, tool, canRun: false, reason: problem }];
      });

      const teams = teamInstances.map(({ instance, tool }): (Target & { toAdd?: ProviderToAdd }) | Unavailable => {
        const found = unread === undefined ? providerOf(instance, tool, { custom: customs, named: named[instance.name], onThisMachine: isOnThisMachine(url), ...ownHome(instance, tool) }) : { cannot: unread };

        if ('cannot' in found) return { name: instance.name, tool, canRun: false, reason: found.cannot };

        // One teamai adds at the first open that runs it, so the daemon gets an entry only for a team tool a step runs.
        return 'add' in found ? { name: instance.name, tool, provider: found.add.id, toAdd: found.add } : { name: instance.name, tool, provider: found.provider };
      });

      const planned: Array<(Target & { toAdd?: ProviderToAdd }) | Unavailable> = [...builtins, ...teams];

      return Promise.all(planned.map(async (target): Promise<InstalledTool> => {
        if ('canRun' in target) return target;
        const { tool, provider } = target;

        // Until it is added, it takes the modes Paseo lists for its tool, as the provider teamai adds extends it; its
        // sign-in is checked once it is added.
        const { toAdd } = target;

        if (toAdd) {
          const listed = await modesOf(tool, tool);

          return 'cannot' in listed ? { name: target.name, tool, canRun: false, reason: listed.cannot } : { name: target.name, tool, provider, toAdd, canRun: true, ...listed };
        }

        if (!available.has(provider)) return { ...target, canRun: false, reason: `Paseo does not find the command of its provider ${provider} on the daemon's PATH; install it there, then \`paseo daemon reload\`` };
        const instance = teamInstances.find((team) => team.instance.name === target.name)?.instance;
        const variable = instance?.home?.env ?? homeVariableOf(tool);
        const teamaiHome = instance?.home ? path.join(getUserHome(), instance.home.dir) : process.env[variable] || path.join(getUserHome(), homeDirOf(tool));
        const set = custom.get(provider)?.env?.[variable];
        const providerHome = set !== undefined && path.isAbsolute(set) ? { variable, dir: set, teamaiHome } : undefined;
        const runsIn = providerHome ? { variable, dir: providerHome.dir, shown: providerHome.dir } : instance?.home && { variable, dir: teamaiHome, shown: `~/${instance.home.dir}` };
        // A request Paseo fails for one provider leaves that tool unavailable, never the runtime's other tools.
        let signedIn: SignIn;

        try {
          signedIn = await signIn(target, { runsIn, command: instance?.command });
        } catch (error) {
          signedIn = { canRun: false, problem: `Paseo failed its diagnostic (${PaseoSaidSchema.parse(error)}); run \`paseo provider diagnostic ${provider}\` on the daemon's host to see why` };
        }

        if (!signedIn.canRun) return { ...target, canRun: false, reason: signedIn.problem };
        const listed = await modesOf(tool, provider);

        return 'cannot' in listed ? { ...target, canRun: false, reason: listed.cannot } : { ...target, canRun: true, ...listed, ...(signedIn.home !== undefined && { home: signedIn.home }), ...(providerHome && { providerHome }) };
      }));
    },
    async addProvider({ id, entry }, instance) {
      const tool = entry.extends;
      const home = ownHome(instance, tool);
      let found: ProviderFound;

      try {
        // Read again: another runtime may have added it since this one's init.
        const parsed = CustomProvidersSchema.safeParse((await api.config.get()).config.providers);
        found = providerOf(instance, tool, { custom: parsed.success ? keptOf(parsed.data, [home.variable]) : {}, named: undefined, onThisMachine: true, ...home });
      } catch (error) {
        return { cannot: `Paseo did not answer with its providers (${PaseoSaidSchema.parse(error)}); check that its daemon answers with \`paseo ls\`, then run the step again`, added: false };
      }

      if ('cannot' in found) return { ...found, added: false };
      const setUp = entry.command ? `with command ${JSON.stringify(entry.command)}` : `with env ${JSON.stringify(entry.env ?? {})}`;
      let added = false;

      if ('add' in found) {
        try {
          await api.config.patch({ providers: { [id]: entry } });
          added = true;
        } catch (error) {
          return { cannot: `Paseo refused the provider ${id} teamai added for it (${PaseoSaidSchema.parse(error)}); add one on the daemon's host that extends ${tool} ${setUp}, or name one in the runtime's providers option`, added: false };
        }
      }

      const provider = 'add' in found ? id : found.provider;
      custom = new Map(custom).set(provider, 'add' in found ? entry : custom.get(provider) ?? { extends: tool });
      let signedIn: SignIn;

      try {
        const { providers } = await api.providers.listAvailable();

        if (!providers.some((listed) => listed.provider === provider && listed.available)) {
          return { cannot: `Paseo does not find the command of its provider ${provider} on the daemon's PATH; install it there, then \`paseo daemon reload\``, added };
        }

        signedIn = await signIn({ name: instance.name, tool, provider }, { runsIn: home.home === undefined || !instance.home ? undefined : { variable: home.variable, dir: home.home, shown: `~/${instance.home.dir}` }, command: instance.command });
      } catch (error) {
        return { cannot: `Paseo failed its diagnostic (${PaseoSaidSchema.parse(error)}); run \`paseo provider diagnostic ${provider}\` on the daemon's host to see why`, added };
      }

      if (!signedIn.canRun) return { cannot: signedIn.problem, added };

      // The provider it added, or one with no command of its own that it matched, runs in the instance's own home.
      const providerHome = ('add' in found || instance.command === undefined) ? home.home : undefined;

      return { provider, added, ...(signedIn.home !== undefined && { home: signedIn.home }), ...(providerHome !== undefined && { providerHome }) };
    },
    models,
    isOpen: (cwd) => answeredInTime(isOpenIn(api, cwd)),
    async memberAgentsIn(workspaceId) {
      const found: string[] = [];

      for (let cursor: string | undefined; ;) {
        const listed = await api.agents.list({ page: { limit: 200, ...(cursor !== undefined && { cursor }) } });
        found.push(...listed.entries.flatMap(({ agent }) => (agent.workspaceId === workspaceId && !agent.archivedAt && agent.status !== 'closed' && !Object.hasOwn(agent.labels, 'teamai-attempt') ? [agent.id] : [])));
        const next = listed.pageInfo.nextCursor;

        if (!listed.pageInfo.hasMore || !next) return found;
        cursor = next;
      }
    },
    async workspace(cwd) {
      const opened = await answeredInTime(api.workspaces.open({ cwd }), '; if Paseo opens it later, archive that workspace in the Paseo app');
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
    sessionHome(tool, sessionId, { claudeHome, providerHome, homeDir }) {
      switch (tool) {
        case 'claude':
          return claudeHome ?? providerHome;
        case 'codex':
          return isOnThisMachine(url) ? codexHomeHolding(sessionId, { providerHome, homeDir }) : undefined;
        case 'opencode':
          return isOnThisMachine(url) ? openCodeDataHome(providerHome) : undefined;
        default: {
          const unhandled: never = tool;

          return unhandled;
        }
      }
    },
    async close() {
      await api.dispose().catch(() => {});
      await client.close().catch(() => {});
    },
  };
}
