import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveState: vi.fn(),
  loadStateForScope: vi.fn(async () => ({})),
  saveStateForScope: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  autoDetectInit: vi.fn(),
}));

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  createGit: vi.fn(),
}));

// pull() takes a real ~/.teamai/.sync-lock; parallel workers would race on it.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    persist: vi.fn(),
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
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

import { RulesHandler } from '../resources/rules.js';
import { pull } from '../pull.js';
import { uninstall } from '../uninstall.js';
import { autoDetectInit, detectProjectConfig, loadLocalConfigForScope, loadTeamConfig } from '../config.js';
import {
  TeamaiConfigSchema,
  TEAMAI_TEAM_RULES_START,
  TEAMAI_TEAM_RULES_END,
  TEAMAI_RULES_START,
  TEAMAI_RULES_END,
  TEAMAI_CULTURE_START,
  TEAMAI_CLAUDEMD_START,
  TEAMAI_RECALL_RULES_START,
} from '../types.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

const CODEX_FAMILY = ['codex', 'codex-internal', 'tcodex'];

/** How many times `needle` occurs in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('Codex reads team rules from AGENTS.md in project scope (#938)', () => {
  let tmpDir: string;
  let homeDir: string;
  let projectRoot: string;
  let repoPath: string;
  let handler: RulesHandler;
  // The built-in defaults: the bug lives in the default Codex tool paths.
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  const agentsMd = () => path.join(projectRoot, 'AGENTS.md');

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-rules-'));
    homeDir = path.join(tmpDir, 'home');
    projectRoot = path.join(tmpDir, 'project');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(homeDir);
    await fse.ensureDir(path.join(repoPath, 'rules'));
    // Codex is installed for this project: opening a session creates its root.
    await fse.ensureDir(path.join(projectRoot, '.codex'));
    await fse.writeFile(path.join(repoPath, 'rules', 'codeword.md'), 'The team codeword is PELICAN-42.\n');
    vi.stubEnv('HOME', homeDir);

    handler = new RulesHandler();
    teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' });
    localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      additionalRoles: [],
      scope: 'project',
      projectRoot,
      enabledAgents: ['codex'],
    } as unknown as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it.each(CODEX_FAMILY)('inlines the rules for %s in a team-rules block in <project>/AGENTS.md, keeps user text, and writes nothing to its rules dir', async (tool) => {
    await fse.ensureDir(path.join(projectRoot, `.${tool}`));
    localConfig = { ...localConfig, enabledAgents: [tool] } as LocalConfig;
    await fse.writeFile(agentsMd(), '# Project notes\n\nKeep this line.\n');
    await fse.writeFile(
      path.join(repoPath, 'rules', 'scoped.md'),
      '---\npaths:\n  - "src/**"\n---\nPrefer named exports.\n',
    );

    await handler.pullAllRules(teamConfig, localConfig);

    const content = await fse.readFile(agentsMd(), 'utf8');
    expect(content).toContain('# Project notes\n\nKeep this line.\n');
    const start = content.indexOf(TEAMAI_TEAM_RULES_START);
    const end = content.indexOf(TEAMAI_TEAM_RULES_END);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = content.slice(start, end);
    expect(block).toContain('The team codeword is PELICAN-42.');
    // A path-scoped rule is inlined without frontmatter, after the globs it applies to.
    expect(block).toContain('Applies to files matching: src/**\nPrefer named exports.');
    expect(block).not.toContain('paths:');
    expect(await fse.pathExists(path.join(projectRoot, `.${tool}`, 'rules'))).toBe(false);
  });

  it('removes the block when the team has no rules left, keeping user text', async () => {
    await fse.writeFile(agentsMd(), '# Project notes\n');
    await handler.pullAllRules(teamConfig, localConfig);
    await fse.remove(path.join(repoPath, 'rules', 'codeword.md'));

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(agentsMd(), 'utf8')).toBe('# Project notes\n');
  });

  it('removes an AGENTS.md that held nothing but the block when the team has no rules left', async () => {
    await handler.pullAllRules(teamConfig, localConfig);
    expect(await fse.pathExists(agentsMd())).toBe(true);
    await fse.remove(path.join(repoPath, 'rules', 'codeword.md'));

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(agentsMd())).toBe(false);
  });

  it('keeps exactly one block in the AGENTS.md Codex shares with Pi, and the legacy [teamai:rules] strip leaves it alone', async () => {
    await fse.ensureDir(path.join(projectRoot, '.pi'));
    const shared = { ...localConfig, enabledAgents: ['codex', 'pi'] } as LocalConfig;
    // A block an old release inlined into Pi's AGENTS.md, which pull strips.
    await fse.writeFile(agentsMd(), `# Notes\n\n${TEAMAI_RULES_START}\nold rules\n${TEAMAI_RULES_END}\n`);

    await handler.pullAllRules(teamConfig, shared);
    await handler.pullAllRules(teamConfig, shared);

    const content = await fse.readFile(agentsMd(), 'utf8');
    expect(count(content, TEAMAI_TEAM_RULES_START)).toBe(1);
    expect(count(content, TEAMAI_TEAM_RULES_END)).toBe(1);
    expect(content).toContain('The team codeword is PELICAN-42.');
    expect(content).not.toContain(TEAMAI_RULES_START);
    expect(content).toContain('# Notes');
  });

  it.each(CODEX_FAMILY)('removes the block on the next pull once %s is no longer enabled', async (tool) => {
    await fse.ensureDir(path.join(projectRoot, `.${tool}`));
    localConfig = { ...localConfig, enabledAgents: [tool] } as LocalConfig;
    await fse.writeFile(agentsMd(), '# Project notes\n');
    await handler.pullAllRules(teamConfig, localConfig);
    expect(await fse.readFile(agentsMd(), 'utf8')).toContain(TEAMAI_TEAM_RULES_START);

    await handler.pullAllRules(teamConfig, { ...localConfig, enabledAgents: ['claude'] } as LocalConfig);

    expect(await fse.readFile(agentsMd(), 'utf8')).toBe('# Project notes\n');
  });

  it.each(CODEX_FAMILY)('creates no AGENTS.md when %s is not installed for the project', async (tool) => {
    await fse.remove(path.join(projectRoot, '.codex'));
    localConfig = { ...localConfig, enabledAgents: [tool] } as LocalConfig;

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(agentsMd())).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, `.${tool}`))).toBe(false);
  });
});

describe('pull on a machine without Codex (#938)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-absent-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.writeFile(path.join(repoPath, 'rules', 'codeword.md'), 'The team codeword is PELICAN-42.\n');
    await fse.writeFile(path.join(repoPath, 'culture.md'), '---\ncompany:\n  name: Acme\n---\n\nBe kind to teammates.\n');
    await fse.ensureDir(path.join(repoPath, 'claudemd'));
    await fse.writeFile(path.join(repoPath, 'claudemd', 'shared.md'), 'Shared team instructions.\n');
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('creates no ~/.codex for culture, shared instructions or rules when enabledAgents is unset', async () => {
    // A legacy config with no whitelist syncs every installed tool; Codex is not one.
    vi.mocked(loadTeamConfig).mockResolvedValue(
      TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' }),
    );
    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    } as LocalConfig);

    await pull({});

    expect(await fse.readFile(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf8')).toContain('Shared team instructions.');
    expect(await fse.pathExists(path.join(homeDir, '.codex'))).toBe(false);
  });

  // A team entry replaces the default whole. With neither `rules` nor
  // `settings`, only its `skills` path can say whether Codex is installed.
  it.each([
    ['skills only', { skills: '.codex/skills' }],
    ['skills and claudemd', { skills: '.codex/skills', claudemd: 'AGENTS.md' }],
  ])('writes no AGENTS.md for a team codex entry with %s when the project has no .codex/', async (_label, codex) => {
    const projectRoot = path.join(tmpDir, 'project');
    await fse.ensureDir(projectRoot);
    vi.mocked(loadTeamConfig).mockResolvedValue(
      TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git', toolPaths: { codex } }),
    );
    vi.mocked(detectProjectConfig).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'project',
      projectRoot,
      recallEnabled: true,
    } as LocalConfig);

    try {
      await pull({});
    } finally {
      vi.mocked(detectProjectConfig).mockResolvedValue(null);
    }

    expect(await fse.pathExists(path.join(projectRoot, 'AGENTS.md'))).toBe(false);
    expect(await fse.pathExists(path.join(projectRoot, '.codex'))).toBe(false);
  });
});

describe('Codex reads team rules from ~/.codex/AGENTS.md in user scope (#938)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-user-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(homeDir, '.codex'));
    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.writeFile(path.join(repoPath, 'rules', 'codeword.md'), 'The team codeword is PELICAN-42.\n');
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it.each(CODEX_FAMILY)('writes the block for %s to ~/.<tool>/AGENTS.md, not to a home-level AGENTS.md or its rules dir', async (tool) => {
    await fse.ensureDir(path.join(homeDir, `.${tool}`));
    const teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' });
    const localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      additionalRoles: [],
      scope: 'user',
      enabledAgents: [tool],
    } as unknown as LocalConfig;

    await new RulesHandler().pullAllRules(teamConfig, localConfig);

    const content = await fse.readFile(path.join(homeDir, `.${tool}`, 'AGENTS.md'), 'utf8');
    expect(content).toContain(TEAMAI_TEAM_RULES_START);
    expect(content).toContain('The team codeword is PELICAN-42.');
    expect(await fse.pathExists(path.join(homeDir, 'AGENTS.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, `.${tool}`, 'rules'))).toBe(false);
  });
});

describe('a project-scope pull gives Codex every instruction block in one AGENTS.md (#938)', () => {
  let tmpDir: string;
  let homeDir: string;
  let projectRoot: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-blocks-'));
    homeDir = path.join(tmpDir, 'home');
    projectRoot = path.join(tmpDir, 'project');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(homeDir);
    await fse.ensureDir(path.join(projectRoot, '.codex'));
    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.writeFile(path.join(repoPath, 'rules', 'codeword.md'), 'The team codeword is PELICAN-42.\n');
    await fse.writeFile(path.join(repoPath, 'culture.md'), '---\ncompany:\n  name: Acme\n---\n\nBe kind to teammates.\n');
    await fse.ensureDir(path.join(repoPath, 'claudemd'));
    await fse.writeFile(path.join(repoPath, 'claudemd', 'shared.md'), 'Shared team instructions.\n');
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('writes culture, shared instructions, team rules and recall into <project>/AGENTS.md', async () => {
    // The three instruction writers and recall each decide "installed" on
    // their own; one pull shows they agree on the same file.
    vi.mocked(loadTeamConfig).mockResolvedValue(
      TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' }),
    );
    vi.mocked(detectProjectConfig).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'project',
      projectRoot,
      enabledAgents: ['codex'],
      recallEnabled: true,
    } as LocalConfig);

    await pull({});

    const content = await fse.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8');
    for (const marker of [TEAMAI_CULTURE_START, TEAMAI_CLAUDEMD_START, TEAMAI_TEAM_RULES_START, TEAMAI_RECALL_RULES_START]) {
      expect(count(content, marker)).toBe(1);
    }
    expect(content).toContain('Be kind to teammates.');
    expect(content).toContain('Shared team instructions.');
    expect(content).toContain('The team codeword is PELICAN-42.');
  });
});

describe('uninstall keeps exactly the blocks a remaining tool\'s pull writes (#938)', () => {
  const BLOCK_START: Record<string, string> = {
    culture: TEAMAI_CULTURE_START,
    claudemd: TEAMAI_CLAUDEMD_START,
    'team-rules': TEAMAI_TEAM_RULES_START,
    recall: TEAMAI_RECALL_RULES_START,
  };
  const BLOCKS = Object.values(BLOCK_START);
  const defaults = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' }).toolPaths;
  let tmpDir: string;
  let projectRoot: string;
  let repoPath: string;

  const agentsMd = () => path.join(projectRoot, 'AGENTS.md');
  const blocksIn = async () => {
    const content = await fse.readFile(agentsMd(), 'utf8').catch(() => '');
    return BLOCKS.filter((marker) => content.includes(marker));
  };

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-agree-'));
    projectRoot = path.join(tmpDir, 'project');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(tmpDir, 'home'));
    await fse.ensureDir(path.join(projectRoot, '.codex'));
    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.writeFile(path.join(repoPath, 'rules', 'codeword.md'), 'The team codeword is PELICAN-42.\n');
    await fse.writeFile(path.join(repoPath, 'culture.md'), '---\ncompany:\n  name: Acme\n---\n\nBe kind to teammates.\n');
    await fse.ensureDir(path.join(repoPath, 'claudemd'));
    await fse.writeFile(path.join(repoPath, 'claudemd', 'shared.md'), 'Shared team instructions.\n');
    vi.stubEnv('HOME', path.join(tmpDir, 'home'));
  });

  afterEach(async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it.each([
    ['pi', 'no agents', { skills: '.pi/skills', rules: '.pi/rules', claudemd: 'AGENTS.md' }, ['culture', 'claudemd']],
    ['workbuddy', 'agents', {
      skills: '.workbuddy/skills', rules: '.workbuddy/rules', settings: '.workbuddy/settings.json',
      claudemd: 'AGENTS.md', agents: '.workbuddy/agents',
    }, ['culture', 'claudemd', 'recall']],
    ['tcodex', 'the default entry', defaults.tcodex, ['culture', 'claudemd', 'team-rules', 'recall']],
    ['tcodex', 'no agents', { skills: '.tcodex/skills', settings: '.tcodex/hooks.json', claudemd: 'AGENTS.md' }, ['culture', 'claudemd', 'team-rules']],
  ])('uninstall --agent codex leaves %s (%s) the blocks its own pull writes', async (tool, _label, entry, written) => {
    const teamConfig = TeamaiConfigSchema.parse({
      team: 'test', repo: 'https://example.invalid/x/team.git', toolPaths: { codex: defaults.codex, [tool]: entry },
    });
    await fse.ensureDir(path.join(projectRoot, `.${tool}`));
    const localConfig = (enabledAgents: string[]) => ({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'project',
      projectRoot,
      enabledAgents,
      recallEnabled: true,
    }) as LocalConfig;
    const pullAs = async (enabledAgents: string[]) => {
      vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
      vi.mocked(detectProjectConfig).mockResolvedValue(localConfig(enabledAgents));
      await pull({});
    };

    await pullAs([tool]);
    const own = await blocksIn();
    expect(own).toEqual(written.map((block) => BLOCK_START[block]));
    await pullAs(['codex', tool]);
    expect(await blocksIn()).toEqual(BLOCKS);
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig: localConfig(['codex', tool]), teamConfig } as never);

    await uninstall({ force: true, agent: 'codex' });

    expect(await blocksIn()).toEqual(own);
  });
});
