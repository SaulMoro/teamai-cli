import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGit, gitBinary } from '../utils/git.js';

describe('gitBinary', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-binary-')));
    dirs.push(dir);
    return dir;
  }

  /** A dir holding a `git` file, executable unless said otherwise. */
  function gitDir(mode = 0o755): string {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'git'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(dir, 'git'), mode);
    return dir;
  }

  const onPath = (...entries: string[]) => entries.join(path.delimiter);

  it('resolves the first executable git in PATH order', () => {
    const empty = tempDir();
    const first = gitDir();
    const second = gitDir();
    expect(gitBinary({ pathEnv: onPath(empty, first, second), platform: 'darwin' }))
      .toBe(path.join(first, 'git'));
  });

  it('looks PATH up again when it changes', () => {
    const a = gitDir();
    const b = gitDir();
    expect(gitBinary({ pathEnv: onPath(a, b), platform: 'darwin' })).toBe(path.join(a, 'git'));
    expect(gitBinary({ pathEnv: onPath(b, a), platform: 'darwin' })).toBe(path.join(b, 'git'));
  });

  it('falls back to the bare name when git is not on PATH', () => {
    expect(gitBinary({ pathEnv: onPath(tempDir()), platform: 'darwin' })).toBe('git');
  });

  it('falls back to the bare name when an earlier git is not executable, so the spawn fails as it does today', () => {
    expect(gitBinary({ pathEnv: onPath(gitDir(0o644), gitDir()), platform: 'darwin' })).toBe('git');
  });

  it('falls back to the bare name when PATH has an entry a spawn resolves against its cwd', () => {
    const later = gitDir();
    expect(gitBinary({ pathEnv: onPath('', later), platform: 'darwin' })).toBe('git');
    expect(gitBinary({ pathEnv: onPath('bin', later), platform: 'darwin' })).toBe('git');
  });

  it('falls back to the bare name for a path simple-git refuses as its binary', () => {
    const spaced = path.join(tempDir(), 'with space');
    fs.mkdirSync(spaced);
    fs.writeFileSync(path.join(spaced, 'git'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(spaced, 'git'), 0o755);
    expect(gitBinary({ pathEnv: onPath(spaced), platform: 'darwin' })).toBe('git');
  });

  it('keeps the bare name on win32, where the OS resolves it', () => {
    expect(gitBinary({ pathEnv: onPath(gitDir()), platform: 'win32' })).toBe('git');
  });

  it('runs git through createGit with the resolved binary', async () => {
    const repo = tempDir();
    await createGit(repo).init();
    expect(fs.realpathSync((await createGit(repo).revparse(['--show-toplevel'])).trim())).toBe(repo);
  });
});
