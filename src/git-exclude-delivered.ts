import fse from 'fs-extra';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadStateForScope, saveStateForScope } from './config.js';
import {
  existingAncestor,
  gitExcludeFile,
  realFilePath,
  remove,
  sync,
  type GitExcludeOwner,
  type GitExcludeWrite,
} from './git-exclude.js';
import { getDataHome, type LocalConfig } from './types.js';
import { pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';

// ─── What pull delivered into a checkout, kept out of git (#915) ──
//
//  Every writer of a pull reports to one recorder the paths it wrote, or
//  confirmed as teamai's, in this run; a destination it declined (a member's
//  file, a kept copy, a failed write) is never reported. After the last writer
//  (source skills), pull merges the reports into the checkout record's
//  `gitExcludePaths` and syncs teamai's `delivered` block in `.git/info/exclude`
//  with them while `sharing.gitExclude` is on; off, it removes that block.

/** The writers of a pull, as `gitExcludePaths` keys them. */
export const WRITER_IDS = [
  'skills', 'rules', 'agents', 'docs', 'builtin', 'sources', 'instructions', 'hooks', 'coauthor', 'teamai-only',
] as const;
export type WriterId = (typeof WRITER_IDS)[number];

/** A checkout's delivered paths by `WriterId`: absolute, as they landed. A key this CLI does not know is kept as it is. */
export type GitExcludePaths = Record<string, string[]>;

export const DELIVERED_OWNER = 'delivered';

/**
 * What one pull's writers delivered into the project checkout. Only `pull()`
 * creates one, for the project scope; a write it does not carry (the local
 * agent's handler calls) never reaches the `delivered` block.
 *
 * How the reports replace the stored list, writer by writer, on `merge`:
 * - fast path (`fullSync` never called): add-only, every writer.
 * - full sync, writer `succeeded` and not `failed`: what it reported, possibly nothing.
 * - full sync, writer `failed`, or neither (it did not run): its previous
 *   entries that still exist on disk, plus what it reported.
 */
export interface DeliveryRecorder {
  /** `file`, absolute, was written or confirmed as teamai's by `writer` in this run. */
  report(writer: WriterId, file: string): void;
  /** `writer` ran to its end with nothing left undelivered: an early return with nothing to deliver counts. */
  succeeded(writer: WriterId): void;
  /** `writer` left something undelivered (a failed write, a held resource). Wins over `succeeded`. */
  failed(writer: WriterId): void;
  /** This pull is a full sync, not the "Already synced" fast path. */
  fullSync(): void;
  /** `previous` (the record's list) with this run's reports applied, as `gitExcludePaths` stores it. */
  merge(previous: Record<string, string[]> | undefined): Promise<GitExcludePaths>;
}

export function createDeliveryRecorder(): DeliveryRecorder {
  const reports = new Map<string, Set<string>>();
  const succeeded = new Set<string>();
  const failed = new Set<string>();
  let full = false;
  return {
    report: (writer, file) => {
      const set = reports.get(writer) ?? new Set<string>();
      reports.set(writer, set.add(file));
    },
    succeeded: (writer) => { succeeded.add(writer); },
    failed: (writer) => { failed.add(writer); },
    fullSync: () => { full = true; },
    merge: async (previous) => {
      const next: GitExcludePaths = {};
      for (const writer of new Set([...Object.keys(previous ?? {}), ...reports.keys()])) {
        const reported = await Promise.all([...reports.get(writer) ?? []].map((file) => realFilePath(file)));
        const before = previous?.[writer] ?? [];
        const kept = !full ? before : succeeded.has(writer) && !failed.has(writer) ? [] : await existing(before);
        const paths = [...new Set([...kept, ...reported])].sort();
        if (paths.length > 0) next[writer] = paths;
      }
      return next;
    },
  };
}

async function existing(paths: string[]): Promise<string[]> {
  const found = await Promise.all(paths.map((p) => fse.lstat(p).then(() => p, () => null)));
  return found.filter((p): p is string => p !== null);
}

/**
 * teamai's `delivered` owner for the project's own repository, its exclude
 * files recorded in the partition's state.json.
 */
export function deliveredOwner(localConfig: LocalConfig): GitExcludeOwner {
  return partitionOwner(localConfig, DELIVERED_OWNER);
}

/**
 * teamai's owner for what this project delivers into other repositories: a
 * tool folder that is a submodule or a nested clone, a tool home under version
 * control. Its block there is named after this partition, `delivered/<id>`,
 * so a repository that is itself a teamai project keeps its own `delivered`
 * block, and projects sharing a tool home each drop only their own lines.
 */
export function deliveredOwnerElsewhere(localConfig: LocalConfig): GitExcludeOwner {
  return partitionOwner(localConfig, `${DELIVERED_OWNER}/${partitionId(localConfig)}`);
}

/** The partition's 16-hex anchor hash, as its directory name ends (`projectSlug`), else a hash of its path. */
function partitionId(localConfig: LocalConfig): string {
  const dataHome = getDataHome(localConfig);
  return /-([0-9a-f]{16})$/.exec(path.basename(dataHome))?.[1]
    ?? createHash('sha256').update(path.resolve(dataHome)).digest('hex').slice(0, 16);
}

function partitionOwner(localConfig: LocalConfig, name: string): GitExcludeOwner {
  return {
    name,
    record: {
      files: async () => (await loadStateForScope(localConfig)).gitExcludeFiles?.[name] ?? [],
      update: async ({ add, drop }) => {
        const state = await loadStateForScope(localConfig);
        const before = state.gitExcludeFiles?.[name] ?? [];
        const files = [...new Set([...before, ...add])].filter((f) => !drop.includes(f)).sort();
        if (files.length === before.length && files.every((f) => before.includes(f))) return;
        const { [name]: _dropped, ...others } = state.gitExcludeFiles ?? {};
        state.gitExcludeFiles = files.length > 0 ? { ...others, [name]: files } : others;
        await saveStateForScope(state, localConfig);
      },
    },
  };
}

// ─── Every live checkout's list ───────────────────────────────

/** A live checkout of the project and its delivered paths; `paths` null: live, with no list yet (no full sync since an older CLI). */
export interface ListedCheckout {
  root: string;
  paths: string[] | null;
}

/** A delivered path left without a line: `file`, the same path in the checkout at `checkout`, is not in that checkout's list. */
export interface ForeignPath {
  /** The listed path, absolute. */
  path: string;
  /** Its path from its checkout's root, `/`-separated. */
  rel: string;
  checkout: string;
  file: string;
}

export interface DeliveredUnion {
  /** What the `delivered` blocks list: every live checkout's paths but the foreign ones. */
  paths: string[];
  foreign: ForeignPath[];
}

/** Claude Code reads it as the member's own, per checkout: never foreign in another checkout. */
const PERSONAL = new Set(['.claude/settings.local.json']);

/**
 * The paths teamai's `delivered` blocks list for a project: the union of the
 * lists of its live checkouts, less each path that is foreign in another live
 * checkout, since one line in the exclude file they share would hide that
 * checkout's file too. A path is foreign in checkout X when X's root joined
 * with its path from its own checkout's root exists (lstat) and is not in X's
 * list. A checkout without a list has no foreign files; a listed path outside
 * its own checkout (the main checkout's hook file) is not tested. Read-only.
 */
export async function deliveredUnion(checkouts: ListedCheckout[]): Promise<DeliveredUnion> {
  const listed = await Promise.all(checkouts.flatMap(({ root, paths }) => paths === null ? [] : [(async () => ({
    root: await fse.realpath(root).catch(() => root),
    paths,
    set: new Set(paths),
  }))()]));
  const result: DeliveredUnion = { paths: [], foreign: [] };
  for (const checkout of listed) {
    for (const file of checkout.paths) {
      const rel = path.relative(checkout.root, file);
      const inside = rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
      const portable = rel.split(path.sep).join('/');
      const foreign = inside && !PERSONAL.has(portable) ? await foreignIn(listed.filter((other) => other !== checkout), rel) : [];
      result.foreign.push(...foreign.map((other) => ({ path: file, rel: portable, checkout: other.root, file: other.file })));
      if (foreign.length === 0) result.paths.push(file);
    }
  }
  result.paths = [...new Set(result.paths)].sort();
  return result;
}

async function foreignIn(others: Array<{ root: string; set: Set<string> }>, rel: string): Promise<Array<{ root: string; file: string }>> {
  const found = await Promise.all(others.map(async ({ root, set }) => {
    const file = path.join(root, rel);
    return !set.has(file) && await fse.lstat(file).then(() => true, () => false) ? { root, file } : null;
  }));
  return found.filter((f) => f !== null);
}

/** The pull line naming each foreign path once, by the file that holds its line back. */
export function warnForeign(foreign: ForeignPath[]): void {
  const named = new Set<string>();
  for (const { rel, file } of foreign) {
    if (named.has(file)) continue;
    named.add(file);
    log.warn(`Left ${rel} visible to git in every checkout: ${file} is not a copy teamai delivered there, and a git exclude line would hide it too.`);
  }
}

// ─── Sync ─────────────────────────────────────────────────────

/**
 * Make teamai's `delivered` blocks hold `paths` while `enabled`, each in the
 * exclude file git reads for it: the project's own repository's in the
 * `delivered` block, another repository's (a submodule, a nested clone, a
 * tool home under version control) in this partition's `delivered/<id>`
 * block. Off, remove those blocks, and no other owner's. A path outside every
 * repository is left out.
 */
export async function applyDeliveredGitExclude(localConfig: LocalConfig, enabled: boolean, paths: Iterable<string>): Promise<void> {
  const projectRoot = localConfig.projectRoot;
  if (!projectRoot) return;
  const own = await gitExcludeFile(projectRoot);
  const here = deliveredOwner(localConfig);
  const elsewhere = deliveredOwnerElsewhere(localConfig);
  if (enabled) {
    const split = await byRepository(own?.excludeFile ?? null, paths);
    for (const [owner, list] of [[here, split.here], [elsewhere, split.elsewhere]] as const) {
      const result = await sync(owner, list);
      for (const file of result.files) warnUnwritten(file.excludeFile, file.write, 'update');
      for (const refused of result.refused) log.warn(`Not kept out of git: ${refused.message}.`);
      for (const { path: file, error } of result.gitFailed) log.warn(`Could not keep ${file} out of git: ${error}`);
    }
    return;
  }
  // Also the project's own exclude file, when the record lost track of it.
  for (const [owner, files] of [[here, own ? [own.excludeFile] : []], [elsewhere, []]] as const) {
    for (const removal of await remove(owner, { files })) {
      if (removal.write.kind !== 'missing') warnUnwritten(removal.excludeFile, removal.write, 'remove');
    }
  }
}

/**
 * `paths` split by whether git reads them through `ownExclude` (any checkout
 * of the project's repository) or through another repository's exclude file.
 * git is asked once per repository: from the closest directory above a path's
 * landed location that holds `.git`, where git's own search would stop. A
 * path with no `.git` above it goes with the others; `sync` leaves it out.
 */
async function byRepository(ownExclude: string | null, paths: Iterable<string>): Promise<{ here: string[]; elsewhere: string[] }> {
  const excludeOf = new Map<string, Promise<string | null>>();
  const split = { here: [] as string[], elsewhere: [] as string[] };
  for (const file of paths) {
    let dir: string | null = await existingAncestor(await realFilePath(file));
    while (dir !== null && !await pathExists(path.join(dir, '.git'))) dir = path.dirname(dir) === dir ? null : path.dirname(dir);
    if (dir !== null && !excludeOf.has(dir)) excludeOf.set(dir, gitExcludeFile(dir).then((found) => found?.excludeFile ?? null));
    const excludeFile = dir === null ? null : await excludeOf.get(dir);
    (excludeFile !== null && excludeFile === ownExclude ? split.here : split.elsewhere).push(file);
  }
  return split;
}

function warnUnwritten(excludeFile: string, write: GitExcludeWrite, action: 'update' | 'remove'): void {
  const why = write.kind === 'locked' ? `another teamai command held it past the wait`
    : write.kind === 'notWritable' || write.kind === 'notReadable' ? write.message
    : write.kind === 'writeFailed' ? write.error
    : null;
  if (why === null) return;
  log.warn(`Could not ${action} teamai's delivered git exclude block in ${excludeFile}: ${why}. Fix the cause, then run \`teamai pull\` again.`);
}
