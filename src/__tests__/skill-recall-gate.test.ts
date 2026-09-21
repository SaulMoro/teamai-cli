import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const autoDetectInit = vi.fn();
vi.mock('../config.js', () => ({ autoDetectInit }));

import { blockedByRecall, skillGet } from '../skill-content.js';

/**
 * Recall used to be decided when deploying: the share skill simply was not
 * copied into the agent. One deployed stub routes to every workflow, so the
 * decision moved to the moment the agent asks for the content (#678).
 */
describe('recall gate on served skills', () => {
  let stderr: string;
  let stdout: string;
  const restore: Array<() => void> = [];

  beforeEach(() => {
    stderr = '';
    stdout = '';
    process.exitCode = undefined;
    autoDetectInit.mockReset();

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr += args.join(' ') + '\n';
    });
    restore.push(() => writeSpy.mockRestore(), () => errorSpy.mockRestore());
  });

  afterEach(() => {
    while (restore.length > 0) restore.pop()?.();
    process.exitCode = undefined;
  });

  const withRecall = (enabled: boolean): void => {
    autoDetectInit.mockResolvedValue({
      localConfig: { recallEnabled: enabled },
      teamConfig: { sharing: { recall: { enabled } } },
    });
  };

  it('blocks share when recall is disabled, and says what to turn on', async () => {
    withRecall(false);

    expect(await blockedByRecall('share')).toBe(true);

    await skillGet(['share']);
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('share needs recall');
    expect(stderr).toContain('teamai recall enable');
  });

  it('serves share when recall is enabled', async () => {
    withRecall(true);

    expect(await blockedByRecall('share')).toBe(false);

    await skillGet(['share']);
    expect(process.exitCode).toBeUndefined();
    expect(stdout).toContain('name: share');
  });

  it('never gates the skills that do not depend on recall', async () => {
    withRecall(false);

    for (const name of ['core', 'setup', 'wiki']) {
      expect(await blockedByRecall(name), name).toBe(false);
    }
  });

  it('fails open when there is no team config to consult', async () => {
    autoDetectInit.mockRejectedValue(new Error('not initialized'));

    // A fresh machine reading the docs gets the content, not a refusal it
    // cannot act on.
    expect(await blockedByRecall('share')).toBe(false);
  });
});
