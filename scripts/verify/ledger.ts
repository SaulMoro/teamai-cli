/**
 * What a world's runs left behind, written to <world>/LEDGER-<n>.md. A LEAK line fails the verdict whatever the
 * claim's own checks say: teamai must not reach this checkout or the real HOME, and must not leave worktrees behind.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { descriptorOf, TOOL_ORDER } from '../../src/tool-registry.js';
import type { ToolId } from '../../src/tools.js';
import { z } from 'zod';
import { defaultToolHome, envToolHome, toolHome } from '../../src/tool-home.js';
import { detectToolRoot, LocalConfigSchema, RELOCATABLE_TOOLS, TeamaiConfigBaseSchema, type ToolPathsSchema } from '../../src/types.js';
import { defaultPathsOf, instanceHomeDir, instanceReadPath, teamToolInstances, type ResolvedToolInstance } from '../../src/tool-instances.js';
import { projectsRootDir } from '../../src/utils/partition.js';
import { parseYaml } from '@teamai/shared/yaml';
import { MCP_SERVER_KEY } from '../../src/resources/mcp-format.js';
import type { ToolDescriptor } from '@teamai/tool-core/definition';
import { isJsonObject, parseJson, type JsonValue } from '@teamai/shared/json';
import { PERSONAL_DIRS } from '../../src/workflow/runtimes/layers.js';
import { leftoversSection } from './leftovers.js';
import { runOn, type Target } from './target.js';
import { checkoutStatus, git, loadWriters, REPO_ROOT, teamRefs, worldFiles, worldWritersFile, type World } from './world.js';

interface Section {
  readonly title: string;
  readonly leaks: string[];
  readonly notes: string[];
}

const MAX_SCANNED_BYTES = 1024 * 1024;

function teamRepo(world: World): Section {
  const notes: string[] = [];
  const before = world.baseline.teamRefs;
  const after = teamRefs(world.team);

  for (const ref of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (before[ref] === after[ref]) continue;
    notes.push(`team repo ${ref}: ${before[ref]?.slice(0, 7) ?? 'absent'} -> ${after[ref]?.slice(0, 7) ?? 'deleted'}`);
  }

  if (notes.length === 0) notes.push('team repo unchanged since the world was created');

  // What teamai pushes to the origin is a run's result or the member's own work: a note, never a leak.
  if (world.origin !== undefined) {
    const { refs: was } = world.origin;
    const now = teamRefs(world.origin.bare);
    const moved = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort().filter((ref) => was[ref] !== now[ref]);

    for (const ref of moved) notes.push(`origin ${ref}: ${was[ref]?.slice(0, 7) ?? 'absent'} -> ${now[ref]?.slice(0, 7) ?? 'deleted'}${RUN_BRANCH.test(`project/.git/${ref}`) ? ", a run's branch" : ''}`);

    if (moved.length === 0) notes.push('origin unchanged since the harness made it');
  }

  for (const place of ledgerPlaces(world)) {
    const dirty = git(place.project, 'status', '--porcelain');
    notes.push(dirty ? `${place.label}project changes:\n${dirty.split('\n').map((line) => `      ${line}`).join('\n')}` : `${place.label}project working tree clean`);
  }

  return { title: '(a) Team repo and project', leaks: [], notes };
}

function worktrees(world: World): Section {
  const leaks = [...ledgerPlaces(world).map((place) => place.project), world.team, ...world.origin === undefined ? [] : [world.origin.bare]]
    .flatMap((repo) =>
      git(repo, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length))
        .filter((dir) => !fs.existsSync(dir) || fs.realpathSync.native(dir) !== repo),
    )
    .map((dir) => `worktree ${dir} left behind${fs.existsSync(dir) ? '' : ' (directory missing)'}`);

  return { title: '(b) Leftover worktrees', leaks, notes: leaks.length > 0 ? [] : ['none'] };
}

/**
 * Files under `dir`, to a depth of three, changed since the world was born and whose path or content names the world.
 * A world's own directory names hold its run id, so a partition or transcript made for it is found by name.
 */
