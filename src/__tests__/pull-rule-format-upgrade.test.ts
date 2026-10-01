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
