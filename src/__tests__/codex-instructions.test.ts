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
import { log } from '../utils/logger.js';
import { uninstall } from '../uninstall.js';
import { autoDetectInit, detectProjectConfig, loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import {
  TeamaiConfigSchema,
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

describe('a project-scope rules sync writes no team rules for Codex (#938)', () => {
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

  it.each(CODEX_FAMILY)('writes no team rules for %s into <project>/AGENTS.md or its rules dir', async (tool) => {
    // Its session-start hook adds them (codex-hook-rules.test.ts): other tools read this file too.
    await fse.ensureDir(path.join(projectRoot, `.${tool}`));
    localConfig = { ...localConfig, enabledAgents: [tool] } as LocalConfig;
    await fse.writeFile(agentsMd(), '# Project notes\n\nKeep this line.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(agentsMd(), 'utf8')).toBe('# Project notes\n\nKeep this line.\n');
    expect(await fse.pathExists(path.join(projectRoot, `.${tool}`, 'rules'))).toBe(false);
  });

  it('keeps the rule files to the member\'s projects after `remove rules`', async () => {
    await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'), `
version: 1
projects:
  - id: alpha
    resources: { knowledge: [alpha] }
  - id: billing
    resources: { knowledge: [billing] }
`);
    await fse.outputFile(path.join(repoPath, 'rules', 'alpha', 'alpha-rule.md'), 'Alpha rule.\n');
    await fse.outputFile(path.join(repoPath, 'rules', 'billing', 'billing-rule.md'), 'Billing rule.\n');
    await fse.ensureDir(path.join(projectRoot, '.claude'));
    localConfig = { ...localConfig, enabledAgents: ['claude'], projects: ['alpha'] } as LocalConfig;

    await handler.removeItem('codeword', teamConfig, localConfig);

    const rulesDir = path.join(projectRoot, '.claude', 'rules');
    expect(await fse.pathExists(path.join(rulesDir, 'alpha', 'alpha-rule.md'))).toBe(true);
    expect(await fse.pathExists(path.join(rulesDir, 'billing'))).toBe(false);
    expect(await fse.pathExists(path.join(rulesDir, 'codeword.md'))).toBe(false);
  });

  it('strips the legacy [teamai:rules] block from the AGENTS.md Codex shares with Pi, and adds no rules there', async () => {
    await fse.ensureDir(path.join(projectRoot, '.pi'));
    const shared = { ...localConfig, enabledAgents: ['codex', 'pi'] } as LocalConfig;
    // A block an old release inlined into Pi's AGENTS.md, which pull strips.
    await fse.writeFile(agentsMd(), `# Notes\n\n${TEAMAI_RULES_START}\nold rules\n${TEAMAI_RULES_END}\n`);

    await handler.pullAllRules(teamConfig, shared);

    expect(await fse.readFile(agentsMd(), 'utf8')).toBe('# Notes\n');
  });

  it.each(CODEX_FAMILY)('creates no AGENTS.md when %s is not installed for the project', async (tool) => {
    await fse.remove(path.join(projectRoot, '.codex'));
    localConfig = { ...localConfig, enabledAgents: [tool] } as LocalConfig;

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(agentsMd())).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, `.${tool}`))).toBe(false);
  });

  it.each([['empty', ''], ['whitespace-only', '\n  \n']])('keeps a member\'s %s AGENTS.md in a Pi-only project, which holds no block to remove', async (_label, content) => {
    await fse.ensureDir(path.join(projectRoot, '.pi'));
    await fse.writeFile(agentsMd(), content);

    await handler.pullAllRules(teamConfig, { ...localConfig, enabledAgents: ['pi'] } as LocalConfig);

    expect(await fse.readFile(agentsMd(), 'utf8')).toBe(content);
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

describe('a user-scope rules sync writes no team rules for Codex (#938)', () => {
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

  it.each(CODEX_FAMILY)('writes no team rules for %s to ~/.<tool>/AGENTS.md, a home-level AGENTS.md or its rules dir', async (tool) => {
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

    expect(await fse.pathExists(path.join(homeDir, `.${tool}`, 'AGENTS.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, 'AGENTS.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, `.${tool}`, 'rules'))).toBe(false);
  });
});

describe('a project-scope pull gives Codex its instruction blocks in one AGENTS.md (#938)', () => {
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

  it('writes culture, shared instructions and recall into <project>/AGENTS.md, and no team rules', async () => {
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
    for (const marker of [TEAMAI_CULTURE_START, TEAMAI_CLAUDEMD_START, TEAMAI_RECALL_RULES_START]) {
      expect(count(content, marker)).toBe(1);
    }
    expect(content).toContain('Be kind to teammates.');
    expect(content).toContain('Shared team instructions.');
    expect(content).not.toContain('PELICAN-42');
  });
});

describe('a pull at an unchanged team revision after a CLI upgrade (#938)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let saved: Record<string, unknown>;

  const agentsMd = () => path.join(homeDir, '.codex', 'AGENTS.md');
  // What 0.22.0 delivered: the team rule verbatim, in a directory Codex never read.
  const legacyCopy = () => path.join(homeDir, '.codex', 'rules', 'codeword.md');

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-upgrade-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(homeDir, '.codex'));
    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.writeFile(path.join(repoPath, 'rules', 'codeword.md'), 'The team codeword is PELICAN-42.\n');
    vi.stubEnv('HOME', homeDir);
    // The state persists between pulls, so the second one takes the fast path.
    saved = {};
    vi.mocked(saveStateForScope).mockImplementation(async (state) => {
      saved = structuredClone(state) as Record<string, unknown>;
    });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved) as never);
    vi.mocked(loadTeamConfig).mockResolvedValue(
      TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' }),
    );
    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
      enabledAgents: ['codex'],
    } as LocalConfig);
    await pull({});
    // What an older CLI left at this revision: no block, and the copy.
    await fse.writeFile(agentsMd(), 'My own notes.\n');
    await fse.outputFile(legacyCopy(), 'The team codeword is PELICAN-42.\n');
    vi.mocked(log.success).mockClear();
  });

  afterEach(async () => {
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('removes the old .codex/rules copy and writes no rules into AGENTS.md', async () => {
    await pull({});

    expect(vi.mocked(log.success).mock.calls.some(([message]) => String(message).includes('Already synced at abc1234'))).toBe(true);
    expect(await fse.readFile(agentsMd(), 'utf8')).toBe('My own notes.\n');
    expect(await fse.pathExists(legacyCopy())).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codex', 'rules'))).toBe(false);
  });

  it('writes nothing on a dry run', async () => {
    await pull({ dryRun: true });

    expect(await fse.readFile(agentsMd(), 'utf8')).toBe('My own notes.\n');
    expect(await fse.pathExists(legacyCopy())).toBe(true);
  });
});

