import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadLocalConfigForScope } from '../../config.js';
import { shippedDriverFile } from '../../default-drivers.js';
import { workflowNamespacesOf } from '../../resource-namespaces.js';
import { FOLDER_MARKERS } from '../../folder-markers.js';
import { isSymlink, RESOURCE_LAYOUTS, Resources, type TeamTree } from '../../resources/resolver.js';
import { getKnowledgeDir, getTeamaiHomeDir, type LocalConfig } from '../../types.js';
import { JsonValueSchema } from '@teamai/shared/json';
import { parseYaml } from '@teamai/shared/yaml';
import { HOST_DRIVER, LOCAL_DRIVER, parseDriver, type DriverName } from '../driver-name.js';
import { isReservedDriver } from '../reserved-drivers.js';
import type { WorkflowFailure } from '../types.js';
import { readRegularFileNoLink } from '@teamai/shared/regular-file';

// ─── Driver definitions ──────────────────────────────────
//
//  A driver definition is a YAML resource `--driver <name>` selects: the runtimes a run's steps go to, their options, and
//  an optional default tool. It is found, first match wins, in the member's own ~/.teamai/drivers/<name>.yaml, in the
//  team repo's drivers/ (and drivers/<namespace>/ for each active namespace), in the user scope's team repo when the
//  start is in a project, and in the definitions teamai ships (drivers/ in the package, every name prefixed teamai-).
//  `--driver x` and `--driver teamai-x` both run the shipped teamai-x when no definition is named x. `--driver host` runs
//  the definition teamai builds in, with no runtime, and reads no file.
//

/** The prefix of every definition teamai ships, as of every default workflow. */
const SHIPPED_PREFIX = 'teamai-';

const RUNTIME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Name `name` as a definition takes it, or why it cannot: any driver name but one in `RESERVED_DRIVERS`, `host`
 * included, which teamai builds in.
 */
function definitionName(name: string): { ok: true; name: DriverName } | { ok: false; reason: string } {
  const kept = { ok: false, reason: `"${name}" is a name teamai keeps for its own driver` } as const;

  if (isReservedDriver(name)) return kept;
  const parsed = parseDriver(name);

  if (!parsed.ok) return parsed;

  switch (parsed.driver) {
    // parseDriver names a driver of teamai's own only for a name isReservedDriver keeps.
    case 'local':
    case 'skill':
    case 'none':
      return kept;
    default:
      return { ok: true, name: parsed.driver.external };
  }
}

const RuntimeNameSchema = z.string().regex(RUNTIME_NAME, 'A runtime name starts with a letter or digit and holds only letters, digits, dots, dashes and underscores');

/**
 * One runtime of a definition: the runtime it uses and the options it passes at `init`. With `through`, the runtime it
 * uses runs its tools inside the place that other runtime makes (`use: t3, through: sandbox`), and `options` holds
 * each one's options under its name.
 */
const RuntimeEntrySchema = z.object({
  use: RuntimeNameSchema,
  through: RuntimeNameSchema.optional(),
  options: z.record(z.string(), JsonValueSchema).optional(),
}).strict().refine((entry) => entry.through !== entry.use, { path: ['through'], message: 'A runtime runs through another runtime, not through itself' });

export const DriverDefinitionSchema = z.object({
  schemaVersion: z.literal('v1alpha1'),
  name: z.string(),
  description: z.string().optional(),
  /** The tool a prompt step runs on when neither it nor `--tools` names one. */
  tool: z.string().min(1).optional(),
  /** The runtimes the run's steps go to, offered in this order: a step goes to the first that can take it. */
  runtimes: z.array(RuntimeEntrySchema).min(1, 'A driver definition lists at least one runtime'),
}).strict();

export type DriverDefinition = z.infer<typeof DriverDefinitionSchema>;

/** Where a definition came from, which decides whether its runtimes need a person's acceptance. `builtin`: `host`, which no file holds. */
export type DefinitionSource = 'personal' | 'team' | 'shipped' | 'builtin';

export interface ResolvedDriver {
  /** The definition's canonical name: the stored name, `teamai-x` for a shipped `x`. */
  name: string;
  definition: DriverDefinition;
  source: DefinitionSource;
  /** The file it was read from, for messages; for `host`, which no file holds, what it is. */
  file: string;
  /** The config whose team repo holds the definition's team runtimes. */
  config: LocalConfig;
  /** For `host`: the files named host that teamai did not read, which a run's open says once. */
  unread?: string[];
}

/** The member's own directories, which teamai reads and never writes, so team code it caches never reads as the member's. */
export const PERSONAL_DIRS = { drivers: 'drivers', runtimes: 'runtimes', tools: 'tools' } as const;

/** The marker of a driver definition kept as a folder, `drivers/<name>/DRIVER.yaml`, which takes the folder's name. */
const DRIVER_MARKER = FOLDER_MARKERS.drivers.marker;

export function personalDir(kind: keyof typeof PERSONAL_DIRS): string {
  return path.join(getTeamaiHomeDir(), PERSONAL_DIRS[kind]);
}

