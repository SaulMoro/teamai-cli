import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isBareCommandName } from '@teamai/shared/cli-path';
import { INSTANCE_KEYS, type ToolInstance, type ToolInstanceHome } from '@teamai/tool-core/instance';
import { FOLDER_MARKERS } from './folder-markers.js';
import { isSymlink, RESOURCE_LAYOUTS, Resources, type TeamTree } from './resources/resolver.js';
import { isSessionPlatform } from './session-flow/adapters/platform-facts.js';
import { homeEnvOf } from './tool-home.js';
import { homeVariables, isToolId, TOOL_ORDER, useToolInstances } from './tool-registry.js';
import type { ToolId } from './tools.js';
import { DEFAULT_TOOL_PATHS, getTeamaiHomeDir, getTrustDir, rerootToolPaths, ToolPathsSchema, type Scope, type TeamaiConfig } from './types.js';
import { writeJsonAtomic } from './utils/fs.js';
import { getUserHome } from '@teamai/shared/home';
import { log } from '@teamai/shared/log';
import { errorOnce, warnOnce } from './utils/warn-once.js';
import { parseYaml } from '@teamai/shared/yaml';
import { readRegularFile } from '@teamai/shared/regular-file';

// ─── Tool instances ──────────────────────────────────────
//
//  A team adds a tool as an instance of a shipped one, in tools/<name>.yaml of the team repo (or tools/<namespace>/),
//  and a member in ~/.teamai/tools/<name>.yaml, which teamai reads and never writes. Either may keep it as a folder
//  tools/<name>/TOOL.yaml instead, read the same way. An instance sets another command,
//  home and paths, and no code: it keeps the formats of the tool it extends. A member's own instance replaces the
//  team's of the same name. An instance named like a shipped tool adjusts it.
//

/** Where an instance was read: the team repo, which a teammate pushes to, or the member's own directory. */
export type InstanceSource = 'team' | 'personal';

/** An instance as a file defines it, with where it came from and the hash of that file. */
export interface ResolvedToolInstance extends ToolInstance<ToolId> {
  /** The tool paths it sets, which replace the paths of the tool it extends whole, as a `toolPaths` entry does. */
  readonly paths?: z.infer<typeof ToolPathsSchema>;
  readonly source: InstanceSource;
  /** The file it was read from, for messages and acceptance. */
  readonly file: string;
  /** Where a note names it: its path in the team repo, such as tools/acme-claude.yaml, or a member's file. */
  readonly location: string;
  /** The sha256 of that file: a person accepts a team instance's command at this content. */
  readonly revision: string;
}

/** The marker of an instance kept as a folder, `tools/<name>/TOOL.yaml`, which takes the folder's name. */
const TOOL_MARKER = FOLDER_MARKERS.tools.marker;

const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A `$HOME`-relative directory that stays under `$HOME`. */
const HomeDir = z.string().min(1).refine((dir) => !path.isAbsolute(dir) && !dir.split(/[\\/]/).includes('..'), 'home.dir is a directory under your home, such as .acme-claude, with no ..');

const InstanceFileSchema = z.object({
  schemaVersion: z.literal('v1alpha1'),
  name: z.string().regex(NAME, 'A tool name starts with a lowercase letter or digit and holds only lowercase letters, digits, dots, dashes and underscores'),
  extends: z.string().refine(isToolId, { error: (issue) => `${String(issue.input)} is not a tool teamai ships. Extend one of: ${TOOL_ORDER.join(', ')}` }),
  // A path is refused: what runs there, maybe in the step's own checkout, is not the file a person accepted.
  command: z.string().refine(isBareCommandName, 'command is the name of one executable on PATH, with no path, spaces or arguments, such as acme-claude').optional(),
  home: z.object({ dir: HomeDir, env: z.string().regex(ENV_NAME, 'home.env is the name of an environment variable').optional() }).strict().optional(),
  paths: ToolPathsSchema.optional(),
});

/** An instance file teamai does not use, and why. */
export interface RefusedInstance {
  readonly ok: false;
  readonly problem: string;
}

