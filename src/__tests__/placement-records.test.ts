import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
const mockRemoteBranchExists = vi.fn();
vi.mock('../utils/git.js', () => ({
  remoteBranchExists: (...args: unknown[]) => mockRemoteBranchExists(...args),
}));

import { prunePlacementRecords } from '../utils/pending-push.js';
import type { PendingPush } from '../types.js';

/**
 * A placement record says "push put this resource of ours at that path". It is
 * written when the branch reaches the remote, which is before the PR merges,
 * so the target's absence from the default branch is normal while the PR is
 * open — and permanent once the PR is closed unmerged or the file is deleted
 * upstream. A record kept past that point comes true again the day another
 * member creates the same path, and the author's unrelated copy is then
 * treated as that resource (#649 review).
 */
describe('prunePlacementRecords', () => {
  let repoPath: string;
  const awaiting = (relativePath: string, branch = 'teamai/push/me/1'): PendingPush => ({
    branch, prUrl: null, createdAt: '2026-01-01T00:00:00.000Z',
    items: [{ type: 'rules', name: 'my-rule', relativePath }],
  });

  beforeEach(async () => {
    repoPath = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-placed-'));
    mockRemoteBranchExists.mockReset();
  });
  afterEach(async () => { await fse.remove(repoPath); });

  it('keeps a record whose target is on the default branch', async () => {
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'x');
    const state = { placedRules: { 'my-rule': 'rules/fe/my-rule.md' }, placedAgents: {}, pendingPushes: [] };

    expect(await prunePlacementRecords(repoPath, state)).toBe(false);
    expect(state.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });
  });

  it('keeps a record whose target is still awaiting review on an existing branch', async () => {
    mockRemoteBranchExists.mockResolvedValue(true);
    const state = {
      placedRules: { 'my-rule': 'rules/fe/my-rule.md' }, placedAgents: {},
      pendingPushes: [awaiting('rules/fe/my-rule.md')],
    };

    expect(await prunePlacementRecords(repoPath, state)).toBe(false);
    expect(state.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });
  });

  it('drops a record whose PR branch is gone and whose target never landed', async () => {
    mockRemoteBranchExists.mockResolvedValue(false);
    const state = {
      placedRules: { 'my-rule': 'rules/fe/my-rule.md' }, placedAgents: {},
      pendingPushes: [awaiting('rules/fe/my-rule.md')],
    };

    expect(await prunePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placedRules).toEqual({});
  });

  it('drops a record whose target was deleted upstream with nothing awaiting review', async () => {
    const state = {
      placedRules: { 'my-rule': 'rules/fe/my-rule.md' },
      placedAgents: { vr: 'agents/fe/vr.yaml' },
      pendingPushes: [],
    };

    expect(await prunePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placedRules).toEqual({});
    expect(state.placedAgents).toEqual({});
    expect(mockRemoteBranchExists).not.toHaveBeenCalled();
  });

  it('keeps a record when the remote cannot be asked about its branch', async () => {
    mockRemoteBranchExists.mockResolvedValue(null);
    const state = {
      placedRules: { 'my-rule': 'rules/fe/my-rule.md' }, placedAgents: {},
      pendingPushes: [awaiting('rules/fe/my-rule.md')],
    };

    expect(await prunePlacementRecords(repoPath, state)).toBe(false);
    expect(state.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });
  });

  it('trusts a pending entry without asking the remote when told not to', async () => {
    const state = {
      placedRules: { 'my-rule': 'rules/fe/my-rule.md' }, placedAgents: {},
      pendingPushes: [awaiting('rules/fe/my-rule.md')],
    };

    expect(await prunePlacementRecords(repoPath, state, { verifyBranches: false })).toBe(false);
    expect(mockRemoteBranchExists).not.toHaveBeenCalled();
  });
});
