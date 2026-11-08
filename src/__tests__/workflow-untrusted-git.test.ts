/**
 * git in a copy a step controlled (`untrustedGit`) starts no program the copy's own config names, whatever command a
 * finishing path runs there, while the programs the member's own config names still run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pushIfOrigin, readMemberConfig, untrustedGit } from '../workflow/worktree.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type Repo = { root: string; dir: string; mark: string; planted: string; passing: string; env: NodeJS.ProcessEnv; git(args: string[]): string };

/**
 * A repository with two commits and `f` changed since, every file routed through filter, diff and merge driver `x`, and
 * two programs a step could plant: `planted`, which fails, and `passing`, which passes its input or file through. Each
 * writes to `mark` when it runs. The member's global config is the file `gitconfig` beside it.
 */
function repo(): Repo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'untrusted-git-'));
  roots.push(root);
  const dir = path.join(root, 'r');
  const mark = path.join(root, 'mark');
  const planted = path.join(root, 'planted');
  const passing = path.join(root, 'passing');
  fs.writeFileSync(planted, `#!/bin/sh\necho planted >> ${JSON.stringify(mark)}\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(passing, `#!/bin/sh\necho passing >> ${JSON.stringify(mark)}\nif [ -f "$1" ]; then cat "$1"; else cat; fi\n`, { mode: 0o755 });
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = Member\n\temail = member@example.com\n');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  const git = (args: string[]): string => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.mkdirSync(dir);
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'f'), 'a\n');
  git(['add', 'f']);
  git(['commit', '-q', '-m', 'first']);
  fs.writeFileSync(path.join(dir, 'f'), 'a\nb\n');
  git(['commit', '-q', '-am', 'second']);
  fs.writeFileSync(path.join(dir, 'f'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '* filter=x diff=x merge=x\n');

  return { root, dir, mark, planted, passing, env, git };
}

const ran = (at: Repo): string => (fs.existsSync(at.mark) ? fs.readFileSync(at.mark, 'utf8') : '');

/** A local server that asks every request to sign in. */
async function askingServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((_request, response) => response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="team"' }).end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');

  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