/** Why `file` is not an instance teamai can use. */
function refused(file: string, reason: string): RefusedInstance {
  return { ok: false, problem: `Tool instance ${file} is not valid: ${reason}. Fix the file; until then teamai does not use it.` };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Parses the instance `text` of `file`, which is named after it, or says why teamai does not use it. */
function parseToolInstance({ file, text, source, location }: { file: string; text: string; source: InstanceSource; location: string }): { ok: true; instance: ResolvedToolInstance } | RefusedInstance {
  let raw: unknown;

  try {
    raw = parseYaml(text);
  } catch (error) {
    return refused(file, `it is not YAML (${error instanceof Error ? error.message : String(error)})`);
  }

  if (raw instanceof Object && !Array.isArray(raw)) {
    const extra = Object.keys(raw).find((key) => !INSTANCE_KEYS.some((allowed) => allowed === key));

    if (extra !== undefined) {
      return refused(file, `it sets ${extra}, and an instance sets only command, home and paths. It keeps the formats of the tool it extends, so its sessions, tokens and launch flags read as that tool's`);
    }
  }

  const parsed = InstanceFileSchema.safeParse(raw);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    return refused(file, `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'unknown problem'}`);
  }

  const { schemaVersion: _version, extends: base, ...fields } = parsed.data;

  if (!isToolId(base)) return refused(file, `${base} is not a tool teamai ships`);
  const stem = path.basename(file) === TOOL_MARKER ? path.basename(path.dirname(file)) : path.basename(file, '.yaml');

  if (fields.name !== stem) return refused(file, `its name is "${fields.name}", and an instance is named after its file or its folder, "${stem}"`);

  if (isToolId(fields.name) && fields.name !== base) {
    return refused(file, `"${fields.name}" is a tool teamai ships, and an instance named like one adjusts it, so it extends ${fields.name}`);
  }

  if (!isToolId(fields.name) && isSessionPlatform(fields.name)) return refused(file, `"${fields.name}" is the name of a session platform teamai ships`);

  return { ok: true, instance: { ...fields, extends: base, source, file, location, revision: sha256(text) } };
}

