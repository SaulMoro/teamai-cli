import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileHooks, reconcileTeamHooksForConfig, resolveMainCheckoutHooks } from '../hooks.js';
import { LocalConfigSchema, TeamaiConfigSchema, type LocalConfig } from '../types.js';
import { resolveAnchors } from '../utils/git.js';
import { detectProjectConfig, resolveProjectDataHome, saveLocalConfigForScope } from '../config.js';
import { createProjectToolRoots } from '../project-agent-root.js';
import { liveCheckoutRecords, checkoutKey } from '../pull.js';
import { pruneWorkspaceDirs, writeWorkspaceRoot } from '../utils/partition.js';
import { dashboardWorkspaces, workspaceEvents } from '../dashboard/workspaces.js';
import { status } from '../status.js';
import { localAgentCheckouts } from '../local-agent.js';
import { deployBuiltinSkills } from '../builtin-skills.js';
import { allowsSkillDirectory } from '../resources/skills.js';

let base: string;
let parent: string;
let checkout: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-submodule-')));
  vi.stubEnv('HOME', path.join(base, 'home'));
  const source = path.join(base, 'source');
  parent = path.join(base, 'parent');
  for (const root of [source, parent]) {
    fs.mkdirSync(root);
    git(root, 'init', '-q');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-q', '-m', 'init');
  }
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'service');
  git(parent, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-am', 'Add service');
  checkout = path.join(parent, 'service');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

function config(root = checkout): LocalConfig {
  return LocalConfigSchema.parse({
    repo: { localPath: path.join(base, 'team'), remote: 'https://example.com/team.git' },
    username: 'test', scope: 'project', projectRoot: root,
  });
}

describe('submodule checkouts', () => {
  it('delivers the built-in stub through a tracked skill-directory link within the repo', async () => {
    fs.mkdirSync(path.join(checkout, '.claude'));
    fs.mkdirSync(path.join(checkout, '.agents/skills'), { recursive: true });
    fs.symlinkSync('../.agents/skills', path.join(checkout, '.claude/skills'));
    git(checkout, 'add', '.claude/skills');
    const team = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.com/team.git',
      toolPaths: { claude: { skills: '.claude/skills' } } });
    await deployBuiltinSkills(team, { ...config(), enabledAgents: ['claude'] });
    expect(fs.readFileSync(path.join(checkout, '.agents/skills/teamai/SKILL.md'), 'utf8')).toContain('name: teamai');
    expect(fs.lstatSync(path.join(checkout, '.claude/skills')).isSymbolicLink()).toBe(true);
  });

  it('rejects skill roots linked into a child repository', async () => {
    const child = path.join(checkout, 'child');
    fs.mkdirSync(path.join(checkout, '.claude'));
    fs.mkdirSync(child);
    git(child, 'init', '-q');
    fs.mkdirSync(path.join(child, 'skills'));
    fs.symlinkSync('../child/skills', path.join(checkout, '.claude/skills'));
    const team = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.com/team.git',
      toolPaths: { claude: { skills: '.claude/skills' } } });
    await deployBuiltinSkills(team, { ...config(), enabledAgents: ['claude'] });
    expect(fs.readdirSync(path.join(child, 'skills'))).toEqual([]);
  });

  it('preserves a tracked or member-edited built-in stub through the skill root link', async () => {
    fs.mkdirSync(path.join(checkout, '.claude'));
    fs.mkdirSync(path.join(checkout, '.agents/skills/teamai'), { recursive: true });
    fs.symlinkSync('../.agents/skills', path.join(checkout, '.claude/skills'));
    const file = path.join(checkout, '.agents/skills/teamai/SKILL.md');
    fs.writeFileSync(file, 'Member instructions');
    git(checkout, 'add', '.claude/skills', '.agents/skills/teamai/SKILL.md');
    const team = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.com/team.git',
      toolPaths: { claude: { skills: '.claude/skills' } } });
    await deployBuiltinSkills(team, { ...config(), enabledAgents: ['claude'] });
    expect(fs.readFileSync(file, 'utf8')).toBe('Member instructions');
  });

  it.each(['.claude/settings.json', '.custom/settings.json'])('removes only recorded team hooks left at %s in the git directory', async (settingsPath) => {
    const original = config();
    original.dataHome = await resolveProjectDataHome(checkout);
    const anchor = path.join(parent, '.git/modules/service');
    const manifest = path.join(original.dataHome!, 'managed-main-checkout-hooks.json');
    const file = path.join(anchor, path.dirname(settingsPath), 'settings.local.json');
    const def = { key: 'fixture', description: '[teamai:hook:fixture] fixture', event: 'Stop', command: 'echo team', source: 'team' as const };
    await reconcileHooks(file, 'claude', [def], { manifestPath: manifest, teamOnly: true });
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings.member = true;
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo member' }] });
    fs.writeFileSync(file, JSON.stringify(settings));
    fs.mkdirSync(path.join(original.repo.localPath, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(original.repo.localPath, 'hooks/hooks.yaml'), 'hooks: []');
    const team = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.com/team.git',
      toolPaths: { claude: { settings: settingsPath } } });
    await reconcileTeamHooksForConfig(team, { ...original, enabledAgents: ['claude'] });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.member).toBe(true);
    expect(after.hooks.Stop.map((e: { hooks: { command: string }[] }) => e.hooks[0].command)).toEqual(['echo member']);
  });

  it('returns actual local-agent checkouts rather than stored identity directories', async () => {
    const anchor = path.join(parent, '.git/modules/service');
    const home = path.join(base, 'home/.teamai/local-agent');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      endpoint: 'https://example.com/api', token: 'fixture', localAgentId: 'fixture', createdAt: '2026-10-11',
      workspaceBindings: { [anchor]: { projectId: 1 }, [checkout]: { projectId: 1 } },
    }));
    expect(await localAgentCheckouts()).toContain(checkout);
    expect(await localAgentCheckouts()).not.toContain(anchor);
  });

  it.each(['.claude/settings.local.json', '.codex/hooks.json'])('preserves an empty old %s without blocking Git hook installation', async (relative) => {
    const original = config();
    original.dataHome = await resolveProjectDataHome(checkout);
    const file = path.join(parent, '.git/modules/service', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    fs.mkdirSync(path.join(original.repo.localPath, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(original.repo.localPath, 'hooks/hooks.yaml'), 'hooks: []');
    const team = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.com/team.git' });
    await reconcileTeamHooksForConfig(team, { ...original, enabledAgents: ['claude', 'codex'] });
    expect(fs.readFileSync(file, 'utf8')).toBe('');
    expect(git(checkout, 'config', '--get', 'hook.teamai-post-checkout.command')).toContain('hook-dispatch');
  });

  it('displays the submodule checkout in status while judging the identity for orphans', async () => {
    const original = config();
    original.dataHome = await resolveProjectDataHome(checkout);
    await saveLocalConfigForScope(original);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await status({ all: true });
      expect(output.mock.calls.flat().join('\n')).toContain(`project: ${checkout}`);
    } finally {
      output.mockRestore();
    }
  });

  it('shows the real submodule checkout while preserving dashboard identity', async () => {
    const original = config();
    original.dataHome = await resolveProjectDataHome(checkout);
    await saveLocalConfigForScope(original);
    const anchor = path.join(parent, '.git/modules/service');
    const events = [{ type: 'session_start' as const, tool: 'claude', timestamp: '2026-10-11T00:00:00Z',
      sessionId: 'removed-worktree', projectAnchor: anchor, cwd: path.join(base, 'removed') }];
    const workspaces = await dashboardWorkspaces(events);
    const project = workspaces.find((w) => w.scope === 'project');
    expect(project?.root).toBe(checkout);
    expect(workspaceEvents(events, project!, workspaces)).toEqual(events);
  });

  it('seeds a linked submodule worktree from the original tool roots', async () => {
    const original = config();
    original.dataHome = await resolveProjectDataHome(checkout);
    await saveLocalConfigForScope(original);
    fs.mkdirSync(path.join(checkout, '.claude'));
    const linked = path.join(base, 'service-worktree');
    git(checkout, 'worktree', 'add', '-q', '--detach', linked);
    await createProjectToolRoots({ cwd: linked });
    expect(fs.existsSync(path.join(linked, '.claude'))).toBe(true);
    expect((await resolveAnchors(linked))?.mainCheckout).toBe(checkout);
  });

  it('keeps the resolved main hook target when the current worktree disappears during pull', async () => {
    const linked = path.join(base, 'removed-service-worktree');
    git(checkout, 'worktree', 'add', '-q', '--detach', linked);
    const local = config(linked);
    const paths = { codex: { settings: '.codex/hooks.json' } };
    expect((await resolveMainCheckoutHooks(local, paths))?.root).toBe(checkout);
    git(checkout, 'worktree', 'remove', '--force', linked);
    expect((await resolveMainCheckoutHooks(local, paths))?.root).toBe(checkout);
  });

  it('keeps a separate identity when the original submodule no longer exists', async () => {
    const worktree = path.join(base, 'parent-without-original');
    git(parent, 'worktree', 'add', '-q', '--detach', worktree);
    git(worktree, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
    fs.rmSync(path.join(parent, '.git/modules/service'), { recursive: true });
    const child = path.join(worktree, 'service');
    expect((await resolveAnchors(child))?.projectAnchor).toBe(path.join(parent, '.git/worktrees/parent-without-original/modules/service'));
  });

  it('allows a skill root linked inside a home directory outside Git', async () => {
    const home = path.join(base, 'home');
    fs.mkdirSync(path.join(home, '.agents/skills'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.symlinkSync('../.agents/skills', path.join(home, '.claude/skills'));
    expect(await allowsSkillDirectory(home, path.join(home, '.claude/skills/fixture'))).toBe(true);
    expect(await allowsSkillDirectory(home, path.join(base, 'elsewhere/fixture'))).toBe(false);
  });

  it('inherits the original submodule config in a superproject worktree', async () => {
    const original = config();
    original.dataHome = await resolveProjectDataHome(checkout);
    await saveLocalConfigForScope(original);
    const worktree = path.join(base, 'parent-worktree');
    git(parent, 'worktree', 'add', '-q', '--detach', worktree);
    git(worktree, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
    const child = path.join(worktree, 'service');
    expect(await resolveAnchors(child)).toEqual({
      workspaceRoot: child,
      projectAnchor: path.join(parent, '.git/modules/service'),
      mainCheckout: child,
    });
    const inherited = await detectProjectConfig(child);
    expect(inherited?.dataHome).toBe(original.dataHome);
    expect(inherited?.projectRoot).toBe(child);
    const paths = { claude: { settings: '.claude/settings.json' } };
    const originalHooks = await resolveMainCheckoutHooks(original, paths);
    const inheritedHooks = await resolveMainCheckoutHooks(inherited!, paths);
    expect(inheritedHooks?.manifestPath).not.toBe(originalHooks?.manifestPath);
    await writeWorkspaceRoot(original.dataHome!, child);
    expect(await pruneWorkspaceDirs(original.dataHome!, checkout)).toEqual([]);
    const key = await checkoutKey(child);
    const records = { [key]: { root: child, rev: 'revision', targets: [] } };
    expect(await liveCheckoutRecords(checkout, records)).toEqual(records);
  });

  it('places shared team hooks in the checkout that tools read', async () => {
    const target = await resolveMainCheckoutHooks(config(), {
      claude: { settings: '.claude/settings.json' },
      codex: { settings: '.codex/hooks.json' },
    });
    expect(target?.root).toBe(checkout);
    expect(target?.files).toEqual({
      claude: path.join(checkout, '.claude/settings.local.json'),
      codex: path.join(checkout, '.codex/hooks.json'),
    });
  });
});
