/**
 * teamai's git hook: a named hook in a repository's local git config that runs
 * `teamai hook-dispatch <event> --tool git` on `post-checkout` and
 * `post-merge`, so a new worktree gets the team's resources before
 * `git worktree add` returns.
 *
 * Config hooks (`hook.<name>.command` + `hook.<name>.event`, Git >= 2.54) live
 * in the common config every worktree shares, and run beside `core.hooksPath`
 * and `.git/hooks` scripts, so no hook manager's files are touched.
 *
 * Git gives the command no event name, so each event gets its own named hook.
 * Git runs the command as `sh -c '<command> "$@"' <args>`: its arguments land
 * on the command's last simple command. The command is therefore a function
 * definition followed by its call, which receives them, and the function ends
 * in `|| :` so the hook always exits 0 (a non-zero `post-checkout` becomes the
 * exit status of `git worktree add`).
 */

import { ensureTeamaiWrapper, TEAMAI_BIN_DIR } from './builtin-hooks.js';
import path from 'node:path';
import { getDataHome, type LocalConfig } from './types.js';
import { execCommand } from './utils/exec.js';
import { readJson, remove, writeJson } from './utils/fs.js';
import { log } from './utils/logger.js';

export const GIT_HOOK_EVENTS = ['post-checkout', 'post-merge'] as const;
export type GitHookEvent = (typeof GIT_HOOK_EVENTS)[number];

/** The `--tool` value of a dispatch git runs. */
export const GIT_HOOK_TOOL = 'git';

/** First Git release with config-defined hooks. */
const MIN_GIT: readonly [number, number] = [2, 54];

const ZERO_OID = /^0+$/;

function hookName(event: GitHookEvent): string {
  return `teamai-${event}`;
}

/** The shell line git runs for `event`. */
export function gitHookCommand(event: GitHookEvent): string {
  return `teamai_git_hook() { PATH="$HOME/${TEAMAI_BIN_DIR}:$PATH" teamai hook-dispatch ${event} --tool ${GIT_HOOK_TOOL} "$@" >/dev/null 2>&1 || :; }; teamai_git_hook`;
}

export type GitHookInstall =
  | { installed: true; changed: boolean }
  | { installed: false; reason: 'old-git' | 'not-a-repository' };

export type GitHookStatus =
  | { installed: true }
  | { installed: false; reason: 'old-git'; gitVersion: string }
  | { installed: false; reason: 'not-a-repository' | 'not-configured' };

type Git = (args: string[]) => ReturnType<typeof execCommand>;
const gitIn = (repoDir: string): Git => (args) => execCommand('git', args, { cwd: repoDir, timeoutMs: 10_000 });

async function eventsToWrite(git: Git): Promise<GitHookEvent[]> {
  const stale: GitHookEvent[] = [];
  for (const event of GIT_HOOK_EVENTS) {
    const key = `hook.${hookName(event)}`;
    const current = (await git(['config', '--local', '--get', `${key}.command`])).stdout.trim();
    const events = (await git(['config', '--local', '--get-all', `${key}.event`])).stdout.trim();
    if (current !== gitHookCommand(event) || events !== event) stale.push(event);
  }
  return stale;
}

/** Whether the hook is in the local config of the repository holding `repoDir`, and why not. */
export async function gitHookStatus(repoDir: string): Promise<GitHookStatus> {
  const git = gitIn(repoDir);
  const version = (await git(['--version'])).stdout.trim();
  if (!supportsConfigHooks(version)) return { installed: false, reason: 'old-git', gitVersion: version };
  if ((await git(['rev-parse', '--git-dir'])).code !== 0) return { installed: false, reason: 'not-a-repository' };
  return (await eventsToWrite(git)).length === 0 ? { installed: true } : { installed: false, reason: 'not-configured' };
}

/** What `doctor` says about a hook that is not installed: the cause, then the next step. */
export function describeMissingGitHook(status: Exclude<GitHookStatus, { installed: true }>): string {
  switch (status.reason) {
    case 'old-git':
      return `${status.gitVersion || 'This git'} has no config-based hooks (Git 2.54 or later), so new worktrees and `
        + '`git pull` get the team\'s resources only at the next session. Upgrade git, then run `teamai pull`.';
    case 'not-a-repository':
      return 'The project root is not a git repository, so there is no git event to hook.';
    case 'not-configured':
      return 'The teamai hooks are not in this repository\'s git config. Run `teamai pull` to install them.';
  }
}

/**
 * Write (or refresh) the hook into the local config of the repository holding
 * `repoDir`. Idempotent: an up-to-date hook is left untouched.
 */
