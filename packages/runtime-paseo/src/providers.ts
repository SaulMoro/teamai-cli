import path from 'node:path';
import { getUserHome } from '@teamai/tool-core/home';
import { findOnPath } from '@teamai/tool-core/lookpath';
import type { InitInstance } from '@teamai/runtime-protocol';
import { z } from 'zod';

// ─── Paseo's providers ───────────────────────────────────
//
//  The providers Paseo ships that teamai runs as its tools, where each keeps its home, and the custom providers of a
//  daemon's `agents.providers`: which one runs a team instance, or the one teamai adds for it.
//

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

/** The variable that moves `tool`'s home, which a Paseo provider's env may set: OpenCode's is its data directory's. */
export function homeVariableOf(tool: PaseoTool): string {
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

/**
 * The home teamai resolved for an instance and passed in `init.instances`: absolute, the member's value of its variable
 * when their environment sets it, else its directory under their home. The runtime takes it as given.
 */
export function instanceHomeOf(home: NonNullable<InitInstance['home']>): string {
  return path.resolve(getUserHome(), home.dir);
}

/** `dir` as the member reads it: `~/…` under their home, else as it is. */
export function shownPath(dir: string): string {
  const under = path.relative(getUserHome(), dir);

  return under !== '' && !under.startsWith('..') && !path.isAbsolute(under) ? `~/${under}` : dir;
}

/** The directory under `$HOME` `tool`'s home is in when nothing moves it. */
export function homeDirOf(tool: PaseoTool): string {
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

/**
 * The custom providers of the daemon's `agents.providers`, as much of each as tells which tool it extends, what it runs,
 * and its env, of which only the home variables are kept: the rest may hold a secret.
 */
export const CustomProvidersSchema = z.record(z.string(), z.object({ extends: z.string().optional(), command: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }));

export type CustomProviders = z.infer<typeof CustomProvidersSchema>;

/**
 * `providers` with only the variables of each env that move a tool's home, the shipped tools' and `variables`: the rest
 * may hold a secret, and none is kept.
 */
export function keptOf(providers: CustomProviders, variables: readonly string[]): CustomProviders {
  const kept = new Set([...PASEO_TOOLS.map(homeVariableOf), ...variables]);

  return Object.fromEntries(Object.entries(providers).map(([id, entry]) => [id, {
    ...entry, ...(entry.env && { env: Object.fromEntries(Object.entries(entry.env).filter(([name]) => kept.has(name))) }),
  }]));
}

/** Whether a provider whose command starts with `executable` runs `command`: the same name, or an absolute path to it. */
const runsCommand = (executable: string | undefined, command: string): boolean => executable !== undefined
  && (executable === command || (path.isAbsolute(executable) && !path.isAbsolute(command) && path.basename(executable) === command));

/** Why the custom provider the runtime's providers option names cannot run `tool`, or undefined when it extends it. */
export const namedProblem = (named: string, tool: PaseoTool, custom: CustomProviders): string | undefined => (custom[named]?.extends === tool
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
export type ProviderFound = { provider: string } | { cannot: string } | { add: ProviderToAdd };

/**
 * The Paseo provider that runs team instance `instance` of `tool`: the one `named` gives, which must extend `tool` and
 * run the instance's command, else the one custom provider that does, and, for an instance with only a home of its own,
 * the one that runs the tool's own command with that home. With none, the one teamai adds, when it can: on a daemon on
 * this machine, under the instance's name, with its command found on teamai's PATH. Or why it cannot, with how to set one
 * up. `home` is the absolute home the instance sets with `variable`, when it has one of its own.
 */
export function providerOf(instance: InitInstance, tool: PaseoTool, { custom, named, home, variable, onThisMachine }: {
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

  const shownHome = instance.home ? shownPath(instanceHomeOf(instance.home)) : '';
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

