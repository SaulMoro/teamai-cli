/**
 * Docs by namespace (#707): a `docs/<dir>/` that a role or project lists in
 * `resources.docs` reaches only members with it active; an undeclared one stays
 * shared. Deactivating a namespace removes its local docs that are unchanged
 * and keeps edited ones with a line. Asserted through `pull`, on what lands on
 * disk and in the search index.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { execFileSync } from 'node:child_process';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  pullRepo: vi.fn().mockResolvedValue('Already up to date.'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    persist: vi.fn(),
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

// pull() takes a real ~/.teamai/.sync-lock; parallel workers would race on it.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { pull } from '../pull.js';
import { loadLocalConfigForScope, loadTeamConfig, detectProjectConfig } from '../config.js';
import { log } from '../utils/logger.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

const ROLES_YAML = `
version: 1
roles:
  - id: frontend
    resources:
      knowledge: []
      skills: []
      docs: [frontend]
  - id: devops
    resources:
      knowledge: []
      skills: []
      docs: [devops]
`;

describe('pull: docs by namespace', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;

  function configFor(role: string | null, extra: Partial<LocalConfig> = {}): LocalConfig {
    return {
      repo: { localPath: repoPath, remote: 'https://example.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      ...(role ? { primaryRole: role } : {}),
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
      ...extra,
    };
  }

  const as = (role: string | null, extra: Partial<LocalConfig> = {}): void => {
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(configFor(role, extra));
  };
  const local = (rel: string): string => path.join(homeDir, 'team-docs', rel);
  const exists = (rel: string): Promise<boolean> => fse.pathExists(local(rel));
  const team = (rel: string, content: string): Promise<void> => fse.outputFile(path.join(repoPath, rel), content);
  const warned = (pattern: RegExp): boolean => (
    vi.mocked(log.warn).mock.calls.some((args) => pattern.test(args.map(String).join(' ')))
  );
  const indexedDocs = async (): Promise<string[]> => {
    const index = await fse.readJson(path.join(homeDir, '.teamai', 'search-index.json')) as {
      entries: Array<{ type: string; filename: string }>;
    };
    return index.entries.filter((entry) => entry.type === 'docs').map((entry) => entry.filename).sort();
  };

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-docs-ns-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await team('manifest/roles.yaml', ROLES_YAML);
    await team('docs/guide.md', '# Guide\n');
    await team('docs/api/reference.md', '# API\n');
    await team('docs/frontend/components.md', '# Components\n');
    await team('docs/frontend/styling.md', '# Styling\n');
    await team('docs/devops/deploy.md', '# Deploy\n');

    vi.stubEnv('HOME', homeDir);

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '~/team-docs' },
        env: { injectShellProfile: true },
      },
      toolPaths: {},
    };

    as('frontend');
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.error).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('delivers shared docs and the active namespace, not a namespace declared elsewhere', async () => {
    await pull({});

    expect(await exists('guide.md')).toBe(true);
    // Not listed in any resources.docs: shared, as every docs/<dir>/ was before.
    expect(await exists('api/reference.md')).toBe(true);
    expect(await exists('frontend/components.md')).toBe(true);
    expect(await exists('devops/deploy.md')).toBe(false);
    expect(await exists('devops')).toBe(false);
  });

  it('treats a namespace a project declares as declared for a role member too', async () => {
    await team('manifest/projects.yaml', 'version: 1\nprojects:\n  - id: billing\n    resources:\n      docs: [billing]\n');
    await team('docs/billing/invoices.md', '# Invoices\n');

    await pull({});

    expect(await exists('billing/invoices.md')).toBe(false);
    expect(await exists('frontend/components.md')).toBe(true);
  });

  it('delivers a project namespace to a member with that project active', async () => {
    await team('manifest/projects.yaml', 'version: 1\nprojects:\n  - id: billing\n    resources:\n      docs: [billing]\n');
    await team('docs/billing/invoices.md', '# Invoices\n');
    as(null, { projects: ['billing'] });

    await pull({});

    expect(await exists('billing/invoices.md')).toBe(true);
    expect(await exists('frontend/components.md')).toBe(false);
    expect(await exists('guide.md')).toBe(true);
  });

  it('removes unchanged docs of a deactivated namespace and keeps an edited one with a line', async () => {
    await pull({});
    expect(await exists('frontend/components.md')).toBe(true);
    await fse.outputFile(local('frontend/styling.md'), '# Styling, my notes\n');
    await fse.outputFile(local('frontend/mine.md'), '# Only mine\n');

    as('devops');
    await pull({});

    expect(await exists('frontend/components.md')).toBe(false);
    expect(await fse.readFile(local('frontend/styling.md'), 'utf8')).toBe('# Styling, my notes\n');
    // Not a team file: the docs mirror prunes it, as anywhere in the destination (#817).
    expect(await exists('frontend/mine.md')).toBe(false);
    expect(warned(/frontend\/styling\.md/)).toBe(true);
    expect(warned(/components\.md/)).toBe(false);
    expect(await exists('devops/deploy.md')).toBe(true);
    expect(await exists('guide.md')).toBe(true);
  });

  // The team edited a doc after the member received it: the copy is an older
  // team version, not a member edit, so it goes like an unchanged one.
  it('removes a copy of a deactivated namespace that the team has edited since it was delivered', async () => {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'v1');
    await pull({});
    await team('docs/frontend/styling.md', '# Styling v2\n');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'v2');

    as('devops');
    await pull({});

    expect(await exists('frontend/styling.md')).toBe(false);
    expect(warned(/Kept \d+ doc/)).toBe(false);
  });

  it('never withdraws from the team repo when the docs destination is its docs/ directory', async () => {
    vi.mocked(loadTeamConfig).mockResolvedValue({
      ...teamConfig,
      sharing: { ...teamConfig.sharing, docs: { localDir: path.join(repoPath, 'docs') } },
    });
    await fse.ensureDir(homeDir);

    await pull({});

    expect(warned(/Failed to sync docs/)).toBe(false);
    expect(await fse.pathExists(path.join(repoPath, 'docs', 'devops', 'deploy.md'))).toBe(true);
  });

  it('removes the directory a deactivated namespace leaves empty', async () => {
    await team('docs/frontend/nested/deep.md', '# Deep\n');
    await pull({});
    expect(await exists('frontend/nested/deep.md')).toBe(true);

    as('devops');
    await pull({});

    expect(await exists('frontend')).toBe(false);
  });

  it('indexes for recall the docs pull delivers', async () => {
    await pull({});

    expect(await indexedDocs()).toEqual(['api/reference.md', 'frontend/components.md', 'frontend/styling.md', 'guide.md']);
  });

  it('rejects team-codebase as a docs namespace and syncs nothing for the scope', async () => {
    await team('manifest/roles.yaml', ROLES_YAML.replace('docs: [devops]', 'docs: [team-codebase]'));

    await pull({});

    expect(vi.mocked(log.error).mock.calls.some((args) => /team-codebase/.test(args.map(String).join(' ')))).toBe(true);
    expect(await exists('guide.md')).toBe(false);
  });

  it('delivers every docs directory in legacy mode (no role, no projects), as before', async () => {
    as(null);

    await pull({});

    expect(await exists('frontend/components.md')).toBe(true);
    expect(await exists('devops/deploy.md')).toBe(true);
    expect(await indexedDocs()).toContain('devops/deploy.md');
  });
});
