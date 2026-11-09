/**
 * What `untrustedGit` read of a checkout's config, kept for its next calls in that checkout. A read through git (`git
 * config` in the checkout and each submodule, `git ls-files` for the submodules) is reused only while every file that
 * decides its answer holds the bytes it held when that read started: each reuse first reads them all again, here, rather
 * than through git. A process a step started can still be running and write one between two calls, and the next call
 * then reads through git again, as it would with nothing kept. A git command that is not read-only drops every answer.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { errnoCode } from '../utils/fs.js';

/** What each input held: its digest, `dir` for a directory, `absent` when there was nothing there. */
type ConfigInputs = ReadonlyMap<string, string>;

/** A config entry with the file it came from, as `git config --show-origin` names it (`file:<path>`, `command line:`…). */
export interface OriginEntry {
  origin: string;
  key: string;
  value: string;
}

/** What one read of a checkout's config went through: each repository read, and each submodule path its index listed. */
export interface ConfigRead {
  /** Each checkout read, the first `cwd`, with the entries read there, include keys among them. */
  levels: ReadonlyArray<{ dir: string; entries: readonly OriginEntry[] }>;
  /** Each submodule directory an index listed, whether or not it was checked out. */
  gitlinks: readonly string[];
  /** An index git could not read, so the submodules it lists are not known. */
  unread?: true;
}

/** The variables that move where git finds a repository, its index or its config away from what the paths below name. */
const MOVED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'];

/**
 * Every file `read` depends on, or undefined when one of them cannot be named, so its result is never reused: an
 * environment that moves the repository or adds config, a checkout without its own `.git`, an entry from anywhere but a
 * file, an include path relative to nothing or under a user's home by name, an include that depends on the branch
 * checked out, or an index git could not read.
 */
async function inputsOf(read: ConfigRead, env: NodeJS.ProcessEnv): Promise<string[] | undefined> {
  if (read.unread || MOVED.some((name) => env[name] !== undefined)) return undefined;
  const index = env.GIT_INDEX_FILE;

  if (index !== undefined && !path.isAbsolute(index)) return undefined;
  const global = globalFiles(env);

  if (!global) return undefined;
  const paths = new Set([...global, ...read.gitlinks.map((dir) => path.join(dir, '.git'))]);

  for (const level of read.levels) {
    const own = await repositoryFiles(level.dir, index);

    if (!own) return undefined;

    for (const file of own) paths.add(file);

    for (const entry of level.entries) {
      const file = originFile(level.dir, entry.origin);

      if (file === undefined) return undefined;
      paths.add(file);
      const included = includedFile(file, entry, env);

      if (included === null) return undefined;

      if (included !== undefined) paths.add(included);
    }
  }

  return [...paths];
}

/** The global and system config files git reads with `env`, beside those an entry names; undefined when there is no home. */
function globalFiles(env: NodeJS.ProcessEnv): string[] | undefined {
  const system = env.GIT_CONFIG_NOSYSTEM === undefined && env.GIT_CONFIG_SYSTEM !== undefined ? [path.resolve(env.GIT_CONFIG_SYSTEM)] : [];

  if (env.GIT_CONFIG_GLOBAL !== undefined) return [...system, path.resolve(env.GIT_CONFIG_GLOBAL)];

  if (!env.HOME) return undefined;

  return [...system, path.join(env.HOME, '.gitconfig'), path.join(env.XDG_CONFIG_HOME || path.join(env.HOME, '.config'), 'git', 'config')];
}

/**
 * The files of checkout `dir` git reads config and its index from: its `.git`, the git directory that names, the common
 * directory a linked worktree's names, their config and worktree config, and the index. Undefined when `dir` has no
 * `.git` of its own that names one.
 */
async function repositoryFiles(dir: string, index: string | undefined): Promise<string[] | undefined> {
  const dotGit = path.join(dir, '.git');
  const kind = await fs.stat(dotGit).catch(() => undefined);
  let gitDir: string;

  if (kind?.isDirectory()) gitDir = dotGit;
  else if (kind?.isFile()) {
    const named = /^gitdir: (.+)$/m.exec(await fs.readFile(dotGit, 'utf8'))?.[1]?.trim();

    if (!named) return undefined;
    gitDir = path.resolve(dir, named);
  } else return undefined;

  const common = await fs.readFile(path.join(gitDir, 'commondir'), 'utf8').then((text) => path.resolve(gitDir, text.trim()), () => gitDir);

  return [dotGit, path.join(gitDir, 'commondir'), path.join(common, 'config'), path.join(gitDir, 'config.worktree'), index ?? path.join(gitDir, 'index')];
}