function namingWorld(dir: string, world: World, since: number, found: string[], unreadable: string[], depth = 0): void {
  if (!fs.existsSync(dir)) return;
  const id = world.runId.toLowerCase();
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    unreadable.push(dir);

    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.name.toLowerCase().includes(id)) {
      found.push(full);
      continue;
    }

    if (entry.isDirectory()) {
      if (depth < 3) namingWorld(full, world, since, found, unreadable, depth + 1);
      continue;
    }

    // Pull delivers by symlink too, and a world's path holds its run id; a linked directory is read like any other.
    if (entry.isSymbolicLink()) {
      try {
        if (fs.readlinkSync(full).toLowerCase().includes(id)) found.push(full);
        else if (depth < 3 && fs.statSync(full).isDirectory()) namingWorld(full, world, since, found, unreadable, depth + 1);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) unreadable.push(full);
      }

      continue;
    }

    // A .jsonl is a session log: the session running this world types its run id, so its content proves nothing.
    if (!entry.isFile() || entry.name.endsWith('.jsonl')) continue;

    // A live tool home deletes files while it is read.
    try {
      const stat = fs.statSync(full);

      if (stat.mtimeMs < since || stat.size > MAX_SCANNED_BYTES) continue;
      const text = fs.readFileSync(full, 'utf8');

      if (text.includes(world.dir) || text.includes(world.runId)) found.push(full);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) unreadable.push(full);
    }
  }
}

function hostFiles(world: World, instances: readonly ResolvedToolInstance[]): Section {
  const leaks: string[] = [];
  const notes: string[] = [];
  const before = new Set(world.baseline.checkoutStatus);

  for (const line of checkoutStatus()) if (!before.has(line)) leaks.push(`this checkout changed: ${line}`);
  const checkoutHead = git(REPO_ROOT, 'rev-parse', 'HEAD');

  // A commit empties the status lines it made, so HEAD is compared too; one of your own also counts.
  if (checkoutHead !== world.build.commit) leaks.push(`this checkout's HEAD moved: ${world.build.commit.slice(0, 7)} -> ${checkoutHead.slice(0, 7)}`);
  const realHome = os.homedir();
  const since = Date.parse(world.createdAt);
  // Every tool home TOOLS knows: default, recorded, and moved by this shell's env (also a relocated tool root), so a new tool is checked without editing this list.
  const homes = [...new Set([path.join(realHome, '.teamai'), ...TOOL_ORDER.flatMap((tool) => [defaultToolHome(tool, { home: realHome, path }), toolHome(tool), envToolHome(tool)?.dir ?? []].flat()), ...Object.keys(RELOCATABLE_TOOLS).flatMap((tool) => detectToolRoot(tool) ?? []), ...instances.flatMap((instance) => (instance.home === undefined ? [] : [path.join(realHome, instance.home.dir), instanceHomeDir(instance.home, instance.extends)]))])];
  const found: string[] = [];
  const unreadable: string[] = [];

  for (const home of homes) namingWorld(home, world, since, found, unreadable);

  for (const dir of unreadable) notes.push(`not readable, so not checked: ${dir}`);

  // Tool homes often link to one shared directory: report each real file once.
  const real = new Map(found.toReversed().map((file) => [path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file)), file]));

  for (const file of real.values()) leaks.push(`real HOME names this world: ${file}`);
  notes.push(`checked ${homes.length} homes under ${realHome}`);
  const landed = fs.existsSync(world.home) ? fs.readdirSync(world.home).sort() : [];
  notes.push(`in the world's HOME: ${landed.join(', ') || 'nothing'}`);

  return { title: '(c) Host files', leaks, notes };
}

