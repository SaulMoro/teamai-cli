import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { RuntimeOptions } from '@teamai/runtime-protocol';
import { JsonValueSchema } from '@teamai/shared/json';
import { readRegularFileNoLink } from '@teamai/shared/regular-file';
import { parseYaml } from '@teamai/shared/yaml';
import { teamaiPackageDir } from '../../default-drivers.js';
import { isSymlink, RESOURCE_LAYOUTS, Resources, type ShippedFile } from '../../resources/resolver.js';
import { getKnowledgeDir } from '../../types.js';
import type { WorkflowFailure } from '../types.js';
import { personalItem, SHIPPED_PREFIX, teamTreeOf, type ResolvedDriver } from './definitions.js';
import { fixOf, type RuntimeLayer } from './locate.js';
import { firstLink, folderRevision } from './resource-folder.js';

// ─── Sandbox profiles ────────────────────────────────────
//
//  What the sandbox runtime runs a place in: a provider and its options, as `sandboxes/<name>.yaml` or a folder
//  `sandboxes/<name>/` with its `SANDBOX.yaml` and the files it builds from, such as a Containerfile. A driver's entry
//  names one with `sandbox: <name>`, `default` when it names none. It is found as a runtime is: the member's own
//  ~/.teamai/sandboxes/, the team repo's sandboxes/ (and sandboxes/<namespace>/), then teamai's own; first by the exact
//  name in every layer, then as teamai-<name>. The driver's entry keeps `max_parallel` and `credentials`.
//

/** The marker of a sandbox profile kept as a folder. */
export const SANDBOX_MARKER = RESOURCE_LAYOUTS.sandboxes.marker;

/** The profile an entry runs when it names none. */
export const DEFAULT_PROFILE = 'default';

/** What a driver's entry sets for the sandbox runtime, which a profile never does. */
const ENTRY_KEYS = ['max_parallel', 'credentials'] as const;

/** The option teamai gives the sandbox runtime itself: the profile's name, revision and folder. */
export const PROFILE_OPTION = 'profile';

/** A sandbox profile as found, with the options it gives the sandbox runtime. */
export interface SandboxProfile {
  /** The name the entry asked for, `default` when it named none. */
  readonly asked: string;
  /** The name of the resource found for it: `asked` itself, or `teamai-<asked>`. */
  readonly resource: string;
  readonly layer: RuntimeLayer;
  /** Where a message names it: its path in the team repo (`sandboxes/gpu/`), the member's file, or teamai's. */
  readonly location: string;
  /** The folder of a profile kept as one, which its paths are inside. */
  readonly folder?: string;
  /** The sha256 of a file's content, or the folder's revision (`folderRevision`). */
  readonly revision: string;
  readonly options: Readonly<Record<string, z.infer<typeof JsonValueSchema>>>;
  /** The provider its options name, which the sandbox runtime checks; unset when they name none. */
  readonly provider?: string;
  /** The profile of teamai's own this one of the member or the team stands in for. */
  readonly replaces?: string;
}

type LayerLookup = { readonly kind: 'found'; readonly profile: SandboxProfile } | { readonly kind: 'missing' } | { readonly kind: 'refused'; readonly failure: WorkflowFailure };

/** A profile of one name in one layer, before its file is read. */
interface Definition {
  readonly layer: RuntimeLayer;
  readonly resource: string;
  readonly form: 'file' | 'folder';
  /** The file form itself, or the folder. */
  readonly at: string;
  readonly location: string;
  /** The file's text, as the teamai layer holds it read; read from `at` otherwise. */
  readonly text?: string;
}

const ProfileOptionsSchema = z.record(z.string(), JsonValueSchema);
const ProviderSchema = z.object({ provider: z.string() });

function invalid({ driver, asked, location, layer }: { driver: ResolvedDriver; asked: string; location: string; layer: RuntimeLayer }, reason: string): LayerLookup {
  return { kind: 'refused', failure: { code: 'sandbox_profile_invalid', message: `Driver "${driver.name}" runs its sandbox with profile "${asked}", and ${location} cannot be used: ${reason}. ${fixOf(layer)}` } };
}

