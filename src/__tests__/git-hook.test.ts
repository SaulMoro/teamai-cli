import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describeMissingGitHook, gitHookStatus, guardedGitHookLine, installGitHook } from '../git-hook.js';

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

describe('teamai hook script on a Git without config hooks', () => {
  let sandbox: string;
  let repo: string;
  let home: string;
  let saved: { PATH?: string; HOME?: string };

  const run = (args: string[], cwd = repo) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  const hookFile = (event: string) => path.join(repo, '.git', 'hooks', event);
  const calls = () => {
    const file = path.join(sandbox, 'calls.txt');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
  };

  beforeEach(() => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-hook-old-')));
    repo = path.join(sandbox, 'repo');
    home = path.join(sandbox, 'home');
    fs.mkdirSync(repo);
    fs.mkdirSync(home);
    // Old Git, simulated where teamai reads the version: a `git` on PATH that
    // reports 2.39 and hands every other command to the real one.
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const shim = path.join(sandbox, 'old-git');
    fs.mkdirSync(shim);
    fs.writeFileSync(
      path.join(shim, 'git'),
      `#!/bin/sh\nif [ "$1" = --version ]; then echo "git version 2.39.5"; exit 0; fi\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    saved = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = `${shim}${path.delimiter}${process.env.PATH}`;
    process.env.HOME = home;
    run(['init', '-q', '-b', 'main']);
    run(['commit', '-q', '--allow-empty', '-m', 'init']);
  });

  afterEach(() => {
    process.env.PATH = saved.PATH;
    process.env.HOME = saved.HOME;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const fakeTeamai = () => {
    fs.mkdirSync(path.join(home, '.teamai', 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.teamai', 'bin', 'teamai'),
      `#!/bin/sh\necho "$@" >> "${path.join(sandbox, 'calls.txt')}"\necho noise\nexit 3\n`,
      { mode: 0o755 },
    );
  };

  it('adds a marked block to an existing hook script without changing its other lines', async () => {
    const original = '#!/bin/sh\n# the team\'s own hook\necho mine >> "$0.log"\n';
    fs.writeFileSync(hookFile('post-checkout'), original, { mode: 0o755 });

    expect(await installGitHook(repo)).toEqual({ installed: true, changed: true });
    const text = fs.readFileSync(hookFile('post-checkout'), 'utf8');
    const block = /# >>> teamai[^\n]*\n[\s\S]*?# <<< teamai[^\n]*\n/.exec(text);
    expect(block).not.toBeNull();
    expect(text.replace(block![0], '')).toBe(original);
    // A second run leaves it alone.
    expect(await installGitHook(repo)).toEqual({ installed: true, changed: false });
    expect(fs.readFileSync(hookFile('post-checkout'), 'utf8')).toBe(text);
    // post-merge had no script: a new executable one.
    expect(fs.statSync(hookFile('post-merge')).mode & 0o111).not.toBe(0);
    expect(await gitHookStatus(repo)).toEqual({ installed: true });
  });

  it('runs the dispatcher with Git\'s arguments, silently, keeping the script\'s own work and exit status', async () => {
    fs.writeFileSync(hookFile('post-checkout'), '#!/bin/sh\necho mine >> "$0.log"\n', { mode: 0o755 });
    await installGitHook(repo);
    fakeTeamai();

    const r = run(['worktree', 'add', '-q', path.join(sandbox, 'wt')]);

    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatch(/^hook-dispatch post-checkout --tool git 0+ [0-9a-f]{40} 1$/);
    expect(fs.readFileSync(`${hookFile('post-checkout')}.log`, 'utf8')).toBe('mine\n');
  });

  it('leaves a core.hooksPath manager\'s files alone, and doctor advises upgrading or a guarded line', async () => {
    const managed = path.join(sandbox, 'managed');
    fs.mkdirSync(managed);
    fs.writeFileSync(path.join(managed, 'post-checkout'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    run(['config', 'core.hooksPath', managed]);

    expect(await installGitHook(repo)).toEqual({ installed: false, reason: 'hooks-path' });
    expect(fs.readdirSync(managed)).toEqual(['post-checkout']);
    expect(fs.readFileSync(path.join(managed, 'post-checkout'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect(fs.existsSync(hookFile('post-checkout'))).toBe(false);

    const status = await gitHookStatus(repo);
    expect(status).toMatchObject({ installed: false, reason: 'hooks-path' });
    const advice = describeMissingGitHook(status as Exclude<typeof status, { installed: true }>);
    const upgrade = advice.indexOf('Upgrade Git');
    const guarded = advice.indexOf('command -v teamai >/dev/null 2>&1 && teamai hook-dispatch post-checkout --tool git "$@"');
    expect(upgrade).toBeGreaterThan(-1);
    expect(guarded).toBeGreaterThan(upgrade);
    expect(advice).toContain('teamai hook-dispatch post-merge --tool git "$@"');
    expect(advice).toContain('sh -c');
  });

  it('the guarded line does nothing and exits 0 without teamai', () => {
    const line = guardedGitHookLine('post-checkout');
    const r = spawnSync('/bin/sh', ['-c', line, 'post-checkout', '0', '1', '1'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: home },
    });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
  });
});
