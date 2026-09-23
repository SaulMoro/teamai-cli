import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  setStderrOnly: vi.fn(() => false),
}));

import { NotInitializedError, findUnreadableProjectConfig, requireInit } from '../config.js';

/**
 * `loadLocalConfig` returns null both for a missing file and for one it could
 * not use. Commands that work without a team fall back on NotInitializedError
 * alone, so only the missing file may produce it.
 */
describe('requireInit: missing config versus unreadable config', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-config-init-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is NotInitializedError when there is no config file', async () => {
    await expect(requireInit()).rejects.toBeInstanceOf(NotInitializedError);
  });

  it('names the file, and is not NotInitializedError, when the config exists but does not parse', async () => {
    const configPath = path.join(home, '.teamai', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'repo: [unclosed\n');

    const error = await requireInit().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NotInitializedError);
    expect(String(error)).toContain(configPath);
  });

  it('is not NotInitializedError when the config parses but fails validation', async () => {
    const configPath = path.join(home, '.teamai', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'username: 42\n');

    await expect(requireInit()).rejects.not.toBeInstanceOf(NotInitializedError);
  });
});

describe('findUnreadableProjectConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-project-config-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names a project config that exists but does not parse, which detection alone skips', async () => {
    const configPath = path.join(dir, '.teamai', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'repo: [unclosed\n');

    expect(await findUnreadableProjectConfig(dir)).toContain(configPath);
  });

  it('is null when there is no project config at all', async () => {
    expect(await findUnreadableProjectConfig(dir)).toBeNull();
  });
});

