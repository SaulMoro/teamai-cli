/**
 * Team env by directory (#1018): a process started in a directory gets the
 * env of the scope that governs that directory, the way `resolveConfigForDir`
 * resolves it, and nothing records a machine-wide "active project".
 *
 * Each project pull records its scope in a registry under `~/.teamai`, keyed
 * the way detection keys it: the git common directory, shared by a checkout
 * and all of its worktrees, or the directory itself outside git. A shell
 * profile block sources one loader script, which looks the shell's directory
 * up in that registry and loads the matching env.sh. Several projects open at
 * once each get their own env, and a pull never rewrites the profile to switch
 * between them.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { acquireLock, releaseLock } from '../update.js';
import { getDataHome, getTeamaiHome, getTeamaiHomeDir, getUserConfigPath, type LocalConfig } from '../types.js';
import { pathExists, readFileSafe, writeFileAtomic } from '../utils/fs.js';
import { gitCommonDir } from '../utils/git.js';
import { projectsRootDir, readAnchorFile } from '../utils/partition.js';
import { log } from '../utils/logger.js';
import { isWindowsFormPath, shellQuoteValue } from '../utils/shell-profile.js';

/** The script the shell profile block sources. */
export function envLoaderPath(): string {
  return path.join(getTeamaiHomeDir(), 'env-loader.sh');
}

/**
 * One line per project scope: `git|dir <TAB> key <TAB> env.sh <TAB> 0|1 (inherits the user scope)`,
 * after one for the user scope, `user <TAB> - <TAB> env.sh <TAB> 0`, when it is set up.
 * The env.sh field is `-` for a team that keeps its env out of shells. The
 * first line, `stamp <TAB> token`, changes with every change to the registry
 * or to an env.sh: a shell that inherited its env from one started in the
 * same directory loads again when the stamp it carries is not this one.
 */
function envScopesPath(): string {
  return path.join(getTeamaiHomeDir(), 'env-scopes');
}

/** A path in the form the loader's `pwd` prints: forward slashes for a Windows path (Git Bash `pwd -W`). */
function shellForm(p: string): string {
  return isWindowsFormPath(p) ? p.replace(/\\/g, '/') : p;
}

/** The registry entry that routes `localConfig`'s directories to its env.sh, or says whether the user scope's loads in shells. */
async function scopeEntry(localConfig: LocalConfig, inShells = true): Promise<{ id: string; line: string } | null> {
  let [kind, key] = ['user', '-'];
  if (localConfig.scope === 'project') {
    if (!localConfig.projectRoot) return null;
    const common = await gitCommonDir(localConfig.projectRoot);
    [kind, key] = common
      ? ['git', common]
      : ['dir', await fs.promises.realpath(localConfig.projectRoot).catch(() => localConfig.projectRoot as string)];
  }
  const envSh = path.join(getDataHome(localConfig), 'env.sh');
  const fields = [kind, shellForm(key), inShells ? shellForm(envSh) : '-', localConfig.inheritUserScope === true ? '1' : '0'];
  // A field holding a tab or a newline cannot be stored in the line format.
  if (fields.some((field) => /[\t\n]/.test(field))) return null;
  const id = `${kind}\t${fields[1]}\t`;
  return { id, line: fields.join('\t') };
}

/**
 * Record this scope in the registry, under its lock so two projects pulling
 * at once both land. A directory no project governs gets the user scope's
 * env.sh, and a project that inherits the user scope gets it too, unless the
 * user scope's team keeps its env out of shells (`injectShellProfile: false`):
 * its line, first so the loader reads it before any project's, says so. A
 * project team that does still governs its directories, so they load none of
 * its env and none of the user scope's.
 */
export async function registerEnvScope(localConfig: LocalConfig, inShells: boolean): Promise<void> {
  const entry = await scopeEntry(localConfig, inShells);
  if (!entry) return;
  await updateEnvScopes((lines) => {
    const others = lines.filter((line) => !line.startsWith(entry.id));
    return localConfig.scope === 'user' ? [entry.line, ...others] : [...others, entry.line];
  }, { fillUserLine: localConfig.scope !== 'user' });
}

/**
 * The user scope's line for a registry that has none (an earlier version
 * pulled it), as its own pull would write it: from its config and its team's
 * `injectShellProfile`. Opted out when either cannot be read, so its env.sh
 * stays out of shells until it is pulled. Null when there is no user scope.
 */
