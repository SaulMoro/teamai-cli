import fs from 'node:fs/promises';
import path from 'node:path';
import { createGit, DetachedTeamRepoError, getDefaultBranch, pullRepo, remotesMatch } from './utils/git.js';
import type { GlobalOptions, LocalConfig } from './types.js';

export type ResolvedTeamRef = { ref: string; kind: 'branch' | 'tag' | 'commit'; commit: string };

export class TeamRefError extends Error {
  constructor(ref: string, branches: string[]) {
    super(`Team ref "${ref}" is not a branch, tag or commit of the team repo that holds teamai.yaml. Branches: ${branches.join(', ')}. Push it, or check the name.`);
    this.name = 'TeamRefError';
  }
}

export function teamRefBlocker(project: LocalConfig | null, user: LocalConfig | null): { message: string } | null {
  if (!project) return { message: '--team-ref needs a teamai workspace here. Run teamai init --scope workspace here first.' };
  if (project.inheritUserScope || (user && remotesMatch(project.repo.remote, user.repo.remote))) {
    return { message: '--team-ref pins one workspace, but this team also reaches it through user scope, where every workspace shares one copy. Remove the user-scope install, or turn off inheritUserScope, to pin a workspace.' };
  }
  if (project.repo.kind === 'self') return { message: "--team-ref does not apply in single-repo mode: the project's own commit decides which team assets it has." };
  if (project.repo.kind === 'http') return { message: '--team-ref needs a git team repo. This team is served over HTTP.' };
  return null;
}

export function teamRefNotice(ref: string, commit: string, defaultBranch: string): string {
  return `Pinned to team ref "${ref}" at ${commit}. Run teamai pull --team-ref ${defaultBranch} to follow the default branch again.`;
}

