import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadStateForScope: vi.fn(async () => ({})),
  saveStateForScope: vi.fn(),
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
}));

import { RulesHandler } from '../resources/rules.js';
import { openLedger } from '../resources/delivered-copies.js';
import { loadStateForScope } from '../config.js';
import { log } from '../utils/logger.js';
import { TeamaiConfigSchema } from '../types.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

describe('pull reclaims the .codex/rules copies earlier pulls wrote (#938)', () => {
  let tmpDir: string;
  let homeDir: string;
  let projectRoot: string;
  let repoPath: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  const legacyDir = () => path.join(projectRoot, '.codex', 'rules');
  const legacy = (file: string) => path.join(legacyDir(), file);

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-legacy-'));
    homeDir = path.join(tmpDir, 'home');
    projectRoot = path.join(tmpDir, 'project');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(homeDir);
    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.ensureDir(path.join(projectRoot, '.codex'));
    await fse.writeFile(path.join(repoPath, 'rules', 'codeword.md'), 'The team codeword is PELICAN-42.\n');
    vi.stubEnv('HOME', homeDir);
    vi.clearAllMocks();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);

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

  it('removes an unchanged rule copy, and the directory once nothing else is in it', async () => {
    await fse.ensureDir(legacyDir());
    await fse.writeFile(legacy('codeword.md'), 'The team codeword is PELICAN-42.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(legacy('codeword.md'))).toBe(false);
    expect(await fse.pathExists(legacyDir())).toBe(false);
  });

  it('removes the built-in teamai-recall.md, as this or an earlier teamai version deployed it', async () => {
    await fse.ensureDir(legacyDir());
    // An earlier version's recall rule: same heading, older body.
    await fse.writeFile(legacy('teamai-recall.md'), '# Team Knowledge Recall (teamai)\n\nRun `teamai recall` first.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(legacy('teamai-recall.md'))).toBe(false);
    expect(await fse.pathExists(legacyDir())).toBe(false);
  });

  it('keeps an edited copy and names it once in an English warning with how to remove it', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'style.md'), 'Use tabs.\n');
    await fse.ensureDir(legacyDir());
    await fse.writeFile(legacy('codeword.md'), 'The team codeword is PELICAN-42.\nMy own note.\n');
    await fse.writeFile(legacy('style.md'), 'Use spaces.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(legacy('codeword.md'), 'utf8')).toBe('The team codeword is PELICAN-42.\nMy own note.\n');
    expect(await fse.readFile(legacy('style.md'), 'utf8')).toBe('Use spaces.\n');
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(legacy('codeword.md'));
    expect(warnings[0]).toContain(legacy('style.md'));
    expect(warnings[0]).toContain('AGENTS.md');
    expect(warnings[0]).toMatch(/[Dd]elete/);
  });

  it('never touches Codex exec-policy files or files that are not team rules', async () => {
    await fse.ensureDir(legacyDir());
    await fse.writeFile(legacy('codeword.md'), 'The team codeword is PELICAN-42.\n');
    await fse.writeFile(legacy('default.rules'), 'prefix_rule(pattern = ["git", "status"], decision = "allow")\n');
    // Same bytes as a team rule, but not a team rule's name.
    await fse.writeFile(legacy('personal.md'), 'The team codeword is PELICAN-42.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(legacy('codeword.md'))).toBe(false);
    expect(await fse.readFile(legacy('default.rules'), 'utf8')).toContain('prefix_rule');
    expect(await fse.pathExists(legacy('personal.md'))).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('removes a copy of the rule as it was at the revision this checkout last pulled', async () => {
    const run = (args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
    } });
    run(['init', '-q', '-b', 'main']);
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'rule as delivered']);
    const deliveredRev = run(['rev-parse', 'HEAD']).trim();
    await fse.writeFile(path.join(repoPath, 'rules', 'codeword.md'), 'The team codeword is HERON-7.\n');
    run(['commit', '-q', '-am', 'rule changed since']);
    vi.mocked(loadStateForScope).mockImplementation(async () => ({ lastPullRev: deliveredRev }) as never);
    await fse.ensureDir(legacyDir());
    await fse.writeFile(legacy('codeword.md'), 'The team codeword is PELICAN-42.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(legacy('codeword.md'))).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('removes a copy the delivery ledger recorded, and forgets the record', async () => {
    await fse.ensureDir(legacyDir());
    const file = legacy('codeword.md');
    // Written by a build that delivered a since-reverted edit of the rule.
    await fse.writeFile(file, 'The team codeword was PELICAN-41.\n');
    const hash = crypto.createHash('sha256').update('The team codeword was PELICAN-41.\n').digest('hex');
    const ledger = openLedger({ [file]: hash });

    await handler.pullAllRules(teamConfig, localConfig, undefined, [], ledger);

    expect(await fse.pathExists(file)).toBe(false);
    expect(ledger.hashes[file]).toBeUndefined();
  });

  // The team removed the rule after this machine's last pre-#938 pull.
  it('removes the copy of a rule the team has since removed', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'retired\n');
    await fse.ensureDir(legacyDir());
    await fse.writeFile(legacy('retired.md'), 'A rule the team retired.\n');
    await fse.writeFile(legacy('codeword.md'), 'The team codeword is PELICAN-42.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(legacy('retired.md'))).toBe(false);
    expect(await fse.pathExists(legacyDir())).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('keeps and names the copy of a removed rule the member changed since teamai delivered it (#822)', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'retired\n');
    await fse.ensureDir(legacyDir());
    const file = legacy('retired.md');
    await fse.writeFile(file, 'A rule the team retired.\nMy own note.\n');
    const delivered = crypto.createHash('sha256').update('A rule the team retired.\n').digest('hex');
    const ledger = openLedger({ [file]: delivered });

    await handler.pullAllRules(teamConfig, localConfig, undefined, [], ledger);

    expect(await fse.readFile(file, 'utf8')).toBe('A rule the team retired.\nMy own note.\n');
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
  });

  it('runs when no rule reaches this directory, and covers rules filtered out by roles or tags', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'backend-only.md'), 'Backend rule.\n');
    await fse.ensureDir(legacyDir());
    await fse.writeFile(legacy('codeword.md'), 'The team codeword is PELICAN-42.\n');
    await fse.writeFile(legacy('backend-only.md'), 'Backend rule.\n');

    await handler.pullAllRules(teamConfig, localConfig, []);

    expect(await fse.pathExists(legacy('codeword.md'))).toBe(false);
    expect(await fse.pathExists(legacy('backend-only.md'))).toBe(false);
    expect(await fse.pathExists(legacyDir())).toBe(false);
  });

  it('also reclaims the copies of a Codex that is excluded or not installed', async () => {
    // Excluded, and no hooks.json: nothing marks Codex as installed.
    localConfig = { ...localConfig, enabledAgents: ['claude'] } as LocalConfig;
    await fse.ensureDir(legacyDir());
    await fse.writeFile(legacy('codeword.md'), 'The team codeword is PELICAN-42.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(legacy('codeword.md'))).toBe(false);
  });

  it('leaves a directory the team still delivers rules to through its toolPaths', async () => {
    teamConfig = {
      ...teamConfig,
      toolPaths: { ...teamConfig.toolPaths, codex: { ...teamConfig.toolPaths.codex, rules: '.codex/rules' } },
    };
    await fse.ensureDir(legacyDir());
    await fse.writeFile(legacy('codeword.md'), 'The team codeword is PELICAN-42.\n');
    // The built-in pull deploys there next to the team rules.
    await fse.writeFile(legacy('teamai-recall.md'), '# Team Knowledge Recall (teamai)\n\nRecall first.\n');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(legacy('codeword.md'), 'utf8')).toBe('The team codeword is PELICAN-42.\n');
    expect(await fse.pathExists(legacy('teamai-recall.md'))).toBe(true);
  });

  it.each(['codex', 'codex-internal', 'tcodex'])('reclaims %s copies in user scope, and a second pull finds nothing to do', async (tool) => {
    // The default entries: no Codex-family id delivers to a rules dir.
    localConfig = { ...localConfig, scope: 'user', projectRoot: undefined } as unknown as LocalConfig;
    const dir = path.join(homeDir, `.${tool}`, 'rules');
    await fse.ensureDir(dir);
    await fse.writeFile(path.join(dir, 'codeword.md'), 'The team codeword is PELICAN-42.\n');
    await fse.writeFile(path.join(dir, 'default.rules'), 'prefix_rule(pattern = ["ls"], decision = "allow")\n');

    await handler.pullAllRules(teamConfig, localConfig);
    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(dir, 'codeword.md'))).toBe(false);
    expect(await fse.pathExists(path.join(dir, 'default.rules'))).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
