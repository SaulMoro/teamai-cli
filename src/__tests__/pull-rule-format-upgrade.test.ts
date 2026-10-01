import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
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

import { pull } from '../pull.js';
import { log } from '../utils/logger.js';
import { loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { TeamaiConfigSchema, type LocalConfig, type State } from '../types.js';

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * A CLI upgrade that gives a tool its own rules format must reach a machine
 * whose team revision has not moved, or its rules stay verbatim until the
 * team next changes (#946).
 */
describe('a pull at an unchanged team revision after the rule formats change (#946)', () => {
  let tmpDir: string;
  let homeDir: string;
  let saved: State;

  const SCOPED = '---\npaths:\n  - "src/**"\n---\n\nUse named exports.\n';
  const KIRO = '---\ninclusion: fileMatch\nfileMatchPattern: ["src/**"]\n---\n\nUse named exports.\n';
  const kiroCopy = () => path.join(homeDir, '.kiro', 'steering', 'scoped.md');
  const qoderCopy = () => path.join(homeDir, '.qoder', 'rules', 'scoped.md');
  const delivered = () => Object.values(saved.lastPullByWorkspace ?? {})[0]?.delivered ?? {};

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rule-format-upgrade-'));
    homeDir = path.join(tmpDir, 'home');
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(homeDir, '.kiro'));
    await fse.ensureDir(path.join(homeDir, '.qoder'));
    await fse.outputFile(path.join(repoPath, 'rules', 'scoped.md'), SCOPED);
    vi.stubEnv('HOME', homeDir);
    saved = {} as State;
    vi.mocked(saveStateForScope).mockImplementation(async (state) => {
      saved = structuredClone(state);
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
      enabledAgents: ['kiro', 'qoder'],
    } as LocalConfig);
    await pull({});
    // What an older CLI left at this revision: the team rule verbatim, on
    // record as delivered; the member then edited the Qoder copy.
    for (const copy of [kiroCopy(), qoderCopy()]) await fse.writeFile(copy, SCOPED);
    const record = Object.values(saved.lastPullByWorkspace ?? {})[0];
    record.delivered = { ...record.delivered, [kiroCopy()]: sha256(SCOPED), [qoderCopy()]: sha256(SCOPED) };
    await fse.writeFile(qoderCopy(), 'My own wording.\n');
    vi.mocked(log.success).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('re-renders the unedited copy, records it, and leaves the edited one', async () => {
    await pull({});

    const successes = vi.mocked(log.success).mock.calls.map(([message]) => String(message));
    expect(successes.some((message) => message.includes('Already synced at abc1234'))).toBe(true);
    expect(await fse.readFile(kiroCopy(), 'utf8')).toBe(KIRO);
    expect(await fse.readFile(qoderCopy(), 'utf8')).toBe('My own wording.\n');
    expect(delivered()[kiroCopy()]).toBe(sha256(KIRO));
    expect(delivered()[qoderCopy()]).toBe(sha256(SCOPED));
    expect(successes).toContain('[user] Rewrote 1 rule(s) in their tool\'s own format: scoped');
    // Kept and named, as a full sync names it (#822).
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings.filter((message) => message.includes(`Kept ${qoderCopy()}`))).toHaveLength(1);
  });
});

/**
 * OMP reads only the top of its rules directory, so a namespaced rule moved
 * from `fe/style.md` to `fe.style.md`. The new path has no record, so the
 * re-render above cannot reach it; the old copy is what moves it.
 */
