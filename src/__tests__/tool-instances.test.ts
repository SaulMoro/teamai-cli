import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';

/**
 * Tool instances as `loadTeamConfig` reads them: a team's in tools/ of its repo, a member's in ~/.teamai/tools/, and
 * every lookup of a tool name seeing them. Each test loads the modules afresh, since the instances a process read
 * are the ones it keeps.
 */

let root: string;
let home: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-instances-')));
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function teamRepo(files: Record<string, string>): string {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: acme\nrepo: acme/team\n');

  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  }

  return repo;
}

function personal(name: string, text: string): void {
  const dir = path.join(home, '.teamai', 'tools');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), text);
}

/** The member's user-scope config, whose team repo is `repo`, with `fields` (`projects: [...]`) set. */
function memberOf(repo: string, fields: { projects?: string[] }): void {
  const dir = path.join(home, '.teamai');
  fs.mkdirSync(dir, { recursive: true });
  const projects = fields.projects ? `projects: [${fields.projects.join(', ')}]\n` : '';
  fs.writeFileSync(path.join(dir, 'config.yaml'), `repo:\n  localPath: ${repo}\n  remote: https://example.test/acme/team.git\nusername: tester\nscope: user\n${projects}`);
}

const ACME_CLAUDE = `schemaVersion: v1alpha1
name: acme-claude
extends: claude
command: acme-claude
home: { dir: .acme-claude, env: ACME_CLAUDE_CONFIG_DIR }
`;

async function load(repo: string, member?: LocalConfig) {
  const { loadTeamConfig } = await import('../config.js');
  const registry = await import('../tool-registry.js');
  const { log } = await import('@teamai/shared/log');
  const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
  const config = await loadTeamConfig(repo, member);

  return { config, registry, errors: errors.mock.calls.map(([message]) => String(message)) };
}