async function userScopeLine(): Promise<string | null> {
  if (!await pathExists(getUserConfigPath())) return null;
  const user = await loadLocalConfig({ dryRun: true, suppressMigrationNotice: true });
  const team = user ? await loadTeamConfig(user.repo.localPath) : null;
  if (!user || !team) {
    log.warn('Could not read the user scope\'s config or its team\'s teamai.yaml, so its env stays out of shells. Fix that config, then run `teamai pull` outside any project.');
    return `${USER_LINE}-\t0`;
  }
  return (await scopeEntry(user, team.sharing.env.injectShellProfile !== false))?.line ?? null;
}

/** Whether the registry lets the user scope's env.sh load in shells. */
async function userEnvInShells(): Promise<boolean> {
  return !(await readFileSafe(envScopesPath()) ?? '').split('\n').some((line) => line.startsWith(`${USER_LINE}-\t`));
}

/** Take this scope out of the registry, so a project's directories get the user scope's env again. */
export async function unregisterEnvScope(localConfig: LocalConfig): Promise<void> {
  const entry = await scopeEntry(localConfig);
  if (!entry) return;
  await updateEnvScopes((lines) => lines.filter((line) => !line.startsWith(entry.id)), { fillUserLine: localConfig.scope !== 'user' });
}

/**
 * Whether no remaining scope loads env through the loader. A registered scope
 * with `-` in its env path keeps its data but does not need the shell loader.
 */
export async function isLastEnvScope(localConfig: LocalConfig): Promise<boolean> {
  const entry = await scopeEntry(localConfig);
  const hasUserConfig = await pathExists(getUserConfigPath());
  const others = (await readFileSafe(envScopesPath()) ?? '').split('\n')
    .filter((line) => line !== '' && !line.startsWith(STAMP) && (entry === null || !line.startsWith(entry.id)));
  if (others.some((line) => (!line.startsWith(USER_LINE) || hasUserConfig)
    && Boolean(line.split('\t')[2]) && line.split('\t')[2] !== '-')) return false;
  // An older user install has no registry line, so the loader still uses its
  // fallback env.sh until a pull records the user's shell-loading preference.
  return localConfig.scope === 'user' || Boolean(others.some((line) => line.startsWith(USER_LINE))) || !hasUserConfig;
}

/** Remove the shell loader when no scope loads env; keep registry entries for opted-out scopes. */
export async function removeEnvLoader(): Promise<void> {
  if (!await pathExists(getUserConfigPath())) {
    await updateEnvScopes((lines) => lines.filter((line) => !line.startsWith(USER_LINE)));
  }
  await fs.promises.rm(envLoaderPath(), { force: true });
  const scopes = (await readFileSafe(envScopesPath()) ?? '').split('\n')
    .filter((line) => line !== '' && !line.startsWith(STAMP));
  if (scopes.length === 0) await fs.promises.rm(envScopesPath(), { force: true });
}

/**
 * The files a removal of `~/.teamai` keeps for registered projects: the loader
 * only when some project env loads, the registry, and each project's data
 * directory (which holds its env.sh and config). Empty when none remain.
 */
export async function envLoaderFilesForProjects(): Promise<string[]> {
  await updateEnvScopes((lines) => lines.filter((line) => !line.startsWith(USER_LINE)));
  const projectEntries = (await readFileSafe(envScopesPath()) ?? '').split('\n')
    .filter((line) => line !== '' && !line.startsWith(STAMP) && !line.startsWith(USER_LINE));
  const homes = [...new Set([
    ...projectEntries.map((line) => line.split('\t')[2]).filter((envSh) => envSh && envSh !== '-').map((envSh) => path.dirname(envSh)),
    ...await registeredProjectDataHomes(projectEntries),
  ])];
  return [
    ...projectEntries.some((line) => {
      const envSh = line.split('\t')[2];
      return Boolean(envSh) && envSh !== '-';
    }) ? [envLoaderPath()] : [],
    ...projectEntries.length > 0 ? [envScopesPath()] : [],
    ...homes,
  ];
}

