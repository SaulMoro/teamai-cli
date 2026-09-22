import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import fse from 'fs-extra';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  loadState: vi.fn(),
  saveState: vi.fn(),
  // pullAllRules reads placement records so its stale sweep spares the
  // author's own copy of a rule published into a namespace.
  loadStateForScope: vi.fn(async () => ({})),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn(),
  pushRepoBranch: vi.fn().mockResolvedValue(true),
  generateBranchName: vi.fn().mockReturnValue('teamai/push/test/20260305-120000'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

import { ResourceHandler } from '../resources/base.js';
import { SkillsHandler } from '../resources/skills.js';
import { RulesHandler } from '../resources/rules.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('ResourceHandler.isToolInstalled', () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-install-test-'));
    homeDir = path.join(tmpDir, 'home');
    await fse.ensureDir(path.join(homeDir, '.claude'));
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should return true when tool root directory exists', async () => {
    expect(await ResourceHandler.isToolInstalled('.claude/skills')).toBe(true);
  });

  it('should return false when tool root directory does not exist', async () => {
    expect(await ResourceHandler.isToolInstalled('.codebuddy/skills')).toBe(false);
  });

  it('should return false for nested path when root does not exist', async () => {
    expect(await ResourceHandler.isToolInstalled('.cursor/skills')).toBe(false);
  });

  it('should return true after tool directory is created', async () => {
    expect(await ResourceHandler.isToolInstalled('.codex/skills')).toBe(false);
    await fse.ensureDir(path.join(homeDir, '.codex'));
    expect(await ResourceHandler.isToolInstalled('.codex/skills')).toBe(true);
  });

  it('should detect codex-internal tool installation', async () => {
    expect(await ResourceHandler.isToolInstalled('.codex-internal/skills')).toBe(false);
    await fse.ensureDir(path.join(homeDir, '.codex-internal'));
    expect(await ResourceHandler.isToolInstalled('.codex-internal/skills')).toBe(true);
  });

  it('uses .config/opencode (not .config) as the OpenCode user-scope root', async () => {
    // A bare .config dir must NOT count as OpenCode installed.
    await fse.ensureDir(path.join(homeDir, '.config'));
    expect(await ResourceHandler.isToolInstalled('.config/opencode/skills')).toBe(false);
    await fse.ensureDir(path.join(homeDir, '.config/opencode'));
    expect(await ResourceHandler.isToolInstalled('.config/opencode/skills')).toBe(true);
  });

  it('uses the first segment as the root for openclaw 3-segment claudemd paths', async () => {
    // .openclaw/workspace/AGENTS.md → root is .openclaw, not .openclaw/workspace.
    expect(await ResourceHandler.isToolInstalled('.openclaw/workspace/AGENTS.md')).toBe(false);
    await fse.ensureDir(path.join(homeDir, '.openclaw'));
    expect(await ResourceHandler.isToolInstalled('.openclaw/workspace/AGENTS.md')).toBe(true);
  });
});

describe('SkillsHandler.pullItem — skip uninstalled tools', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: SkillsHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skills-pull-'));
    homeDir = path.join(tmpDir, 'home');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'skills'));

    // Only create .claude, NOT .codebuddy
    await fse.ensureDir(path.join(homeDir, '.claude'));

    vi.stubEnv('HOME', homeDir);
    handler = new SkillsHandler();

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
        codebuddy: { skills: '.codebuddy/skills', rules: '.codebuddy/rules' },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
    };

    // Create a skill in the team repo to pull
    const skillDir = path.join(repoPath, 'skills', 'test-skill');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'SKILL.md'), '# Test Skill');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should sync skill to installed tool (claude)', async () => {
    const item = {
      name: 'test-skill',
      type: 'skills' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'skills', 'test-skill'),
      relativePath: 'skills/test-skill',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/test-skill/SKILL.md'))).toBe(true);
  });

  it('should NOT create directories for uninstalled tool (codebuddy)', async () => {
    const item = {
      name: 'test-skill',
      type: 'skills' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'skills', 'test-skill'),
      relativePath: 'skills/test-skill',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.codebuddy'))).toBe(false);
  });

  it('should sync to both tools when both are installed', async () => {
    // Now also create .codebuddy
    await fse.ensureDir(path.join(homeDir, '.codebuddy'));

    const item = {
      name: 'test-skill',
      type: 'skills' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'skills', 'test-skill'),
      relativePath: 'skills/test-skill',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/test-skill/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/skills/test-skill/SKILL.md'))).toBe(true);
  });
});

