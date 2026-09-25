/**
 * Publishing queued learnings: the one place that knows where a learning goes.
 *
 * `teamai contribute` writes to the durable queue and calls this. So does
 * `teamai pull`, which is what makes an offline or rejected contribution reach
 * the team later instead of being lost. A queue entry is dropped only once its
 * content is confirmed on origin, so a failure of any kind is always safe.
 */
import path from 'node:path';
import fs from 'node:fs';
import type { SimpleGit } from 'simple-git';

import { ensureDir } from './fs.js';
import { parseFrontmatter } from './frontmatter.js';
import { createGit } from './git.js';
import { learningsBranch } from './learnings-branch.js';
import { CheckoutRefusedError, failureReason, fetchTrackingRef, type PublishResult } from './branch-worktree.js';
import { log } from './logger.js';
import {
  dropPendingLearning,
  listPendingForInstall,
  listPendingLearnings,
  readPendingLearning,
  savePendingLearning,
} from './pending-learnings.js';
import { acquireLock, releaseLock } from '../update.js';
import { getDataHome, SYNC_LOCK_FILENAME, type LocalConfig } from '../types.js';

export interface PublishQueueReport {
  /** Learnings confirmed on origin during this run, relative to `learnings/`. */
  published: string[];
  /** Learnings still queued afterwards. */
  remaining: number;
  /**
   * Why the queue did not drain, when it did not. Present only when something
   * is still queued because publishing failed, not when the queue was empty.
   */
  lastError?: string;
  /**
   * `lastError` is a checkout refusal: every pull meets it too, so the queue
   * stays until the member does what the refusal says.
   */
  refused?: true;
  /**
   * Why nothing was published at all: the install the command loaded is not
   * this queue's any more (init switched its kind, or its config moved away),
   * so the learnings stay where they are, for the install they belong to.
   */
  installChanged?: string;
}

function commitMessageFor(username: string): string {
  return `[teamai] Contribute session knowledge from ${username}`;
}

/**
 * Publish everything in the queue, as one commit. Best-effort and non-blocking:
 * it never throws, and a failure leaves every entry queued for the next run
 * rather than hammering an unreachable origin.
 */
export async function publishQueuedLearnings(
  localConfig: LocalConfig,
  username: string,
  options: { holdsSyncLock?: boolean; dryRun?: boolean } = {},
): Promise<PublishQueueReport> {
  // Publishing writes to the team clone, which `pull` and `push` guard with the
  // partition sync lock. On contention nothing is lost and nothing is forced:
  // the learnings stay queued and the run that holds the lock publishes them.
  // `pull` already holds the lock when it calls this, and the lock is not
  // reentrant, so it says so instead of deadlocking against itself.
  const syncLock = options.holdsSyncLock ? null : syncLockPath(localConfig);
  const locked = syncLock === null || await acquireLock(syncLock);
  try {
    return await publishUnderSyncLock(localConfig, username, locked, options.dryRun === true);
  } finally {
    if (syncLock && locked) await releaseLock(syncLock);
  }
}

async function publishUnderSyncLock(
  localConfig: LocalConfig,
  username: string,
  locked: boolean,
  dryRun: boolean,
): Promise<PublishQueueReport> {
  // Before the queue is read, which this adds to. Only under the sync lock:
  // two commands at once would each queue the same file.
  if (locked && !dryRun) await queueImportRemnants(localConfig);

  const listing = await listPendingForInstall(localConfig);
  switch (listing.status) {
    case 'listed':
      break;
    case 'busy':
      return {
        published: [],
        remaining: (await listPendingLearnings(localConfig)).length,
        lastError: `another teamai command holds ${listing.lockPath}`,
      };
    case 'changed':
      return {
        published: [],
        remaining: 0,
        installChanged: `this project's teamai install changed while this command ran (${listing.configPath} ${listing.cause})`,
      };
    default: {
      const unhandled: never = listing;
      throw new Error(`Unhandled queue listing: ${JSON.stringify(unhandled)}`);
    }
  }
  const queued = listing.queued;
  if (queued.length === 0) {
    return { published: [], remaining: 0 };
  }
  if (dryRun) return { published: [], remaining: queued.length };
  if (!locked) {
    log.debug('[learnings] a pull or push is in progress; leaving the queue for it');
    return {
      published: [],
      remaining: queued.length,
      lastError: 'another teamai pull or push is in progress',
    };
  }

  try {
    const report = await publishToLearningsBranch(localConfig, username, queued);

    for (const relPath of report.published) {
      await dropPendingLearning(localConfig, relPath);
    }
    return { ...report, remaining: queued.length - report.published.length };
  } catch (e) {
    // Never throw: a contribution is already safe in the queue, and publishing
    // it is never the reason a command fails.
    log.debug(`[learnings] publishing failed (non-blocking): ${(e as Error).message}`);
    return {
      published: [],
      remaining: queued.length,
      lastError: failureReason(e),
      refused: e instanceof CheckoutRefusedError || undefined,
    };
  }
}

