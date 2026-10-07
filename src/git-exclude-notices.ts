import path from 'node:path';
import { updateFileLocked } from './git-exclude.js';
import { getDataHome, type GlobalOptions, type LocalConfig } from './types.js';
import { pathExists, readFileSafe } from './utils/fs.js';
import { log } from './utils/logger.js';
import { warnOnce } from './utils/warn-once.js';

// ─── What a background pull could not say about git exclude blocks (#915) ──
//
//  A pull a session start or a git hook runs prints to no one. What it has to
//  say about teamai's git exclude blocks is kept in the project partition
//  (`git-exclude-notices.json`, separate from `git-hook-failure.json`):
//  - the last failure to update a block, replaced by each failed sync and
//    cleared by the next sync that succeeds, whoever runs it; the next
//    interactive pull says it once;
//  - notices (a path no git exclude line can name, a path left visible because
//    another checkout has its own file there, a shared file that stopped being
//    teamai's alone), each said once by the next interactive pull, which then
//    drops it. `doctor` shows both and changes nothing.

export interface GitExcludeNotice {
  at: string;
  message: string;
}

export interface GitExcludeNotices {
  /** `said`: an interactive pull has said it; `doctor` still shows it until a sync succeeds. */
  lastFailure: (GitExcludeNotice & { said?: boolean }) | null;
  notices: GitExcludeNotice[];
}

const NOTICES_FILE = 'git-exclude-notices.json';

function noticesFile(config: LocalConfig): string {
  return path.join(getDataHome(config), NOTICES_FILE);
}

/** A pull nobody watches: a session start's (`silent`) or a git hook's. */
export function isBackgroundPull(options: Pick<GlobalOptions, 'silent' | 'gitHook'>): boolean {
  return Boolean(options.silent || options.gitHook);
}

function parse(content: string | null): GitExcludeNotices {
  const empty: GitExcludeNotices = { lastFailure: null, notices: [] };
  if (!content?.trim()) return empty;
  try {
    const parsed = JSON.parse(content) as Partial<GitExcludeNotices>;
    const valid = (n: unknown): n is GitExcludeNotice => typeof (n as GitExcludeNotice)?.message === 'string' && typeof (n as GitExcludeNotice)?.at === 'string';
    return {
      lastFailure: valid(parsed.lastFailure) ? { ...parsed.lastFailure, said: parsed.lastFailure.said === true } : null,
      notices: Array.isArray(parsed.notices) ? parsed.notices.filter(valid) : [],
    };
  } catch {
    // Nothing in it is worth more than the notices to come.
    return empty;
  }
}

/** What background pulls kept for this project. Read-only. */
export async function readGitExcludeNotices(config: LocalConfig): Promise<GitExcludeNotices> {
  return parse(await readFileSafe(noticesFile(config)));
}

/**
 * Change the record under its lock. A record that cannot be written (its lock
 * held past the wait, the data home not writable) is written to debug.log
 * instead: the next pull meets the same state and tries again.
 */
async function updateNotices(config: LocalConfig, edit: (current: GitExcludeNotices) => GitExcludeNotices | null): Promise<void> {
  const file = noticesFile(config);
  try {
    const result = await updateFileLocked(file, (content) => {
      const next = edit(parse(content));
      return next === null ? null : `${JSON.stringify(next, null, 2)}\n`;
    });
    if (result === 'locked') log.persist(`git exclude: ${file} was busy, its update waits for the next pull`);
  } catch (e) {
    log.persist(`git exclude: could not update ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Say `message` about a git exclude block now, once per pull, or, in a
 * background pull, keep it for the next interactive pull and `doctor`. The
 * same message is kept once.
 */
export async function noticeGitExclude(config: LocalConfig, message: string, options: Pick<GlobalOptions, 'silent' | 'gitHook'>): Promise<void> {
  if (!isBackgroundPull(options)) {
    warnOnce(message);
    return;
  }
  log.persist(`git exclude: ${message}`);
  await updateNotices(config, (current) => current.notices.some((n) => n.message === message)
    ? null
    : { ...current, notices: [...current.notices, { at: new Date().toISOString(), message }] });
}

/** A background sync's failure, replacing the one before. */
export async function recordGitExcludeFailure(config: LocalConfig, message: string): Promise<void> {
  log.persist(`git exclude: ${message}`);
  await updateNotices(config, (current) => ({ ...current, lastFailure: { at: new Date().toISOString(), message } }));
}

/** A sync succeeded: the last failure is over. */
export async function clearGitExcludeFailure(config: LocalConfig): Promise<void> {
  if (!await pathExists(noticesFile(config))) return;
  await updateNotices(config, (current) => current.lastFailure === null ? null : { ...current, lastFailure: null });
}

/**
 * The interactive pull's turn: say the last background failure, once, and
 * every notice, then drop the notices (the failure stays, for `doctor`,
 * until a sync succeeds). Returns whether a failure is on record.
 */
export async function sayGitExcludeNotices(config: LocalConfig): Promise<boolean> {
  const { lastFailure, notices } = await readGitExcludeNotices(config);
  const failure = lastFailure && !lastFailure.said ? lastFailure : null;
  if (failure) log.warn(`A background pull (${failure.at}) could not keep teamai's git exclude blocks up to date: ${failure.message}`);
  for (const notice of notices) warnOnce(notice.message);
  if (failure || notices.length > 0) {
    const said = new Set(notices.map((n) => n.message));
    await updateNotices(config, (current) => ({
      lastFailure: current.lastFailure && current.lastFailure.at === failure?.at ? { ...current.lastFailure, said: true } : current.lastFailure,
      notices: current.notices.filter((n) => !said.has(n.message)),
    }));
  }
  return lastFailure !== null;
}
