import fs from 'node:fs';
import path from 'node:path';
import { fitReason, type OpId } from '@teamai/runtime-protocol';
import { findOnPath } from '@teamai/tool-core/lookpath';
import { addProviderInstance, findProviderInstance, isInstanceId, type NewInstance } from './add-instance.js';
import type { ServeOptions, Serving, Session } from './runtime.js';
import { DRIVERS } from './sessions.js';
import type { readSettings } from './settings.js';
import { tilde, type ServedInstances } from './tool-instances.js';
import type { Provider } from './t3.js';
import { sleep } from './within.js';

// ─── The provider instances teamai adds ───
//
//  A tool instance init offers with no T3 provider instance yet gets one on the first open or prompt that runs it,
//  added to T3's settings as the member adds one; the opens of parallel steps add it once.
//

/**
 * Why a tool instance's provider instance cannot run: teamai could not add it; or it is there, and T3 cannot run it
 * yet, such as a tool not signed in in its home.
 */
export type NotAdded = { ok: false; kind: 'not-added'; why: string } | { ok: false; kind: 'not-ready'; id: string; why: string };

/** Adds the provider instances init offered to add, as `options` says, telling the person through `notice`. */
export function instanceAdder({ options, notice }: { options: ServeOptions; notice: Serving['notice'] }) {
  /**
   * The provider instance teamai adds for each of `missing` on the first open that runs it: named after the instance,
   * running its command from PATH, in the home teamai gives it when that is not its tool's own (Claude reads its own
   * config file elsewhere once its home is set at all). teamai writes T3's settings file as the member, in any run, as
   * Paseo's runtime adds a provider. One it cannot add is in `unavailable`, saying why.
   */
  const toBeAdded = ({ missing, settings }: { missing: ServedInstances['missing']; settings: ReturnType<typeof readSettings> }) => {
    const pending = new Map<string, NewInstance>();
    const reasons: Record<string, string> = {};

    for (const { instance: { name }, instance, driver, command } of missing) {
      const found = path.isAbsolute(command) ? (fs.existsSync(command) ? command : null) : findOnPath(command);
      // A PATH folder named relatively finds it relative to this folder, which T3 does not run in.
      const binaryPath = found === null ? null : path.resolve(found);
      // Only a home of the tool's own goes into T3's settings, never one a run's environment moved: it stays for every run.
      const ownHome = instance.home && path.resolve(options.home, instance.home.dir);
      const homePath = ownHome === path.join(options.home, DRIVERS[driver].home) ? undefined : ownHome;
      const setting = `with driver ${DRIVERS[driver].label} and Binary path ${binaryPath ?? `the absolute path of ${command} (command -v ${command})`}${homePath ? `, and Home path ${tilde(homePath, options.home)}` : ''}`;
      const wanted: NewInstance | undefined = binaryPath === null ? undefined : { id: name, driver, displayName: name, command, binaryPath, ...(homePath && { homePath }) };
      // One another run added, which T3 has not listed yet, is not in the way.
      const present = wanted && findProviderInstance({ settings, instance: wanted, userHome: options.t3UserHome });

      if (wanted === undefined) {
        reasons[name] = fitReason(`No T3 Code provider instance runs ${name}, and teamai cannot add one: ${command} is not on PATH here. Install ${command}, or add one in T3 Code under Settings → Providers, ${setting}, or map one with instances: { ${name}: <its id> } in the definition's t3 options.`);
      } else if (!isInstanceId(name)) {
        reasons[name] = fitReason(`No T3 Code provider instance runs ${name}, and teamai cannot add one: T3 Code takes no provider instance named "${name}" (a letter, then letters, digits, _ or -). Add one in T3 Code under Settings → Providers, ${setting}, and map it with instances: { ${name}: <its id> } in the definition's t3 options.`);
      } else if (present === undefined && settings.providerInstances?.[name] !== undefined) {
        reasons[name] = fitReason(`No T3 Code provider instance runs ${name}, and teamai cannot add one: T3 Code already has a provider instance "${name}" that runs another command. Point its Binary path at ${command}, or map another with instances: { ${name}: <its id> } in the definition's t3 options.`);
      } else {
        pending.set(name, wanted);
      }
    }

    return { pending, reasons };
  };

  /** The adding of each instance under way, by name, so the opens of parallel steps add it once. */
  const adding = new Map<string, Promise<NotAdded | { ok: true }>>();

  /** How long T3 gets to list an instance it was given, from its settings changing to its own check of it. */
  const ADD_WAIT_MS = 20_000;

  /** Adds the provider instance of `name` teamai offered to add, then waits until T3 can run it. */
  const addInstance = async (s: Session, name: string, instance: NewInstance, about: { op: OpId }): Promise<NotAdded | { ok: true }> => {
    const added = await addProviderInstance({ t3Home: options.t3Home, lockFile: options.settingsLock, userHome: options.t3UserHome, instance });

    switch (added.kind) {
      case 'added':
        notice(`Added the T3 Code provider instance "${added.id}" (driver ${DRIVERS[instance.driver].label}, Binary path ${instance.binaryPath}${instance.homePath ? `, Home path ${tilde(instance.homePath, options.home)}` : ''}), so ${name} runs on T3 Code. It stays for later runs; remove it in T3 Code under Settings → Providers.`, about);
        break;
      case 'found':
        break;
      case 'failed':
        return { ok: false, kind: 'not-added', why: added.why };
      default: {
        const unhandled: never = added;

        return unhandled;
      }
    }

    // T3 reloads its settings once they change, then checks the instance before it can run.
    const deadline = Date.now() + ADD_WAIT_MS;
    let listed: Provider | undefined;

    for (;;) {
      try {
        listed = (await s.t3.providers()).find((provider) => provider.providerInstanceId === added.id);
      } catch (error) {
        return { ok: false, kind: 'not-ready', id: added.id, why: `T3 Code did not say which provider instances it runs (${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')})` };
      }

      if ((listed && (listed.constraints ?? []).length === 0) || Date.now() > deadline) break;
      await sleep(250);
    }

    if (!listed || (listed.constraints ?? []).length > 0) {
      return { ok: false, kind: 'not-ready', id: added.id, why: listed ? (listed.constraints ?? []).join(' ') : `it has not listed it within ${ADD_WAIT_MS / 1_000} s` };
    }

    s.instances.set(name, listed);
    s.pending.delete(name);

    return { ok: true };
  };

  /** The provider instance of `name` exists once this settles, when teamai offered to add it; a failure says why. */
  const instanceFor = (s: Session, name: string, about: { op: OpId }): Promise<NotAdded | { ok: true }> | undefined => {
    const instance = s.pending.get(name);

    if (!instance) return adding.get(name);

    // A failure nobody expected still answers the open, and leaves nothing for the process to die of.
    const going = adding.get(name) ?? addInstance(s, name, instance, about).catch((error) => ({
      ok: false, kind: 'not-added', why: error instanceof Error ? error.message : String(error),
    } satisfies NotAdded));

    adding.set(name, going);
    // A later open tries again, once the person fixed what failed.
    void going.then((done) => { if (!done.ok && adding.get(name) === going) adding.delete(name); });

    return going;
  };

  /** What a step whose instance cannot run is told: why, and what the person does about it. */
  const notAdded = (name: string, instance: NewInstance | undefined, failure: NotAdded): string => {
    const home = instance?.homePath ? tilde(instance.homePath, options.home) : undefined;
    const setting = instance ? `, with driver ${DRIVERS[instance.driver].label} and Binary path ${instance.binaryPath}${home ? `, and Home path ${home}` : ''}` : '';
    const why = failure.why.replace(/\.$/, '');

    switch (failure.kind) {
      case 'not-added':
        return `teamai could not add a T3 Code provider instance for ${name}: ${why}. Add one in T3 Code under Settings → Providers${setting}.`;
      case 'not-ready':
        return `T3 Code cannot run the provider instance "${failure.id}" for ${name} yet: ${why}.${home ? ` It runs in ${home}.` : ''} Fix that, then retry the step; the instance is in T3 Code under Settings → Providers.`;
      default: {
        const unhandled: never = failure;

        return unhandled;
      }
    }
  };

  return { toBeAdded, instanceFor, notAdded };
}

export type InstanceAdder = ReturnType<typeof instanceAdder>;
