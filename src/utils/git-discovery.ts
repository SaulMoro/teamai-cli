import fs from 'node:fs';
import path from 'node:path';
import { GIT_REPOSITORY_ENV } from './git-env.js';

const exists = (p: string): Promise<boolean> => fs.promises.lstat(p).then(() => true, () => false);

/** Where git starts looking from `dir`: its real path, symlinks resolved, as the working directory git runs in reads. */
const realDir = (dir: string): Promise<string> => fs.promises.realpath(dir).catch(() => path.resolve(dir));

/**
 * The `.git` entry, or else the `HEAD`, git finds first at or above `real`
 * (see realDir) when it looks for a repository; null when none. Git walks up
 * the real path: a symlink's own parents are never searched.
 */
async function firstRepositoryEntry(real: string): Promise<{ file: string; stat: fs.Stats } | null> {
  const lstat = (file: string): Promise<fs.Stats | null> => fs.promises.lstat(file).catch(() => null);
  for (let at = real; ; at = path.dirname(at)) {
    const [dotGit, head] = await Promise.all([lstat(path.join(at, '.git')), lstat(path.join(at, 'HEAD'))]);
    if (dotGit) return { file: path.join(at, '.git'), stat: dotGit };
    if (head) return { file: path.join(at, 'HEAD'), stat: head };
    if (path.dirname(at) === at) return null;
  }
}

/**
 * Whether git is sure to find no repository for `dir`, told without starting
 * it. Git looks for one at `dir` and every directory above it: a `.git` entry
 * there, or the directory being a git directory itself (a bare repository, or
 * inside a `.git`), which holds `HEAD`. With neither anywhere, and no
 * `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR` naming one, every git command
 * that needs a repository fails there. Anything found is left to git to judge.
 *
 * A project outside git, and the user scope, asked git several times per
 * command and got the same failure each time: a few lstat calls instead of a
 * process each.
 */
export async function gitFindsNoRepository(dir: string): Promise<boolean> {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) return false;
  return await firstRepositoryEntry(await realDir(dir)) === null;
}

/**
 * What tells a later read of an entry from this one: none, or its device and
 * inode, and for a file its last change and size. Not a directory's last
 * change: git writing its config or index there changes nothing git finds.
 */
const identity = (stat: fs.Stats | null): number[] | null =>
  stat && (stat.isDirectory() ? [stat.dev, stat.ino] : [stat.dev, stat.ino, stat.mtimeMs, stat.size]);

/**
 * Which repository git finds for `dir`, told without starting it: `dir`'s real
 * path, the entry gitFindsNoRepository looks for, the git directory git opens
 * from it (`.git` itself, the one a `.git` file names, or the directory
 * holding `HEAD`), and the identity of each, of its `HEAD`, of the common
 * directory it names and of the config files there (`core.worktree`, also
 * in `config.worktree`; git never takes it from a file those include), plus
 * the variables that stop git's search. A symlink inside `core.worktree`
 * retargeted later goes unseen. While the stamp stays equal, what git
 * said about where `dir` sits still holds, provided git opened `gitDir`: a
 * symlink pointed elsewhere, a repository moved, cloned again, broken,
 * removed, created inside it later, or given another work tree changes it.
 * Null when `dir` is missing or git finds none, and when the environment
 * hands git a repository (GIT_REPOSITORY_ENV), which no file tells.
 */
export async function repositoryStamp(dir: string): Promise<{ stamp: string; gitDir: string } | null> {
  if (GIT_REPOSITORY_ENV.some((name) => process.env[name] !== undefined)) return null;
  // A directory gone since is no repository git enters, whatever was said about it.
  const real = await fs.promises.realpath(dir).catch(() => null);
  if (real === null) return null;
  const entry = await firstRepositoryEntry(real);
  if (!entry) return null;
  let gitDir = path.dirname(entry.file);
  let link = '';
  if (path.basename(entry.file) === '.git') {
    link = entry.stat.isFile() ? await fs.promises.readFile(entry.file, 'utf8').catch(() => '') : '';
    const named = /^gitdir: (.+)$/m.exec(link)?.[1]?.trim();
    gitDir = named ? path.resolve(path.dirname(entry.file), named) : entry.file;
  }
  const stat = (file: string): Promise<fs.Stats | null> => fs.promises.stat(file).catch(() => null);
  const commonDirFile = (await fs.promises.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
  const [gitDirStat, head, config, worktreeConfig, commonConfig] = await Promise.all([
    stat(gitDir), stat(path.join(gitDir, 'HEAD')), stat(path.join(gitDir, 'config')), stat(path.join(gitDir, 'config.worktree')),
    stat(path.join(path.resolve(gitDir, commonDirFile), 'config')),
  ]);
  const search = [process.env.GIT_CEILING_DIRECTORIES, process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM];
  return {
    stamp: JSON.stringify([real, entry.file, identity(entry.stat), link, gitDir, identity(gitDirStat), identity(head),
      commonDirFile, identity(config), identity(worktreeConfig), identity(commonConfig), search]),
    gitDir,
  };
}

/**
 * What `git worktree list` reads about the linked worktrees of the repository
 * whose common directory is `commonDir`, from git's own files: each worktree's
 * admin directory, where its checkout is, whether that is still there, and its
 * lock, and the config saying whether the main entry is bare (the common
 * `config`, or the main checkout's own `config.worktree`; a `core.bare` set
 * in a file those include goes unseen). Equal stamps mean an equal list; adding, moving, deleting, locking or pruning a worktree
 * changes it. Null when the admin directory cannot be read for another reason
 * than being absent: no stamp then tells that list from an empty one.
 */
export async function linkedWorktreesStamp(commonDir: string): Promise<string | null> {
  const stat = (file: string): Promise<fs.Stats | null> => fs.promises.stat(path.join(commonDir, file)).catch(() => null);
  const config = (await Promise.all([stat('config'), stat('config.worktree')])).map(identity);
  const admin = path.join(commonDir, 'worktrees');
  const names = await fs.promises.readdir(admin).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : null);
  if (names === null) return null;
  names.sort();
  const entries = await Promise.all(names.map(async (name) => {
    const dir = path.join(admin, name);
    const gitdir = (await fs.promises.readFile(path.join(dir, 'gitdir'), 'utf8').catch(() => '')).trim();
    const [live, locked] = await Promise.all([
      gitdir !== '' && fs.promises.stat(path.resolve(dir, gitdir)).then(() => true, () => false),
      exists(path.join(dir, 'locked')),
    ]);
    return JSON.stringify([name, gitdir, live, locked]);
  }));
  return [JSON.stringify(config), ...entries].join('\n');
}