/** Match opted-out registrations to machine partitions by their authoritative anchor. */
async function registeredProjectDataHomes(projectEntries: string[]): Promise<string[]> {
  const registeredGitDirs = new Set(projectEntries.flatMap((line) => {
    const [kind, key, envSh] = line.split('\t');
    return kind === 'git' && envSh === '-' && key ? [path.normalize(key.replace(/[\\/]/g, path.sep))] : [];
  }));
  if (registeredGitDirs.size === 0) return [];
  const root = projectsRootDir();
  const partitions = (await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  const homes: string[] = [];
  for (const partition of partitions) {
    const anchor = await readAnchorFile(partition);
    if (!anchor) continue;
    const commonDir = await gitCommonDir(anchor);
    if (commonDir && registeredGitDirs.has(path.normalize(commonDir))) homes.push(partition);
  }
  return homes;
}

/** Tell shells that inherited their env that an env.sh changed, so they load it again. */
export async function markEnvChanged(): Promise<void> {
  await updateEnvScopes((lines) => lines, { changed: true, fillUserLine: true });
}

const STAMP = 'stamp\t';
const USER_LINE = 'user\t-\t';

/**
 * Change the registry under its lock. A pull (`fillUserLine`) also writes the
 * user scope's line when it is missing, so no shell loads the user env.sh on
 * the fallback alone once any pull has run.
 */
async function updateEnvScopes(
  change: (lines: string[]) => string[],
  { changed = false, fillUserLine = false }: { changed?: boolean; fillUserLine?: boolean } = {},
): Promise<void> {
  const file = envScopesPath();
  const lock = `${file}.lock`;
  let held = false;
  for (let attempt = 0; attempt < 100 && !held; attempt++) {
    held = await acquireLock(lock);
    if (!held) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!held) {
    log.warn(`Another teamai command is changing ${file}; this project's env reaches new shells after the next pull.`);
    return;
  }
  try {
    const before = (await readFileSafe(file) ?? '').split('\n').filter((line) => line !== '' && !line.startsWith(STAMP));
    const userLine = fillUserLine && !before.some((line) => line.startsWith(USER_LINE)) ? await userScopeLine() : null;
    const after = change(userLine ? [userLine, ...before] : before);
    if (changed || after.join('\n') !== before.join('\n')) {
      await writeFileAtomic(file, `${[`${STAMP}${crypto.randomUUID()}`, ...after].join('\n')}\n`);
    }
  } finally {
    await releaseLock(lock);
  }
}

/** What a shell started in a directory loads, against what the scope governing it should. */
export type DirectoryEnv =
  | { readonly kind: 'loads-scope' }
  | { readonly kind: 'loads-other'; readonly loaded: readonly string[]; readonly expected: readonly string[] }
  | { readonly kind: 'shell-without-loader'; readonly shell: string }
  | { readonly kind: 'shell-failed'; readonly shell: string; readonly reason: string };

/** The name of `shell` when it runs the loader (zsh and bash do), else null. */
export function loaderShell(shell: string): 'zsh' | 'bash' | null {
  const name = path.basename(shell).replace(/\.exe$/i, '');
  return name === 'zsh' || name === 'bash' ? name : null;
}

/**
 * Start the member's shell in `dir`, run the loader there, and compare the
 * env files it loaded with the ones `localConfig` (the scope governing `dir`)
 * should: the check runs the loader the way every shell does, so a broken
 * loader or a stale registry shows up here. Only zsh and bash run the loader.
 */
export async function directoryEnv(localConfig: LocalConfig, dir: string, shell = process.env.SHELL ?? ''): Promise<DirectoryEnv> {
  if (!loaderShell(shell)) return { kind: 'shell-without-loader', shell: path.basename(shell) || 'no SHELL' };
  const userEnvSh = path.join(getTeamaiHome('user'), 'env.sh');
  const expected = (localConfig.scope === 'project'
    ? [...(localConfig.inheritUserScope === true && await userEnvInShells() ? [userEnvSh] : []), path.join(getDataHome(localConfig), 'env.sh')]
    : [userEnvSh]).map(shellForm);
  // A fresh resolution: none of what this process's shell already loaded.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('__TEAMAI_ENV_') && key !== 'BASH_ENV'));
  let loaded: string[];
  try {
    const { stdout } = await promisify(execFile)(shell, [
      '-c', '. "$1" >/dev/null 2>&1; printf \'\\n%s%s\' "$2" "${__TEAMAI_ENV_FILES-}"', 'teamai', envLoaderPath(), LOADED_MARK,
    ], { cwd: dir, env, timeout: 10_000 });
    const at = stdout.lastIndexOf(LOADED_MARK);
    loaded = at === -1 ? [] : stdout.slice(at + LOADED_MARK.length).split('\n').filter(Boolean);
  } catch (error) {
    return { kind: 'shell-failed', shell, reason: error instanceof Error ? error.message : String(error) };
  }
  return loaded.join('\n') === expected.join('\n') ? { kind: 'loads-scope' } : { kind: 'loads-other', loaded, expected };
}

/** Where the loaded file list starts in the shell's output, after anything the member's own startup files print. */
const LOADED_MARK = '__TEAMAI_ENV_FILES__';

/** Write the loader script, unless it already says the same. */
export async function writeEnvLoader(): Promise<void> {
  const script = envLoaderScript({
    loaderFile: shellForm(envLoaderPath()),
    scopesFile: shellForm(envScopesPath()),
    userEnvSh: shellForm(path.join(getTeamaiHomeDir(), 'env.sh')),
  });
  if (await readFileSafe(envLoaderPath()) === script) return;
  await writeFileAtomic(envLoaderPath(), script);
}

/**
 * The loader. POSIX sh that zsh (in sh emulation) and bash both run, sourced
 * by every shell the profile block reaches, so it prints nothing, fails
 * nothing, and does no work when neither the directory nor the registry's
 * stamp has changed: the directory, the stamp and the files it loaded are
 * exported, so a child shell started in the same directory returns at once.
 *
 * Every variable it sets for its own bookkeeping starts with `__teamai_` (the
 * shell's) or `__TEAMAI_ENV_` (exported, so a child shell started elsewhere
 * can put back what the member had before).
 */
function envLoaderScript({ loaderFile, scopesFile, userEnvSh }: { loaderFile: string; scopesFile: string; userEnvSh: string }): string {
  return `# DO NOT EDIT: written by teamai. Loads the team env of the scope that governs
# the shell's directory (#1018).
__teamai_env_scopes=${shellQuoteValue(scopesFile)}
__teamai_env_user=${shellQuoteValue(userEnvSh)}
__teamai_env_loader=${shellQuoteValue(loaderFile)}

__teamai_env_pwd() { pwd -W 2>/dev/null || pwd -P; }

# The real path of directory $1. Never the member's cd: no CDPATH, no cd
# function, and in zsh no chpwd hooks (-q), any of which could print into it.
__teamai_env_realdir() {
  if [ -n "\${ZSH_VERSION-}" ]; then CDPATH= builtin cd -q -- "$1" 2>/dev/null; else CDPATH= builtin cd -- "$1" 2>/dev/null; fi \\
    && __teamai_env_pwd
}

# The env files the scope governing directory $1 loads, one per line. The
# user scope's line, before any project's, says whether its env.sh loads.
__teamai_env_files() {
  __teamai_kind=dir __teamai_key=$1 __teamai_found= __teamai_user=$__teamai_env_user
  if __teamai_common=$(git -C "$1" rev-parse --git-common-dir 2>/dev/null); then
    case $__teamai_common in /* | ?:/*) ;; *) __teamai_common=$1/$__teamai_common ;; esac
    __teamai_key=$(__teamai_env_realdir "$__teamai_common") && __teamai_kind=git
  fi
  if [ -f "$__teamai_env_scopes" ]; then
    while IFS='	' read -r __teamai_k __teamai_p __teamai_f __teamai_i; do
      if [ "$__teamai_k" = user ]; then
        [ "$__teamai_f" = - ] && __teamai_user=
      elif [ "$__teamai_k" = "$__teamai_kind" ] && [ "$__teamai_p" = "$__teamai_key" ]; then
        __teamai_found=1
        [ "$__teamai_i" = 1 ] && [ -n "$__teamai_user" ] && printf '%s\\n' "$__teamai_user"
        [ "$__teamai_f" = - ] || printf '%s\\n' "$__teamai_f"
        break
      fi
    done < "$__teamai_env_scopes"
  fi
  if [ -z "$__teamai_found" ] && [ -n "$__teamai_user" ]; then printf '%s\\n' "$__teamai_user"; fi
}

# Put back what the member had before the loaded files set it.
__teamai_env_unapply() {
  for __teamai_k in \${__TEAMAI_ENV_KEYS-}; do
    eval "__teamai_set=\\\${__TEAMAI_ENV_SET_$__teamai_k-}"
    if [ "$__teamai_set" = 1 ]; then
      eval "export $__teamai_k=\\"\\\${__TEAMAI_ENV_PREV_$__teamai_k}\\""
    else
      unset "$__teamai_k"
    fi
    unset "__TEAMAI_ENV_SET_$__teamai_k" "__TEAMAI_ENV_PREV_$__teamai_k"
  done
  unset __TEAMAI_ENV_KEYS
}

# One file per line. No here-document: a sandboxed tool may not let the shell
# create the temp file one needs.
__teamai_env_load() {
  __teamai_keys=
  __teamai_ifs_set=\${IFS+1} __teamai_ifs=\${IFS-}
  IFS='
'
  for __teamai_f in $__TEAMAI_ENV_FILES; do
    [ -f "$__teamai_f" ] || continue
    for __teamai_k in $(sed -n 's/^export \\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' "$__teamai_f"); do
      case " $__teamai_keys " in *" $__teamai_k "*) continue ;; esac
      __teamai_keys="$__teamai_keys $__teamai_k"
      eval "__teamai_set=\\\${$__teamai_k+1}"
      if [ "$__teamai_set" = 1 ]; then
        eval "export __TEAMAI_ENV_SET_$__teamai_k=1 __TEAMAI_ENV_PREV_$__teamai_k=\\"\\$$__teamai_k\\""
      fi
    done
    . "$__teamai_f"
  done
  if [ -n "$__teamai_ifs_set" ]; then IFS=$__teamai_ifs; else unset IFS; fi
  export __TEAMAI_ENV_KEYS="$__teamai_keys"
}

# bash reads no startup file for \`bash -c\`, except the one BASH_ENV names:
# point it here, so a bash this shell starts, a zsh's too, gets the env of its
# own directory. The member's own BASH_ENV is kept, to source after.
__teamai_env_bash_env() {
  [ "\${BASH_ENV-}" = "$__teamai_env_loader" ] && return 0
  if [ -n "\${BASH_ENV-}" ]; then export __TEAMAI_ENV_BASH_ENV="$BASH_ENV"; else unset __TEAMAI_ENV_BASH_ENV; fi
  export BASH_ENV="$__teamai_env_loader"
}

__teamai_env_apply() {
  [ -n "\${ZSH_VERSION-}" ] && emulate -L sh
  # Again on each cd: a startup file the member's runs after this one may set its own.
  __teamai_env_bash_env
  __teamai_d=$(__teamai_env_pwd) || return 0
  # Changes with the registry and with every env.sh a pull rewrites.
  __teamai_stamp=
  if [ -f "$__teamai_env_scopes" ]; then { IFS= read -r __teamai_stamp < "$__teamai_env_scopes"; } 2>/dev/null || :; fi
  [ "$__teamai_stamp" = "\${__TEAMAI_ENV_STAMP-}" ] || unset __TEAMAI_ENV_DIR __TEAMAI_ENV_FILES
  [ "$__teamai_d" = "\${__TEAMAI_ENV_DIR-}" ] && return 0
  __teamai_files=$(__teamai_env_files "$__teamai_d")
  export __TEAMAI_ENV_DIR="$__teamai_d" __TEAMAI_ENV_STAMP="$__teamai_stamp"
  [ "$__teamai_files" = "\${__TEAMAI_ENV_FILES-}" ] && return 0
  __teamai_env_unapply
  export __TEAMAI_ENV_FILES="$__teamai_files"
  __teamai_env_load
  return 0
}

# A bash that runs this as its BASH_ENV sources the member's own after it, once.
__teamai_env_chain=
if [ -n "\${BASH_VERSION-}" ] && [ "\${BASH_ENV-}" = "$__teamai_env_loader" ] && [ -z "\${__teamai_env_chained-}" ]; then
  case $- in *i*) ;; *) __teamai_env_chain=1 ;; esac
fi
__teamai_env_apply
# An interactive shell follows cd. A script does not: its cd's would each run git.
case $- in
  *i*) if [ -n "\${ZSH_VERSION-}" ]; then
      eval 'typeset -ga chpwd_functions; case " \${chpwd_functions[*]} " in *" __teamai_env_apply "*) ;; *) chpwd_functions+=(__teamai_env_apply) ;; esac'
    elif [ -n "\${BASH_VERSION-}" ]; then
      case ";\${PROMPT_COMMAND-};" in
        *";__teamai_env_apply;"*) ;;
        *) PROMPT_COMMAND="__teamai_env_apply\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
      esac
    fi ;;
esac
if [ -n "$__teamai_env_chain" ]; then
  __teamai_env_chained=1
  if [ -n "\${__TEAMAI_ENV_BASH_ENV-}" ] && [ -f "$__TEAMAI_ENV_BASH_ENV" ]; then . "$__TEAMAI_ENV_BASH_ENV"; fi
fi
:
`;
}