describe('team tool instances', () => {
  it('reads a team instance as a tool of its own over the tool it extends, with that tool\'s paths moved to its home', async () => {
    const { config, registry } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE }));

    expect(registry.toolOf('acme-claude')).toMatchObject({ name: 'acme-claude', base: 'claude', instance: { command: 'acme-claude', source: 'team' } });
    expect(registry.channelsOf('acme-claude')).toEqual(registry.channelsOf('claude'));
    expect(registry.sessionPlatformsOf('acme-claude')).toEqual(['acme-claude']);
    expect(config?.toolPaths['acme-claude']).toEqual({
      skills: '.acme-claude/skills', rules: '.acme-claude/rules', settings: '.acme-claude/settings.json', claudemd: '.acme-claude/CLAUDE.md',
      agents: '.acme-claude/agents', mcp: '.acme-claude/.claude.json', mcpProject: '.mcp.json',
    });
    expect(config?.toolPaths.claude?.skills).toBe('.claude/skills');
  });

  it('gives an instance the paths it sets, whole', async () => {
    const { config } = await load(teamRepo({ 'tools/acme-claude.yaml': `${ACME_CLAUDE}paths: { skills: .acme/skills }\n` }));

    expect(config?.toolPaths['acme-claude']).toEqual({ skills: '.acme/skills' });
  });

  it('lets a team instance named like a shipped tool replace that tool\'s paths, as a toolPaths entry does', async () => {
    const { config, registry } = await load(teamRepo({ 'tools/claude.yaml': 'schemaVersion: v1alpha1\nname: claude\nextends: claude\npaths: { skills: .claude/team-skills }\n' }));

    expect(config?.toolPaths.claude).toEqual({ skills: '.claude/team-skills' });
    expect(registry.sessionPlatformsOf('claude')).toEqual(['claude-code']);
  });

  it.each([
    ['a format key', 'sessions: pi\n', /sets sessions, and an instance sets only command, home and paths/],
    ['another key', 'launch: { args: [-p] }\n', /sets launch, and an instance sets only command, home and paths/],
    ['an unknown tool', '', /extends: nope is not a tool teamai ships/],
  ])('refuses an instance that sets %s, naming it, and uses none of it', async (_, extra, message) => {
    const text = _ === 'an unknown tool' ? ACME_CLAUDE.replace('extends: claude', 'extends: nope') : `${ACME_CLAUDE}${extra}`;
    const { config, registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': text }));

    expect(errors).toEqual([expect.stringMatching(message)]);
    expect(errors[0]).toContain(path.join('tools', 'acme-claude.yaml'));
    expect(registry.toolOf('acme-claude')).toBeUndefined();
    expect(config?.toolPaths['acme-claude']).toBeUndefined();
  });

  it.each(['./scripts/acme-claude', 'bin/acme-claude', '/opt/acme/bin/acme-claude', String.raw`tools\acme-claude.exe`])(
    'refuses an instance whose command is the path %s, since what runs at a path is not the file a person accepted',
    async (command) => {
      const { registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE.replace('command: acme-claude', `command: '${command}'`) }));

      expect(errors).toEqual([expect.stringContaining('command: command is the name of one executable on PATH, with no path, spaces or arguments, such as acme-claude')]);
      expect(registry.toolOf('acme-claude')).toBeUndefined();
    },
  );

  it.each(['C:acme-claude', '.:acme-claude', '$PATH:acme-claude', 'acme*', 'acme-claude?'])(
    'refuses an instance whose command is %s, which Windows reads as a place or a wildcard and may find in the checkout',
    async (command) => {
      const { registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE.replace('command: acme-claude', `command: '${command}'`) }));

      expect(errors).toEqual([expect.stringContaining('command: command is the name of one executable on PATH, with no path, spaces or arguments, such as acme-claude')]);
      expect(registry.toolOf('acme-claude')).toBeUndefined();
    },
  );

  it('names an instance it refuses once per pull, though a pull loads the team config many times', async () => {
    const repo = teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE.replace('command: acme-claude', "command: './scripts/acme-claude'") });
    const { loadTeamConfig } = await import('../config.js');
    const { resetWarnOnce } = await import('../utils/warn-once.js');
    const { log } = await import('@teamai/shared/log');
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    const shown = () => errors.mock.calls.map(([message]) => String(message));
    const refusal = expect.stringContaining('command: command is the name of one executable on PATH');

    for (let pass = 0; pass < 3; pass++) await loadTeamConfig(repo);
    expect(shown()).toEqual([refusal]);

    resetWarnOnce();
    await loadTeamConfig(repo);
    expect(shown()).toEqual([refusal, refusal]);
  });

  it('accepts an instance whose command is a bare name, looked up on PATH where the tool runs', async () => {
    const { registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE.replace('command: acme-claude', 'command: acme-claude-2.4') }));

    expect(errors).toEqual([]);
    expect(registry.toolOf('acme-claude')?.instance?.command).toBe('acme-claude-2.4');
  });

  it('refuses an instance not named after its file, or named like another shipped tool', async () => {
    const { errors, registry } = await load(teamRepo({
      'tools/acme.yaml': ACME_CLAUDE,
      'tools/codex.yaml': 'schemaVersion: v1alpha1\nname: codex\nextends: claude\n',
    }));

    expect(errors).toEqual([
      expect.stringContaining('its name is "acme-claude", and an instance is named after its file or its folder, "acme"'),
      expect.stringContaining('"codex" is a tool teamai ships, and an instance named like one adjusts it, so it extends codex'),
    ]);
    expect(registry.toolOf('codex')).toEqual({ name: 'codex', base: 'codex' });
  });

  it('uses neither of two namespaces that define one name, and names both files', async () => {
    const { errors, registry } = await load(teamRepo({ 'tools/web/acme-claude.yaml': ACME_CLAUDE, 'tools/mobile/acme-claude.yaml': ACME_CLAUDE }));

    expect(errors).toEqual([expect.stringMatching(/"acme-claude" is defined twice in the team repo \(tools\/mobile\/acme-claude\.yaml and tools\/web\/acme-claude\.yaml\)/)]);
    expect(registry.toolOf('acme-claude')).toBeUndefined();
  });

  it('lets a namespace instance replace the root one of the same name', async () => {
    const { registry } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE, 'tools/web/acme-claude.yaml': ACME_CLAUDE.replace('command: acme-claude', 'command: acme-claude-web') }));

    expect(registry.toolOf('acme-claude')?.instance?.command).toBe('acme-claude-web');
  });

  it('reads an instance in a namespace only for the member it is given, whose project or role selects it, as drivers and workflows are', async () => {
    const repo = teamRepo({
      'manifest/projects.yaml': 'version: 1\nprojects:\n  - id: checkout\n    resources: { workflows: [web] }\n  - id: billing\n    resources: { workflows: [mobile] }\n',
      'tools/web/web-claude.yaml': ACME_CLAUDE.replaceAll('acme-claude', 'web-claude'),
      'tools/mobile/mobile-claude.yaml': ACME_CLAUDE.replaceAll('acme-claude', 'mobile-claude'),
    });
    memberOf(repo, { projects: ['checkout'] });
    const { loadLocalConfig } = await import('../config.js');
    // A loader that ran for another member before decides nothing.
    const checkout = await loadLocalConfig();
    if (checkout === null) throw new Error('no member config');
    const { registry, config } = await load(repo, { ...checkout, projects: ['billing'] });

    expect(registry.toolOf('mobile-claude')?.instance?.command).toBe('mobile-claude');
    expect(registry.toolOf('web-claude')).toBeUndefined();
    expect(config?.toolPaths['web-claude']).toBeUndefined();
  });

  it('reads only the root instances of a team repo whose manifest selects namespaces, when given no member', async () => {
    const { registry } = await load(teamRepo({
      'manifest/projects.yaml': 'version: 1\nprojects:\n  - id: checkout\n    resources: { workflows: [web] }\n',
      'tools/acme-claude.yaml': ACME_CLAUDE,
      'tools/web/web-claude.yaml': ACME_CLAUDE.replaceAll('acme-claude', 'web-claude'),
    }));

    expect(registry.toolOf('acme-claude')?.instance?.source).toBe('team');
    expect(registry.toolOf('web-claude')).toBeUndefined();
  });
});

