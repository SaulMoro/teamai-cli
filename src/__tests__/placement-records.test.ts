import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

const mockWarn = vi.fn();
vi.mock('../utils/logger.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: (...args: unknown[]) => mockWarn(...args), error: vi.fn(), success: vi.fn() },
}));
const mockRemoteBranchExists = vi.fn();
vi.mock('../utils/git.js', async () => ({
  ...(await vi.importActual<typeof import('../utils/git.js')>('../utils/git.js')),
  remoteBranchExists: (...args: unknown[]) => mockRemoteBranchExists(...args),
}));
import { execFileSync } from 'node:child_process';

import { reconcilePlacementRecords, isPlacement } from '../utils/pending-push.js';
import type { PendingPush, ResourceItem } from '../types.js';

/**
 * A placement record says "the author's root copy of <name> IS the team file
 * at <root>/<ns>/<name>". Push marks the placement on the pending PR entry;
 * only once that file is on the default branch does it become a record — so a
 * PR closed unmerged, branch kept or not, never leaves one behind, and no
 * provider has to be asked whether a PR is open. A record is withdrawn again
 * when its file is gone, or when a shared-root file of the same name appears
 * and takes over the root path in every tool directory (#649 review).
 */
describe('reconcilePlacementRecords', () => {
  let repoPath: string;
  const pending = (items: PendingPush['items'], branch = 'teamai/push/me/1'): PendingPush => ({
    branch, prUrl: null, createdAt: '2026-01-01T00:00:00.000Z', items,
  });
  const placedRule = { type: 'rules', name: 'my-rule', relativePath: 'rules/fe/my-rule.md', namespace: 'fe', placed: true };

  beforeEach(async () => {
    repoPath = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-placed-'));
    mockRemoteBranchExists.mockReset();
    mockWarn.mockReset();
  });
  afterEach(async () => { await fse.remove(repoPath); });

  it('records a placement once its file is on the default branch', async () => {
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'x');
    const state = { placedRules: {}, placedAgents: {}, pendingPushes: [pending([placedRule])] };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });
  });

  it('records nothing while the placement is not on the default branch, whatever its branch is doing', async () => {
    // Open PR, or closed unmerged with the branch kept: the same from here,
    // and neither may leave a record.
    const state = { placedRules: {}, placedAgents: {}, pendingPushes: [pending([placedRule])] };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(false);
    expect(state.placedRules).toEqual({});
    expect(mockRemoteBranchExists).not.toHaveBeenCalled();
  });

  it('records a placement only when the blob it pushed is in the default branch history for that path', async () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
    } }).trim();
    git(['init', '-q', '-b', 'main']);
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'ours, as pushed\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'merge ours']);
    const ours = git(['hash-object', 'rules/fe/my-rule.md']);
    // A teammate edits it afterwards: the path still exists, the blob differs now.
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'edited after the merge\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'teammate edit']);
    await fse.outputFile(path.join(repoPath, 'never-committed.md'), 'never pushed anywhere\n');
    const theirs = git(['hash-object', 'never-committed.md']);

    const landed = { placedRules: {}, placedAgents: {}, pendingPushes: [pending([{ ...placedRule, blob: ours }])] };
    expect(await reconcilePlacementRecords(repoPath, landed)).toBe(true);
    expect(landed.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });

    // Same path, but what is there was never what we pushed: somebody else's file.
    const shadow = { placedRules: {}, placedAgents: {}, pendingPushes: [pending([{ ...placedRule, blob: theirs }])] };
    expect(await reconcilePlacementRecords(repoPath, shadow)).toBe(false);
    expect(shadow.placedRules).toEqual({});
  });

  it('does not record a pending item that was not a placement', async () => {
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'x');
    const state = { placedRules: {}, placedAgents: {}, pendingPushes: [pending([{ ...placedRule, placed: undefined }])] };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(false);
    expect(state.placedRules).toEqual({});
  });

  it('keeps a record whose file is on the default branch', async () => {
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'x');
    const state = { placedRules: { 'my-rule': 'rules/fe/my-rule.md' }, placedAgents: {}, pendingPushes: [] };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(false);
    expect(state.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });
  });

  it('drops every record whose file the team has deleted, not just the last one', async () => {
    // Deleting by destructuring from the ORIGINAL map put back what an earlier
    // iteration had removed, so only the last stale record actually went.
    await fse.outputFile(path.join(repoPath, 'rules/fe/kept.md'), 'x');
    const state = {
      placedRules: { gone1: 'rules/fe/gone1.md', kept: 'rules/fe/kept.md', gone2: 'rules/fe/gone2.md' },
      placedAgents: { vr: 'agents/fe/vr.yaml', qa: 'agents/fe/qa.yaml' },
      pendingPushes: [],
    };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placedRules).toEqual({ kept: 'rules/fe/kept.md' });
    expect(state.placedAgents).toEqual({});
  });

  it('withdraws a record once a shared-root file of the same name exists, and says so', async () => {
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'the author\'s');
    await fse.outputFile(path.join(repoPath, 'rules/my-rule.md'), 'somebody else\'s, for everyone');
    const state = { placedRules: { 'my-rule': 'rules/fe/my-rule.md' }, placedAgents: {}, pendingPushes: [] };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placedRules).toEqual({});
    expect(mockWarn.mock.calls.flat().join(' ')).toContain('rules/my-rule.md now exists at the shared root');
  });

  it('withdraws an agent record shadowed by a legacy shared-root .md of the same stem', async () => {
    await fse.outputFile(path.join(repoPath, 'agents/fe/vr.yaml'), 'name: vr\n');
    await fse.outputFile(path.join(repoPath, 'agents/vr.md'), '# vr\n');
    const state = { placedRules: {}, placedAgents: { vr: 'agents/fe/vr.yaml' }, pendingPushes: [] };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placedAgents).toEqual({});
  });

  it('does not record a landed placement that a shared-root file already shadows', async () => {
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'x');
    await fse.outputFile(path.join(repoPath, 'rules/my-rule.md'), 'y');
    const state = { placedRules: {}, placedAgents: {}, pendingPushes: [pending([placedRule])] };

    await reconcilePlacementRecords(repoPath, state);

    expect(state.placedRules).toEqual({});
  });
});