describe('a project-scope pull at an unchanged team revision after a CLI upgrade (#938)', () => {
  let tmpDir: string;
  let projectRoot: string;
  let repoPath: string;
  let saved: Record<string, unknown>;

  const agentsMd = () => path.join(projectRoot, 'AGENTS.md');
  const legacyCopy = () => path.join(projectRoot, '.codex', 'rules', 'codeword.md');

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-upgrade-project-'));
    projectRoot = path.join(tmpDir, 'project');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(tmpDir, 'home'));
    await fse.ensureDir(path.join(projectRoot, '.codex'));
    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.writeFile(path.join(repoPath, 'rules', 'codeword.md'), 'The team codeword is PELICAN-42.\n');
    vi.stubEnv('HOME', path.join(tmpDir, 'home'));
    saved = {};
    vi.mocked(saveStateForScope).mockImplementation(async (state) => {
      saved = structuredClone(state) as Record<string, unknown>;
    });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved) as never);
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
    } as LocalConfig);
    await pull({});
    await fse.writeFile(agentsMd(), 'My own notes.\n');
    await fse.outputFile(legacyCopy(), 'The team codeword is PELICAN-42.\n');
    vi.mocked(log.success).mockClear();
  });

  afterEach(async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('removes the old .codex/rules copy and writes no rules into <project>/AGENTS.md', async () => {
    await pull({});

    expect(vi.mocked(log.success).mock.calls.some(([message]) => String(message).includes('Already synced at abc1234'))).toBe(true);
    expect(await fse.readFile(agentsMd(), 'utf8')).toBe('My own notes.\n');
    expect(await fse.pathExists(legacyCopy())).toBe(false);
    expect(await fse.pathExists(path.join(projectRoot, '.codex', 'rules'))).toBe(false);
  });
});

describe('uninstall keeps exactly the blocks a remaining tool\'s pull writes (#938)', () => {
  const BLOCK_START: Record<string, string> = {
    culture: TEAMAI_CULTURE_START,
    claudemd: TEAMAI_CLAUDEMD_START,
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
    ['tcodex', 'the default entry', defaults.tcodex, ['culture', 'claudemd', 'recall']],
    ['tcodex', 'no agents', { skills: '.tcodex/skills', settings: '.tcodex/hooks.json', claudemd: 'AGENTS.md' }, ['culture', 'claudemd']],
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

  it.each([
    ['gives back a member\'s empty AGENTS.md as it was', ''],
    ['removes the AGENTS.md teamai created', null],
  ])('uninstall --agent codex %s', async (_label, before) => {
    const teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' });
    if (before !== null) await fse.writeFile(agentsMd(), before);
    const localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'project',
      projectRoot,
      enabledAgents: ['codex'],
      recallEnabled: true,
    } as LocalConfig;
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(detectProjectConfig).mockResolvedValue(localConfig);
    await pull({});
    expect(await blocksIn()).toEqual(BLOCKS);
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig, teamConfig } as never);

    await uninstall({ force: true, agent: 'codex' });

    if (before === null) expect(await fse.pathExists(agentsMd())).toBe(false);
    else expect(await fse.readFile(agentsMd(), 'utf8')).toBe(before);
  });
});