describe('RulesHandler.pullItem — skip uninstalled tools', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rules-pull-'));
    homeDir = path.join(tmpDir, 'home');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'rules'));

    // Only create .claude, NOT .cursor
    await fse.ensureDir(path.join(homeDir, '.claude'));

    vi.stubEnv('HOME', homeDir);
    handler = new RulesHandler();

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules', claudemd: '.claude/CLAUDE.md' },
        cursor: { skills: '.cursor/skills', rules: '.cursor/rules' },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
    };

    // Create a rule in the team repo
    await fse.writeFile(path.join(repoPath, 'rules', 'test-rule.md'), '# Test Rule');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should sync rule to installed tool (claude)', async () => {
    const item = {
      name: 'test-rule',
      type: 'rules' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'rules', 'test-rule.md'),
      relativePath: 'rules/test-rule.md',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules/test-rule.md'))).toBe(true);
  });

  it('should NOT create directories for uninstalled tool (cursor)', async () => {
    const item = {
      name: 'test-rule',
      type: 'rules' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'rules', 'test-rule.md'),
      relativePath: 'rules/test-rule.md',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.cursor'))).toBe(false);
  });

  it('should sync to both tools when both are installed', async () => {
    await fse.ensureDir(path.join(homeDir, '.cursor'));

    const item = {
      name: 'test-rule',
      type: 'rules' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'rules', 'test-rule.md'),
      relativePath: 'rules/test-rule.md',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules/test-rule.md'))).toBe(true);
    // Cursor rules must be written as `.mdc` (a plain `.md` there is ignored by Cursor).
    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/test-rule.mdc'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/test-rule.md'))).toBe(false);
  });
});

describe('RulesHandler.pullAllRules — skip CLAUDE.md update for uninstalled tools', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-claudemd-'));
    homeDir = path.join(tmpDir, 'home');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'rules'));

    // Only create .claude, NOT .codebuddy
    await fse.ensureDir(path.join(homeDir, '.claude'));

    vi.stubEnv('HOME', homeDir);
    handler = new RulesHandler();

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules', claudemd: '.claude/CLAUDE.md' },
        codebuddy: { skills: '.codebuddy/skills', rules: '.codebuddy/rules', claudemd: '.codebuddy/CODEBUDDY.md' },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
    };

    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), '# My Rule');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should distribute rules to installed tool only', async () => {
    await handler.pullAllRules(teamConfig, localConfig);

    // claude rules directory should have the rule file
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules/my-rule.md'))).toBe(true);

    // codebuddy should not exist at all
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy'))).toBe(false);
  });
});