describe('isPlacement', () => {
  const base = { sourcePath: '/tmp/x', status: 'new' as const };
  it('is a new root rule or agent that ended up namespaced', () => {
    expect(isPlacement({ ...base, type: 'rules', name: 'my-rule', relativePath: 'rules/fe/my-rule.md', namespace: 'fe' })).toBe(true);
    expect(isPlacement({ ...base, type: 'agents', name: 'vr', relativePath: 'agents/fe/vr.yaml', namespace: 'fe' })).toBe(true);
  });
  it('is not a rule the scanner found in a subdirectory, a modified item, a skill, or an unplaced one', () => {
    expect(isPlacement({ ...base, type: 'rules', name: 'fe/my-rule', relativePath: 'rules/fe/my-rule.md', namespace: 'fe' })).toBe(false);
    expect(isPlacement({ ...base, type: 'agents', name: 'vr', relativePath: 'agents/fe/vr.yaml', namespace: 'fe', status: 'modified' })).toBe(false);
    expect(isPlacement({ ...base, type: 'skills', name: 's', relativePath: 'skills/fe/s', namespace: 'fe' })).toBe(false);
    expect(isPlacement({ ...base, type: 'rules', name: 'my-rule', relativePath: 'rules/my-rule.md' })).toBe(false);
  });
  it('is an agent rewritten under another extension through its record', () => {
    const item: ResourceItem & { supersedes: string } = {
      ...base, type: 'agents', name: 'vr', relativePath: 'agents/fe/vr.yaml', namespace: 'fe',
      status: 'modified', supersedes: 'agents/fe/vr.md',
    };
    expect(isPlacement(item)).toBe(true);
  });
});