/**
 * The partition sync lock, or null when this config cannot resolve one. A
 * `scope: 'project'` config without a project root is permitted by the schema,
 * and publishing must not be the thing that crashes on it: it just runs
 * unguarded, exactly as contribute always did.
 */
function syncLockPath(localConfig: LocalConfig): string | null {
  try {
    return path.join(getDataHome(localConfig), SYNC_LOCK_FILENAME);
  } catch {
    return null;
  }
}

/**
 * How `import --from-mr` in 0.25.0 to 0.26.0-beta.3 named the learning it wrote:
 * `<YYYY-MM-DD>-<title>.md`, the title part empty when no character of it was kept.
 */
const IMPORT_REMNANT_NAME = /^\d{4}-\d{2}-\d{2}-(.*)\.md$/;

/** The merge request a learning was extracted from, from its frontmatter. */
function sourceMr(frontmatter: Record<string, unknown>): string | null {
  const mr = frontmatter.source_mr;
  return typeof mr === 'string' && mr.trim() !== '' ? mr.trim() : null;
}

/**
 * Queue what `import --from-mr` (0.25.0 to 0.26.0-beta.3) wrote into the learnings checkout and
 * never committed (#823 item 7), so the publish that follows sends it. Such a
 * file never reached the team and, in single-repo mode, keeps git from removing
 * the checkout an older teamai left in `.teamai/`.
 *
 * Only that exact shape moves: untracked, directly under `learnings/`, named
 * `<date>-<title>.md`, with `source_mr` in its frontmatter. Nothing else in the
 * checkout is touched; a learning on the branch is tracked, edited or not, so it
 * never is. One is removed instead when the branch or the queue already has one
 * from the same merge request (a later import of it) or with the same content. The copy is queued before the original goes, so
 * a failure leaves it where it was. Never throws.
 */
async function queueImportRemnants(localConfig: LocalConfig): Promise<void> {
  try {
    const checkout = await learningsBranch.registeredCheckout(localConfig);
    if (checkout === null) return;
    const git = createGit(checkout);
    const lsFiles = async (args: string[]): Promise<string[]> =>
      (await git.raw(['ls-files', '-z', ...args, '--', 'learnings'])).split('\0').filter(Boolean);

    const remnants: Array<{ file: string; content: string; mr: string; title?: string }> = [];
    for (const rel of await lsFiles(['--others', '--exclude-standard'])) {
      // Directly under `learnings/`: those versions wrote nothing into a namespace.
      if (rel.split('/').length !== 2) continue;
      const named = IMPORT_REMNANT_NAME.exec(path.posix.basename(rel));
      if (!named) continue;
      const file = path.join(checkout, rel);
      const content = await fs.promises.readFile(file, 'utf-8');
      const { data } = parseFrontmatter(content);
      const mr = sourceMr(data);
      if (mr === null) continue;
      const title = typeof data.title === 'string' && data.title.trim() ? data.title : named[1];
      remnants.push({ file, content, mr, title: title || undefined });
    }
    if (remnants.length === 0) return;

    // What already covers a remnant: a learning on the branch, in any
    // namespace, or one in the queue.
    const known: Array<{ label: string; content: string; mr: string | null }> = [];
    for (const rel of (await lsFiles([])).filter((f) => f.endsWith('.md'))) {
      const content = await fs.promises.readFile(path.join(checkout, rel), 'utf-8').catch(() => null);
      if (content !== null) known.push({ label: rel, content, mr: sourceMr(parseFrontmatter(content).data) });
    }
    // The checkout may be behind origin: the one an older teamai left in
    // `.teamai/` is never synced again (#823 item 21). What a teammate published
    // since counts too.
    for (const rel of await publishedSinceCheckout(git)) {
      const content = await git.show([`origin/${learningsBranch.branch}:${rel}`]).catch(() => null);
      if (content !== null) known.push({ label: rel, content, mr: sourceMr(parseFrontmatter(content).data) });
    }
    for (const rel of await listPendingLearnings(localConfig)) {
      const content = await readPendingLearning(localConfig, rel);
      if (content !== null) {
        known.push({ label: `the contribution queue (${rel})`, content, mr: sourceMr(parseFrontmatter(content).data) });
      }
    }

    const { generateFilename, resolveLearningsSubdir } = await import('../contribute.js');
    const subdir = await resolveLearningsSubdir(localConfig);
    const queued: string[] = [];
    for (const remnant of remnants) {
      const covered = known.find((k) => k.content === remnant.content || k.mr === remnant.mr);
      if (covered) {
        await fs.promises.rm(remnant.file, { force: true });
        log.warn(`Removed ${remnant.file}, which an older teamai import --from-mr left unpublished: ${covered.label} already has it.`);
        continue;
      }
      const relPath = path.posix.join(subdir, generateFilename(remnant.title));
      const saved = await savePendingLearning(localConfig, relPath, remnant.content);
      if (saved.status !== 'saved') {
        log.debug(`[learnings] could not queue ${remnant.file}: ${saved.status}`);
        break;
      }
      await fs.promises.rm(remnant.file, { force: true });
      queued.push(remnant.file);
      known.push({ label: `the contribution queue (${relPath})`, content: remnant.content, mr: remnant.mr });
    }
    if (queued.length > 0) {
      log.warn(`Queued ${queued.length} learning(s) an older teamai import --from-mr left unpublished: ${queued.join(', ')}`);
    }
  } catch (e) {
    log.debug(`[learnings] could not queue what an older import --from-mr left: ${failureReason(e)}`);
  }
}

