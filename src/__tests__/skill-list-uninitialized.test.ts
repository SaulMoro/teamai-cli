import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { autoDetectInit, logDim, NotInitializedError } = vi.hoisted(() => ({
  autoDetectInit: vi.fn(),
  logDim: vi.fn(),
  NotInitializedError: class NotInitializedError extends Error {},
}));
vi.mock('../config.js', () => ({ autoDetectInit, NotInitializedError }));
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: logDim },
  setStderrOnly: vi.fn(() => false),
}));

import { skillList } from '../skill-cmd.js';

/**
 * `skill get` serves the packaged content on a machine with no team; the
 * human-readable `skill list` must let that machine discover it too, instead of
 * failing on the team listing it prints first.
 */
describe('teamai skill list before init', () => {
  let stdout: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    autoDetectInit.mockReset();
    logDim.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout += args.join(' ') + '\n';
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('prints the packaged catalog and says what to run for the rest', async () => {
    autoDetectInit.mockRejectedValue(new NotInitializedError('teamai is not initialized. Run `teamai init` first.'));

    await skillList({});

    expect(process.exitCode).toBeUndefined();
    expect(stdout).toContain('=== BUILT-IN SKILLS (served by the CLI) ===');
    for (const name of ['core', 'setup', 'share', 'wiki']) {
      expect(stdout).toContain(`teamai skill get ${name}`);
    }
    expect(logDim).toHaveBeenCalledWith(expect.stringContaining('teamai init'));
  });

  it('reports a broken config instead of calling the machine uninitialized', async () => {
    // A config that exists but cannot be used is not "no team": telling the
    // member to run `teamai init` would send them to re-init over a real setup.
    autoDetectInit.mockRejectedValue(new Error('Team config (teamai.yaml) not found. Check your repo path.'));

    await expect(skillList({})).rejects.toThrow('Team config (teamai.yaml) not found');
    expect(logDim).not.toHaveBeenCalledWith(expect.stringContaining('Not initialized'));
  });
});