describe('a linked tools folder', () => {
  it('reads no instance through a team repo\'s tools folder that is a link, and says why', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'acme-claude.yaml'), ACME_CLAUDE);
    const repo = teamRepo({});
    fs.symlinkSync(outside, path.join(repo, 'tools'));
    const { registry, errors } = await load(repo);

    expect(registry.toolOf('acme-claude')).toBeUndefined();
    expect(errors).toEqual(['tools in the team repo is a link, and teamai reads the team\'s tool instances only from a folder the team repo holds, so it uses none of them. Replace the link with the folder, push it, and run teamai pull.']);
  });
});

describe('team instances of two scopes', () => {
  it('takes the workspace\'s team instance over the user scope\'s of the same name, as a driver definition is', async () => {
    const userRepo = teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE });
    const workspaceRepo = path.join(root, 'workspace-repo');
    fs.mkdirSync(path.join(workspaceRepo, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRepo, 'teamai.yaml'), 'team: acme\nrepo: acme/workspace\n');
    fs.writeFileSync(path.join(workspaceRepo, 'tools', 'acme-claude.yaml'), ACME_CLAUDE.replace('command: acme-claude', 'command: acme-claude-workspace'));
    memberOf(userRepo, {});
    const project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(project, '.teamai', 'config.yaml'), `repo:\n  localPath: ${workspaceRepo}\n  remote: https://example.test/acme/workspace.git\nusername: tester\nscope: workspace\n`);
    const { loadLocalConfig, readConfigFrom } = await import('../config.js');
    const user = await loadLocalConfig();
    const workspace = await readConfigFrom(path.join(project, '.teamai'), project);
    expect(workspace).toMatchObject({ scope: 'project' });
    const { registry, errors } = await load(workspaceRepo, workspace ?? undefined);
    await load(userRepo, user ?? undefined);

    expect(registry.toolOf('acme-claude')?.instance?.command).toBe('acme-claude-workspace');
    expect(errors).toEqual([]);
  });
});

