import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadLocalConfigForScope } from '../../config.js';
import { shippedDriverFile } from '../../default-drivers.js';
import { isSafeNamespaceSegment } from '../../manifest-schema.js';
import { resolveNamespacedItems, type NamespaceCandidate } from '../../namespace-resolver.js';
import { resolveResourceNamespaces } from '../../resource-namespaces.js';
import { getKnowledgeDir, getTeamaiHomeDir, type LocalConfig } from '../../types.js';
import { JsonValueSchema } from '@teamai/shared/json';
import { parseYaml } from '@teamai/shared/yaml';
import { HOST_DRIVER, LOCAL_DRIVER, parseDriver, type DriverName } from '../driver-name.js';
import type { WorkflowFailure } from '../types.js';
import { readRegularFile } from '@teamai/shared/regular-file';

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
 * Name `name` as a definition takes it, or why it cannot: a name `parseDriver` reads as a driver outside teamai, but
 * `host`, which teamai builds in. Every other name is teamai's own driver, or none, so a driver teamai adds is refused
 * here until a case below takes it.
 */
function definitionName(name: string): { ok: true; name: DriverName } | { ok: false; reason: string } {
  const parsed = parseDriver(name);

  if (!parsed.ok) return parsed;

  switch (parsed.driver) {
    case 'local':
    case 'skill':
    case 'none':
      return { ok: false, reason: `"${name}" is a name teamai keeps for its own driver` };
    default: {
      const definition: { external: DriverName } = parsed.driver;

      if (definition.external === HOST_DRIVER) return { ok: false, reason: `"${name}" is a name teamai keeps for its own driver` };

      return { ok: true, name: definition.external };
    }
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

export function personalDir(kind: keyof typeof PERSONAL_DIRS): string {
  return path.join(getTeamaiHomeDir(), PERSONAL_DIRS[kind]);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(file);

    return stat.isFile() ? await readRegularFile(file, 'utf8') : undefined;
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
  const stem = path.basename(file, '.yaml');

  if (definition.name !== stem) return invalid(file, `its name is "${definition.name}", and a definition is named after its file, "${stem}"`);
  const named = definitionName(definition.name);

  if (!named.ok) return invalid(file, named.reason);

  return { ok: true, definition };
}

async function namespaceDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && isSafeNamespaceSegment(entry.name)).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/**
 * The namespaces the member receives workflows from: the workflow namespaces their roles and projects activate,
 * or, with no manifest to filter by, every namespace directory `onDisk` holds. A manifest that cannot be read activates
 * none.
 */
export async function activeWorkflowNamespaces(config: LocalConfig, onDisk: string[]): Promise<string[]> {
  if (onDisk.length === 0) return [];
  let active: Awaited<ReturnType<typeof resolveResourceNamespaces>>;

  try {
    active = await resolveResourceNamespaces(config);
  } catch {
    return [];
  }

  return active ? active.activeNamespaces.workflows ?? [] : onDisk;
}

/**
 * The one team item named `name` under `root` (`root/<name><suffix>`, or `root/<ns>/<name><suffix>` for an active
 * namespace), or the conflict of two active namespaces that both define it.
 */
export async function teamItem(config: LocalConfig, root: string, name: string, suffix: string): Promise<{ kind: 'found'; at: string } | { kind: 'missing' } | { kind: 'conflict'; first: string; second: string }> {
  const onDisk = await namespaceDirs(root);
  const candidates: NamespaceCandidate<string>[] = [];

  for (const namespace of [null, ...onDisk]) {
    const at = namespace === null ? path.join(root, `${name}${suffix}`) : path.join(root, namespace, `${name}${suffix}`);

    if (await fs.lstat(at).then(() => true, () => false)) candidates.push({ name, source: path.relative(path.dirname(root), at), namespace, value: at });
  }

  if (candidates.length === 0) return { kind: 'missing' };
  const resolution = resolveNamespacedItems(candidates, await activeWorkflowNamespaces(config, onDisk));

  if (resolution.kind === 'conflict') return { kind: 'conflict', first: resolution.first.source, second: resolution.second.source };
  const [item] = resolution.items;

  return item ? { kind: 'found', at: item.value } : { kind: 'missing' };
}

type Lookup = { kind: 'found'; driver: ResolvedDriver } | { kind: 'missing' } | { kind: 'failed'; failure: WorkflowFailure };

async function read(file: string, source: DefinitionSource, config: LocalConfig): Promise<Lookup> {
  const text = await readText(file);

  if (text === undefined) return { kind: 'missing' };
  const parsed = parseDriverDefinition(file, text);

  return parsed.ok ? { kind: 'found', driver: { name: parsed.definition.name, definition: parsed.definition, source, file, config } } : { kind: 'failed', failure: parsed.failure };
}

async function fromTeam(config: LocalConfig, name: string): Promise<Lookup> {
  const found = await teamItem(config, path.join(getKnowledgeDir(config), 'drivers'), name, '.yaml');

  if (found.kind === 'missing') return found;

  if (found.kind === 'conflict') {
    return { kind: 'failed', failure: { code: 'driver_namespace_conflict', message: `Driver "${name}" is defined in two active namespaces (${found.first} and ${found.second}). Keep it in one namespace, push it, run teamai pull, and start again.` } };
  }

  return read(found.at, 'team', config);
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
  const mine = path.join(personalDir('drivers'), `${HOST_DRIVER}.yaml`);
  const own = personal && await fs.lstat(mine).then(() => true, () => false) ? [mine] : [];

  const teams = await Promise.all([config, ...(user ? [user] : [])].map(async (scope) => {
    const found = await teamItem(scope, path.join(getKnowledgeDir(scope), 'drivers'), HOST_DRIVER, '.yaml');

    return found.kind === 'found' ? [found.at] : found.kind === 'conflict' ? [found.first, found.second] : [];
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
    ...(personal ? [() => read(path.join(personalDir('drivers'), `${candidate}.yaml`), 'personal', config)] : []),
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
