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
import { loadLocalConfigForScope, loadTeamConfig } from '../config.js';
import {
  TeamaiConfigSchema,
  TEAMAI_TEAM_RULES_START,
  TEAMAI_TEAM_RULES_END,
  TEAMAI_RULES_START,
  TEAMAI_RULES_END,
} from '../types.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

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

  it('inlines the rules in a team-rules block in <project>/AGENTS.md, keeps user text, and writes nothing to .codex/rules', async () => {
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
    expect(await fse.pathExists(path.join(projectRoot, '.codex', 'rules'))).toBe(false);
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

  it('removes the block on the next pull once Codex is no longer enabled', async () => {
    await fse.writeFile(agentsMd(), '# Project notes\n');
    await handler.pullAllRules(teamConfig, localConfig);

    await handler.pullAllRules(teamConfig, { ...localConfig, enabledAgents: ['claude'] } as LocalConfig);

    expect(await fse.readFile(agentsMd(), 'utf8')).toBe('# Project notes\n');
  });

  it('creates no AGENTS.md when Codex is not installed for the project', async () => {
    await fse.remove(path.join(projectRoot, '.codex'));

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(agentsMd())).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codex'))).toBe(false);
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
});