describe('a tool instance kept as a folder', () => {
  it('reads tools/<name>/TOOL.yaml as the instance named after its folder, in the user scope\'s team repo and a workspace\'s', async () => {
    const userRepo = teamRepo({ 'tools/acme-claude/TOOL.yaml': ACME_CLAUDE });
    const workspaceRepo = path.join(root, 'workspace-repo');
    fs.mkdirSync(path.join(workspaceRepo, 'tools', 'ws-claude'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRepo, 'teamai.yaml'), 'team: acme\nrepo: acme/workspace\n');
    fs.writeFileSync(path.join(workspaceRepo, 'tools', 'ws-claude', 'TOOL.yaml'), ACME_CLAUDE.replaceAll('acme-claude', 'ws-claude'));
    const { registry, errors } = await load(userRepo);
    await load(workspaceRepo);

    expect(registry.toolOf('acme-claude')?.instance).toMatchObject({ command: 'acme-claude', source: 'team', location: 'tools/acme-claude/TOOL.yaml' });
    expect(registry.toolOf('ws-claude')?.instance).toMatchObject({ command: 'ws-claude', source: 'team' });
    expect(registry.toolOf('TOOL')).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('runs an instance moved from tools/<name>.yaml into its folder with the acceptance its unchanged content had', async () => {
    const repo = teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE });
    const first = await load(repo);
    const { acceptToolCommand } = await import('../tool-instances.js');
    const instance = first.registry.toolOf('acme-claude')?.instance;
    expect(instance && await acceptToolCommand(instance, { ask: async () => 'y' })).toEqual({ ok: true });
    fs.mkdirSync(path.join(repo, 'tools', 'acme-claude'));
    fs.renameSync(path.join(repo, 'tools', 'acme-claude.yaml'), path.join(repo, 'tools', 'acme-claude', 'TOOL.yaml'));
    vi.resetModules();
    const moved = await load(repo);
    const { acceptToolCommand: acceptMoved } = await import('../tool-instances.js');
    const movedInstance = moved.registry.toolOf('acme-claude')?.instance;

    expect(movedInstance?.location).toBe('tools/acme-claude/TOOL.yaml');
    expect(movedInstance && await acceptMoved(movedInstance, { ask: undefined })).toEqual({ ok: true });
  });

  it('uses neither of one name kept as a file and a folder in one place, and names both', async () => {
    const { registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE, 'tools/acme-claude/TOOL.yaml': ACME_CLAUDE }));

    expect(registry.toolOf('acme-claude')).toBeUndefined();
    expect(errors).toEqual([expect.stringContaining('"acme-claude" is defined twice in the team repo (tools/acme-claude.yaml and tools/acme-claude/)')]);
  });

  it('reads the member\'s own ~/.teamai/tools/<name>/TOOL.yaml', async () => {
    fs.mkdirSync(path.join(home, '.teamai', 'tools', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'tools', 'mine', 'TOOL.yaml'), 'schemaVersion: v1alpha1\nname: mine\nextends: codex\n');
    const { registry } = await load(teamRepo({}));

    expect(registry.toolOf('mine')?.instance).toMatchObject({ source: 'personal', extends: 'codex' });
  });
});

describe('the sessions of an instance', () => {
  it('reads an instance that keeps the home of the tool it extends on that tool\'s platform, listed once', async () => {
    await load(teamRepo({
      'tools/review-claude.yaml': 'schemaVersion: v1alpha1\nname: review-claude\nextends: claude\npaths: { skills: .claude/review-skills }\n',
      'tools/claude.yaml': 'schemaVersion: v1alpha1\nname: claude\nextends: claude\npaths: { skills: .claude/team-skills }\n',
      'tools/acme-claude.yaml': ACME_CLAUDE,
    }));
    const { AgentSession } = await import('../session-flow/agent-session.js');
    const { listAvailablePlatforms } = await import('../session-flow/adapters/index.js');
    const platforms = listAvailablePlatforms();

    expect(AgentSession.platformForTool('review-claude')).toBe('claude-code');
    expect(AgentSession.platformForTool('acme-claude')).toBe('acme-claude');
    expect(platforms.filter((platform) => platform === 'claude-code')).toHaveLength(1);
    expect(platforms).toContain('acme-claude');
    expect(platforms).not.toContain('review-claude');
  });

  it('reads an OpenCode instance whose home moves XDG_DATA_HOME on a platform of its own, in that home\'s opencode', async () => {
    vi.stubEnv('XDG_DATA_HOME', '');
    await load(teamRepo({ 'tools/opencode-work.yaml': 'schemaVersion: v1alpha1\nname: opencode-work\nextends: opencode\nhome: { dir: .opencode-work, env: XDG_DATA_HOME }\n' }));
    const { AgentSession } = await import('../session-flow/agent-session.js');
    const { adapterOn, listAvailablePlatforms, storeDirOf } = await import('../session-flow/adapters/index.js');

    expect(AgentSession.platformForTool('opencode-work')).toBe('opencode-work');
    expect(listAvailablePlatforms()).toContain('opencode-work');
    expect(storeDirOf('opencode-work', { kind: 'recorded', toolRoots: undefined })).toBe(path.join(home, '.opencode-work', 'opencode'));
    expect(storeDirOf('opencode-work', { kind: 'tool-home', dir: path.join(root, 'attempt-home') })).toBe(path.join(root, 'attempt-home', 'opencode'));
    expect(adapterOn('opencode-work', { kind: 'recorded', toolRoots: undefined }).platform).toBe('opencode-work');
  });

  it('keeps no platform for an OpenCode instance that moves only its config directory, whose sessions OpenCode keeps in the member\'s own data home', async () => {
    vi.stubEnv('XDG_DATA_HOME', '');
    await load(teamRepo({ 'tools/opencode-review.yaml': 'schemaVersion: v1alpha1\nname: opencode-review\nextends: opencode\nhome: { dir: .opencode-review, env: OPENCODE_CONFIG_DIR }\n' }));
    const { AgentSession } = await import('../session-flow/agent-session.js');
    const { listAvailablePlatforms } = await import('../session-flow/adapters/index.js');

    expect(AgentSession.platformForTool('opencode-review')).toBeUndefined();
    expect(listAvailablePlatforms()).not.toContain('opencode-review');
  });
});

