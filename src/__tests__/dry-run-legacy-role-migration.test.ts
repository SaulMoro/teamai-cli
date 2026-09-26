import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rolesSet } from '../roles-cmd.js';
import { tagsSubscribe, tagsUnsubscribe } from '../tags.js';
import { log } from '../utils/logger.js';

// A role-less user config next to a roles manifest that declares `hai` is
// migrated on load. Under --dry-run that migration must stay in memory.
describe('--dry-run with a config that still needs the legacy role migration', () => {
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  let home: string;
  let configPath: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'teamai-dry-run-legacy-'));
    process.env.HOME = home;
    // Outside any git repo, so no project config is detected.
    const cwd = path.join(home, 'work');
    mkdirSync(cwd);
    process.chdir(cwd);
    const repoDir = path.join(home, 'team-repo');
    mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
    writeFileSync(path.join(repoDir, 'teamai.yaml'), 'team: demo\nrepo: owner/repo\nprovider: github\n');
    writeFileSync(
      path.join(repoDir, 'manifest', 'roles.yaml'),
      'version: 1\nroles:\n  - id: hai\n    resources: { knowledge: [], skills: [hai] }\n  - id: pm\n    resources: { knowledge: [], skills: [pm] }\n',
    );
    mkdirSync(path.join(home, '.teamai'), { recursive: true });
    configPath = path.join(home, '.teamai', 'config.yaml');
    writeFileSync(
      configPath,
      `repo:\n  localPath: ${repoDir}\n  remote: owner/repo\nusername: dev\nsubscribedTags:\n  - frontend\n`,
    );
    vi.spyOn(log, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  const hashConfig = (): string => createHash('sha256').update(readFileSync(configPath)).digest('hex');

  it.each([
    ['tags subscribe', () => tagsSubscribe(['testing'], { dryRun: true })],
    ['tags unsubscribe', () => tagsUnsubscribe(['frontend'], { dryRun: true })],
    ['roles set', () => rolesSet('pm', { dryRun: true })],
  ])('%s leaves config.yaml untouched', async (_name, run) => {
    const before = hashConfig();
    await run();
    expect(hashConfig()).toBe(before);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[dry-run] Would'));
  });
});
