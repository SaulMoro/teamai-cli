import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installGitHook } from '../git-hook.js';

const gitVersion = (): [number, number] => {
  const m = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' }));
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};
const [major, minor] = gitVersion();
const configHooks = major > 2 || (major === 2 && minor >= 54);

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

describe.skipIf(!configHooks)('teamai git hook in the repository config', () => {
  let sandbox: string;
  let repo: string;
  let home: string;

  const git = (args: string[], cwd = repo) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, HOME: home } });

  /** A `teamai` on the wrapper path that records its arguments, then exits with `code`. */
  const fakeTeamai = (code: number) => {
    const bin = path.join(home, '.teamai', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'teamai'),
      `#!/bin/sh\necho "$@" >> "${path.join(sandbox, 'calls.txt')}"\necho noise\necho noise >&2\nexit ${code}\n`,
      { mode: 0o755 },
    );
  };
  const calls = () => {
    const file = path.join(sandbox, 'calls.txt');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
  };

  beforeEach(() => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-hook-')));
    repo = path.join(sandbox, 'repo');
    home = path.join(sandbox, 'home');
    fs.mkdirSync(repo);
    fs.mkdirSync(home);
    git(['init', '-q', '-b', 'main']);
    git(['commit', '-q', '--allow-empty', '-m', 'init']);
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('registers one named hook per event, shared by every worktree', async () => {
    await installGitHook(repo);

    expect(git(['hook', 'list', 'post-checkout']).stdout.trim()).toBe('teamai-post-checkout');
    expect(git(['hook', 'list', 'post-merge']).stdout.trim()).toBe('teamai-post-merge');
    // Written to the common config: a linked worktree sees the same hooks.
    git(['worktree', 'add', '-q', path.join(sandbox, 'wt')]);
    expect(git(['hook', 'list', 'post-checkout'], path.join(sandbox, 'wt')).stdout.trim()).toBe('teamai-post-checkout');
  });

  it('is idempotent', async () => {
    await installGitHook(repo);
    await installGitHook(repo);

    expect(git(['config', '--local', '--get-all', 'hook.teamai-post-checkout.event']).stdout.trim()).toBe('post-checkout');
    expect(git(['config', '--local', '--get-all', 'hook.teamai-post-merge.event']).stdout.trim()).toBe('post-merge');
  });

  it('passes the event and Git\'s arguments to the dispatcher, silently', async () => {
    await installGitHook(repo);
    fakeTeamai(0);

    const r = git(['hook', 'run', 'post-checkout', '--', 'old', 'new', '1']);

    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(calls()).toEqual(['hook-dispatch post-checkout --tool git old new 1']);
  });

  it('exits 0 and prints nothing when the dispatcher fails or teamai is missing', async () => {
    await installGitHook(repo);
    fakeTeamai(3);
    const failing = git(['hook', 'run', 'post-merge', '--', '0']);
    expect(failing.status).toBe(0);
    expect(failing.stdout + failing.stderr).toBe('');
    expect(calls()).toEqual(['hook-dispatch post-merge --tool git 0']);

    // Only git on PATH, so no globally installed teamai can answer.
    fs.rmSync(path.join(home, '.teamai'), { recursive: true, force: true });
    const onlyGit = path.join(sandbox, 'only-git');
    fs.mkdirSync(onlyGit);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.symlinkSync(realGit, path.join(onlyGit, 'git'));
    const missing = spawnSync(realGit, ['hook', 'run', 'post-merge', '--', '0'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${onlyGit}:/usr/bin:/bin` },
    });
    expect(missing.status).toBe(0);
    expect(missing.stdout + missing.stderr).toBe('');
  });
});