/**
 * The member's own item `name` of `kind`, as a file `<name>.yaml` or a folder `<name>/` holding `marker`, in their own
 * directory, which teamai reads and never writes; `duplicate` when both are there.
 */
export async function personalItem(kind: keyof typeof PERSONAL_DIRS, name: string, marker: string): Promise<{ kind: 'file'; file: string } | { kind: 'folder'; folder: string } | { kind: 'missing' } | { kind: 'duplicate'; file: string; folder: string }> {
  const file = path.join(personalDir(kind), `${name}.yaml`);
  const folder = path.join(personalDir(kind), name);

  const [isFile, isFolder] = await Promise.all([
    fs.stat(file).then((stat) => stat.isFile(), () => false),
    fs.stat(path.join(folder, marker)).then((stat) => stat.isFile(), () => false),
  ]);

  if (isFile && isFolder) return { kind: 'duplicate', file, folder: `${folder}${path.sep}` };

  if (isFile) return { kind: 'file', file };

  return isFolder ? { kind: 'folder', folder } : { kind: 'missing' };
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readRegularFileNoLink(file, 'utf8');
  } catch {
    return undefined;
  }
}

type Refused = { ok: false; failure: WorkflowFailure };

function invalid(file: string, reason: string): Refused {
  return { ok: false, failure: { code: 'driver_invalid', message: `Driver definition ${file} is not valid: ${reason}. Fix the file and start again.` } };
}

/** Parses the definition in `file`, which must be named after it, or says why it cannot run. */
export function parseDriverDefinition(file: string, text: string): { ok: true; definition: DriverDefinition } | { ok: false; failure: WorkflowFailure } {
  let raw: unknown;

  try {
    raw = parseYaml(text);
  } catch (error) {
    return invalid(file, `it is not YAML (${error instanceof Error ? error.message : String(error)})`);
  }

  const parsed = DriverDefinitionSchema.safeParse(raw);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    return invalid(file, `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'unknown problem'}`);
  }

  const definition = parsed.data;
  const stem = path.basename(file) === DRIVER_MARKER ? path.basename(path.dirname(file)) : path.basename(file, '.yaml');

  if (definition.name !== stem) return invalid(file, `its name is "${definition.name}", and a definition is named after its file or its folder, "${stem}"`);
  const named = definitionName(definition.name);

  if (!named.ok) return invalid(file, named.reason);

  return { ok: true, definition };
}

type Lookup = { kind: 'found'; driver: ResolvedDriver } | { kind: 'missing' } | { kind: 'failed'; failure: WorkflowFailure };

async function read(file: string, source: DefinitionSource, config: LocalConfig): Promise<Lookup> {
  const text = await readText(file);

  if (text === undefined) return { kind: 'missing' };
  const parsed = parseDriverDefinition(file, text);

  return parsed.ok ? { kind: 'found', driver: { name: parsed.definition.name, definition: parsed.definition, source, file, config } } : { kind: 'failed', failure: parsed.failure };
}

/**
 * `config`'s team tree as the resolver reads drivers, runtimes and sandboxes from it: the root, and each namespace active
 * for the member's workflows.
 */
export function teamTreeOf(config: LocalConfig): TeamTree {
  return { root: getKnowledgeDir(config), namespaces: () => workflowNamespacesOf(config) };
}

/**
 * The one team definition named `name` in `config`'s team tree, by its file; the two active namespaces that both define
 * it; or `linked` when the tree's `drivers` folder is a link, whose definitions are not the team repo's.
 */
async function teamDefinition(config: LocalConfig, name: string): Promise<{ kind: 'found'; file: string } | { kind: 'missing' } | { kind: 'conflict'; reason: 'duplicate' | 'two-namespaces'; first: string; second: string } | { kind: 'linked' }> {
  const tree = teamTreeOf(config);

  if (await isSymlink(path.join(tree.root, RESOURCE_LAYOUTS.drivers.dir))) return { kind: 'linked' };
  const resolution = await Resources.resolve(RESOURCE_LAYOUTS.drivers, name, { team: tree });

  switch (resolution.kind) {
    case 'missing':
      return resolution;
    case 'conflict':
      return { kind: 'conflict', reason: resolution.reason, first: resolution.first.source.path, second: resolution.second.source.path };
    case 'resolved': {
      const { source } = resolution.item;

      return { kind: 'found', file: source.kind === 'folder' ? path.join(source.full, DRIVER_MARKER) : source.full };
    }

    default: {
      const unhandled: never = resolution;

      return unhandled;
    }
  }
}

