import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const autoDetectInit = vi.fn();
vi.mock('../config.js', () => ({ autoDetectInit }));

import { resolveServableSkill, skillCatalog, skillGet, skillPath } from '../skill-content.js';

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
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout += args.join(' ') + '\n';
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr += args.join(' ') + '\n';
    });
    restore.push(() => writeSpy.mockRestore(), () => logSpy.mockRestore(), () => errorSpy.mockRestore());
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

    expect(await resolveServableSkill('share')).toEqual({ kind: 'blocked', name: 'share', reason: 'recall' });
    // Aliases land on the same gate: the name in the refusal is the canonical one.
    expect(await resolveServableSkill('teamai-share-learnings')).toMatchObject({ kind: 'blocked', name: 'share' });

    await skillGet(['share']);
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('share needs recall');
    expect(stderr).toContain('teamai recall enable');
  });

  it('serves share when recall is enabled', async () => {
    withRecall(true);

    expect(await resolveServableSkill('share')).toMatchObject({ kind: 'found', skill: { name: 'share' } });

    await skillGet(['share']);
    expect(process.exitCode).toBeUndefined();
    expect(stdout).toContain('name: share');
  });

  it('leaves share out of --all when recall is disabled, and says so on stderr', async () => {
    withRecall(false);

    await skillGet([], { all: true });
    expect(process.exitCode).toBeUndefined();
    expect(stdout).toContain('name: core');
    expect(stdout).toContain('name: wiki');
    expect(stdout).not.toContain('name: share');
    expect(stderr).toContain('Skipped share');
    expect(stderr).toContain('teamai recall enable');
  });

  it('withholds the share directory from skill path and the catalog when recall is disabled', async () => {
    withRecall(false);

    await skillPath('share');
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('share needs recall');

    const share = (await skillCatalog()).find((entry) => entry.name === 'share');
    expect(share).toMatchObject({ blockedBy: 'recall', path: null });
  });

  it('serves the share directory through skill path and the catalog when recall is enabled', async () => {
    withRecall(true);

    await skillPath('share');
    expect(process.exitCode).toBeUndefined();
    expect(stdout.trim()).toMatch(/skill-data[\\/]share$/);

    const share = (await skillCatalog()).find((entry) => entry.name === 'share');
    expect(share).toMatchObject({ blockedBy: null, path: stdout.trim() });
  });

  it('withholds share from a read-only HTTP team, whose `teamai contribute` always refuses', async () => {
    // Recall on, so only the source decides: the workflow's last step would fail
    // after the agent had written the whole learning.
    autoDetectInit.mockResolvedValue({
      localConfig: { recallEnabled: true, repo: { kind: 'http', localPath: '/tmp', remote: '' } },
      teamConfig: { sharing: { recall: { enabled: true } } },
    });

    expect(await resolveServableSkill('share')).toEqual({ kind: 'blocked', name: 'share', reason: 'read-only' });
    await skillGet(['share']);
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('read-only HTTP source');
    expect(stderr).not.toContain('teamai recall enable');
    expect((await skillCatalog()).find((entry) => entry.name === 'share')).toMatchObject({ blockedBy: 'read-only', path: null });
  });

  it('never gates the skills that do not depend on recall', async () => {
    withRecall(false);

    for (const name of ['core', 'setup', 'wiki']) {
      expect((await resolveServableSkill(name)).kind, name).toBe('found');
    }
  });

  it('fails open when there is no team config to consult', async () => {
    autoDetectInit.mockRejectedValue(new Error('not initialized'));

    // A fresh machine reading the docs gets the content, not a refusal it
    // cannot act on.
    expect((await resolveServableSkill('share')).kind).toBe('found');
  });
});