/** Section (d)'s lines: the variables, by name, each install's commands got. */
export function environmentNotes(world: Pick<World, 'bin' | 'members'>): string[] {
  const run = fs.readFileSync(path.join(world.bin, 'run'), 'utf8');
  const names = [...run.matchAll(/ ([A-Z_]+)='/g)].map((match) => match[1]);

  return [`commands got only: ${names.join(', ')}`, ...(world.members ?? []).map((member) => `@${member.name}'s commands got only: ${Object.keys(member.env).join(', ')}`)];
}

function environment(world: World): Section {
  return { title: '(d) Environment', leaks: [], notes: environmentNotes(world) };
}

/** What `teamai uninstall` leaves today, each tracked in KNOWN_LEFTOVERS_ISSUE; any other leftover is a LEAK. */
const KNOWN_LEFTOVERS_ISSUE = 'https://github.com/Tencent/teamai-cli/issues/1808';

// Each with what it holds: a sha256, `dir`, or `any` where the content names this machine or is a log.

/** teamai's own leftovers, which no tool reads. */
const TEAMAI_LEFTOVERS: readonly (readonly [string, string])[] = [
  // debug.log stays: an uninstall that failed is explained there, and that
  // record is worth more than the file, so ~/.teamai stays to hold it (#1808).
  ['home/.teamai', 'dir'],
  ['home/.teamai/projects', 'dir'],
  ['home/.teamai/debug.log', 'any'],
  // What the hooks of a session leave today, in a world that ran them.
  ['home/.teamai/dashboard', 'dir'],
  ['home/.teamai/dashboard/session-owners.jsonl', 'any'],
  ['home/.teamai/dashboard/events.jsonl', 'any'],
  ['home/.teamai/dashboard/requests.jsonl', 'any'],
  // The skills a session used, kept across log truncation (usage-tracker.ts `updateKnownSkills`).
  ['home/.teamai/known-skills.json', 'any'],
  ['home/.teamai/state.json', 'any'],
];

/**
 * What a shipped tool writes for itself where teamai writes, as that tool has it in HOME: each file with what it holds,
 * and the directories it leaves with everything in them. teamai starts Codex's app-server to trust its hooks (#955), and
 * Codex writes its system skills, and the table of hook approvals that taking teamai's out leaves empty.
 */
const TOOL_LEFTOVERS: Partial<Record<ToolId, { readonly files: readonly (readonly [string, string])[]; readonly dirs: readonly string[] }>> = {
  codex: {
    files: [['home/.codex/skills', 'dir'], ['home/.codex/config.toml', createHash('sha256').update('[hooks.state]\n').digest('hex')]],
    dirs: ['home/.codex/skills/.system'],
  },
};

/** The part of an install's config.yaml that names its team repo. */
const InstallRepo = z.object({ repo: LocalConfigSchema.shape.repo });

/**
 * Each tool instance an install under `home` declares: those of the team repo each data home's config names, every
 * namespace's, and the member's own in ~/.teamai/tools, with its home as teamai joins it to HOME. Read before
 * `teamai uninstall`, which removes those records. An instance it cannot read is judged as no tool's: what it left is a LEAK.
 */
export async function toolInstancesIn(home: string): Promise<ResolvedToolInstance[]> {
  const projects = projectsRootDir(home);
  const dataHomes = [path.join(home, '.teamai'), ...(fs.existsSync(projects) ? fs.readdirSync(projects).map((slug) => path.join(projects, slug)) : [])];

  const teamRepos = dataHomes.flatMap((dataHome) => {
    const file = path.join(dataHome, 'config.yaml');
    let text: unknown;

    try {
      text = parseYaml(fs.readFileSync(file, 'utf8'));
    } catch {
      return [];
    }

    const config = InstallRepo.safeParse(text);

    return config.success ? [config.data.repo.localPath] : [];
  });

  const instances = await Promise.all([
    ...[...new Set(teamRepos)].map((root) => teamToolInstances({ root, namespaces: async () => 'legacy' })),
    // The member's own folder has the team root's layout, with no namespaces.
    teamToolInstances({ root: path.join(home, '.teamai'), namespaces: async () => [] }),
  ]);

  // `.acme/`, `./.acme` and `.acme` name one folder.
  return instances.flat().map((instance) => (instance.home === undefined ? instance : { ...instance, home: { ...instance.home, dir: path.posix.normalize(instance.home.dir).replace(/\/+$/, '') } }));
}

const Base = z.enum(['home', 'project']);

const Read = z.union([
  z.object({ base: Base, path: z.string() }).transform(({ base, path: read }) => [`${base}/${read}`]),
  z.object({ base: Base, firstOf: z.array(z.union([z.string(), z.object({ path: z.string() }).transform((file) => file.path)])) })
    .transform(({ base, firstOf }) => firstOf.map((read) => `${base}/${read}`)),
]);

/** Every path under HOME and in the project that TOOLS says `tool` reads, each candidate of a `firstOf` too: where teamai writes for it. */
function toolReads(tool: ToolId): string[] {
  const paths: string[] = [];

  JSON.stringify(descriptorOf(tool), (_key, value) => {
    const read = Read.safeParse(value);

    if (read.success) paths.push(...read.data);

    return value;
  });

  return paths;
}

/**
 * A tool as the ledger judges it: a shipped tool in its own home, or an instance of one in another. An instance is the
 * tool it extends reading another home, so every rule of that tool holds for it with its paths placed as the instance
 * reads them (`instanceReadPath`).
 */
interface ToolView {
  readonly tool: ToolId;
  /** Its home under HOME. */
  readonly home: string;
  /** Where teamai delivers its resources, as its tool paths say. */
  readonly paths: z.infer<typeof ToolPathsSchema>;
  /** `entry`, a `home/…` or `project/…` path the shipped tool reads, as this one reads it. */
  readonly placed: (entry: string) => string;
}

const SHIPPED_PATHS = TeamaiConfigBaseSchema.shape.toolPaths.parse(undefined);

const SHIPPED_VIEWS: readonly ToolView[] = TOOL_ORDER.map((tool) => ({ tool, home: descriptorOf(tool).home.dir, paths: SHIPPED_PATHS[tool] ?? {}, placed: (entry) => entry }));

/** The view of `instance`; none for one with no home of its own, which reads where its tool does. */
function instanceView(instance: ResolvedToolInstance): ToolView[] {
  if (instance.home === undefined || instance.name === instance.extends) return [];

  const placed = (entry: string): string => {
    const [base, ...rest] = entry.split('/');

    return base === 'home' || base === 'project' ? `${base}/${instanceReadPath(instance, { from: base, relative: rest.join('/') })}` : entry;
  };

  return [{ tool: instance.extends, home: instance.home.dir, paths: instance.paths ?? defaultPathsOf(instance), placed }];
}

/**
 * Each state file of `tool` beside its home (`home.stateFiles`), as a `home/…` entry, with the key the tool's user MCP
 * servers sit under, where teamai may have written them: Claude's ~/.claude.json is both.
 */
function stateFilesOf(tool: ToolId): [string, string | undefined][] {
  const { home, mcp }: Pick<ToolDescriptor, 'home' | 'mcp'> = descriptorOf(tool);
  const servers = mcp.user instanceof Object && mcp.user.format !== 'codex' ? MCP_SERVER_KEY[mcp.user.format] : undefined;

  return (home.stateFiles ?? []).map((file) => [`home/${file}`, servers]);
}

/** Whether `text` names teamai beyond the harness's own paths: every world's directory and TMPDIR hold `teamai-verify`. */
function mentionsTeamai(text: string): boolean {
  return /teamai/i.test(text.replaceAll(/teamai-verify[\w.-]*/g, ''));
}

/**
 * Whether `text`, the file at `entry`, is a tool's own state file (`home.stateFiles`) holding nothing of teamai's: no
 * name of teamai, and no non-empty object under the key the tool's MCP servers sit under, at any depth, where a server
 * teamai wrote would be. Text that is not JSON holds something of teamai's, as far as the ledger can tell.
 */
function isToolOwnState(stateFiles: ReadonlyMap<string, string | undefined>, entry: string, text: string): boolean {
  if (!stateFiles.has(entry) || mentionsTeamai(text)) return false;
  const servers = stateFiles.get(entry);

  if (servers === undefined) return true;
  let parsed: JsonValue;

  try {
    parsed = parseJson(text);
  } catch {
    return false;
  }

  const holds = (value: JsonValue): boolean => {
    if (Array.isArray(value)) return value.some(holds);

    return isJsonObject(value) && Object.entries(value).some(([name, inner]) => (name === servers && isJsonObject(inner) && Object.keys(inner).length > 0) || holds(inner));
  };

  return !holds(parsed);
}

/**
 * What sbx v0.51.0 and v0.53.0 write for themselves on macOS in a HOME they are asked `sbx ls` or `sbx template ls`
 * from while not signed in there, and what v0.53.0 adds for `sbx secret ls`, which teamai asks once `sbx ls` answers:
 * its update check, and its feature toggles in its cache. Anything else of it stays a LEAK.
 */
const SBX_OWN = ['analyticskit', 'auth-ambiguous-refresh', 'auth-cooldown', 'locks', 'settings.json.lock', 'sandboxd/client.log', 'sandboxd/update-state.json'];

/**
 * Where a program keeps state of its own, which teamai writes none of: `dir` names it in a note, `paths` are its own.
 * `makesDir`: the program makes those folders, and those that hold them, too; a tool's home is #1808's (`knownLeftover`).
 * Never a whole store a teamai run fills, such as sbx's images and sandbox disks: what is left there stays a LEAK.
 */
const PROGRAMS_STATE = [
  // T3 Code checkpoints the project a thread of a teamai run works in, under refs/t3.
  { owner: 'T3 Code', dir: 'project/.git/refs/t3', paths: ['project/.git/refs/t3'], makesDir: true },
  // OpenCode's own folders under the XDG folders of a HOME that sets none, as its home under ~/.config is: v2.3.0 makes
  // them on any start, `opencode --version` included, which doctor, pull and a workflow launch ask, and keeps a step's
  // session there. What its TUI keeps beyond them (~/.local/share/opentui, bun's cache) stays a LEAK.
  ...['home/.cache/opencode', 'home/.local/share/opencode', 'home/.local/state/opencode'].map((dir) => ({ owner: 'OpenCode', dir, paths: [dir], makesDir: true })),
  // Teamai's sandbox runtime, doctor, the observer and section (f) all ask sbx in a world's HOME.
  { owner: 'sbx', dir: 'home/Library/Application Support/com.docker.sandboxes', paths: SBX_OWN.map((own) => `home/Library/Application Support/com.docker.sandboxes/sandboxes/${own}`), makesDir: true },
  { owner: 'sbx', dir: 'home/Library/Caches/com.docker.sandboxes', paths: ['policykit', 'unleash-toggles-production.json'].map((own) => `home/Library/Caches/com.docker.sandboxes/sandboxes/${own}`), makesDir: true },
];

/** Whose own state an entry left behind is, or the owner of a folder made only to hold such state. */
type OwnState = { kind: 'state'; owner: string; dir: string } | { kind: 'folder'; owner: string };

/** A run's branch, which a run that succeeded keeps as its result (docs/guide/workflow.md, The branches a run leaves). */
const RUN_BRANCH = /^project\/\.git\/refs\/heads\/teamai(\/r[0-9a-f]{16}(\/[^/]+(\/p\d+)?)?)?$/;

/** What the project's repository tracks, and what differs from its HEAD, is untracked or is ignored, each relative to the project. */
function repositoryView(project: string) {
  // Untrimmed: a status line starts with a space when the index matches HEAD.
  const list = (...args: string[]): string[] | undefined => {
    const listed = spawnSync('git', args, { cwd: project, encoding: 'utf8' });

    return listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : undefined;
  };

  const tracked = fs.existsSync(path.join(project, '.git')) ? list('ls-files', '-z') : undefined;
  const dirty = tracked === undefined ? undefined : list('status', '--porcelain', '-z', '--ignored', '--untracked-files=all');

  // A repository git cannot read, such as one with a broken config, vouches for nothing.
  return tracked === undefined || dirty === undefined ? { tracked: [], dirty: [] } : { tracked, dirty: dirty.map((line) => line.slice(3)) };
}

/** git's copy of what a remote holds, which a fetch or a push writes whoever asked for it. */
const REMOTE_REF = /^project\/\.git\/refs\/remotes(\/|$)/;

/** git's note of the last fetch, which every fetch rewrites whoever asked for it, as it does the remote's refs. */
const FETCH_HEAD = 'project/.git/FETCH_HEAD';

/** teamai's own directories: whatever wrote last there, it is teamai's to remove. */
const TEAMAI_ROOTS = ['home/.teamai', 'project/.teamai'];

/** The member's own folders in ~/.teamai, which teamai reads and never writes, so uninstall keeps them. */
const MEMBERS_OWN = Object.values(PERSONAL_DIRS).map((dir) => `home/.teamai/${dir}`);

/** Where teamai hides what it adds to the project, beside the member's own patterns. */
const GIT_EXCLUDE = 'project/.git/info/exclude';

/** How the ledger judges what an install left: the shipped tools' rules, and each instance's, derived from its tool's. */
export interface LedgerRules {
  /**
   * Whose own state the entry left behind with `value` is, and the folder a note names; or the owner of a folder made
   * only to hold such state, whose other contents are judged on their own; undefined when it may be teamai's.
   */
  ownStateOf(entry: string, value: string | undefined): OwnState | undefined;
  /**
   * Whether `text`, the file at `entry`, is a tool's own state file (`home.stateFiles`) holding nothing of teamai's: no
   * name of teamai, and no non-empty object under the key the tool's MCP servers sit under, at any depth, where a server
   * teamai wrote would be. Text that is not JSON holds something of teamai's, as far as the ledger can tell.
   */
  isToolOwnState(entry: string, text: string): boolean;
  /**
   * Where teamai writes, which neither a member's command nor a tool's home excuses: an agent's session runs teamai's
   * hooks, which pull, and teamai names what it adds elsewhere in a tool's home, such as an adapter, after itself.
   * Of git's settings, teamai writes its own, the worktree extension and a hooks path to its hooks.
   */
  isTeamaiPlace(entry: string, value: string | undefined): boolean;
  /** The files teamai writes its part into beside a tool's own settings, never a resource it delivers into a folder. */
  isSharedFile(entry: string): boolean;
  /** What `entry` is known to hold when uninstall leaves it (#1808): a sha256, `dir`, or `any`. */
  knownLeftover(entry: string): string | undefined;
  /** Directories left with everything in them: session ids name what is in them, or the tool installs them. */
  readonly knownLeftoverDirs: readonly string[];
}

/** The rules for an install that declares `instances`: the shipped tools', and each instance's as its tool's. */
export function ledgerRules(instances: readonly ResolvedToolInstance[]): LedgerRules {
  const views = [...SHIPPED_VIEWS, ...instances.flatMap(instanceView)];
  const reads = [...new Set(views.flatMap((view) => toolReads(view.tool).map(view.placed)))];
  const homeWrites = reads.filter((read) => read.startsWith('home/'));

  const projectWrites = [...new Set([
    ...views.flatMap(({ paths }) => [paths.skills, paths.rules, paths.settings, paths.agents, paths.mcpProject, paths.claudemd].flatMap((write) => (write === undefined ? [] : [`project/${write}`]))),
    ...reads.filter((read) => read.startsWith('project/')),
  ])];

  const writes = [...TEAMAI_ROOTS, ...homeWrites, ...projectWrites, GIT_EXCLUDE];
  const sharedFiles = new Set([...homeWrites, ...projectWrites, GIT_EXCLUDE]);

  // Each tool's own state file beside its home (`home.stateFiles`): Claude's ~/.claude.json, inside an instance's moved home.
  const stateFiles = new Map(views.flatMap((view) => stateFilesOf(view.tool).map(([file, servers]): [string, string | undefined] => [view.placed(file), servers])));

  // A tool's home under HOME holds the tool's own state (sessions, caches, the runtime of a Codex teamai starts to trust its hooks) beside what teamai writes there.
  const ownState = [...[...new Set(views.map((view) => `home/${view.home}`))].map((dir) => ({ owner: 'the tool', dir, paths: [dir], makesDir: false })), ...PROGRAMS_STATE];

  // A tool's own directory stays: teamai removes what it put inside, not the directory the tool reads. Removing ~/.claude
  // stopped Claude's MCP config from being written in the mcp-uninstall e2e, so uninstall leaves it (#1808). So do the
  // folders above it, and the top directory of each project path teamai writes for a tool.
  const toolDirs = views.flatMap((view) => [
    ...view.home.split('/').map((_, i, parts) => `home/${parts.slice(0, i + 1).join('/')}`),
    ...[view.paths.skills, view.paths.rules, view.paths.settings, view.paths.agents, view.paths.mcpProject].flatMap((dir) => (dir?.includes('/') ? [`project/${dir.split('/')[0]}`] : [])),
  ]);

  const known = new Map<string, string>([
    ...toolDirs.map((dir) => [dir, 'dir'] as const),
    ...TEAMAI_LEFTOVERS,
    ...views.flatMap((view) => (TOOL_LEFTOVERS[view.tool]?.files ?? []).map(([entry, holds]) => [view.placed(entry), holds] as const)),
  ]);

  const knownLeftoverDirs = ['home/.teamai/sessions', ...views.flatMap((view) => (TOOL_LEFTOVERS[view.tool]?.dirs ?? []).map(view.placed))];

  const isTeamaiPlace = (entry: string, value: string | undefined): boolean =>
    writes.some((write) => entry === write || entry.startsWith(`${write}/`))
    || entry.split('/').some((segment) => /^teamai([-_.]|$)/i.test(segment))
    || /#((.*\.)?teamai|extensions\.worktreeconfig$)/i.test(entry)
    || (/#core\.hookspath$/i.test(entry) && /teamai/i.test(value ?? ''));

  return {
    ownStateOf(entry, value) {
      if (isTeamaiPlace(entry, value)) return undefined;
      const state = ownState.find(({ paths, makesDir }) => paths.some((own) => entry.startsWith(`${own}/`) || (makesDir && entry === own)));

      if (state !== undefined) return { kind: 'state', owner: state.owner, dir: state.dir };
      const folder = value === 'dir' ? ownState.find(({ paths, makesDir }) => makesDir && paths.some((own) => own.startsWith(`${entry}/`))) : undefined;

      return folder === undefined ? undefined : { kind: 'folder', owner: folder.owner };
    },
    isToolOwnState: (entry, text) => isToolOwnState(stateFiles, entry, text),
    isTeamaiPlace,
    isSharedFile: (entry) => sharedFiles.has(entry),
    knownLeftover: (entry) => (knownLeftoverDirs.includes(entry) ? 'any' : known.get(entry)),
    knownLeftoverDirs,
  };
}

/** One install the ledger uninstalls and compares: the world's own, or a member's, whose lines start with `@<name> `. */
interface LedgerPlace {
  readonly label: string;
  readonly target: Target;
  readonly home: string;
  readonly project: string;
  readonly writers: string;
  readonly baseline: Record<string, string> | undefined;
}

function ledgerPlaces(world: World): LedgerPlace[] {
  return [
    { label: '', target: { kind: 'world' }, home: world.home, project: world.project, writers: worldWritersFile(world), baseline: world.baseline.files },
    ...(world.members ?? []).map((member): LedgerPlace => ({ label: `@${member.name} `, target: { kind: 'member', name: member.name }, home: member.home, project: member.project, writers: member.writers, baseline: member.baseline.files })),
  ];
}

/** The file a `worldFiles` entry names: `home/…` under the place's HOME, `project/…` under its project. */
function entryPath(place: LedgerPlace, entry: string): string {
  const [base, ...rest] = entry.split('#')[0]?.split('/') ?? [];

  return path.join(base === 'home' ? place.home : place.project, ...rest);
}

/** A way in has a way out: after `teamai uninstall` each install's HOME and project match the snapshot taken when it was made. */
async function reverseState(world: World, instances: ReadonlyMap<string, readonly ResolvedToolInstance[]>): Promise<Section> {
  const title = '(e) After teamai uninstall';
  const leaks: string[] = [];
  const notes: string[] = [];

  for (const place of ledgerPlaces(world)) {
    const reversed = await reverseOf(world, place, ledgerRules(instances.get(place.label) ?? []));
    leaks.push(...reversed.leaks.map((line) => `${place.label}${line}`));
    notes.push(...reversed.notes.map((line) => `${place.label}${line}`));
  }

  return { title, leaks, notes };
}

async function reverseOf(world: World, place: LedgerPlace, rules: LedgerRules): Promise<{ leaks: string[]; notes: string[] }> {
  if (place.baseline === undefined) return { leaks: ['this world has no snapshot to compare: make a new world'], notes: [] };
  const before = place.baseline;
  // Uninstall drops a clone's registrations with it, so a worktree outside HOME and the project is listed first.
  const repos = Object.keys(worldFiles(place)).flatMap((entry) => (entry.endsWith('/.git') ? [path.dirname(entryPath(place, entry))] : []));

  const registered = new Set(
    repos.flatMap((repo) =>
      git(repo, 'worktree', 'list', '--porcelain')
        .split('\n')
        .flatMap((line) => (line.startsWith('worktree ') ? [line.slice('worktree '.length)] : []))
        .filter((dir) => !repos.includes(dir)),
    ),
  );

  const { exit: status } = await runOn(world, place.target, ['teamai', 'uninstall', '--force'], { pass: new Map() });
  const after = worldFiles(place);
  const leaks = status === 0 ? [] : [`teamai uninstall exited ${status}`];

  for (const dir of registered) if (fs.existsSync(dir)) leaks.push(`worktree ${dir} left behind after uninstall`);
  const notes: string[] = [];

  const leaked: string[] = [];
  const writers = loadWriters(place.writers);
  const theirs = new Map<string, string[]>();
  const under = (entry: string, dirs: Iterable<string>): boolean => [...dirs].some((dir) => entry.startsWith(`${dir}/`));

  const excuse = (why: string, entry: string): void => {
    if (!under(entry, [...theirs.values()].flat())) theirs.set(why, [...theirs.get(why) ?? [], entry]);
  };

  const repository = repositoryView(place.project);
  const namesTeamai = (entry: string): boolean => mentionsTeamai(fs.readFileSync(entryPath(place, entry), 'utf8'));
  const remoteTips = new Set(Object.entries(after).flatMap(([entry, value]) => (REMOTE_REF.test(entry) && value !== 'dir' ? [value] : [])));

  for (const entry of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (before[entry] === after[entry] || under(entry, [...leaked, ...rules.knownLeftoverDirs])) continue;
    const change = before[entry] === undefined ? 'left behind' : after[entry] === undefined ? 'removed' : 'changed';
    const writer = writers[entry];

    if (change === 'left behind' && MEMBERS_OWN.some((dir) => entry === dir || entry.startsWith(`${dir}/`)) && writer !== undefined && writer.value === after[entry]) {
      excuse(`the member's own, put there by ${writer.program}, which uninstall keeps`, entry);
      continue;
    }

    // A tool's sessions, or a member's own commit: left as a member's program left it, whatever teamai did in between.
    if (writer !== undefined && writer.value === (after[entry] ?? null) && !rules.isTeamaiPlace(entry, after[entry])) {
      excuse(`left as ${writer.program} wrote it, so not teamai's`, entry);
      continue;
    }

    // A file teamai shares with a tool, such as Claude's ~/.claude.json, which keeps the tool's state once teamai's part is out.
    if (writer !== undefined && writer.value === after[entry] && /^[0-9a-f]{64}$/.test(after[entry]) && rules.isSharedFile(entry) && !namesTeamai(entry)) {
      excuse(`left as ${writer.program} wrote it, with nothing of teamai's in it`, entry);
      continue;
    }

    // A tool writes its own state there whether teamai launched it or the member did: what teamai adds is its servers.
    if (change === 'left behind' && /^[0-9a-f]{64}$/.test(after[entry] ?? '') && rules.isToolOwnState(entry, fs.readFileSync(entryPath(place, entry), 'utf8'))) {
      excuse("the tool's own state file, with no MCP server and nothing else of teamai's in it", entry);
      continue;
    }

    const own = change === 'left behind' ? rules.ownStateOf(entry, after[entry]) : undefined;

    if (own?.kind === 'state') {
      excuse(`${own.owner}'s own state in ${own.dir}, where teamai writes none of it`, entry);
      continue;
    }

    if (own?.kind === 'folder') continue;

    if (REMOTE_REF.test(entry)) {
      excuse("git's copy of what the remote holds", entry);
      continue;
    }

    if (entry === FETCH_HEAD) {
      excuse("git's note of the last fetch", entry);
      continue;
    }

    if (change === 'changed' && entry.startsWith('project/.git/refs/heads/') && remoteTips.has(after[entry] ?? '')) {
      excuse("the member's branch moved to a commit the remote has, history uninstall does not rewrite", entry);
      continue;
    }

    // Uninstall keeps what the repository tracks (#915): self mode commits the team's content, and teamai's part of
    // a tracked file it edits out for the member to commit. A tracked file still naming teamai stays a leak.
    const tracked = entry.startsWith('project/') && !entry.startsWith('project/.git/') ? entry.slice('project/'.length) : undefined;
    const within = (paths: string[]): boolean => tracked !== undefined && paths.some((file) => file === tracked || file.startsWith(`${tracked}/`));

    if (within(repository.tracked) && !within(repository.dirty)) {
      excuse("the repository's, as its HEAD has it", entry);
      continue;
    }

    if (tracked !== undefined && within(repository.tracked) && /^[0-9a-f]{64}$/.test(after[entry] ?? '')
      && !/teamai/i.test(fs.readFileSync(path.join(place.project, tracked), 'utf8'))) {
      excuse("teamai's part taken out of a file the repository tracks, for the member to commit", entry);
      continue;
    }

    if (change === 'left behind' && RUN_BRANCH.test(entry)) {
      if (after[entry] !== 'dir') notes.push(`${entry.slice('project/.git/refs/heads/'.length)} left behind: a run's result branch, the member's to keep`);
      continue;
    }

    const known = rules.knownLeftover(entry);

    if (change === 'left behind' && (known === 'any' || known === after[entry])) notes.push(`${entry} left behind, known: ${KNOWN_LEFTOVERS_ISSUE}`);
    else {
      leaks.push(`${entry} ${change}${after[entry] === 'dir' || before[entry] === 'dir' ? ', with everything in it' : ''}`);
      leaked.push(entry);
    }
  }

  for (const [why, entries] of theirs) notes.push(`${why}: ${entries.join(', ')}`);

  if (leaks.length === 0 && notes.length === 0) notes.push('HOME and project match the world as it was made');

  return { leaks, notes };
}

/** Uninstalls teamai in the world, writes the next LEDGER-<n>.md and returns whether it is clean. */
export async function runLedger(world: World): Promise<boolean> {
  // Before uninstall, which removes the records that say which runtimes the world's runs used; observed after it.
  const leftovers = await leftoversSection(world);
  // The tool instances each install declares, read before uninstall too: their homes are judged as their tools' are.
  const instances = new Map(await Promise.all(ledgerPlaces(world).map(async (place) => [place.label, await toolInstancesIn(place.home)] as const)));
  const reverse = await reverseState(world, instances);
  const left = { title: '(f) What a driver left running', ...await leftovers.observe() };
  const sections = [teamRepo(world), worktrees(world), hostFiles(world, [...instances.values()].flat()), environment(world), reverse, left];
  const leaks = sections.reduce((sum, section) => sum + section.leaks.length, 0);
  const verdict = leaks === 0 ? 'CLEAN' : `${leaks} LEAK${leaks === 1 ? '' : 'S'}`;

  const body = sections
    .map((section) => [`## ${section.title}`, ...section.leaks.map((leak) => `- LEAK ${leak}`), ...section.notes.map((note) => `- ${note}`)].join('\n'))
    .join('\n\n');

  const n = fs.readdirSync(world.dir).filter((name) => /^LEDGER-\d+\.md$/.test(name)).length + 1;
  const file = path.join(world.dir, `LEDGER-${n}.md`);
  const head = `# Ledger ${n}: world ${world.runId}\n\nBuild ${world.build.commit.slice(0, 12)}${world.build.dirty ? '+dirty' : ''}, teamai ${world.build.version}\n\n`;
  fs.writeFileSync(file, `${head}${body}\n\nLedger: ${verdict}\n`);
  console.log(`${body}\n\nLedger: ${verdict}\nWritten to ${file}`);

  return leaks === 0;
}