/** The profile `definition` holds, or why it cannot be used. */
async function readProfile(driver: ResolvedDriver, asked: string, definition: Definition): Promise<LayerLookup> {
  // What the marker itself says wrong names the marker; what the folder holds names the folder.
  const markerLocation = definition.form === 'folder' && /[\\/]$/.test(definition.location) ? `${definition.location}${SANDBOX_MARKER}` : definition.location;
  const refuse = (reason: string): LayerLookup => invalid({ driver, asked, location: definition.location, layer: definition.layer }, reason);
  const badMarker = (reason: string): LayerLookup => invalid({ driver, asked, location: markerLocation, layer: definition.layer }, reason);
  const file = definition.form === 'folder' ? path.join(definition.at, SANDBOX_MARKER) : definition.at;

  if (definition.text === undefined && definition.form === 'file' && definition.layer === 'team' && await isSymlink(file)) return refuse('it is a link, and teamai reads a profile only from a file the team repo holds');
  let text = definition.text;

  if (text === undefined) {
    try {
      text = await readRegularFileNoLink(file, 'utf8');
    } catch (error) {
      return badMarker(`it cannot be read (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  let raw: unknown;

  try {
    raw = parseYaml(text);
  } catch (error) {
    return badMarker(`it is not YAML (${error instanceof Error ? error.message : String(error)})`);
  }

  const parsed = ProfileOptionsSchema.safeParse(raw);

  if (!parsed.success) return badMarker('it sets no options, and a profile is a mapping such as provider: docker');
  const options = parsed.data;
  const entryKey = ENTRY_KEYS.find((key) => key in options);

  if (entryKey !== undefined) return badMarker(`it sets ${entryKey}, which the driver definition's entry sets, as its options: { ${entryKey}: ${JSON.stringify(options[entryKey])} }`);

  if (PROFILE_OPTION in options) return badMarker(`it sets ${PROFILE_OPTION}, which teamai gives the sandbox runtime itself`);
  let revision: string;

  try {
    revision = definition.form === 'folder' ? await folderRevision(definition.at) : createHash('sha256').update(text).digest('hex');
  } catch (error) {
    return refuse(`its folder cannot be read (${error instanceof Error ? error.message : String(error)})`);
  }

  const named = ProviderSchema.safeParse(options);

  return {
    kind: 'found',
    profile: {
      asked, resource: definition.resource, layer: definition.layer, location: definition.location, ...(definition.form === 'folder' && { folder: definition.at }), revision, options,
      ...(named.success && { provider: named.data.provider }),
    },
  };
}

/** The member's own profile named `name`, in ~/.teamai/sandboxes/. */
async function fromPersonal(driver: ResolvedDriver, asked: string, name: string): Promise<LayerLookup> {
  const found = await personalItem('sandboxes', name, SANDBOX_MARKER);

  switch (found.kind) {
    case 'missing':
      return found;
    case 'duplicate':
      return { kind: 'refused', failure: { code: 'sandbox_profile_invalid', message: `Sandbox profile "${name}" is defined twice in your own sandboxes (${found.file} and ${found.folder}). Keep one, and start again.` } };
    case 'file':
    case 'folder':
      return readProfile(driver, asked, { layer: 'personal', resource: name, form: found.kind, at: found.kind === 'file' ? found.file : found.folder, location: found.kind === 'file' ? found.file : `${found.folder}${path.sep}` });
    default: {
      const unhandled: never = found;

      return unhandled;
    }
  }
}

/** The team's profile named `name` in `driver`'s team tree, among the root and the active namespaces. */
async function fromTeam(driver: ResolvedDriver, asked: string, name: string): Promise<LayerLookup> {
  const refused = (message: string): LayerLookup => ({ kind: 'refused', failure: { code: 'sandbox_profile_invalid', message } });
  const opening = `Driver "${driver.name}" runs its sandbox with profile "${asked}", and`;

  if (await isSymlink(path.join(getKnowledgeDir(driver.config), RESOURCE_LAYOUTS.sandboxes.dir))) {
    return refused(`${opening} sandboxes in the team repo is a link, and teamai reads a team sandbox profile only from a folder the team repo holds. Replace the link with the folder, push it, run teamai pull, and start again.`);
  }

  const { resolutions, diagnostics } = await Resources.survey(RESOURCE_LAYOUTS.sandboxes, { team: teamTreeOf(driver.config) });
  const linked = diagnostics.find((diagnostic) => diagnostic.kind === 'invalid' && path.posix.basename(diagnostic.path) === name && diagnostic.path.endsWith('/'));

  if (linked) return refused(`${opening} its folder ${linked.path.slice(0, -1)} in the team repo is a link, and teamai reads a team sandbox profile only from a folder the team repo holds. Replace the link with the folder, push it, run teamai pull, and start again.`);
  const resolution = resolutions.find((candidate) => candidate.name === name);

  if (resolution === undefined) return { kind: 'missing' };

  if (resolution.kind === 'conflict') {
    const where = resolution.reason === 'duplicate' ? 'twice in one place' : 'in two active namespaces';

    return refused(`Sandbox profile "${name}" is defined ${where} (${resolution.first.source.path} and ${resolution.second.source.path}). Keep one, push it, run teamai pull, and start again.`);
  }

  const { source } = resolution.item;

  if (source.kind === 'folder') {
    const found = await firstLink(source.full);

    if (!found.ok) return invalid({ driver, asked, location: source.path, layer: 'team' }, found.reason);
    const { link } = found;

    if (link !== undefined) return invalid({ driver, asked, location: source.path, layer: 'team' }, `it holds the link ${link}, and teamai builds a sandbox only from what the folder itself holds`);
  }

  return readProfile(driver, asked, { layer: 'team', resource: name, form: source.kind === 'folder' ? 'folder' : 'file', at: source.full, location: source.path });
}

/** teamai's own profile named `name`, in `sandboxes/` of its package. */
async function fromTeamai(driver: ResolvedDriver, asked: string, name: string): Promise<LayerLookup> {
  const resolution = await Resources.resolve(RESOURCE_LAYOUTS.sandboxes, name, { teamai: { root: teamaiPackageDir(), read: (file: ShippedFile) => file } });

  if (resolution.kind !== 'resolved' || resolution.item.layer !== 'teamai') return { kind: 'missing' };
  const { item } = resolution;

  return readProfile(driver, asked, {
    layer: 'teamai', resource: name, form: item.source.kind === 'folder' ? 'folder' : 'file', at: item.source.full, location: `teamai's ${item.shipped.relativePath}`, text: item.shipped.content,
  });
}

/** The first of `names` teamai ships a profile by, or none. */
async function shippedProfile(names: readonly string[]): Promise<string | undefined> {
  const teamai = { root: teamaiPackageDir(), read: (file: ShippedFile) => file };

  for (const name of names) {
    const resolution = await Resources.resolve(RESOURCE_LAYOUTS.sandboxes, name, { teamai });

    if (resolution.kind === 'resolved' && resolution.item.layer === 'teamai') return name;
  }

  return undefined;
}

/** The sandbox profile a runtime entry of `driver` names with `sandbox:` (`named`), or why there is none it can use. */
export async function locateSandboxProfile(driver: ResolvedDriver, named: string | undefined): Promise<{ ok: true; profile: SandboxProfile } | { ok: false; failure: WorkflowFailure }> {
  const asked = named ?? DEFAULT_PROFILE;
  const names = asked.startsWith(SHIPPED_PREFIX) ? [asked] : [asked, `${SHIPPED_PREFIX}${asked}`];

  for (const name of names) {
    for (const layer of [fromPersonal, fromTeam, fromTeamai]) {
      const found = await layer(driver, asked, name);

      switch (found.kind) {
        case 'found': {
          const replaced = found.profile.layer === 'teamai' ? undefined : await shippedProfile(names);

          return { ok: true, profile: replaced === undefined ? found.profile : { ...found.profile, replaces: replaced } };
        }

        // A profile that cannot be used fails the run: another layer's never stands in for the one the member was given.
        case 'refused':
          return { ok: false, failure: found.failure };
        case 'missing':
          break;
        default: {
          const unhandled: never = found;

          return unhandled;
        }
      }
    }
  }

  return {
    ok: false,
    failure: {
      code: 'sandbox_profile_not_found',
      message: `Driver "${driver.name}" runs its sandbox with profile "${asked}", and none is declared: add sandboxes/${asked}.yaml (or sandboxes/${asked}/${SANDBOX_MARKER} with what it builds from) to the team repo and run teamai pull, or add ~/.teamai/sandboxes/${asked}.yaml for yourself.`,
    },
  };
}

/**
 * The options the sandbox runtime of `driver` starts with: those of the profile its entry names (`named`), and the
 * `profile` option naming it. `given` is what the entry and the member's config pass it besides `max_parallel` and
 * `credentials`, which must be nothing now that a profile holds the provider's options; `from` names where they were set.
 */
export async function sandboxOptions({ driver, named, given, from }: { driver: ResolvedDriver; named: string | undefined; given: RuntimeOptions; from: string }): Promise<{ ok: true; options: RuntimeOptions; profile: SandboxProfile } | { ok: false; failure: WorkflowFailure }> {
  const [inline] = Object.keys(given);

  if (inline !== undefined) {
    const name = named ?? (driver.name.startsWith(SHIPPED_PREFIX) ? driver.name.slice(SHIPPED_PREFIX.length) : driver.name);

    return {
      ok: false,
      failure: {
        code: 'bad_option',
        message: `Driver definition ${from} gives runtime "sandbox" the option "${inline}", and a sandbox's options live in a sandbox profile: move them to sandboxes/${name}.yaml in the team repo (or ~/.teamai/sandboxes/${name}.yaml for yourself), name it on the entry with sandbox: ${name}, and start again.`,
      },
    };
  }

  const located = await locateSandboxProfile(driver, named);

  if (!located.ok) return located;
  const { profile } = located;
  const profileOption = { name: profile.resource, revision: profile.revision, ...(profile.folder !== undefined && { folder: profile.folder }) };

  return { ok: true, options: { ...profile.options, [PROFILE_OPTION]: profileOption }, profile };
}
