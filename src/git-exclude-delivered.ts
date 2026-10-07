import fse from 'fs-extra';
import path from 'node:path';
import { loadStateForScope, saveStateForScope } from './config.js';
import {
  gitExcludeFile,
  realFilePath,
  remove,
  sync,
  type GitExcludeOwner,
  type GitExcludeWrite,
} from './git-exclude.js';
import type { LocalConfig } from './types.js';
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

/** teamai's `delivered` owner, its exclude files recorded in the partition's state.json. */
export function deliveredOwner(localConfig: LocalConfig): GitExcludeOwner {
  return {
    name: DELIVERED_OWNER,
    record: {
      files: async () => (await loadStateForScope(localConfig)).gitExcludeFiles?.[DELIVERED_OWNER] ?? [],
      update: async ({ add, drop }) => {
        const state = await loadStateForScope(localConfig);
        const before = state.gitExcludeFiles?.[DELIVERED_OWNER] ?? [];
        const files = [...new Set([...before, ...add])].filter((f) => !drop.includes(f)).sort();
        if (files.length === before.length && files.every((f) => before.includes(f))) return;
        const { [DELIVERED_OWNER]: _dropped, ...others } = state.gitExcludeFiles ?? {};
        state.gitExcludeFiles = files.length > 0 ? { ...others, [DELIVERED_OWNER]: files } : others;
        await saveStateForScope(state, localConfig);
      },
    },
  };
}

/**
 * Make teamai's `delivered` block in the project's exclude file hold `paths`
 * while `enabled`, or remove that block, and no other owner's, when not. Only
 * paths inside the project checkout are listed.
 */
export async function applyDeliveredGitExclude(localConfig: LocalConfig, enabled: boolean, paths: Iterable<string>): Promise<void> {
  const projectRoot = localConfig.projectRoot;
  if (!projectRoot) return;
  const owner = deliveredOwner(localConfig);
  const root = await fse.realpath(projectRoot).catch(() => projectRoot);
  const inside = [...paths].filter((p) => p.startsWith(`${root}${path.sep}`));
  if (enabled) {
    const result = await sync(owner, inside);
    for (const file of result.files) warnUnwritten(file.excludeFile, file.write, 'update');
    for (const refused of result.refused) log.warn(`Not kept out of git: ${refused.message}.`);
    for (const { path: file, error } of result.gitFailed) log.warn(`Could not keep ${file} out of git: ${error}`);
    return;
  }
  // Also the project's own exclude file, when the record lost track of it.
  const own = await gitExcludeFile(projectRoot);
  for (const removal of await remove(owner, { files: own ? [own.excludeFile] : [] })) {
    if (removal.write.kind !== 'missing') warnUnwritten(removal.excludeFile, removal.write, 'remove');
  }
}

function warnUnwritten(excludeFile: string, write: GitExcludeWrite, action: 'update' | 'remove'): void {
  const why = write.kind === 'locked' ? `another teamai command held it past the wait`
    : write.kind === 'notWritable' || write.kind === 'notReadable' ? write.message
    : write.kind === 'writeFailed' ? write.error
    : null;
  if (why === null) return;
  log.warn(`Could not ${action} teamai's delivered git exclude block in ${excludeFile}: ${why}. Fix the cause, then run \`teamai pull\` again.`);
}