export async function installGitHook(repoDir: string): Promise<GitHookInstall> {
  const git = gitIn(repoDir);
  if (!supportsConfigHooks((await git(['--version'])).stdout)) return { installed: false, reason: 'old-git' };
  if ((await git(['rev-parse', '--git-dir'])).code !== 0) return { installed: false, reason: 'not-a-repository' };

  // The wrapper is what the hook command finds `teamai` through when the app
  // that runs git has no login PATH.
  ensureTeamaiWrapper();

  const stale = await eventsToWrite(git);
  for (const event of stale) {
    const key = `hook.${hookName(event)}`;
    await ok(git(['config', '--local', `${key}.command`, gitHookCommand(event)]), key);
    await ok(git(['config', '--local', '--replace-all', `${key}.event`, event]), key);
  }
  if (stale.length > 0) log.debug(`git hook: installed teamai hooks in ${repoDir}`);
  return { installed: true, changed: stale.length > 0 };
}

async function ok(result: ReturnType<typeof execCommand>, key: string): Promise<void> {
  const { code, stderr } = await result;
  if (code !== 0) throw new Error(`git config ${key} failed: ${stderr.trim() || `exit ${code}`}`);
}

function supportsConfigHooks(versionOutput: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(versionOutput);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]);
}

/**
 * Whether a `post-checkout` with these arguments created a checkout (a new
 * worktree): Git passes an all-zero old ref then. A branch switch passes the
 * previous HEAD.
 */
export function isNewCheckout(args: readonly string[]): boolean {
  const [oldRef, , branchFlag] = args;
  return !!oldRef && ZERO_OID.test(oldRef) && branchFlag === '1';
}

/**
 * Variables through which Git hands a hook the repository it runs for
 * (`git rev-parse --local-env-vars`, minus GIT_CONFIG_COUNT and its
 * GIT_CONFIG_KEY/VALUE pairs, which a member sets in their own environment and
 * Git never adds for a hook). Every git child teamai starts would inherit them
 * and act on the business repo instead of the team clone it names.
 */
const REPOSITORY_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
] as const;

/** Drop the repository Git exported for the hook, before teamai runs any git. */
export function clearGitHookRepositoryEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of REPOSITORY_ENV) delete env[name];
}

// ─── Recorded failures ─────────────────────────────────
//
// The hook is silent and exits 0, so a failure inside it is kept here, in the
// project partition every worktree shares, until someone is told: `doctor`
// names it, the next interactive `pull` mentions it once and drops it, and the
// next hook-started pull that succeeds (the detached retry included) drops it.

export type GitHookFailure =
  | { kind: 'fetch-failed'; event: GitHookEvent; at: string; error: string }
  | { kind: 'fetch-timeout'; event: GitHookEvent; at: string; capMs: number }
  | { kind: 'lock-held'; event: GitHookEvent; at: string; waitedMs: number }
  | { kind: 'hook-error'; event: GitHookEvent; at: string; error: string };

/** A failure as the member reads it: what happened and why, then the next step. */
export interface GitHookFailureReport {
  message: string;
  fix: string;
}

function failureFile(config: LocalConfig): string {
  return path.join(getDataHome(config), 'git-hook-failure.json');
}

export function isGitHookEvent(value: unknown): value is GitHookEvent {
  return (GIT_HOOK_EVENTS as readonly unknown[]).includes(value);
}

/** Keep `failure` for `doctor` and the next pull, and write it to debug.log. */
export async function recordGitHookFailure(config: LocalConfig, failure: GitHookFailure): Promise<void> {
  log.persist(`git hook: ${describeGitHookFailure(failure).message}`);
  await writeJson(failureFile(config), failure)
    .catch((e) => log.persist(`git hook: could not record the failure: ${(e as Error).message}`));
}

export async function readGitHookFailure(config: LocalConfig): Promise<GitHookFailure | null> {
  const failure = await readJson<GitHookFailure>(failureFile(config)).catch(() => null);
  return failure && isGitHookEvent(failure.event) ? failure : null;
}

export async function clearGitHookFailure(config: LocalConfig): Promise<void> {
  await remove(failureFile(config)).catch(() => {});
}

export function describeGitHookFailure(failure: GitHookFailure): GitHookFailureReport {
  const when = `(${failure.at})`;
  // git's stderr runs over several lines; the first names the cause, debug.log keeps the rest.
  const firstLine = (error: string) => error.trim().split('\n')[0];
  switch (failure.kind) {
    case 'fetch-failed':
      return {
        message: `${failure.event} could not fetch the team repo ${when}: ${firstLine(failure.error)}`,
        fix: 'The worktree may lack the team\'s latest resources. Check that you can reach the team repo, '
          + 'then run `teamai pull`.',
      };
    case 'fetch-timeout':
      return {
        message: `${failure.event} stopped the team repo fetch at its ${failure.capMs} ms cap ${when}, `
          + 'and the pull it handed over to has not completed it',
        fix: 'Check that you can reach the team repo, then run `teamai pull`.',
      };
    case 'lock-held':
      return {
        message: `${failure.event} skipped its sync: another teamai process held the project's sync lock `
          + `for the ${failure.waitedMs} ms it waits ${when}`,
        fix: 'Run `teamai pull` once that process finishes. If a teamai pull is stuck, stop it first.',
      };
    case 'hook-error':
      return {
        message: `${failure.event} failed ${when}: ${firstLine(failure.error)}`,
        fix: 'Run `teamai pull` to sync; ~/.teamai/debug.log has the details.',
      };
  }
}