describe('untrustedGit in a copy a step controlled', () => {
  it.each([
    { program: 'gpg.program', plant: (at: Repo) => [['gpg.program', at.planted]], args: ['commit', '-S', '--allow-empty', '-m', 'signed'] },
    { program: 'gpg.ssh.program', plant: (at: Repo) => [['gpg.format', 'ssh'], ['user.signingKey', 'key::ssh-ed25519 AAAA'], ['gpg.ssh.program', at.planted]], args: ['commit', '-S', '--allow-empty', '-m', 'signed'] },
    { program: 'filter.<driver>.clean', plant: (at: Repo) => [['filter.x.clean', at.passing]], args: ['add', 'f'] },
    { program: 'filter.<driver>.smudge', plant: (at: Repo) => [['filter.x.smudge', at.passing]], args: ['checkout', '--', 'f'] },
    { program: 'filter.<driver>.process', plant: (at: Repo) => [['filter.x.process', at.planted]], args: ['add', 'f'] },
    { program: 'diff.external', plant: (at: Repo) => [['diff.external', at.planted]], args: ['diff'] },
    { program: 'diff.<driver>.command', plant: (at: Repo) => [['diff.x.command', at.planted]], args: ['diff'] },
    { program: 'diff.<driver>.textconv', plant: (at: Repo) => [['diff.x.textconv', at.passing]], args: ['diff'] },
    { program: 'merge.<driver>.driver', plant: (at: Repo) => [['merge.x.driver', at.planted]], args: ['merge', '-q', '--no-edit', 'side'], before: (at: Repo) => {
      at.git(['commit', '-q', '-am', 'third']);
      at.git(['checkout', '-q', '-b', 'side', 'HEAD~1']);
      fs.writeFileSync(path.join(at.dir, 'f'), 'a\nb\nside\n');
      at.git(['commit', '-q', '-am', 'side']);
      at.git(['checkout', '-q', 'main']);
    } },
    { program: 'core.editor', plant: (at: Repo) => [['core.editor', at.planted]], args: ['commit', '--allow-empty'] },
    { program: 'sequence.editor', plant: (at: Repo) => [['sequence.editor', at.planted]], args: ['rebase', '-q', '-i', 'HEAD~1'], before: (at: Repo) => at.git(['commit', '-q', '-am', 'third']) },
    { program: 'core.pager', plant: (at: Repo) => [['core.pager', at.planted]], args: ['-p', 'log', '-1'] },
    { program: 'core.sshCommand', plant: (at: Repo) => [['core.sshCommand', at.planted], ['remote.origin.url', 'ssh://git@127.0.0.1:9/team.git']], args: ['ls-remote', 'origin'] },
    { program: 'remote.<name>.uploadpack', plant: (at: Repo) => [['remote.origin.url', bare(at)], ['remote.origin.uploadpack', at.planted]], args: ['ls-remote', 'origin'], succeeds: true },
    { program: 'remote.<name>.receivepack', plant: (at: Repo) => [['remote.origin.url', bare(at)], ['remote.origin.receivepack', at.planted]], args: ['push', '-q', 'origin', 'HEAD:refs/heads/work'], succeeds: true },
    { program: 'core.gitProxy', plant: (at: Repo) => [['core.gitProxy', at.planted], ['remote.origin.url', 'git://127.0.0.1:9/team.git']], args: ['ls-remote', 'origin'] },
    { program: 'an ext:: remote protocol.ext.allow lets in', plant: (at: Repo) => [['protocol.ext.allow', 'always'], ['remote.origin.url', `ext::${at.planted} %S`]], args: ['ls-remote', 'origin'] },
  ])('does not run the program $program names in the copy\'s config', async ({ plant, args, before, succeeds }) => {
    const at = repo();
    before?.(at);
    for (const [key = '', value = ''] of plant(at)) at.git(['config', '--local', key, value]);

    const result = await untrustedGit(at.env)(at.dir, args);

    expect(ran(at)).toBe('');
    if (succeeds) expect(result.code, result.stderr).toBe(0);
  });

  it('does not run the askpass program the copy\'s config names when origin asks to sign in', async () => {
    const at = repo();
    const server = await askingServer();

    try {
      at.git(['config', '--local', 'core.askPass', at.planted]);
      at.git(['config', '--local', 'remote.origin.url', `${server.url}/team.git`]);

      await untrustedGit(at.env)(at.dir, ['ls-remote', 'origin']);

      expect(ran(at)).toBe('');
    } finally {
      await server.close();
    }
  });

  it('runs the filter the member\'s own config names, and the copy\'s config cannot replace it', async () => {
    const at = repo();
    at.git(['config', '--file', String(at.env.GIT_CONFIG_GLOBAL), 'filter.x.clean', at.passing]);
    at.git(['config', '--local', 'filter.x.clean', at.planted]);

    const added = await untrustedGit(at.env)(at.dir, ['add', 'f']);

    expect(added.code, added.stderr).toBe(0);
    expect(ran(at)).toBe('passing\n');
  });

  it('does not run the filter a submodule\'s config names when git looks into the submodule', async () => {
    const at = repo();
    const sub = path.join(at.root, 'sub');
    execFileSync('git', ['init', '-q', '-b', 'main', sub], { env: at.env });
    fs.writeFileSync(path.join(sub, 'g'), 'g\n');
    execFileSync('git', ['add', 'g'], { cwd: sub, env: at.env });
    execFileSync('git', ['commit', '-q', '-m', 'sub'], { cwd: sub, env: at.env });
    at.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 's']);
    const inner = (args: string[]): string => execFileSync('git', args, { cwd: path.join(at.dir, 's'), env: at.env, encoding: 'utf8' });
    inner(['config', '--local', 'filter.y.clean', at.passing]);
    fs.writeFileSync(path.join(at.git(['-C', 's', 'rev-parse', '--absolute-git-dir']), 'info', 'attributes'), '* filter=y\n');
    // A file whose stat changed and content did not makes git run the clean filter to compare it.
    fs.utimesSync(path.join(at.dir, 's', 'g'), new Date(), new Date(Date.now() + 5000));

    const status = await untrustedGit(at.env)(at.dir, ['status', '--porcelain', '--ignore-submodules=none']);

    expect(status.code, status.stderr).toBe(0);
    expect(ran(at)).toBe('');
  });

  it('runs the programs the member\'s checkout named before the run, and turns off one a step changed or added', async () => {
    const at = repo();
    at.git(['config', '--local', 'filter.x.clean', at.passing]);
    at.git(['config', '--local', 'filter.x.required', 'true']);
    const kept = await readMemberConfig(at.dir);
    if ('error' in kept) throw new Error(kept.error);
    const memberGit = untrustedGit(at.env, undefined, new Set(kept));

    const added = await memberGit(at.dir, ['add', 'f']);

    expect(added.code, added.stderr).toBe(0);
    expect(ran(at)).toBe('passing\n');
    at.git(['config', '--local', 'filter.x.clean', at.planted]);
    at.git(['config', '--local', 'diff.external', at.planted]);
    fs.writeFileSync(path.join(at.dir, 'f'), 'changed\n');

    await memberGit(at.dir, ['add', 'f']);
    await memberGit(at.dir, ['diff', 'HEAD']);

    expect(ran(at)).toBe('passing\n');
  });

  it('pushes to the origin the member\'s checkout named before the run, never to a repository a step pointed origin at, whose hooks never run', async () => {
    const at = repo();
    const origin = bare(at);
    at.git(['remote', 'add', 'origin', origin]);
    const kept = await readMemberConfig(at.dir);
    if ('error' in kept) throw new Error(kept.error);
    const elsewhere = path.join(at.root, 'elsewhere.git');
    execFileSync('git', ['init', '-q', '--bare', elsewhere], { env: at.env });
    fs.writeFileSync(path.join(elsewhere, 'hooks', 'pre-receive'), `#!/bin/sh\necho pre-receive >> ${JSON.stringify(at.mark)}\n`, { mode: 0o755 });
    at.git(['config', '--local', 'remote.origin.url', elsewhere]);
    at.git(['config', '--local', `url.${elsewhere}.insteadOf`, origin]);
    const tip = at.git(['rev-parse', 'HEAD']);

    const pushed = await pushIfOrigin(at.dir, 'main', [tip], untrustedGit(at.env, undefined, new Set(kept)), { kept: new Set(kept), env: at.env });

    expect(pushed).toBe('pushed');
    expect(ran(at)).toBe('');
    expect(execFileSync('git', ['--git-dir', origin, 'rev-parse', 'refs/heads/main'], { env: at.env, encoding: 'utf8' }).trim()).toBe(tip);
  });

  it('pushes to every push URL the member\'s checkout named for origin, none rewritten by a pushInsteadOf, as git push origin does', async () => {
    const at = repo();
    const origin = bare(at);
    const mirror = path.join(at.root, 'mirror.git');
    execFileSync('git', ['init', '-q', '--bare', mirror], { env: at.env });
    at.git(['remote', 'add', 'origin', origin]);
    at.git(['config', 'remote.origin.pushurl', origin]);
    at.git(['config', '--add', 'remote.origin.pushurl', mirror]);
    // git push origin applies no pushInsteadOf to a push URL the remote names.
    at.git(['config', `url.${path.join(at.root, 'nowhere.git')}.pushInsteadOf`, origin]);
    const kept = await readMemberConfig(at.dir);
    if ('error' in kept) throw new Error(kept.error);
    const tip = at.git(['rev-parse', 'HEAD']);

    const pushed = await pushIfOrigin(at.dir, 'main', [tip], untrustedGit(at.env, undefined, new Set(kept)), { kept: new Set(kept), env: at.env });

    expect(pushed).toBe('pushed');

    for (const remote of [origin, mirror]) {
      expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { env: at.env, encoding: 'utf8' }).trim()).toBe(tip);
    }
  });

  it('runs git under a step deadline further away than a timer can wait, as under none', async () => {
    const at = repo();
    const slow = path.join(at.root, 'slow');
    fs.writeFileSync(slow, `#!/bin/sh\nsleep 0.3\ncat\necho slow >> ${JSON.stringify(at.mark)}\n`, { mode: 0o755 });
    at.git(['config', '--file', String(at.env.GIT_CONFIG_GLOBAL), 'filter.x.clean', slow]);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const added = await untrustedGit(at.env, expiresAt)(at.dir, ['add', 'f']);

    expect({ code: added.code, ran: ran(at) }).toEqual({ code: 0, ran: 'slow\n' });
  });
});

/** A bare repository beside `at`, its origin. */
function bare(at: Repo): string {
  const origin = path.join(at.root, 'origin.git');
  if (!fs.existsSync(origin)) execFileSync('git', ['init', '-q', '--bare', origin], { env: at.env });

  return origin;
}