describe('the home of an instance', () => {
  it('stays the instance\'s own directory when its variable is the home variable of the tool it extends, which the member set for that tool', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude2'));
    vi.stubEnv('XDG_DATA_HOME', path.join(home, 'data'));
    await load(teamRepo({
      'tools/claude-work.yaml': 'schemaVersion: v1alpha1\nname: claude-work\nextends: claude\nhome: { dir: .claude-work, env: CLAUDE_CONFIG_DIR }\n',
      'tools/opencode-work.yaml': 'schemaVersion: v1alpha1\nname: opencode-work\nextends: opencode\nhome: { dir: .opencode-work, env: XDG_DATA_HOME }\n',
    }));
    const { storeDirOf } = await import('../session-flow/adapters/index.js');
    const recorded = { kind: 'recorded', toolRoots: undefined } as const;

    expect(storeDirOf('claude-work', recorded)).toBe(path.join(home, '.claude-work', 'projects'));
    expect(storeDirOf('opencode-work', recorded)).toBe(path.join(home, '.opencode-work', 'opencode'));
  });

  it('follows the member\'s value of a variable of the instance\'s own', async () => {
    vi.stubEnv('ACME_CLAUDE_CONFIG_DIR', path.join(root, 'acme'));
    await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE }));
    const { storeDirOf } = await import('../session-flow/adapters/index.js');

    expect(storeDirOf('acme-claude', { kind: 'recorded', toolRoots: undefined })).toBe(path.join(root, 'acme', 'projects'));
  });
});

describe('personal tool instances', () => {
  it('lets a member\'s own instance replace the team\'s of the same name', async () => {
    personal('acme-claude', ACME_CLAUDE.replace('command: acme-claude', 'command: my-acme-build'));
    const { registry, config } = await load(teamRepo({ 'tools/acme-claude.yaml': `${ACME_CLAUDE}paths: { skills: .acme/skills }\n` }));

    expect(registry.toolOf('acme-claude')?.instance).toMatchObject({ command: 'my-acme-build', source: 'personal' });
    expect(config?.toolPaths['acme-claude']?.skills).toBe('.acme-claude/skills');
  });

  it('leaves the member\'s own instances out once the process ignores them, and the team\'s take their place', async () => {
    personal('acme-claude', ACME_CLAUDE.replace('command: acme-claude', 'command: my-acme-build'));
    personal('mine', 'schemaVersion: v1alpha1\nname: mine\nextends: codex\n');
    const repo = teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE });
    const { ignorePersonalToolInstances } = await import('../tool-instances.js');
    ignorePersonalToolInstances();
    const { registry, config } = await load(repo);

    expect(registry.toolOf('acme-claude')?.instance).toMatchObject({ command: 'acme-claude', source: 'team' });
    expect(registry.toolOf('mine')).toBeUndefined();
    expect(config?.toolPaths.mine).toBeUndefined();
  });
});

describe('resume --next', () => {
  it('drives a run another member handed over without the member\'s own instances', async () => {
    personal('mine', 'schemaVersion: v1alpha1\nname: mine\nextends: codex\n');
    const { registry } = await load(teamRepo({}));
    expect(registry.toolOf('mine')?.instance?.source).toBe('personal');
    const { workflowResume } = await import('../workflow-commands.js');
    const written = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const cwd = process.cwd();
    process.chdir(root);

    try {
      await workflowResume(undefined, { next: true });
    } finally {
      process.chdir(cwd);
      written.mockRestore();
    }

    expect(registry.toolOf('mine')).toBeUndefined();
  });
});
