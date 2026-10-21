/**
 * Where teamai writes a tool's resource, where that tool reads it, and what
 * must hold for the write, on one machine. The answer depends on the tool, the
 * member's config (`Install`) and the machine (`Host`) and nothing else: no
 * `process.env`, home or filesystem read is reachable from `locate` except
 * through `host`, and paths are joined in the host's flavor, so a Linux test
 * can resolve a Windows member's paths.
 */
import path from 'node:path';
import {
  installGateOf, isToolId, TOOLS,
  type BlocksHeader, type ChannelProbe, type HomeSkillRead, type ProjectSkillRead, type ReadGateKind, type RunTimeVia,
} from './tools.js';
import {
  isAgentExcluded, resolveBaseDir, scopedToolPaths, toolGateRoot,
  type HomePaths, type LocalConfig, type TeamaiConfig,
} from './types.js';
import { homeRoot, realHost, toolHome, type Host } from './tool-home.js';
import { resolveOpenclawWorkspace } from './openclaw-home.js';

/**
 * What the member's config decides. `toolRoots` re-root user-scope paths only,
 * as they always have. A tool's home is the machine's (`Host`), not the config's.
 */
export type Install = {
  readonly toolPaths: TeamaiConfig['toolPaths'];
  readonly agents: Pick<LocalConfig, 'enabledAgents' | 'disabledAgents'>;
  readonly toolRoots: Readonly<Record<string, string>>;
} & ({ readonly scope: 'user' } | { readonly scope: 'project'; readonly projectRoot: string });

/** The one parse of the config shapes into an `Install`; a project config without its root throws `resolveBaseDir`'s error. */
export function installOf(
  team: Pick<TeamaiConfig, 'toolPaths'>,
  local: Pick<LocalConfig, 'scope' | 'projectRoot' | 'toolRoots' | 'enabledAgents' | 'disabledAgents'>,
): Install {
  const shared = {
    toolPaths: team.toolPaths,
    agents: { enabledAgents: local.enabledAgents, disabledAgents: local.disabledAgents },
    toolRoots: local.toolRoots ?? {},
  };
  switch (local.scope) {
    case 'user':
      return { ...shared, scope: 'user' };
    case 'project':
      return { ...shared, scope: 'project', projectRoot: resolveBaseDir(local) };
    default: {
      const unhandled: never = local.scope;
      return unhandled;
    }
  }
}

/** Resources `locate` answers for. */
export type Resource = 'skills';

/** A directory teamai writes one file or folder per item into: skills, agents, rule files. */
export type DirPlace = { readonly kind: 'dir'; readonly path: string };

/**
 * A file teamai keeps marked blocks in: the instruction blocks, or the
 * team-rules block of a tool that reads no rules directory. `owned`: the
 * whole file is teamai's, deleted once its blocks are gone; otherwise it is
 * the member's or the tool's.
 */
export type FilePlace = { readonly kind: 'file'; readonly path: string; readonly owned: boolean; readonly header: BlocksHeader | null };

/**
 * A map under `key` of a JSON or TOML file teamai shares with the tool, under
 * `projects[projectKey]` of that file for a local scope (#915).
 */
export type EntryPlace = { readonly kind: 'entry'; readonly path: string; readonly key: readonly [string, ...string[]]; readonly projectKey?: string };

export type Place = DirPlace | FilePlace | EntryPlace;

/** What each resource writes. */
export type PlaceOf = {
  readonly skills: DirPlace;
};

/**
 * Where the tool reads. `always`: from any session. `workspaceUnder`: from a
 * session at or under `root`. `cwdOnly`: from a session at `root` only. A file
 * read names the map it takes (`key`, and `projectKey` for a local scope).
 * `shadowedBy`: the tool reads only the first of several files that exists
 * (#993), and that is this other file, so this one is not read now.
 */
export type Read = {
  readonly path: string;
  readonly key?: readonly string[];
  readonly projectKey?: string;
  readonly shadowedBy?: string;
} & (
  | { readonly when: 'always' }
  | { readonly when: 'workspaceUnder' | 'cwdOnly'; readonly root: string }
);

