import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { claudeProjectDirName, scanFiles } from './fs.js';

describe('claudeProjectDirName carried as its source', () => {
  // A fake Claude Code written as a script runs `String(claudeProjectDirName)` with nothing of this module around it.
  const copied = (cwd: string): unknown => vm.runInNewContext(`(${String(claudeProjectDirName)})(cwd)`, { cwd });

  it.each([
    ['a short cwd', '/home/user/project'],
    ['a cwd with spaces', '/Users/foo/my project'],
    ['a cwd over 200 characters, which is cut and hashed', `/home/user/${'deep/'.repeat(50)}project`],
  ])('names the project of %s as the module does', (_, cwd) => {
    expect(copied(cwd)).toBe(claudeProjectDirName(cwd));
  });
});

describe.skipIf(process.platform === 'win32')('scanFiles over a store with a folder it cannot read', () => {
  const store = (): { root: string; kept: string; foreign: string; done: () => void } => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-scan-files-')));
    const kept = path.join(root, '2026', '11', '13', 'rollout-a.jsonl');
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.writeFileSync(kept, '{}\n');
    // A folder another user left in the store, which this one can write and not list.
    const foreign = path.join(root, '0000');
    fs.mkdirSync(foreign);
    fs.chmodSync(foreign, 0o300);

    return {
      root, kept, foreign,
      done: () => {
        fs.chmodSync(root, 0o700);
        fs.chmodSync(foreign, 0o700);
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  };

  it('finds the files in the folders it can read, and skips the one it cannot', () => {
    const { root, kept, done } = store();

    try {
      expect(scanFiles(root, /\.jsonl$/)).toEqual([kept]);
    } finally {
      done();
    }
  });

  it('still fails on a store it cannot list at all, so its caller can say which folder', () => {
    const { root, done } = store();
    fs.chmodSync(root, 0o300);

    try {
      expect(() => scanFiles(root, /\.jsonl$/)).toThrow(/EACCES/);
    } finally {
      done();
    }
  });
});
