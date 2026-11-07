import path from 'node:path';
import { UNAVAILABLE_REASON_MAX, type InitInstance } from '@teamai/runtime-protocol';
import { DRIVER_NAMES, DRIVERS, driverOf, type Driver } from './sessions.js';
import type { Provider } from './t3.js';

// ─── The T3 provider instance that runs each tool instance ───
//
//  A team or personal tool instance (`extends: claude`, `command: acme-claude`) runs in T3 on a provider instance whose
//  Binary path is the instance's command. `instances` in the definition's options maps a name to a provider instance
//  by id; with no entry, the runtime finds the one whose Binary path in the member's T3 settings is absolute and names
//  the command, so a team definition needs no machine's ids.
//
//    init instances: [{ name: acme-claude, tool: claude, command: acme-claude }]
//    settings.json   providerInstances.acme-claude-t3.config.binaryPath = /opt/acme/bin/acme-claude
//    →               acme-claude runs on acme-claude-t3
//

/** Whether the file name of `binaryPath` is `command`: on Windows, also `<command>.exe` or `.cmd`, in any case. */
function namesCommand(binaryPath: string, command: string): boolean {
  const name = path.basename(binaryPath);

  if (process.platform !== 'win32') return name === command;

  return [command, `${command}.exe`, `${command}.cmd`].some((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

/** Whether `binaryPath` is an absolute path to `command`. */
function runsCommand(binaryPath: string, command: string): boolean {
  return path.isAbsolute(binaryPath) && namesCommand(binaryPath, command);
}

/**
 * Whether a provider instance of `driver` with `binaryPath` runs the provider's own tool, such as `claude`: none set, or
 * a path to that command by name. Any other is a wrapper or a team tool's command, which a base tool never runs on.
 */
export function runsOwnBinary(binaryPath: string | undefined, driver: Driver): boolean {
  return binaryPath === undefined || namesCommand(binaryPath, DRIVERS[driver].tool);
}

/** What finds the provider instance of each tool instance: T3's instances, which of them can run now, and each one's Binary path. */
export interface InstanceLookup {
  providers: Provider[];
  /** Whether the provider instance can run now, for the checkout's project. */
  isUsable(provider: Provider): boolean;
  /** The Binary path the member set for the provider instance in T3, if any. */
  binaryPathOf(instanceId: string): string | undefined;
}

export interface ServedInstances {
  served: Map<string, Provider>;
  unavailable: Record<string, string>;
  /** What the person hears at the start: a misspelt `instances` key, which no step may ever name to show its reason. */
  notices: string[];
}

/**
 * The provider instance that serves each of `instances` T3 can run: the one `mapped` names, checked, else the one whose
 * Binary path runs its command. One it cannot find, whose command two instances run, or whose mapping cannot hold is
 * not served, and `unavailable` says what to set. teamai passes every instance the member may run at init, so a problem
 * with one never fails the others.
 */
export function servedInstances({ instances, mapped, lookup }: { instances: InitInstance[]; mapped: Record<string, string> | undefined; lookup: InstanceLookup }): ServedInstances {
  const served = new Map<string, Provider>();
  const unavailable: Record<string, string> = {};
  const reason = (message: string): string => message.slice(0, UNAVAILABLE_REASON_MAX);

  const notices: string[] = [];

  // A misspelt name maps nothing, so it is named; it may also be a team tool this machine has not accepted.

  for (const stray of Object.keys(mapped ?? {}).filter((name) => !instances.some((instance) => instance.name === name))) {
    const message = reason(`instances names ${stray}, which is neither claude, codex nor a tool instance teamai has here. Remove instances.${stray}, or name the instance as its tool definition does.`);
    unavailable[stray] = message;
    notices.push(message);
  }

  for (const instance of instances) {
    const driver = driverOf(instance.tool);

    // T3 runs only Claude and Codex here; another runtime of the definition serves the rest.
    if (!driver) continue;
    const { name, command } = instance;
    const label = DRIVERS[driver].label;
    const id = mapped?.[name];

    if (id !== undefined) {
      const provider = lookup.providers.find((one) => one.providerInstanceId === id);

      if (!provider) {
        unavailable[name] = reason(`T3 Code has no provider instance "${id}", which instances maps ${name} to. Add or enable it in T3 Code under Settings → Providers, or remove instances.${name}`);
        continue;
      }

      if (provider.driverKind !== driver) {
        unavailable[name] = reason(`T3 Code provider instance "${id}" runs ${provider.driverKind}, and ${name} extends ${instance.tool}. Map ${name} to a ${label} instance in instances.${name}`);
        continue;
      }

      if (!lookup.isUsable(provider)) {
        unavailable[name] = reason(`T3 Code provider instance "${id}", which instances maps ${name} to, cannot run now: ${(provider.constraints ?? []).join(' ') || 'it is turned off for this project.'} Enable it in T3 Code under Settings → Providers, or change instances.${name}`);
        continue;
      }

      const binaryPath = lookup.binaryPathOf(id);

      if (command !== undefined && binaryPath !== undefined && !runsCommand(binaryPath, command)) {
        unavailable[name] = reason(`T3 Code provider instance "${id}" has the Binary path ${binaryPath}, which is not ${command}, the command ${name} runs. Set its Binary path in T3 Code under Settings → Providers to the absolute path of ${command} (command -v ${command}), or change instances.${name}`);
        continue;
      }

      served.set(name, provider);
      continue;
    }

    // One named like the tool it adjusts, with no command of its own, is that tool, on the instance T3 runs it on.
    if (command === undefined && name === instance.tool) continue;

    // An instance with no command of its own runs the tool's, so no Binary path tells it apart.
    if (command === undefined) {
      unavailable[name] = reason(`${name} names no command of its own, so teamai cannot tell which T3 Code provider instance runs it. Map one with instances: { ${name}: <its id> } in the definition's t3 options.`);
      continue;
    }

    const found = lookup.providers.filter((provider) => {
      const binaryPath = lookup.binaryPathOf(provider.providerInstanceId);

      return provider.driverKind === driver && lookup.isUsable(provider) && binaryPath !== undefined && runsCommand(binaryPath, command);
    });

    if (found.length > 1) {
      const names = found.map((provider) => `"${provider.providerInstanceId}"`);
      unavailable[name] = reason(`T3 Code provider instances ${names.slice(0, -1).join(', ')} and ${names.at(-1)} both run ${command}. Pick one with instances: { ${name}: <its id> } in the definition's t3 options.`);
      continue;
    }

    const [provider] = found;

    if (provider) served.set(name, provider);
    else unavailable[name] = reason(`No T3 Code provider instance runs ${command}. Add one in T3 Code under Settings → Providers, with driver ${label} and Binary path the absolute path of ${command} (command -v ${command}), or map one with instances: { ${name}: <its id> } in the definition's t3 options.`);
  }

  return { served, unavailable, notices };
}

/** The T3 driver of `provider`, when this runtime runs it. */
export function driverOfProvider(provider: Provider): Driver | undefined {
  return DRIVER_NAMES.find((driver) => driver === provider.driverKind);
}