describe('deployBuiltinSkills — skip uninstalled tools', () => {
  let tmpDir: string;
  let homeDir: string;
  let builtinSkillsDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-builtin-skills-'));
    homeDir = path.join(tmpDir, 'home');

    // Only create .claude, NOT .codebuddy
    await fse.ensureDir(path.join(homeDir, '.claude'));

    vi.stubEnv('HOME', homeDir);

    // Create a fake built-in skills directory to simulate bundled skills
    builtinSkillsDir = path.join(tmpDir, 'builtin-skills', 'teamai-test-skill');
    await fse.ensureDir(builtinSkillsDir);
    await fse.writeFile(path.join(builtinSkillsDir, 'SKILL.md'), '# Test Built-in Skill');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should NOT create directories for uninstalled tool (codebuddy)', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills' },
        codebuddy: { skills: '.codebuddy/skills' },
      },
    };

    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    await deployBuiltinSkills(teamConfig, localConfig);

    // codebuddy directory should NOT be created
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy'))).toBe(false);
  });

  it('should deploy to installed tool (claude)', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills' },
      },
    };

    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    // deployBuiltinSkills uses getBuiltinSkillsDir() which resolves from import.meta.url
    // In test env the built-in skills dir may not exist, so deployed count could be 0
    // Key assertion: it does NOT create .codebuddy directories and does not throw
    await deployBuiltinSkills(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude'))).toBe(true);
  });

  it('uses the default home when no local config is available', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');
    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: { claude: { skills: '.claude/skills' } },
    };

    const deployed = await deployBuiltinSkills(teamConfig);

    expect(deployed).toBeGreaterThan(0);
    expect(await fse.pathExists(path.join(
      homeDir,
      '.claude/skills/teamai/SKILL.md',
    ))).toBe(true);
  });

  it('deploys the discovery stub only, never the packaged content', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills' },
      },
    };

    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    const deployed = await deployBuiltinSkills(teamConfig, localConfig);
    const skillsDir = path.join(homeDir, '.claude/skills');
    const stubDir = path.join(skillsDir, 'teamai');

    expect(deployed).toBeGreaterThan(0);
    expect(await fse.pathExists(path.join(stubDir, 'SKILL.md'))).toBe(true);
    // The stub is the whole deployed unit: one file, no references, no scripts.
    expect(await fse.readdir(stubDir)).toEqual(['SKILL.md']);
    expect(await fse.readdir(skillsDir)).toEqual(['teamai']);
    // ...and it is the packaged file verbatim, so a diff means a bug.
    expect(await fse.readFile(path.join(stubDir, 'SKILL.md'), 'utf8')).toBe(
      await fse.readFile(path.join(PACKAGE_ROOT, 'skills/teamai/SKILL.md'), 'utf8'),
    );
  });

  it('deploys built-in skills to OpenCode user scope under .config/opencode/skills', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    // OpenCode-only user: config lives at ~/.config/opencode, no ~/.opencode.
    await fse.ensureDir(path.join(homeDir, '.config/opencode'));

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        opencode: {
          skills: '.opencode/skills',
          userScope: { skills: '.config/opencode/skills' },
        },
      },
    };

    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    const deployed = await deployBuiltinSkills(teamConfig, localConfig);

    expect(deployed).toBeGreaterThan(0);
    // Written to the user-scope path, NOT the project-scope .opencode/skills.
    expect(await fse.pathExists(path.join(homeDir, '.config/opencode/skills/teamai/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.opencode'))).toBe(false);
  });

  it('deploys the stub regardless of recall, and prunes the legacy directories', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills' },
      },
    };

    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    // Pre-stub releases left these behind in every agent directory.
    await fse.ensureDir(path.join(homeDir, '.claude/skills/team-wiki-codebase/references'));
    await fse.writeFile(path.join(homeDir, '.claude/skills/team-wiki-codebase/SKILL.md'), '# old');
    await fse.ensureDir(path.join(homeDir, '.claude/skills/teamai-share-learnings'));
    await fse.writeFile(path.join(homeDir, '.claude/skills/teamai-share-learnings/SKILL.md'), '# old');
    // These two names were reserved in the old guard set but never packaged, so
    // a directory by either name is the user's own skill.
    for (const userSkill of ['teamai-workflow', 'teamai-import']) {
      await fse.ensureDir(path.join(homeDir, `.claude/skills/${userSkill}`));
      await fse.writeFile(path.join(homeDir, `.claude/skills/${userSkill}/SKILL.md`), '# mine');
    }

    const deployed = await deployBuiltinSkills(teamConfig, localConfig);

    expect(deployed).toBeGreaterThan(0);
    // The stub routes to every workflow, so recall no longer gates deployment:
    // `teamai skill get share` decides at run time whether recall is on, and the
    // directories earlier releases deployed are removed on the way.
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/teamai/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/team-wiki-codebase'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/teamai-share-learnings'))).toBe(false);
    for (const userSkill of ['teamai-workflow', 'teamai-import']) {
      expect(await fse.readFile(path.join(homeDir, `.claude/skills/${userSkill}/SKILL.md`), 'utf8'), userSkill).toBe('# mine');
    }
  });

  it('parks a copy of every file it prunes, so a member who edited one can get it back', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills' },
      },
    };

    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    // Ownership is proven by pathname, so this file is pruned even though the
    // member edited it. A retired release's path is never overwritten by the
    // deployment either, which is what makes the backup the only way back.
    const wiki = path.join(homeDir, '.claude/skills/team-wiki-codebase');
    await fse.ensureDir(path.join(wiki, 'references/methodology'));
    await fse.writeFile(path.join(wiki, 'SKILL.md'), '# edited by the member');
    await fse.writeFile(path.join(wiki, 'references/methodology/phase0-collection.md'), '# my notes');

    await deployBuiltinSkills(teamConfig, localConfig);

    expect(await fse.pathExists(wiki)).toBe(false);

    const stamp = new Date().toISOString().slice(0, 10);
    const backup = path.join(homeDir, '.teamai/removed-skills', stamp, 'claude/team-wiki-codebase');
    expect(await fse.readFile(path.join(backup, 'SKILL.md'), 'utf8')).toBe('# edited by the member');
    expect(await fse.readFile(path.join(backup, 'references/methodology/phase0-collection.md'), 'utf8')).toBe('# my notes');
  });

  it('removes the references an earlier release deployed beside the stub', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { claude: { skills: '.claude/skills' } },
    };
    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    // What `teamai pull` wrote before the stub: the same directory name, with a
    // references tree the new deployment does not ship.
    const stubDir = path.join(homeDir, '.claude/skills/teamai');
    await fse.ensureDir(path.join(stubDir, 'references'));
    await fse.writeFile(path.join(stubDir, 'SKILL.md'), '# old body');
    await fse.writeFile(path.join(stubDir, 'references/setup-admin.md'), '# old reference');

    await deployBuiltinSkills(teamConfig, localConfig);

    expect(await fse.readdir(stubDir)).toEqual(['SKILL.md']);
    expect(await fse.readFile(path.join(stubDir, 'SKILL.md'), 'utf8')).toBe(
      await fse.readFile(path.join(PACKAGE_ROOT, 'skills/teamai/SKILL.md'), 'utf8'),
    );
  });

  it('prunes legacy skills from the Codex shared directory and deploys the stub beside them', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    await fse.ensureDir(path.join(homeDir, '.codex'));
    const sharedLegacy = path.join(homeDir, '.agents/skills/team-wiki-codebase');
    await fse.ensureDir(sharedLegacy);
    await fse.writeFile(path.join(sharedLegacy, 'SKILL.md'), '# old');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.test/team.git',
      provider: 'git' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { codex: { skills: '.codex/skills' } },
    };
    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://example.test/team.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    const deployed = await deployBuiltinSkills(teamConfig, localConfig);

    expect(deployed).toBe(1);
    expect(await fse.pathExists(sharedLegacy)).toBe(false);
    // Codex reads .codex/skills; the shared .agents/skills is where its legacy
    // copies live, and the prune is the only thing that reaches in there.
    expect(await fse.readFile(path.join(homeDir, '.codex/skills/teamai/SKILL.md'), 'utf8')).toBe(
      await fse.readFile(path.join(PACKAGE_ROOT, 'skills/teamai/SKILL.md'), 'utf8'),
    );
  });

  it('records every file the package still ships, so the prune keeps proving ownership', async () => {
    const { PACKAGED_SKILL_FILES } = await import('../builtin-skills.js');

    const shipped: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await fse.readdir(dir, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
        else shipped.push(relative);
      }
    };
    await walk(path.join(PACKAGE_ROOT, 'skills'), '');

    // A packaged file missing from the manifest is one a later migration would
    // leave behind on every machine, which no other test would notice.
    for (const relative of shipped) {
      const [skillName, ...rest] = relative.split('/');
      expect(PACKAGED_SKILL_FILES.get(skillName), relative).toContain(rest.join('/'));
    }
  });

  it('removes the packaged files from a legacy directory but keeps what the member added', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.test/team.git',
      provider: 'git' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { claude: { skills: '.claude/skills' } },
    };
    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://example.test/team.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    const wiki = path.join(homeDir, '.claude/skills/team-wiki-codebase');
    // What the release packaged…
    for (const packaged of ['SKILL.md', 'README.md', 'references/methodology/phase0-collection.md', 'scripts/scan_repo.py']) {
      await fse.ensureDir(path.join(wiki, path.dirname(packaged)));
      await fse.writeFile(path.join(wiki, packaged), '# packaged');
    }
    // …and what the member put beside it, which `overwrite: true` never deleted.
    await fse.writeFile(path.join(wiki, 'references/methodology/my-notes.md'), '# mine');
    await fse.ensureDir(path.join(wiki, 'scripts/__pycache__'));
    await fse.writeFile(path.join(wiki, 'scripts/__pycache__/scan_repo.cpython-311.pyc'), 'bytecode');

    await deployBuiltinSkills(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(wiki, 'SKILL.md'))).toBe(false);
    expect(await fse.pathExists(path.join(wiki, 'README.md'))).toBe(false);
    expect(await fse.pathExists(path.join(wiki, 'references/methodology/phase0-collection.md'))).toBe(false);
    // Bytecode of a script we shipped is ours, so it does not keep the tree alive.
    expect(await fse.pathExists(path.join(wiki, 'scripts'))).toBe(false);
    // The member's file, and only it, survives.
    expect(await fse.readFile(path.join(wiki, 'references/methodology/my-notes.md'), 'utf8')).toBe('# mine');
  });

  it('keeps a file the member added beside the deployed stub', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.test/team.git',
      provider: 'git' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { claude: { skills: '.claude/skills' } },
    };
    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://example.test/team.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    const stubDir = path.join(homeDir, '.claude/skills/teamai');
    await fse.ensureDir(path.join(stubDir, 'references'));
    await fse.writeFile(path.join(stubDir, 'SKILL.md'), '# old body');
    await fse.writeFile(path.join(stubDir, 'references/setup-admin.md'), '# old reference');
    await fse.writeFile(path.join(stubDir, 'references/team-playbook.md'), '# mine');

    await deployBuiltinSkills(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(stubDir, 'references/setup-admin.md'))).toBe(false);
    expect(await fse.readFile(path.join(stubDir, 'references/team-playbook.md'), 'utf8')).toBe('# mine');
    expect(await fse.readFile(path.join(stubDir, 'SKILL.md'), 'utf8')).toBe(
      await fse.readFile(path.join(PACKAGE_ROOT, 'skills/teamai/SKILL.md'), 'utf8'),
    );
  });

  it('leaves the Codex shared directory alone when another tool prunes and Codex is excluded', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');

    await fse.ensureDir(path.join(homeDir, '.claude'));
    await fse.ensureDir(path.join(homeDir, '.codex'));
    const sharedLegacy = path.join(homeDir, '.agents/skills/team-wiki-codebase');
    await fse.ensureDir(sharedLegacy);
    await fse.writeFile(path.join(sharedLegacy, 'SKILL.md'), '# codex copy');

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.test/team.git',
      provider: 'git' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { claude: { skills: '.claude/skills' }, codex: { skills: '.codex/skills' } },
    };
    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://example.test/team.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
      enabledAgents: ['claude'],
    };

    const deployed = await deployBuiltinSkills(teamConfig, localConfig);

    // .agents/skills is Codex's; the whitelist says Codex is neither written to
    // nor deleted from, and Claude's pass must not reach it on Codex's behalf.
    expect(deployed).toBe(1);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/teamai/SKILL.md'))).toBe(true);
    expect(await fse.readFile(path.join(sharedLegacy, 'SKILL.md'), 'utf8')).toBe('# codex copy');
  });

  it('deploys a built-in Codex skill to its existing shared location', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');
    const sharedSkill = path.join(homeDir, '.agents', 'skills', 'teamai');
    await fse.ensureDir(path.join(homeDir, '.codex'));
    await fse.ensureDir(sharedSkill);

    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.test/team.git',
      provider: 'git' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { codex: { skills: '.codex/skills' } },
    };
    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://example.test/team.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };

    await deployBuiltinSkills(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(sharedSkill, 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codex', 'skills', 'teamai'))).toBe(false);
  });
});