/**
 * The learnings origin has and the checkout's commit lacks or holds another
 * version of, after a best-effort fetch. None when origin cannot be read.
 */
async function publishedSinceCheckout(git: SimpleGit): Promise<string[]> {
  try {
    await fetchTrackingRef(git, learningsBranch.branch);
  } catch (e) {
    log.debug(`[learnings] fetch failed, comparing with the last fetched ${learningsBranch.branch}: ${failureReason(e)}`);
  }
  try {
    const diff = await git.raw(['diff', '-z', '--name-only', '--no-renames', '--diff-filter=AM', 'HEAD', `origin/${learningsBranch.branch}`, '--', 'learnings']);
    return diff.split('\0').filter((f) => f.endsWith('.md'));
  } catch (e) {
    log.debug(`[learnings] cannot compare the checkout with origin/${learningsBranch.branch}: ${failureReason(e)}`);
    return [];
  }
}

/**
 * Publish whatever maintenance just changed in the learnings worktree.
 *
 * Pruning, promotion and confidence write-backs used to mutate a checkout
 * nothing pushes, so their result reached no teammate and the next realign
 * could undo it. They now write into the worktree, and this is what makes the
 * change leave the machine.
 */
export async function publishLearningsMaintenance(
  localConfig: LocalConfig,
  message: string,
  changed: readonly string[],
): Promise<PublishResult> {
  // Only the files maintenance wrote or removed, never all of `learnings/`: the
  // checkout may hold files nobody committed, such as a learning an older
  // import --from-mr left there, and they would ride along in this commit (#823).
  const checkout = learningsBranch.dir(localConfig);
  const inCheckout = changed
    .map((file) => path.relative(checkout, file))
    .filter((rel) => rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel));
  if (inCheckout.length < changed.length) {
    log.debug(`[learnings] maintenance changed files outside ${checkout}; not publishing those`);
  }
  // A removed file git never tracked has nothing to stage, and naming it would
  // fail the whole `git add`, publishing nothing of this run.
  const removed = inCheckout.filter((rel) => !fs.existsSync(path.join(checkout, rel)));
  const tracked = removed.length === 0 ? new Set<string>()
    : new Set((await createGit(checkout).raw(['ls-files', '-z', '--', ...removed])).split('\0').filter(Boolean));
  const files = inCheckout.filter((rel) => !removed.includes(rel) || tracked.has(rel.split(path.sep).join('/')));
  if (files.length === 0) return { status: 'already-present' };
  // `commitAndPush`, not `update`: maintenance already wrote into the worktree
  // before this call, and `update` syncs with origin first, which can carry
  // those uncommitted files into a rebase or leave them behind.
  return learningsBranch.commitAndPush(localConfig, message, files);
}

/**
 * Write every queued learning into the `teamai-learnings` worktree and push it.
 *
 * One path for every git-backed repo: an independent clone and a single-repo
 * business repo differ only in where the worktree sits. Nothing touches the
 * default branch, so a member needs no write access to it, and nothing touches
 * the user's active working tree either.
 */
async function publishToLearningsBranch(
  localConfig: LocalConfig,
  username: string,
  queued: string[],
): Promise<Omit<PublishQueueReport, 'remaining'>> {
  const published: string[] = [];
  // An entry nobody can read will be skipped again on every run. Naming it is
  // the difference between "1 learning is not published" forever with no
  // reason, and something the member can act on.
  const unreadable: string[] = [];

  const result = await learningsBranch.update(localConfig, async (worktree) => {
    const files: string[] = [];
    for (const relPath of queued) {
      const content = await readPendingLearning(localConfig, relPath);
      if (content === null) {
        log.debug(`[learnings] skipping unreadable queue entry ${relPath}`);
        unreadable.push(relPath);
        continue;
      }
      const destAbs = path.join(worktree, 'learnings', relPath);
      await ensureDir(path.dirname(destAbs));
      await fs.promises.writeFile(destAbs, content, 'utf-8');
      files.push(path.posix.join('learnings', relPath.split(path.sep).join('/')));
      published.push(relPath);
    }
    if (files.length === 0) return null;
    return { files, message: commitMessageFor(username) };
  });

  const unreadableReason = unreadable.length > 0
    ? `cannot read ${unreadable.join(', ')} in the contribution queue`
    : undefined;

  switch (result.status) {
    case 'published':
      return { published, lastError: unreadableReason };
    case 'already-present':
      // The branch already carries exactly this content: an earlier run pushed
      // it and could not confirm. Dropping the queue entry now is safe.
      return { published, lastError: unreadableReason };
    case 'busy':
      return { published: [], lastError: 'another teamai write is in progress' };
    case 'failed':
      return { published: [], lastError: result.reason, refused: result.refused };
  }
}