/** A condition on teamai's write: pull skips a tool whose gates are not all met. */
export type Gate =
  | { readonly kind: 'selected'; readonly met: boolean }
  | { readonly kind: 'installed'; readonly probe: string; readonly met: boolean }
  /** OpenClaw's instruction files: an openclaw.json teamai cannot parse may name another workspace (#946). */
  | { readonly kind: 'readable-config'; readonly file: string; readonly met: boolean };

/**
 * A condition outside teamai's write that decides whether the tool reads it.
 * Declared, not evaluated: doctor evaluates it, and pull writes regardless,
 * so a trust a later step of the same pull grants never holds a write back.
 */
export type ReadGate = {
  readonly kind: ReadGateKind;
  /** The tool config that holds the verdict. */
  readonly config: string;
  readonly checkout: string;
};

/**
 * A place teamai wrote this resource to before and no longer writes, and why.
 * Pull strips or moves teamai's content out of it, never the member's, and
 * uninstall clears it. A place a tool left because its home moved is not one:
 * pull keeps that and names it once (`places.ts`).
 */
export type Retired<P extends Place> = {
  readonly place: P;
  readonly was:
    /** An earlier release's default, or the built-in path of a tool the team remapped. */
    | 'default'
    /** The team's configured path, where teamai no longer writes. */
    | 'configured'
    /** The target the other value of `sharing.gitExclude` selects (#915). */
    | 'git-exclude'
    /** Another file of a first-existing lookup (#993). */
    | 'lookup'
    /** A tool's project file or its local scope, whichever is not in use (#915). */
    | 'other-scope';
};

type Common<P extends Place> = { readonly retired: readonly Retired<P>[]; readonly gates: readonly Gate[] };

/**
 * teamai writes `own`: null when the tool has no place in the scope (no
 * configured path, no OpenClaw workspace). Present whether or not the gates
 * are met, so uninstall and push look where teamai may have written.
 */
export type FilesChannel<P extends Place> = Common<P> & {
  readonly channel: 'files';
  readonly own: P | null;
  readonly reads: readonly Read[] | 'unknown';
  readonly readGates: readonly ReadGate[];
};

/** teamai's session hook, extension or plugin adds the resource to each session; `probe` names the check that says it is installed there. */
export type RunTimeChannel<P extends Place> = Common<P> & {
  readonly channel: 'run-time';
  readonly via: RunTimeVia;
  readonly probe: ChannelProbe;
  /** Characters the channel takes before the tool drops the text whole. */
  readonly limit: number | null;
};

/** `none`: teamai builds nothing here, by decision. `unknown`: teamai builds nothing because where the tool takes it is unknown. */
export type SilentChannel<P extends Place> = Common<P> & { readonly channel: 'none' | 'unknown' };

/** How a resource of places `P` reaches a tool. */
export type Located<P extends Place> = FilesChannel<P> | RunTimeChannel<P> | SilentChannel<P>;

type LocationOf = {
  /** `shared`: Codex's `.agents/skills`, chosen per skill by its writer; null for every other tool. */
  readonly skills: FilesChannel<DirPlace> & { readonly shared: DirPlace | null };
};

/** Where `locate` says a tool takes `R`: one type per resource, so a caller never narrows a place kind it asked for. */
export type Location<R extends Resource = Resource> = LocationOf[R];

/** `.agents/skills`: Codex reads it, and Muse writes it in a project. */
export const SHARED_AGENT_SKILLS_PATH = '.agents/skills';

type Locator<R extends Resource> = (tool: string, install: Install, host: Host) => Promise<Location<R>>;

/** One locator per resource: a resource without one fails `tsc` here. */
const LOCATORS: { readonly [R in Resource]: Locator<R> } = {
  skills: locateSkills,
};

/** Where `tool` takes `resource` on `host` under `install`. */
export async function locate<R extends Resource>(tool: string, resource: R, install: Install, host: Host = realHost()): Promise<Location<R>> {
  return LOCATORS[resource](tool, install, host);
}

/** A place beside `own` that teamai also writes: Codex's shared skills directory. */
type Beside<P extends Place> = { readonly shared?: P | null };