async function readText(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(file);

    return stat.isFile() ? await readRegularFile(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The instance files in `dir`: each `<name>.yaml`, and each `<name>/TOOL.yaml`. A name kept both ways is logged and
 * neither is read.
 */
async function instanceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = new Map(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.yaml')).map((entry) => [entry.name.slice(0, -'.yaml'.length), path.join(dir, entry.name)]));
  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => [entry.name, path.join(dir, entry.name, TOOL_MARKER)] as const);
  const marked = await Promise.all(folders.map(async ([, marker]) => (await fs.lstat(marker).catch(() => undefined))?.isFile() === true));

  for (const [index, [name, marker]] of folders.entries()) {
    if (!marked[index]) continue;
    const file = files.get(name);

    if (file === undefined) {
      files.set(name, marker);
      continue;
    }

    errorOnce(`Tool instance "${name}" is defined twice in your own tools (${file} and ${marker}), so teamai uses neither. Keep one.`);
    files.delete(name);
  }

  return [...files.values()].sort();
}

/** Each instance in `files`, parsed; one that does not parse is logged and left out. */
async function readInstances(files: readonly string[], source: InstanceSource): Promise<ResolvedToolInstance[]> {
  const read = await Promise.all(files.map(async (file) => {
    const text = await readText(file);

    return text === undefined ? undefined : parseToolInstance({ file, text, source, location: file });
  }));

  return read.flatMap(usable);
}

/** The instance `parsed` gives, or none after logging why it is not used. */
function usable(parsed: ReturnType<typeof parseToolInstance> | undefined): ResolvedToolInstance[] {
  if (parsed === undefined) return [];

  if (!parsed.ok) {
    errorOnce(parsed.problem);

    return [];
  }

  return [parsed.instance];
}

/** The team's layers a scope reads its instances from, and which scope that is: a workspace's instance replaces the user scope's. */
export interface TeamToolTree extends TeamTree {
  readonly scope: Scope | undefined;
  /** Whether it is read for a member, whose namespaces and scope it has, rather than for a field of teamai.yaml alone. */
  readonly isForMember: boolean;
}

/**
 * The instances of the team tree `team`: `tools/<name>.yaml`, and `tools/<namespace>/<name>.yaml` for each namespace
 * active for the member, which replaces the root one. Two of one name in two active namespaces are a conflict, and
 * neither is used; an instance an active namespace replaces is not used even when the namespace's does not parse. A
 * `tools` folder that is a link gives none: what it names is not the team repo's.
 */
export async function teamToolInstances(team: TeamTree): Promise<ResolvedToolInstance[]> {
  if (await isSymlink(path.join(team.root, RESOURCE_LAYOUTS.tools.dir))) {
    errorOnce('tools in the team repo is a link, and teamai reads the team\'s tool instances only from a folder the team repo holds, so it uses none of them. Replace the link with the folder, push it, and run teamai pull.');

    return [];
  }

  const { resolutions, diagnostics } = await Resources.survey(RESOURCE_LAYOUTS.tools, { team });

  for (const diagnostic of diagnostics) if (diagnostic.kind === 'invalid') errorOnce(diagnostic.message);

  const read = await Promise.all(resolutions.map(async (resolution) => {
    if (resolution.kind === 'conflict') {
      log.error(`Tool instance "${resolution.name}" is defined twice in the team repo (${resolution.first.source.path} and ${resolution.second.source.path}), so teamai uses neither. Keep one, push it, and run teamai pull.`);

      return undefined;
    }

    const { source } = resolution.item;
    const [file, location] = source.kind === 'folder' ? [path.join(source.full, TOOL_MARKER), `${source.path}${TOOL_MARKER}`] : [source.full, source.path];
    const text = await readText(file);

    return text === undefined ? undefined : parseToolInstance({ file, text, source: 'team', location });
  }));

  return read.flatMap(usable);
}

/**
 * Where an instance of `base` has its home on this machine: its variable's value when set, else its directory under
 * `$HOME`. A variable that moves `base`'s own home, or an XDG base directory, is set for that tool or for every tool, so
 * its value is never the instance's home: the instance's home is then its directory.
 */
export function instanceHomeDir(home: ToolInstanceHome, base: string, env: NodeJS.ProcessEnv = process.env): string {
  const moved = home.env === undefined || movesSharedHome(home.env, base) ? undefined : env[home.env];

  return moved ? moved : path.join(getUserHome(), home.dir);
}

/** Whether `variable` moves the home of shipped tool `base` itself, or every XDG tool's. */
function movesSharedHome(variable: string, base: string): boolean {
  if (variable === 'XDG_CONFIG_HOME' || variable === 'XDG_DATA_HOME') return true;

  return isToolId(base) && (homeEnvOf(base) === variable || homeVariables(base).includes(variable));
}

/** The name of the member's own instance directory in `~/.teamai/`. */
export const PERSONAL_TOOLS_DIR = 'tools';

/** The member's own instance directory, `~/.teamai/tools/`: teamai reads it and never writes it. */
export function personalToolsDir(): string {
  return path.join(getTeamaiHomeDir(), PERSONAL_TOOLS_DIR);
}

/** The member's own instances, from `personalToolsDir()`. */
export async function personalToolInstances(): Promise<ResolvedToolInstance[]> {
  const dir = personalToolsDir();

  return readInstances(await instanceFiles(dir), 'personal');
}

// ─── The instances this process sees ─────────────────────

/** The instances read from each team repo this process loaded, by the repo's real path, with the scope that repo serves. */
const teamByRepo = new Map<string, { readonly scope: Scope | undefined; readonly instances: readonly ResolvedToolInstance[]; readonly isForMember: boolean }>();
let personal: readonly ResolvedToolInstance[] = [];
let readsPersonal = true;

/**
 * Leaves the member's own instances out of every lookup from now on, for a run handed over from another member
 * (`resume --next`), whose tools are the team's.
 */
export function ignorePersonalToolInstances(): void {
  readsPersonal = false;
  publish();
}

/**
 * The instances a lookup sees: the member's own first, then the team's. A workspace's team instance replaces the user
 * scope's of the same name, as its driver definitions do; one name two team repos of one scope define apart is left out.
 */
function effectiveInstances(): Map<string, ResolvedToolInstance> {
  const table = new Map<string, ResolvedToolInstance>();
  const repos = [...teamByRepo.values()];

  for (const scope of ['user', 'project'] as const) {
    const ofScope = repos.filter((repo) => (repo.scope ?? 'user') === scope).flatMap((repo) => repo.instances);
    const conflicted = new Set<string>();
    const own = new Map<string, ResolvedToolInstance>();

    for (const instance of ofScope) {
      const known = own.get(instance.name);

      if (known === undefined) own.set(instance.name, instance);
      else if (known.revision !== instance.revision) conflicted.add(instance.name);
    }

    for (const name of conflicted) {
      const files = ofScope.flatMap((instance) => (instance.name === name ? [instance.file] : []));

      warnOnce(`Tool instance "${name}" is defined apart in two team repos (${files.join(' and ')}), so teamai uses neither. Make them the same, or rename one.`);
      own.delete(name);
    }

    for (const [name, instance] of own) table.set(name, instance);
  }

  if (readsPersonal) for (const instance of personal) table.set(instance.name, instance);

  return table;
}

function publish(): void {
  useToolInstances(effectiveInstances());
}

/** The tool paths `instance` gives its tool: its own `paths`, else the paths of the tool it extends, moved to its home. */
function instancePaths(instance: ResolvedToolInstance, toolPaths: TeamaiConfig['toolPaths']): z.infer<typeof ToolPathsSchema> | undefined {
  if (instance.paths) return instance.paths;
  const extended = toolPaths[instance.extends] ?? DEFAULT_TOOL_PATHS[instance.extends];

  return instance.home ? rerootToolPaths(extended, instance.home.dir) : extended;
}

/** The paths `instance` replaces with its own: those of the tool it adjusts, or of the tool it extends, moved to its home. */
export function defaultPathsOf(instance: ResolvedToolInstance): z.infer<typeof ToolPathsSchema> {
  const shipped = DEFAULT_TOOL_PATHS[instance.extends];

  return instance.home && instance.name !== instance.extends ? rerootToolPaths(shipped, instance.home.dir) : shipped;
}

/**
 * `config`, the team config of the tree `tree`, with the instances of that tree and the member's own read,
 * every lookup of a tool name seeing them, and their tool paths in `toolPaths`. A member's instance replaces the team's.
 */
export async function withToolInstances(tree: TeamToolTree, config: TeamaiConfig): Promise<TeamaiConfig> {
  const [team, own, repo] = await Promise.all([
    teamToolInstances(tree),
    readsPersonal ? personalToolInstances() : [],
    // Two spellings of one repo, through a link or /tmp against /private/tmp, are one repo.
    fs.realpath(tree.root).catch(() => path.resolve(tree.root)),
  ]);

  // A read for no member never replaces the member's instances, which another loader of this process published.
  if (tree.isForMember || teamByRepo.get(repo)?.isForMember !== true) teamByRepo.set(repo, { scope: tree.scope, instances: team, isForMember: tree.isForMember });

  personal = own;
  publish();

  const byName = new Map(team.map((instance) => [instance.name, instance]));

  for (const instance of own) byName.set(instance.name, instance);

  if (byName.size === 0) return config;
  const toolPaths = { ...config.toolPaths };

  for (const instance of byName.values()) {
    const paths = instancePaths(instance, config.toolPaths);

    if (paths) toolPaths[instance.name] = paths;
  }

  return { ...config, toolPaths };
}

// ─── Accepting a team file's command ─────────────────────
//
//  A team file that names a command, a tool instance's `command` or a step runtime's `entry: { command }`, runs a
//  program a teammate named on the member's machine. Before its first run with a given file content, a person accepts
//  that content: an attended run asks, and an unattended one refuses. A member's own file, and an instance that sets
//  only home or paths, need no acceptance.
//

const TrustFileSchema = z.object({
  accepted: z.array(z.object({ kind: z.literal('runtime').optional(), name: z.string(), revision: z.string(), acceptedAt: z.string() })),
});

function trustFile(): string {
  return path.join(getTrustDir(), 'tools.json');
}

async function readTrust(): Promise<z.infer<typeof TrustFileSchema>> {
  try {
    return TrustFileSchema.parse(JSON.parse(await readRegularFile(trustFile(), 'utf8')));
  } catch {
    return { accepted: [] };
  }
}

/**
 * A command a file of the team repo names, accepted at that file's content (`revision`, its sha256): a tool instance's,
 * which runs in place of the tool it extends, or a step runtime's. One name of each kind is accepted at one content.
 */
export type TeamCommand =
  | { readonly kind: 'tool'; readonly name: string; readonly command: string; readonly file: string; readonly revision: string; readonly extends: string }
  | { readonly kind: 'runtime'; readonly name: string; readonly command: string; readonly file: string; readonly revision: string };

/** Why a team file's command did not run: the person said no, closed the question unanswered, or was not there to ask. */
export interface UnacceptedTeamCommand {
  readonly ok: false;
  readonly reason: 'declined' | 'unanswered' | 'unattended';
  readonly message: string;
}

function labelOf(subject: TeamCommand): string {
  switch (subject.kind) {
    case 'tool':
      return `Tool "${subject.name}"`;
    case 'runtime':
      return `Step runtime "${subject.name}"`;
    default: {
      const unhandled: never = subject;

      return unhandled;
    }
  }
}

/** Whether `entry` of the trust file accepts `subject` at its content. */
function accepts(entry: z.infer<typeof TrustFileSchema>['accepted'][number], subject: TeamCommand): boolean {
  return (entry.kind ?? 'tool') === subject.kind && entry.name === subject.name;
}

/**
 * Whether the command of `subject` may run here: a person must have accepted its file's content on this machine. `ask`,
 * given when a person at a terminal answers, puts the question to them and returns the line they typed, or nothing once
 * the run stopped asking; a yes is recorded, and anything else declines. With no one to ask, an unaccepted content is
 * refused, naming what to run.
 */
export async function acceptTeamCommand(
  subject: TeamCommand,
  { ask }: { ask: ((question: string) => Promise<string | undefined>) | undefined },
): Promise<{ ok: true } | UnacceptedTeamCommand> {
  const trust = await readTrust();

  if (trust.accepted.some((entry) => accepts(entry, subject) && entry.revision === subject.revision)) return { ok: true };
  const short = subject.revision.slice(0, 12);
  const label = labelOf(subject);

  if (ask) {
    const inPlaceOf = subject.kind === 'tool' ? `, in place of ${subject.extends}` : '';

    const question = `${label} comes from the team repo (${subject.file}, content ${short}), which you have not accepted on this machine. `
      + `It runs ${subject.command} as you, with your files${inPlaceOf}. Review the file before you accept it.\nRun it? [y/N] `;

    const answer = await ask(question);

    if (/^y(es)?$/i.test(answer?.trim() ?? '')) {
      const kept = trust.accepted.filter((entry) => !accepts(entry, subject));
      const entry = { ...(subject.kind === 'runtime' && { kind: subject.kind }), name: subject.name, revision: subject.revision, acceptedAt: new Date().toISOString() };
      await writeJsonAtomic(trustFile(), { accepted: [...kept, entry] });

      return { ok: true };
    }

    return { ok: false, reason: answer === undefined ? 'unanswered' : 'declined', message: `${label} (content ${short}) was not accepted, so ${subject.command} did not run.` };
  }

  return {
    ok: false,
    reason: 'unattended',
    message: `${label} comes from the team repo (${subject.file}, content ${short}) and runs ${subject.command}, which no one has accepted on this machine, and an unattended run does not ask. `
      + 'Run the same command once in a terminal, attended, to review and accept it, then run it unattended again.',
  };
}

/** Why a team instance's command did not run. */
export interface UnacceptedCommand {
  readonly ok: false;
  readonly code: 'tool_not_accepted';
  readonly message: string;
}

/**
 * Whether `instance`'s command may run here (`acceptTeamCommand`). Only a team instance that sets one needs it.
 */
export async function acceptToolCommand(
  instance: ResolvedToolInstance,
  { ask }: { ask: ((question: string) => Promise<string | undefined>) | undefined },
): Promise<{ ok: true } | UnacceptedCommand> {
  if (instance.source !== 'team' || instance.command === undefined) return { ok: true };
  const accepted = await acceptTeamCommand({ kind: 'tool', name: instance.name, command: instance.command, file: instance.file, revision: instance.revision, extends: instance.extends }, { ask });

  return accepted.ok ? accepted : { ok: false, code: 'tool_not_accepted', message: accepted.message };
}
