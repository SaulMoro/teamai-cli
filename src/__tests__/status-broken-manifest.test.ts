import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

const { repoDir } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  return { repoDir: mkdtempSync(path.join(os.tmpdir(), 'teamai-status-broken-')) };
});

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: vi.fn().mockResolvedValue({
    localConfig: { repo: { localPath: repoDir, remote: 'https://github.com/acme/team.git' }, username: 'dev', scope: 'user' },
    teamConfig: {},
  }),
  loadStateForScope: vi.fn().mockResolvedValue({}),
}));
vi.mock('../utils/git.js', () => ({ getRepoStatus: vi.fn().mockResolvedValue({ ahead: 0, behind: 0, modified: [] }) }));
vi.mock('../resources/index.js', () => ({
  getAllHandlers: vi.fn().mockReturnValue([
    {
      type: 'skills',
      scanLocalForPush: vi.fn().mockRejectedValue(new Error('Invalid roles manifest: roles.0.resources.skills.0: bad')),
    },
    { type: 'rules', scanLocalForPush: vi.fn().mockResolvedValue([{ name: 'r' }]) },
  ]),
}));

import { status } from '../status.js';
import { log } from '../utils/logger.js';

describe('status with a roles manifest that does not parse', () => {
  let out: string[];

  beforeEach(() => {
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { out.push(args.join(' ')); });
    vi.spyOn(log, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('reports the type it could not scan and still lists the rest', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await expect(status({})).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[skills] could not scan: Invalid roles manifest'));
    expect(out).toContain('  [rules] 1 new');
  });
});