/** `own` when the channel writes files and every gate is met, else null: the one rule a writer applies. */
export function writable<P extends Place>(location: Located<P>): P | null {
  return location.channel === 'files' && location.gates.every((gate) => gate.met) ? location.own : null;
}

/** `own` whatever the gates say: what push and the scans read, where pull would write. */
export function ownOf<P extends Place>(location: Located<P>): P | null {
  return location.channel === 'files' ? location.own : null;
}

/** Every place teamai writes the tool's resource to: its own, then the shared one. */
export function writesOf<P extends Place>(location: Located<P> & Beside<P>): P[] {
  if (location.channel !== 'files') return [];
  return [location.own, location.shared ?? null].filter((place) => place !== null);
}

/** Every place teamai may hold the tool's resource in: its writes and the places it retired. Uninstall clears these. */
export function cleanupOf<P extends Place>(location: Located<P> & Beside<P>): P[] {
  return [...writesOf(location), ...location.retired.map((retired) => retired.place)];
}

/** A write the tool does not read from a session at the host's cwd, and why. */
export type Unread =
  | { readonly write: string; readonly reason: 'not-read' }
  | { readonly write: string; readonly reason: 'shadowed'; readonly by: string }
  | { readonly write: string; readonly reason: 'cwd-only' | 'outside-workspace'; readonly readFrom: string };

/** The writes of `location` the tool would not read from a session in `host.cwd()`; none when it writes no files or its reads are unknown. */
export function unreadWrites<P extends Place>(location: Located<P> & Beside<P>, host: Host = realHost()): readonly Unread[] {
  if (location.channel !== 'files' || location.reads === 'unknown') return [];
  const { reads } = location;
  const p = host.path;
  const cwd = host.cwd();
  const unread: Unread[] = [];
  for (const write of writesOf(location)) {
    const read = reads.find((candidate) => readsPlace(p, candidate, write));
    if (!read) {
      unread.push({ write: write.path, reason: 'not-read' });
      continue;
    }
    if (read.shadowedBy !== undefined) {
      unread.push({ write: write.path, reason: 'shadowed', by: read.shadowedBy });
      continue;
    }
    switch (read.when) {
      case 'always':
        break;
      case 'cwdOnly':
        if (!samePathOn(p, cwd, read.root)) unread.push({ write: write.path, reason: 'cwd-only', readFrom: read.root });
        break;
      case 'workspaceUnder':
        if (!isAtOrUnder(p, cwd, read.root)) unread.push({ write: write.path, reason: 'outside-workspace', readFrom: read.root });
        break;
      default: {
        const unhandled: never = read;
        return unhandled;
      }
    }
  }
  return unread;
}

/** Whether `read` is where the tool takes `write` from: the directory itself, the file or a directory holding it, or the same map of the same file. */
function readsPlace(p: path.PlatformPath, read: Read, write: Place): boolean {
  switch (write.kind) {
    case 'dir':
      return read.key === undefined && samePathOn(p, write.path, read.path);
    case 'file':
      return read.key === undefined && isAtOrUnder(p, write.path, read.path);
    case 'entry':
      return samePathOn(p, write.path, read.path) && write.projectKey === read.projectKey
        && read.key !== undefined && read.key.length === write.key.length && read.key.every((part, i) => part === write.key[i]);
    default: {
      const unhandled: never = write;
      return unhandled;
    }
  }
}

function samePathOn(p: path.PlatformPath, a: string, b: string): boolean {
  return isAtOrUnder(p, a, b) && isAtOrUnder(p, b, a);
}

function isAtOrUnder(p: path.PlatformPath, dir: string, root: string): boolean {
  const relative = p.relative(root, dir);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative));
}