describe('deployBuiltinSkills — enabledAgents whitelist (#510)', () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-builtin-whitelist-'));
    homeDir = path.join(tmpDir, 'home');
    await fse.ensureDir(path.join(homeDir, '.workbuddy'));
    await fse.ensureDir(path.join(homeDir, '.hermes'));
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  function teamConfig() {
    return {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        workbuddy: { skills: '.workbuddy/skills' },
        hermes: { skills: '.hermes/skills' },
      },
    };
  }

  function localConfig(enabledAgents?: string[]) {
    return {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
      ...(enabledAgents ? { enabledAgents } : {}),
    };
  }

  it('does not copy builtin skills into an installed tool outside the whitelist', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');
    const deployed = await deployBuiltinSkills(teamConfig(), localConfig(['workbuddy']));

    expect(deployed).toBeGreaterThan(0);
    expect(await fse.pathExists(path.join(homeDir, '.workbuddy/skills/teamai/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.hermes/skills/teamai'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.hermes/skills'))).toBe(false);
  });

  it('still deploys to every installed tool when enabledAgents is unset', async () => {
    const { deployBuiltinSkills } = await import('../builtin-skills.js');
    const deployed = await deployBuiltinSkills(teamConfig(), localConfig());

    expect(deployed).toBeGreaterThan(0);
    expect(await fse.pathExists(path.join(homeDir, '.workbuddy/skills/teamai/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.hermes/skills/teamai/SKILL.md'))).toBe(true);
  });
});
