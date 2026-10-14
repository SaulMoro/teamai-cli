import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitFindsNoRepository, linkedWorktreesStamp } from '../utils/git-discovery.js';

describe('gitFindsNoRepository', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-discovery-')));
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) vi.stubEnv(name, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** What git itself answers in `dir`. */
  function gitFindsRepository(dir: string): boolean {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  it('agrees with git outside any checkout', async () => {
    const dir = path.join(root, 'a', 'b');
    fs.mkdirSync(dir, { recursive: true });

    // True wherever the temp dir is outside every repository, as on CI.
    expect(await gitFindsNoRepository(dir)).toBe(!gitFindsRepository(dir));
  });

  it('is false in a checkout and below it', async () => {
    const dir = path.join(root, 'repo', 'sub');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'repo') });

    expect(await gitFindsNoRepository(dir)).toBe(false);
  });

  it('is false in a linked worktree, whose .git is a file', async () => {
    const dir = path.join(root, 'wt');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');

    expect(await gitFindsNoRepository(dir)).toBe(false);
  });

  it('is false in a bare repository and inside a git directory', async () => {
    const bare = path.join(root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);

    expect(await gitFindsNoRepository(bare)).toBe(false);
    expect(await gitFindsNoRepository(path.join(bare, 'refs', 'heads'))).toBe(false);
  });

  it('is false when the environment names a repository', async () => {
    vi.stubEnv('GIT_DIR', path.join(root, 'elsewhere.git'));

    expect(await gitFindsNoRepository(root)).toBe(false);
  });
});

describe('linkedWorktreesStamp', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-worktrees-stamp-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, stdio: 'ignore' });
  };

  it('stays equal while nothing changes, and changes with a lock and a prune', async () => {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'commit', '--allow-empty', '-q', '-m', 'init');
    const commonDir = path.join(repo, '.git');
    const wt = path.join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, 'HEAD');

    const added = await linkedWorktreesStamp(commonDir);
    expect(await linkedWorktreesStamp(commonDir)).toBe(added);

    git(repo, 'worktree', 'lock', wt);
    const locked = await linkedWorktreesStamp(commonDir);
    expect(locked).not.toBe(added);

    git(repo, 'worktree', 'unlock', wt);
    fs.rmSync(wt, { recursive: true, force: true });
    const deleted = await linkedWorktreesStamp(commonDir);
    git(repo, 'worktree', 'prune');
    expect(await linkedWorktreesStamp(commonDir)).not.toBe(deleted);
  });
});
