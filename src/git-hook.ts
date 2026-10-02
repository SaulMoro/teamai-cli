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
import { execCommand } from './utils/exec.js';
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

/**
 * Write (or refresh) the hook into the local config of the repository holding
 * `repoDir`. Idempotent: an up-to-date hook is left untouched.
 */
export async function installGitHook(repoDir: string): Promise<GitHookInstall> {
  const git = (args: string[]) => execCommand('git', args, { cwd: repoDir, timeoutMs: 10_000 });
  if (!supportsConfigHooks((await git(['--version'])).stdout)) return { installed: false, reason: 'old-git' };
  if ((await git(['rev-parse', '--git-dir'])).code !== 0) return { installed: false, reason: 'not-a-repository' };

  // The wrapper is what the hook command finds `teamai` through when the app
  // that runs git has no login PATH.
  ensureTeamaiWrapper();

  let changed = false;
  for (const event of GIT_HOOK_EVENTS) {
    const key = `hook.${hookName(event)}`;
    const command = gitHookCommand(event);
    const current = (await git(['config', '--local', '--get', `${key}.command`])).stdout.trim();
    const events = (await git(['config', '--local', '--get-all', `${key}.event`])).stdout.trim();
    if (current === command && events === event) continue;
    await ok(git(['config', '--local', `${key}.command`, command]), key);
    await ok(git(['config', '--local', '--replace-all', `${key}.event`, event]), key);
    changed = true;
  }
  if (changed) log.debug(`git hook: installed teamai hooks in ${repoDir}`);
  return { installed: true, changed };
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