async function locateSkills(tool: string, install: Install, host: Host): Promise<Location<'skills'>> {
  const p = host.path;
  const at: HomePaths = { home: host.home, path: p };
  const configured = install.scope === 'user'
    ? scopedToolPaths(install, { scope: 'user', toolRoots: install.toolRoots }, at)[tool]?.skills
    : install.toolPaths[tool]?.skills;
  if (configured === undefined) return { channel: 'files', own: null, shared: null, reads: 'unknown', readGates: [], retired: [], gates: [] };

  const known = isToolId(tool) ? tool : undefined;
  const base = install.scope === 'user' ? host.home : install.projectRoot;
  const join = (root: string, relative: string): string => p.join(root, ...relative.split('/'));
  const home = known === undefined ? undefined : { root: homeRoot(known), dir: toolHome(known, host), installedBy: installGateOf(known) };
  // A `$HOME`-relative path, re-rooted at the tool's home when it hangs off the home's root.
  const underHome = (relative: string): string => {
    if (home && (relative === home.root || relative.startsWith(`${home.root}/`))) return join(home.dir, relative.slice(home.root.length + 1));
    return join(host.home, relative);
  };
  const enabled = install.agents.enabledAgents?.includes(tool) === true;
  const probe = async (dir: string, met?: boolean): Promise<Gate> => ({ kind: 'installed', probe: dir, met: met ?? await host.exists(dir) });

  let own: string | null;
  let shared: string | null = null;
  let installed: Gate;
  if (tool === 'openclaw') {
    const workspace = await resolveOpenclawWorkspace(undefined, { host, stateDir: home?.dir ?? join(host.home, '.openclaw') });
    let dir: string | null;
    let tried: string;
    switch (workspace.kind) {
      case 'found':
        dir = workspace.dir;
        tried = workspace.dir;
        break;
      case 'unreadable-config':
        dir = workspace.fallback;
        tried = workspace.fallback ?? workspace.file;
        break;
      case 'none':
        dir = null;
        tried = workspace.candidate;
        break;
      default: {
        const unhandled: never = workspace;
        return unhandled;
      }
    }
    own = dir === null ? null : p.join(dir, 'skills');
    installed = await probe(tried, dir !== null);
  } else if (tool === 'hermes' && home) {
    own = p.join(home.dir, 'skills');
    installed = await probe(home.dir);
  } else if (tool === 'copilot' && home) {
    // User-scope Copilot paths are relative to its home, and its home says it is installed in either scope.
    own = join(install.scope === 'user' ? home.dir : base, configured);
    installed = await probe(home.dir, enabled || undefined);
  } else {
    own = install.scope === 'user' ? underHome(configured) : join(base, configured);
    if (tool === 'codex') shared = join(base, SHARED_AGENT_SKILLS_PATH);
    if (home?.installedBy !== undefined) {
      switch (home.installedBy) {
        case 'home-edition':
          installed = await probe(join(host.home, home.root), enabled || undefined);
          break;
        case 'home':
          installed = await probe(home.dir);
          break;
        case 'own-root':
          installed = await probe(join(base, home.root));
          break;
        default: {
          const unhandled: never = home.installedBy;
          return unhandled;
        }
      }
    } else {
      const gateRoot = toolGateRoot(tool, configured, install.toolRoots, at);
      const gateRootLeftByMovedHome = home !== undefined && home.root.startsWith(`${gateRoot}/`) && home.dir !== join(host.home, home.root);
      installed = await probe(install.scope !== 'user' ? join(base, gateRoot) : gateRootLeftByMovedHome ? home.dir : underHome(gateRoot));
    }
  }

  const declared: readonly (HomeSkillRead | ProjectSkillRead)[] | 'unknown' = known === undefined ? 'unknown' : TOOLS[known].skills[install.scope];
  const reads = declared === 'unknown' ? 'unknown' : declared.map((read): Read => {
    switch (read.base) {
      case 'home': {
        const relocated = install.scope === 'user'
          ? scopedToolPaths({ toolPaths: { [tool]: { skills: read.path } } }, { scope: 'user', toolRoots: install.toolRoots }, at)[tool]?.skills ?? read.path
          : read.path;
        return { path: underHome(relocated), when: 'always' };
      }
      case 'project':
        return { path: join(base, read.path), when: read.when, root: base };
      default: {
        const unhandled: never = read;
        return unhandled;
      }
    }
  });

  return {
    channel: 'files',
    own: own === null ? null : { kind: 'dir', path: own },
    shared: shared === null ? null : { kind: 'dir', path: shared },
    reads,
    readGates: [],
    retired: [],
    gates: [{ kind: 'selected', met: !isAgentExcluded(install.agents, tool) }, installed],
  };
}
