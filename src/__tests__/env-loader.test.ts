import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { EnvHandler } from '../resources/env.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(), persist: vi.fn() },
}));

/**
 * A process started in a directory gets the team env of the scope that governs
 * that directory (#1018). Observed the way a member's tools observe it: through
 * a real shell started there, under a sandboxed HOME.
 */
const hasShell = (shell: string): boolean => spawnSync(shell, ['-c', 'true']).status === 0;

describe('team env by directory (#1018)', () => {
  let tmpDir: string;
  let homeDir: string;
  let teamConfig: TeamaiConfig;
  const handler = new EnvHandler();

  beforeEach(async () => {
    tmpDir = fs.realpathSync(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-env-loader-')));
    homeDir = path.join(tmpDir, 'home');
    await fse.ensureDir(path.join(homeDir, '.teamai'));
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('ZDOTDIR', '');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.example.com/team/repo.git',
      provider: 'git',
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {},
    } as TeamaiConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fse.remove(tmpDir);
  });

  /** A project-scope install in its own git checkout, as `teamai init` leaves it. */
  const project = async (name: string): Promise<LocalConfig> => {
    const root = path.join(tmpDir, 'work', name);
    await fse.ensureDir(root);
    execFileSync('git', ['init', '-q', root]);
    return {
      repo: { localPath: path.join(tmpDir, 'team-repo'), remote: teamConfig.repo },
      username: 'member',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'project',
      projectRoot: root,
      dataHome: path.join(homeDir, '.teamai', 'projects', name),
    } as LocalConfig;
  };

  /** What `printenv key` prints in a non-interactive shell started in `dir`, as a tool runs a command there. */
  const shellSees = (shell: string, dir: string, key: string, inherited: NodeJS.ProcessEnv = {}): string => {
    const env: NodeJS.ProcessEnv = { HOME: homeDir, PATH: process.env.PATH, SHELL: shell, ...inherited };
    const run = spawnSync(shell, ['-c', `printenv ${key} || true`], { cwd: dir, env, encoding: 'utf-8' });
    return run.stdout.trim();
  };

  /**
   * Every zsh, and every bash a terminal starts, runs the loader: a script's
   * output or its exit status must not change because of it, and it must not
   * add a noticeable cost to each command a tool runs.
   */
  describe('cost to every shell', () => {
    const runs = (shell: string, args: string[], dir: string) => {
      // A sandboxed tool (Codex's read-only sandbox) cannot create temp files:
      // the shells' here-document files go to these.
      const unwritable = path.join(tmpDir, 'no-such-dir');
      const env: NodeJS.ProcessEnv = {
        HOME: homeDir, PATH: process.env.PATH, SHELL: shell, BASH_ENV: path.join(homeDir, '.teamai', 'env-loader.sh'),
        TMPDIR: unwritable, TMPPREFIX: path.join(unwritable, 'zsh'),
      };
      const started = process.hrtime.bigint();
      // stdin from /dev/null: Debian's bash reads /etc/bash.bashrc and ~/.bashrc when
      // stdin is a socket (it takes the caller for sshd), and Node's pipes are sockets.
      const run = spawnSync(shell, args, { cwd: dir, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { ...run, ms: Number(process.hrtime.bigint() - started) / 1e6 };
    };

    it.each(['zsh', 'bash'].filter(hasShell))('%s prints nothing and fails nothing, even with nounset or no writable temp dir, in a project and outside one', async (shell) => {
      vi.stubEnv('SHELL', `/bin/${shell}`);
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

      for (const dir of [a.projectRoot ?? '', tmpDir]) {
        const run = runs(shell, ['-u', '-c', 'true'], dir);
        expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: '', stderr: '' });
      }
    });

    it.skipIf(!hasShell('zsh'))('adds little to a zsh -c started in a project', async () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      const median = (dir: string): number => {
        const times = Array.from({ length: 7 }, () => runs('zsh', ['-c', 'true'], dir).ms).sort((x, y) => x - y);
        return times[3];
      };
      const without = median(a.projectRoot ?? '');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

      expect(median(a.projectRoot ?? '') - without).toBeLessThan(100);
    });
  });

  describe('upgrading a profile an older version wrote', () => {
    /** A per-scope block as versions before #1018 wrote it. */
    const oldBlock = (envSh: string): string =>
      `# [teamai:env:start]\n# DO NOT EDIT: This section is auto-managed by teamai\n[ -f '${envSh}' ] && source '${envSh}'\n# [teamai:env:end]`;
    const blocksIn = async (file: string): Promise<number> =>
      ((await fse.readFile(file, 'utf-8').catch(() => '')).match(/# \[teamai:env:start\]/g) ?? []).length;

    it('replaces the user and project blocks in every profile file with the one loader block', async () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      const zshrc = path.join(homeDir, '.zshrc');
      await fse.writeFile(zshrc, [
        'alias ll="ls -l"',
        oldBlock(path.join(homeDir, '.teamai', 'env.sh')),
        oldBlock(path.join(a.dataHome ?? '', 'env.sh')),
        'export EDITOR=vim',
        '',
      ].join('\n\n'));

      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

      expect(await blocksIn(zshrc)).toBe(0);
      expect(await fse.readFile(zshrc, 'utf-8')).toContain('alias ll="ls -l"');
      expect(await fse.readFile(zshrc, 'utf-8')).toContain('export EDITOR=vim');
      expect(await blocksIn(path.join(homeDir, '.zshenv'))).toBe(1);
    });

    it('takes the user block out when the first pull after the upgrade is a project that ships no env', async () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const a = await project('a');
      const userEnvSh = path.join(homeDir, '.teamai', 'env.sh');
      await fse.writeFile(userEnvSh, "export USER_ONLY='u'\n");
      const zshrc = path.join(homeDir, '.zshrc');
      await fse.writeFile(zshrc, `${oldBlock(userEnvSh)}\n`);

      await handler.writeResolvedEnv([], teamConfig, a);

      expect(await blocksIn(zshrc)).toBe(0);
      expect(await blocksIn(path.join(homeDir, '.zshenv'))).toBe(1);
    });

    it('says once that user env no longer loads in projects when the profile had both kinds of block', async () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const { log } = await import('../utils/logger.js');
      const a = await project('a');
      await fse.writeFile(path.join(homeDir, '.zshrc'), [
        oldBlock(path.join(homeDir, '.teamai', 'env.sh')),
        oldBlock(path.join(a.dataHome ?? '', 'env.sh')),
      ].join('\n\n'));

      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

      const notices = vi.mocked(log.info).mock.calls.filter(([message]) => String(message).includes('inheritUserScope'));
      expect(notices).toHaveLength(1);
      // The session-start pull is silent: debug.log keeps the notice.
      expect(vi.mocked(log.persist).mock.calls.filter(([message]) => String(message).includes('inheritUserScope'))).toHaveLength(1);
    });
  });

  describe.skipIf(!hasShell('zsh'))('zsh', () => {
    beforeEach(() => { vi.stubEnv('SHELL', '/bin/zsh'); });

    it('gives a shell started in each project that project\'s env, whichever pulled last', async () => {
      const a = await project('a');
      const b = await project('b');

      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);

      expect(shellSees('zsh', a.projectRoot ?? '', 'MARKER')).toBe('from-a');
      expect(shellSees('zsh', b.projectRoot ?? '', 'MARKER')).toBe('from-b');
    });

    it('gives a zsh -c started with ZDOTDIR set its own directory\'s env, when ~/.zshenv is what sets ZDOTDIR', async () => {
      const zdotdir = path.join(homeDir, '.config', 'zsh');
      await fse.ensureDir(zdotdir);
      await fse.writeFile(path.join(homeDir, '.zshenv'), `export ZDOTDIR='${zdotdir}'\n`);
      vi.stubEnv('ZDOTDIR', zdotdir);
      const a = await project('a');
      const b = await project('b');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);
      const inA = JSON.parse(spawnSync('zsh', ['-c', `'${process.execPath}' -e 'process.stdout.write(JSON.stringify(process.env))'`], {
        cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh', ZDOTDIR: zdotdir }, encoding: 'utf-8',
      }).stdout) as NodeJS.ProcessEnv;

      expect(shellSees('zsh', b.projectRoot ?? '', 'MARKER', inA)).toBe('from-b');
    });

    it('gives a bash -c that a zsh starts in another project that project\'s env', async () => {
      const a = await project('a');
      const b = await project('b');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);

      const env: NodeJS.ProcessEnv = { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh' };
      const run = spawnSync('zsh', ['-c', `printenv MARKER; cd '${b.projectRoot}' && bash -c 'printenv MARKER'`], {
        cwd: a.projectRoot, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      });

      expect(run.stdout.trim().split('\n')).toEqual(['from-a', 'from-b']);
    });

    it('switches env on cd in an interactive shell and puts back the member\'s own value on the way out', async () => {
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);
      const elsewhere = path.join(tmpDir, 'elsewhere');
      await fse.ensureDir(elsewhere);

      const env: NodeJS.ProcessEnv = { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh', SHARED: 'mine' };
      const terminal = spawnSync('zsh', ['-i', '-c', `printenv SHARED; cd '${a.projectRoot}'; printenv SHARED; cd '${elsewhere}'; printenv SHARED`], {
        cwd: elsewhere, env, encoding: 'utf-8',
      });

      expect(terminal.stdout.trim().split('\n')).toEqual(['mine', 'project', 'mine']);
    });

    it('resolves the project whatever the member\'s cd prints or which CDPATH it follows', async () => {
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      // A cd hook that prints, as `ls` on chpwd or zoxide's echo do.
      await fse.writeFile(path.join(homeDir, '.zshrc'), 'chpwd() { echo "now in $PWD"; }\n');
      const elsewhere = path.join(tmpDir, 'elsewhere');
      await fse.ensureDir(elsewhere);

      const env: NodeJS.ProcessEnv = { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/zsh', CDPATH: '.' };
      const terminal = spawnSync('zsh', ['-i', '-c', `cd '${a.projectRoot}' >/dev/null; printenv MARKER`], {
        cwd: elsewhere, env, encoding: 'utf-8',
      });

      expect(terminal.stdout.trim()).toBe('from-a');
    });

    it('gives a linked worktree its project\'s env before the worktree has pulled', async () => {
      const a = await project('a');
      const root = a.projectRoot ?? '';
      execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
      const worktree = path.join(tmpDir, 'work', 'a-feature');
      execFileSync('git', ['-C', root, 'worktree', 'add', '-q', worktree]);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);

      expect(shellSees('zsh', path.join(worktree), 'MARKER')).toBe('from-a');
    });

    describe('with a user scope', () => {
      const userScope = (): LocalConfig => ({
        repo: { localPath: path.join(tmpDir, 'team-repo'), remote: teamConfig.repo },
        username: 'member',
        updatePolicy: 'auto',
        additionalRoles: [],
        scope: 'user',
      } as LocalConfig);

      beforeEach(async () => {
        await handler.writeResolvedEnv([{ key: 'SHARED', value: 'user' }, { key: 'USER_ONLY', value: 'u' }], teamConfig, userScope());
      });

      it('gives a directory no project governs the user scope\'s env, and a project none of it', async () => {
        const a = await project('a');
        await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);
        const elsewhere = path.join(tmpDir, 'elsewhere');
        await fse.ensureDir(elsewhere);

        expect(shellSees('zsh', elsewhere, 'USER_ONLY')).toBe('u');
        expect(shellSees('zsh', a.projectRoot ?? '', 'USER_ONLY')).toBe('');
        expect(shellSees('zsh', a.projectRoot ?? '', 'SHARED')).toBe('project');
      });

      it('puts the user scope\'s variables under a project that inherits it, the project winning a shared key', async () => {
        const a = { ...await project('a'), inheritUserScope: true };
        await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);

        expect(shellSees('zsh', a.projectRoot ?? '', 'USER_ONLY')).toBe('u');
        expect(shellSees('zsh', a.projectRoot ?? '', 'SHARED')).toBe('project');
      });

      it('loads nothing in a project whose team opted out of shell-profile injection', async () => {
        const c = await project('c');
        await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-c' }], {
          ...teamConfig, sharing: { ...teamConfig.sharing, env: { injectShellProfile: false } },
        } as TeamaiConfig, c);

        expect(shellSees('zsh', c.projectRoot ?? '', 'MARKER')).toBe('');
        expect(shellSees('zsh', c.projectRoot ?? '', 'USER_ONLY')).toBe('');
      });

      it('loads nothing in a project whose team ships no env', async () => {
        const a = await project('a');
        await handler.writeResolvedEnv([], teamConfig, a);

        expect(shellSees('zsh', a.projectRoot ?? '', 'USER_ONLY')).toBe('');
      });
    });
  });

  it.each(['zsh', 'bash'].filter(hasShell))('gives a %s started from a shell in the same directory the env a later pull wrote', async (shell) => {
    vi.stubEnv('SHELL', `/bin/${shell}`);
    const a = await project('a');
    await handler.writeResolvedEnv([{ key: 'MARKER', value: 'old' }, { key: 'DROPPED', value: 'x' }], teamConfig, a);
    const loader = path.join(homeDir, '.teamai', 'env-loader.sh');
    const parent = JSON.parse(spawnSync(shell, ['-c', `'${process.execPath}' -e 'process.stdout.write(JSON.stringify(process.env))'`], {
      cwd: a.projectRoot, env: { HOME: homeDir, PATH: process.env.PATH, SHELL: `/bin/${shell}`, BASH_ENV: loader }, encoding: 'utf-8',
    }).stdout) as NodeJS.ProcessEnv;
    expect(parent.MARKER).toBe('old');

    await handler.writeResolvedEnv([{ key: 'MARKER', value: 'new' }], teamConfig, a);

    expect(shellSees(shell, a.projectRoot ?? '', 'MARKER', parent)).toBe('new');
    expect(shellSees(shell, a.projectRoot ?? '', 'DROPPED', parent)).toBe('');
  });

  describe.skipIf(!hasShell('bash'))('bash', () => {
    beforeEach(() => { vi.stubEnv('SHELL', '/bin/bash'); });

    it('gives the terminal and every bash -c it starts the env of their own directory', async () => {
      const a = await project('a');
      const b = await project('b');
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-a' }], teamConfig, a);
      await handler.writeResolvedEnv([{ key: 'MARKER', value: 'from-b' }], teamConfig, b);

      const env: NodeJS.ProcessEnv = { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash' };
      const terminal = spawnSync('bash', ['-i', '-c', `printenv MARKER; cd '${b.projectRoot}' && bash -c 'printenv MARKER'`], {
        cwd: a.projectRoot, env, encoding: 'utf-8',
      });

      expect(terminal.stdout.trim().split('\n')).toEqual(['from-a', 'from-b']);
    });

    it('switches env at the prompt after cd and keeps the member\'s PROMPT_COMMAND', async () => {
      const a = await project('a');
      await handler.writeResolvedEnv([{ key: 'SHARED', value: 'project' }], teamConfig, a);
      const elsewhere = path.join(tmpDir, 'elsewhere');
      await fse.ensureDir(elsewhere);

      const env: NodeJS.ProcessEnv = {
        HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash', SHARED: 'mine', PROMPT_COMMAND: 'echo kept',
      };
      const terminal = spawnSync('bash', ['-i'], {
        cwd: elsewhere, env, encoding: 'utf-8',
        input: `cd '${a.projectRoot}'\nprintenv SHARED\ncd '${elsewhere}'\nprintenv SHARED\nexit\n`,
      });

      expect(terminal.stdout.trim().split('\n').filter((line) => line !== 'kept')).toEqual(['project', 'mine']);
      expect(terminal.stdout).toContain('kept');
    });
  });
});