/** The file `origin` names, resolved from `dir` as git prints it there; undefined for any origin but a file. */
function originFile(dir: string, origin: string): string | undefined {
  return origin.startsWith('file:') && origin.length > 'file:'.length ? path.resolve(dir, origin.slice('file:'.length)) : undefined;
}

/**
 * The file an include entry of `file` names, undefined when `entry` is no include, null when it cannot be named or its
 * condition reads the branch checked out, which no file here holds. A path under a user's home by name (`~user/`) is
 * one git finds in the system's user database, so it cannot be named here.
 */
function includedFile(file: string, entry: OriginEntry, env: NodeJS.ProcessEnv): string | undefined | null {
  const condition = /^includeif\.(.+)\.path$/.exec(entry.key)?.[1];

  if (entry.key !== 'include.path' && condition === undefined) return undefined;

  if (condition?.startsWith('onbranch:')) return null;

  if (entry.value.startsWith('~')) return entry.value.startsWith('~/') && env.HOME ? path.join(env.HOME, entry.value.slice(2)) : null;

  if (entry.value.startsWith('%(prefix)') || entry.value === '') return null;

  return path.resolve(path.dirname(file), entry.value);
}

/** What each of `paths` holds now; undefined when one cannot be read. */
async function readInputs(paths: readonly string[]): Promise<ConfigInputs | undefined> {
  const digests = await Promise.all(paths.map(digestOf));
  const held = new Map<string, string>();

  for (const [at, file] of paths.entries()) {
    const digest = digests[at];

    if (digest === undefined) return undefined;
    held.set(file, digest);
  }

  return held;
}

/** Whether every input still holds what `inputs` says it did. */
async function sameInputs(inputs: ConfigInputs): Promise<boolean> {
  const now = await readInputs([...inputs.keys()]);

  return now !== undefined && [...inputs].every(([file, digest]) => now.get(file) === digest);
}

async function digestOf(file: string): Promise<string | undefined> {
  try {
    return createHash('sha256').update(await fs.readFile(file)).digest('hex');
  } catch (error) {
    const code = errnoCode(error);

    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent';

    return code === 'EISDIR' ? 'dir' : undefined;
  }
}

/** The reads of one `untrustedGit`, by checkout. */
export interface ConfigReads<TAnswer, TFailure> {
  /**
   * The answer for checkout `dir`: the one kept, while every file it depends on is unchanged, else `read`'s. A read keeps
   * its answer only when the files it depends on were read before it started, so the first read in a directory, which
   * learns them, keeps none.
   */
  answer(dir: string, read: () => Promise<{ answer: TAnswer; read: ConfigRead } | { failure: TFailure }>): Promise<{ answer: TAnswer } | { failure: TFailure }>;
  /** git ran `args`: unless the command is read-only, every answer kept is read again through git, whatever its inputs hold now. */
  ran(args: readonly string[]): void;
}

/**
 * The subcommands that write no config and check out no submodule. An index `status` or `diff` refreshes is one of the
 * inputs each reuse reads again.
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'log', 'rev-parse', 'ls-files', 'show', 'cat-file', 'merge-base', 'for-each-ref', 'rev-list', 'ls-tree', 'diff-tree']);

/** The subcommand of git `args`, after the global options; `-c`, `-C` and the path options spelled without `=` take the next one. */
function subcommandOf(args: readonly string[]): string | undefined {
  let at = 0;

  while (at < args.length && (args[at] ?? '').startsWith('-')) at += ['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(args[at] ?? '') ? 2 : 1;

  return args[at];
}

/** Reads kept for git that runs with `env`, empty. */
function open<TAnswer, TFailure>(env: NodeJS.ProcessEnv): ConfigReads<TAnswer, TFailure> {
  /** By checkout: every file its last read depends on, and that read's answer with what those files held when it began. */
  const kept = new Map<string, { inputs: readonly string[]; answer?: { held: ConfigInputs; value: TAnswer } }>();

  return {
    async answer(dir, read) {
      const at = path.resolve(dir);
      const known = kept.get(at);

      if (known?.answer && (await sameInputs(known.answer.held))) return { answer: known.answer.value };
      const before = known && (await readInputs(known.inputs));
      const fresh = await read();

      if ('failure' in fresh) {
        kept.delete(at);

        return fresh;
      }

      const inputs = await inputsOf(fresh.read, env);

      if (!inputs) kept.delete(at);
      else kept.set(at, before && inputs.every((file) => before.has(file)) ? { inputs, answer: { held: before, value: fresh.answer } } : { inputs });

      return { answer: fresh.answer };
    },
    ran(args) {
      if (READ_ONLY_COMMANDS.has(subcommandOf(args) ?? '')) return;

      for (const each of kept.values()) delete each.answer;
    },
  };
}

export const ConfigReads = {
  /** Reads kept for git that runs with `env`, empty. */
  open,
} as const;