async function fromTeam(config: LocalConfig, name: string): Promise<Lookup> {
  const found = await teamDefinition(config, name);

  switch (found.kind) {
    case 'missing':
      return found;
    case 'linked':
      return { kind: 'failed', failure: { code: 'driver_invalid', message: 'drivers in the team repo is a link, and teamai reads the team\'s driver definitions only from a folder the team repo holds, so it reads none of them. Replace the link with the folder, push it, run teamai pull, and start again.' } };
    case 'conflict':
      return {
        kind: 'failed',
        failure: {
          code: 'driver_namespace_conflict',
          message: found.reason === 'duplicate'
            ? `Driver "${name}" is defined twice in one place (${found.first} and ${found.second}). Keep one, push it, run teamai pull, and start again.`
            : `Driver "${name}" is defined in two active namespaces (${found.first} and ${found.second}). Keep it in one namespace, push it, run teamai pull, and start again.`,
        },
      };
    case 'found':
      return read(found.file, 'team', config);
    default: {
      const unhandled: never = found;

      return unhandled;
    }
  }
}

/** The member's own definition `name`, `~/.teamai/drivers/<name>.yaml` or `<name>/DRIVER.yaml`. */
async function fromPersonal(config: LocalConfig, name: string): Promise<Lookup> {
  const found = await personalItem('drivers', name, DRIVER_MARKER);

  switch (found.kind) {
    case 'missing':
      return found;
    case 'duplicate':
      return { kind: 'failed', failure: { code: 'driver_namespace_conflict', message: `Driver "${name}" is defined twice in your own drivers (${found.file} and ${found.folder}). Keep one, and start again.` } };
    case 'file':
      return read(found.file, 'personal', config);
    case 'folder':
      return read(path.join(found.folder, DRIVER_MARKER), 'personal', config);
    default: {
      const unhandled: never = found;

      return unhandled;
    }
  }
}

/** `host`: the definition teamai builds in, with no runtime, so only the host slot runs. */
const HOST_DEFINITION: DriverDefinition = {
  schemaVersion: 'v1alpha1',
  name: HOST_DRIVER,
  description: 'Run commands, gates and workflows whose steps need no AI tool, on this machine, and refuse a step that needs one.',
  runtimes: [],
};

/**
 * The built-in `host`, after saying of each member's or team's `host.yaml` that it is not read, so no team repoints it
 * and no file keeps it from running.
 */
async function hostDriver(config: LocalConfig, { personal, user }: { personal: boolean; user: LocalConfig | null }): Promise<ResolvedDriver> {
  const mine = [path.join(personalDir('drivers'), `${HOST_DRIVER}.yaml`), path.join(personalDir('drivers'), HOST_DRIVER, DRIVER_MARKER)];
  const present = await Promise.all(mine.map(async (file) => fs.lstat(file).then(() => true, () => false)));
  const own = personal ? mine.filter((_, index) => present[index]) : [];

  const teams = await Promise.all([config, ...(user ? [user] : [])].map(async (scope) => {
    const found = await teamDefinition(scope, HOST_DRIVER);

    return found.kind === 'found' ? [found.file] : found.kind === 'conflict' ? [found.first, found.second] : [];
  }));

  return { name: HOST_DRIVER, definition: HOST_DEFINITION, source: 'builtin', file: 'teamai\'s built-in host driver', config, unread: [...own, ...teams.flat()] };
}

/**
 * The definition `--driver <name>` runs from `config`, or why none runs. `personal: false` skips the member's own
 * definitions, for a run handed over from another member.
 */
export async function resolveDriver(config: LocalConfig, name: string, { personal }: { personal: boolean }): Promise<{ ok: true; driver: ResolvedDriver } | { ok: false; failure: WorkflowFailure }> {
  // `local` is no definition's name: it runs `teamai-local`, the member's, then the team's, then teamai's.
  const user = config.scope === 'project' ? await loadLocalConfigForScope('user', undefined, { dryRun: true }) : null;

  if (name === HOST_DRIVER) return { ok: true, driver: await hostDriver(config, { personal, user }) };
  const named = name === LOCAL_DRIVER ? { ok: true as const } : definitionName(name);

  if (!named.ok) return { ok: false, failure: { code: 'driver_not_found', message: `No driver definition can be named "${name}": ${named.reason}.` } };
  const shipped = name.startsWith(SHIPPED_PREFIX) ? name : `${SHIPPED_PREFIX}${name}`;

  const sources = (candidate: string): Array<() => Promise<Lookup>> => [
    ...(personal ? [() => fromPersonal(config, candidate)] : []),
    () => fromTeam(config, candidate),
    ...(user ? [() => fromTeam(user, candidate)] : []),
  ];

  for (const lookup of [...(name === LOCAL_DRIVER ? [] : sources(name)), ...(shipped === name ? [] : sources(shipped)), () => read(shippedDriverFile(shipped), 'shipped', config)]) {
    const found = await lookup();

    if (found.kind === 'found') return { ok: true, driver: found.driver };

    if (found.kind === 'failed') return { ok: false, failure: found.failure };
  }

  return {
    ok: false,
    failure: {
      code: 'driver_not_found',
      message: personal
        ? `No driver definition is named "${name}". Add drivers/${name}.yaml to the team repo and run teamai pull, add ~/.teamai/drivers/${name}.yaml for yourself, or use --driver local.`
        : `No driver definition of the team or teamai is named "${name}", and a definition in ~/.teamai/drivers/ does not count here. Add drivers/${name}.yaml to the team repo and run teamai pull, or use --driver local.`,
    },
  };
}
