import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLocalConfig } from '../config.js';
import { log } from '../utils/logger.js';

describe('loadLocalConfig: legacy role migration against the team repo roles manifest', () => {
  const originalHome = process.env.HOME;
  let home: string;
  let repoDir: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'teamai-legacy-role-'));
    process.env.HOME = home;
    repoDir = path.join(home, 'team-repo');
    mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
    mkdirSync(path.join(home, '.teamai'), { recursive: true });
    writeFileSync(
      path.join(home, '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${repoDir}\n  remote: https://github.com/acme/team.git\nusername: dev\n`,
      'utf-8',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeRoles(content: string): void {
    writeFileSync(path.join(repoDir, 'manifest', 'roles.yaml'), content, 'utf-8');
  }

  it('migrates a role-less config to the hai role when the manifest declares it', async () => {
    writeRoles('version: 1\nroles:\n  - id: hai\n    resources: { knowledge: [], skills: [hai] }\n');
    const config = await loadLocalConfig();
    expect(config?.primaryRole).toBe('hai');
  });

  // Every command loads the config, `pull` included, so a broken manifest that
  // failed the load would leave the member unable to pull the fix. The pull
  // itself refuses a broken manifest, which is what keeps delivery from widening.
  it('keeps the config loadable when the manifest does not parse, and says why it was not migrated', async () => {
    writeRoles("version: 1\nroles:\n  - id: hai\n    resources: { knowledge: [], skills: ['../../evil'] }\n");
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const config = await loadLocalConfig();
    expect(config).not.toBeNull();
    expect(config?.primaryRole).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid roles manifest'));
  });
});