describe('a pull at an unchanged team revision after OMP rules go flat (#946)', () => {
  let tmpDir: string;
  let homeDir: string;
  let saved: State;

  const NS = 'Namespaced rule.\n';
  const OMP_NS = '---\nalwaysApply: true\n---\n\nNamespaced rule.\n';
  const rulesDir = () => path.join(homeDir, '.omp', 'agent', 'rules');
  const record = () => Object.values(saved.lastPullByWorkspace ?? {})[0];

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-flat-upgrade-'));
    homeDir = path.join(tmpDir, 'home');
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(rulesDir());
    await fse.outputFile(path.join(repoPath, 'rules', 'fe', 'style.md'), NS);
    await fse.outputFile(path.join(repoPath, 'rules', 'be', 'api.md'), 'Backend rule.\n');
    vi.stubEnv('HOME', homeDir);
    saved = {} as State;
    vi.mocked(saveStateForScope).mockImplementation(async (state) => {
      saved = structuredClone(state);
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
      enabledAgents: ['omp'],
    } as LocalConfig);
    await pull({});
    // What an older CLI left at this revision: each rule verbatim and nested,
    // on record; the member then edited the backend copy.
    const delivered: Record<string, string> = {};
    for (const name of ['fe.style.md', 'be.api.md']) await fse.remove(path.join(rulesDir(), name));
    for (const [rel, text] of [['fe/style.md', NS], ['be/api.md', 'Backend rule.\n']]) {
      await fse.outputFile(path.join(rulesDir(), rel), text);
      delivered[path.join(rulesDir(), rel)] = sha256(text);
    }
    record().delivered = delivered;
    await fse.writeFile(path.join(rulesDir(), 'be', 'api.md'), 'My own backend wording.\n');
    vi.mocked(log.success).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('writes the flat copy OMP reads, and reclaims the nested one unless the member edited it', async () => {
    await pull({});

    const successes = vi.mocked(log.success).mock.calls.map(([message]) => String(message));
    expect(successes.some((message) => message.includes('Already synced at abc1234'))).toBe(true);
    const flat = path.join(rulesDir(), 'fe.style.md');
    expect(await fse.readFile(flat, 'utf8')).toBe(OMP_NS);
    expect(await fse.pathExists(path.join(rulesDir(), 'fe'))).toBe(false);
    // The member's edit stays where it is; the flat copy still gets the team rule.
    expect(await fse.readFile(path.join(rulesDir(), 'be', 'api.md'), 'utf8')).toBe('My own backend wording.\n');
    expect(await fse.readFile(path.join(rulesDir(), 'be.api.md'), 'utf8')).toBe('---\nalwaysApply: true\n---\n\nBackend rule.\n');
    expect(record().delivered?.[flat]).toBe(sha256(OMP_NS));
    expect(record().delivered?.[path.join(rulesDir(), 'fe', 'style.md')]).toBeUndefined();
    // The edited nested copy is named: OMP does not read it.
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings.filter((message) => message.includes(`Kept ${path.join(rulesDir(), 'be', 'api.md')}`))).toHaveLength(1);
  });

  it('does the same on a machine an older CLI left with no delivery record', async () => {
    delete record().delivered;
    // A root rule's verbatim copy too: the team rule's own bytes, so unedited.
    await fse.outputFile(path.join(tmpDir, 'team-repo', 'rules', 'root.md'), 'Root rule.\n');
    await fse.outputFile(path.join(rulesDir(), 'root.md'), 'Root rule.\n');
    await fse.outputFile(path.join(rulesDir(), 'mine.md'), 'Not a team rule.\n');

    await pull({});

    expect(await fse.readFile(path.join(rulesDir(), 'root.md'), 'utf8')).toBe('---\nalwaysApply: true\n---\n\nRoot rule.\n');
    expect(await fse.readFile(path.join(rulesDir(), 'mine.md'), 'utf8')).toBe('Not a team rule.\n');
    expect(await fse.readFile(path.join(rulesDir(), 'fe.style.md'), 'utf8')).toBe(OMP_NS);
    expect(await fse.pathExists(path.join(rulesDir(), 'fe'))).toBe(false);
    expect(await fse.readFile(path.join(rulesDir(), 'be', 'api.md'), 'utf8')).toBe('My own backend wording.\n');
  });
});

/**
 * A CLI upgrade that moves OpenCode's rules globs must reach a machine whose
 * team revision has not moved, or OpenCode keeps loading through the old
 * entry until the team next changes (#946).
 */
describe('a pull at an unchanged team revision after the OpenCode rules globs move (#946)', () => {
  let tmpDir: string;
  let homeDir: string;
  let projectRoot: string;
  let saved: State;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-oc-glob-upgrade-'));
    homeDir = path.join(tmpDir, 'home');
    projectRoot = path.join(tmpDir, 'project');
    await fse.ensureDir(path.join(homeDir, '.config', 'opencode'));
    await fse.ensureDir(path.join(projectRoot, '.opencode'));
    vi.stubEnv('HOME', homeDir);
    saved = {} as State;
    vi.mocked(saveStateForScope).mockImplementation(async (state) => {
      saved = structuredClone(state);
    });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved) as never);
    vi.mocked(loadTeamConfig).mockResolvedValue(
      TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' }),
    );
  });

  afterEach(async () => {
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  /** Pull once at revision abc1234, then put back what an older CLI left there. */
  async function pullThenDowngrade(scope: 'user' | 'project', configFile: string, old: unknown): Promise<void> {
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.outputFile(path.join(repoPath, 'rules', 'team-rule.md'), 'Use named exports.\n');
    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope,
      projectRoot: scope === 'project' ? projectRoot : undefined,
      enabledAgents: ['opencode'],
    } as LocalConfig);
    await pull({});
    await fse.outputJson(configFile, old);
    vi.mocked(log.success).mockClear();
  }

  const alreadySynced = (): boolean => vi.mocked(log.success).mock.calls
    .some(([message]) => String(message).includes('Already synced at abc1234'));

  it('user scope: replaces the old relative glob with the absolute one', async () => {
    const config = path.join(homeDir, '.config', 'opencode', 'opencode.json');
    await pullThenDowngrade('user', config, { model: 'mine', instructions: ['rules/*.md'] });

    await pull({});

    expect(alreadySynced()).toBe(true);
    const rules = path.join(homeDir, '.config', 'opencode', 'rules');
    expect(await fse.readJson(config)).toEqual({ model: 'mine', instructions: [`${rules}/*.md`] });
  });

  it('project scope: moves the glob from the root opencode.json to .opencode/opencode.json', async () => {
    const root = path.join(projectRoot, 'opencode.json');
    const dot = path.join(projectRoot, '.opencode', 'opencode.json');
    await pullThenDowngrade('project', root, { theme: 'dark', instructions: ['.opencode/rules/*.md'] });
    await fse.outputJson(dot, {});

    await pull({});

    expect(alreadySynced()).toBe(true);
    expect(await fse.readJson(dot)).toEqual({ instructions: ['.opencode/rules/**/*.md'] });
    expect(await fse.readJson(root)).toEqual({ theme: 'dark' });
  });
});