export async function resolveTeamRef(localPath: string, ref: string, signal?: AbortSignal): Promise<ResolvedTeamRef> {
  const git = createGit(localPath, signal);
  const remoteRefs = (await git.raw(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/'])).trim().split('\n');
  const branches = remoteRefs.map((name) => name.slice('refs/remotes/origin/'.length))
    .filter((name) => name && !['HEAD', 'teamai-reports', 'teamai-learnings'].includes(name));
  const invalid = () => new TeamRefError(ref, branches);
  const commitWithManifest = async (name: string): Promise<string> => {
    const commit = (await git.revparse(['-q', '--verify', `${name}^{commit}`])).trim();
    if (!commit || !(await git.raw(['ls-tree', commit, '--', 'teamai.yaml'])).trim()) throw invalid();
    return commit;
  };
  // Fully qualified refs still accept revision operators, so require an exact ref first.
  for (const [kind, name] of [['branch', `refs/remotes/origin/${ref}`], ['tag', `refs/tags/${ref}`]] as const) {
    if (kind === 'branch' && !branches.includes(ref)) continue;
    if (kind === 'tag' && !(await git.raw(['for-each-ref', '--format=%(refname)', 'refs/tags/'])).split('\n').includes(name)) continue;
    return { ref, kind, commit: await commitWithManifest(name) };
  }
  if (/^[0-9a-f]{7,64}$/i.test(ref)) {
    const commit = await commitWithManifest(ref);
    const containing = (await git.raw(['branch', '-r', '--contains', commit, '--format=%(refname)'])).trim().split('\n');
    if (!containing.some((name) => branches.some((branch) => name === `refs/remotes/origin/${branch}`))) throw invalid();
    return { ref, kind: 'commit', commit };
  }
  throw invalid();
}

export class DirtyTeamRepoError extends Error {
  constructor(ref: string, paths: string[]) {
    super(`The team repo has uncommitted changes, so it was not switched to "${ref}": ${paths.join(', ')}. Share them with teamai push, or discard them, then pull again.`);
    this.name = 'DirtyTeamRepoError';
  }
}

/** A failed reattachment of a detached clone with no pin, which fails the pull where a plain refresh would not. */
export class DetachedRecoveryError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

export type TeamRepoTransition = { label: string } & (
  | { transition: 'pinned'; ref: string }
  | { transition: 'none' | 'unpinned' | 'recovered' }
);

export async function transitionTeamRepo(
  config: LocalConfig,
  options: Pick<GlobalOptions, 'teamRef' | 'dryRun'> = {},
  signal?: AbortSignal,
): Promise<TeamRepoTransition> {
  const localPath = config.repo.localPath;
  const ref = options.teamRef ?? config.repo.ref;
  if (ref === undefined) {
    try { return { label: await pullRepo(localPath, signal), transition: 'none' }; }
    catch (error) { if (!(error instanceof DetachedTeamRepoError)) throw error; }
  }
  try {
    const git = createGit(localPath, signal);
    await git.fetch(['--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*']);
    if (options.dryRun) return { label: ref ? `team ref "${ref}"` : 'current team revision', transition: 'none' };
    const defaultBranch = await getDefaultBranch(localPath);
    const symbolic = (await git.raw(['symbolic-ref', '-q', 'HEAD'])).trim();
    const branch = symbolic ? symbolic.replace(/^refs\/heads\//, '') : 'HEAD';
    // Empty only on an unborn branch: every other failure throws.
    const previous = (await git.revparse(['-q', '--verify', 'HEAD^{commit}'])).trim() || null;
    // A checkout leaves the worktree of a submodule the target no longer has: handlers would deliver it
    // again, and git refuses to write the target's files over it. Remove it before the checkout.
    const leavingSubmodules = async (target: string): Promise<string[]> => {
      if (!previous) return [];
      const gitlinks = async (rev: string) => (await git.raw(['ls-tree', '-rz', rev])).split('\0')
        .filter((entry) => entry.startsWith('160000 ')).map((entry) => entry.split('\t')[1]);
      const kept = new Set(await gitlinks(target));
      return (await gitlinks(previous)).filter((file) => !kept.has(file));
    };
    // Removing such a worktree loses nothing only when it is empty, or when its history lives in
    // the clone's .git/modules (a .git file) and it holds no uncommitted, untracked or ignored file.
    const removable = async (worktree: string): Promise<boolean> => {
      if ((await fs.readdir(worktree).catch(() => [])).length === 0) return true;
      if (!(await fs.lstat(path.join(worktree, '.git')).catch(() => null))?.isFile()) return false;
      return !(await createGit(worktree, signal).raw(['status', '--porcelain', '--untracked-files=all', '--ignored'])).trim();
    };
    const checkClean = async (target: string, leaving: string[]) => {
      const status = await git.status(['--ignore-submodules=all']);
      const paths = status.files.filter((file) => file.index !== '?' && file.working_dir !== '?').map((file) => file.path);
      for (const file of leaving) if (!await removable(path.join(localPath, file))) paths.push(file);
      if (paths.length > 0) throw new DirtyTeamRepoError(target, paths);
    };
    const removeWorktrees = (leaving: string[]) => Promise.all(leaving.map((file) => fs.rm(path.join(localPath, file), { recursive: true, force: true })));
    if (ref !== undefined && ref !== defaultBranch) {
      const resolved = await resolveTeamRef(localPath, ref, signal);
      if (branch !== 'HEAD' || previous !== resolved.commit) {
        const leaving = await leavingSubmodules(resolved.commit);
        await checkClean(ref, leaving);
        await removeWorktrees(leaving);
        await git.checkout(['--detach', resolved.commit]);
      }
      return { label: `team ref "${ref}"`, transition: 'pinned', ref };
    }
    if (branch !== defaultBranch) {
      const leaving = await leavingSubmodules(`refs/remotes/origin/${defaultBranch}`);
      await checkClean(defaultBranch, leaving);
      await removeWorktrees(leaving);
      await git.checkout(defaultBranch);
    }
    try {
      const label = await pullRepo(localPath, signal);
      return { label, transition: ref === undefined ? 'recovered' : 'unpinned' };
    } catch (error) {
      if (branch === 'HEAD' && previous) await git.checkout(['--detach', previous]);
      throw error;
    }
  } catch (error) {
    if (ref !== undefined) throw error;
    throw new DetachedRecoveryError(error);
  }
}

export type RemovedTeamResources = Record<'skills' | 'rules' | 'agents', Set<string>>;

export async function removedTeamResources(localPath: string, previous: string, current: string): Promise<RemovedTeamResources> {
  const git = createGit(localPath);
  // Handlers scan a working tree; the old revision exists only as a commit.
  const namesAt = async (rev: string): Promise<RemovedTeamResources> => {
    const names: RemovedTeamResources = { skills: new Set(), rules: new Set(), agents: new Set() };
    const tree = await git.raw(['ls-tree', '-rz', rev, '--', 'skills/', 'rules/', 'agents/']);
    for (const entry of tree.split('\0')) {
      const [metadata, file] = entry.split('\t');
      if (!file) continue;
      const skill = /^skills\/(?:[^/]+\/)?([^/]+)\/SKILL\.md$/.exec(file);
      if (skill) names.skills.add(skill[1]);
      else if (metadata.startsWith('160000 ') && file.startsWith('skills/')) names.skills.add(file.split('/').at(-1)!);
      const rule = /^rules\/(.+)\.md$/.exec(file);
      if (rule) names.rules.add(rule[1]);
      const agent = /^agents\/(?:[^/]+\/)?([^/]+)\.(?:yaml|md)$/.exec(file);
      if (agent) names.agents.add(agent[1]);
    }
    return names;
  };
  const old = await namesAt(previous);
  const next = await namesAt(current);
  for (const type of ['skills', 'rules', 'agents'] as const) {
    for (const name of next[type]) old[type].delete(name);
  }
  return old;
}
