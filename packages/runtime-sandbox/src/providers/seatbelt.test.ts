import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bundleRuntime, tempDir, type Connection, type Message } from '../testing/harness.js';
import { exec, HANDLE, init, nativeHost, openPlace, placeIn, startOn, type NativeHost } from '../testing/native-harness.js';

// The seatbelt provider through the runtime's stdio entry point: on a stand-in sandbox-exec that records the profile and
// runs the command, and, on macOS, on the real one, which alone proves what the profile hides.

const CLAUDE = "if (process.argv.includes('--version')) console.log('2.1.0 (Claude Code)'); else console.log('reviewed');";

let executable: string;
let host: NativeHost;
const open: Connection[] = [];

beforeAll(async () => {
  executable = await bundleRuntime(tempDir());
}, 60_000);

beforeEach(() => {
  host = nativeHost(tempDir());
  host.tool('claude', CLAUDE);
});

afterEach(async () => {
  const connections = open.splice(0);
  await Promise.all(connections.map((connection) => connection.end()));
  expect(connections.flatMap((connection) => connection.invalid)).toEqual([]);
  fs.rmSync(host.dir, { recursive: true, force: true });
});

const start = (extra: NodeJS.ProcessEnv = {}): Connection => startOn(executable, host, open, extra);

/** The profile the last stand-in sandbox-exec was given, with its `-D` parameters. */
function lastProfile(): { profile: string; params: Record<string, string>; command: string[] } {
  const call = host.calls().findLast(([name]) => name === 'sandbox-exec') ?? [];
  const params: Record<string, string> = {};
  let profile = '';
  let index = 1;

  while (index < call.length) {
    const flag = call[index];

    if (flag === '-p') profile = call[index + 1] ?? '';
    else if (flag === '-D') {
      const [name = '', ...value] = (call[index + 1] ?? '').split('=');
      params[name] = value.join('=');
    } else break;
    index += 2;
  }

  return { profile, params, command: call.slice(index) };
}

describe('seatbelt: init', () => {
  it('offers the tools on this machine that sign in, at isolation worktree, and never unattended', async () => {
    const reply = await init(start(), { provider: 'seatbelt' }, { env: ['ANTHROPIC_API_KEY'], logins: [] });

    expect(reply).toMatchObject({ ok: true, can: { isolation: 'worktree', env: true, setup: true, tools: ['claude'], workspace: ['read-only', 'new', 'continue', 'clone', 'team'] } });
    expect(reply.can).not.toHaveProperty('unattended');
    expect(reply.can).not.toHaveProperty('network');
    expect(reply.can).not.toHaveProperty('confined');
  });

  it('names CLAUDE_CODE_OAUTH_TOKEN for Claude when only a login on this machine signs it in, which the sandbox does not read', async () => {
    const reply = await init(start(), { provider: 'seatbelt' }, { env: [], logins: [] });

    expect(reply).toMatchObject({ ok: true, can: { tools: [] } });
    expect(String((reply.unavailable as Message).claude)).toContain('CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('takes no option but provider, naming the key', async () => {
    expect(await init(start(), { provider: 'seatbelt', image: 'x' })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'image', message: 'Provider seatbelt takes no option "image". It takes: provider' } });
  });

  it('fails sandbox_unavailable on a macOS older than 14, and runs nothing', async () => {
    const reply = await init(start({ FAKE_MACOS_VERSION: '13.6.1' }), { provider: 'seatbelt' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(String((reply.error as Message).message)).toContain('macOS 14');
  });

  it('fails sandbox_unavailable off macOS, naming bwrap', async () => {
    fs.rmSync(path.join(host.fakes, 'sw_vers'));
    const reply = await init(start({ PATH: [host.fakes, host.tools].join(path.delimiter) }), { provider: 'seatbelt' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(String((reply.error as Message).message)).toContain('provider: bwrap');
  });
});

describe('seatbelt: a step', () => {
  it('runs the step under a profile that denies what it does not allow, on a home and temp directory of its own', async () => {
    const connection = start();
    await init(connection, { provider: 'seatbelt' }, { env: ['ANTHROPIC_API_KEY'], logins: [] });
    const at = placeIn(host.dir);
    const { ready } = await openPlace(connection, at, { tool: 'claude' });

    expect(ready).toMatchObject({ event: 'ready', display: { label: `${HANDLE} (seatbelt)` } });

    const { end, output } = await exec(connection, { argv: ['claude', '-p', 'Review it.'], credentials: { ANTHROPIC_API_KEY: 'step-key' }, env: { CLAUDE_CONFIG_DIR: at.toolHome }, cwd: at.worktree });

    expect(end).toMatchObject({ event: 'exited', code: 0 });
    expect(output).toBe('reviewed\n');
    const { profile, params, command } = lastProfile();

    expect(command).toEqual(['claude', '-p', 'Review it.']);
    expect(profile).toContain('(deny default)');
    expect(Object.values(params)).toEqual(expect.arrayContaining([fs.realpathSync(at.worktree), fs.realpathSync(at.git), path.join(fs.realpathSync(host.home), '.docker')]));
    expect(Object.values(params)).not.toContain(fs.realpathSync(host.home));
    // No credential value ever reaches the sandbox's argv.
    expect(JSON.stringify(host.calls())).not.toContain('step-key');
  });
});

describe('seatbelt: lifecycle', () => {
  /** A step that says it started, then waits until it is stopped. */
  const WAITS = "console.log('started'); setInterval(() => {}, 1000);";

  it('cancels a running step by ending its process group, then removes its place at close', async () => {
    host.tool('waits', WAITS);
    const connection = start();
    await init(connection, { provider: 'seatbelt' });
    const at = placeIn(host.dir);
    await openPlace(connection, at);
    const op = 'op-0000beef';
    connection.send({ type: 'exec', op, handle: HANDLE, argv: ['waits'], env: {}, unset: [], credentials: {}, cwd: at.worktree });
    await connection.next((message) => message.op === op && message.event === 'output');
    connection.send({ type: 'cancel', op });

    expect(await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)))).toMatchObject({ event: 'cancelled' });
    connection.send({ type: 'close', handle: HANDLE });
    await connection.next((message) => message.event === 'closed' && message.handle === HANDLE);

    expect(fs.existsSync(path.join(host.home, '.teamai', 'runtime-state', 'sandbox', 'seatbelt', HANDLE))).toBe(false);
  });

  it('stops a step a killed runtime left running, from a runtime started again', async () => {
    host.tool('waits', WAITS);
    const first = start();
    await init(first, { provider: 'seatbelt' });
    const at = placeIn(host.dir);
    await openPlace(first, at);
    const op = 'op-0000cafe';
    first.send({ type: 'exec', op, handle: HANDLE, argv: ['waits'], env: {}, unset: [], credentials: {}, cwd: at.worktree });
    await first.next((message) => message.op === op && message.event === 'output');
    first.child.kill('SIGKILL');
    await first.end();
    const pids = path.join(host.home, '.teamai', 'runtime-state', 'sandbox', 'seatbelt', HANDLE, 'pids');
    const [pgid] = fs.readdirSync(pids).map(Number);

    const second = start();
    await init(second, { provider: 'seatbelt' });
    second.send({ type: 'cancel', op });

    expect(await second.next((message) => message.op === op && ['cancelled', 'failed'].includes(String(message.event)))).toMatchObject({ event: 'cancelled' });
    expect(() => process.kill(-Number(pgid), 0)).toThrow();
  });

  it('leaves alone a process group whose number a step held before this machine started, at close', async () => {
    const connection = start();
    await init(connection, { provider: 'seatbelt' });
    const at = placeIn(host.dir);
    await openPlace(connection, at);
    // The member's own process, whose number a step of an earlier boot held.
    const theirs = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const pidFile = path.join(host.home, '.teamai', 'runtime-state', 'sandbox', 'seatbelt', HANDLE, 'pids', String(theirs.pid));
    fs.writeFileSync(pidFile, '');
    const beforeBoot = new Date(Date.now() - (os.uptime() + 3_600) * 1000);
    fs.utimesSync(pidFile, beforeBoot, beforeBoot);

    try {
      connection.send({ type: 'close', handle: HANDLE });
      await connection.next((message) => message.event === 'closed' && message.handle === HANDLE);

      expect(() => process.kill(-Number(theirs.pid), 0)).not.toThrow();
    } finally {
      theirs.kill('SIGKILL');
    }
  });
});

// Only the real sandbox-exec proves what the profile hides.
describe.runIf(process.platform === 'darwin')('seatbelt: on this Mac', () => {
  const PROBE = `
const fs = require('node:fs');
const tries = { readHome: () => fs.readFileSync(process.argv[2], 'utf8'), listHome: () => fs.readdirSync(process.argv[3]), readOther: () => fs.readFileSync(process.argv[4], 'utf8'),
  writeOutside: () => fs.writeFileSync(process.argv[5], 'x'), writeWorktree: () => fs.writeFileSync('made.txt', 'made'), writeOwnHome: () => fs.writeFileSync(process.env.HOME + '/x', 'x'),
  readGit: () => fs.readdirSync(process.argv[6]), writeDotGit: () => fs.writeFileSync('.git', 'gitdir: /tmp/elsewhere') };
console.log(JSON.stringify(Object.fromEntries(Object.entries(tries).map(([name, run]) => { try { run(); return [name, 'ok']; } catch (error) { return [name, error.code]; } }))));`;

  it("keeps the member's home, temp directory and other repositories out of the step's reach, and lets it write only its place, never the worktree's .git", async () => {
    host.tool('probe', PROBE);
    fs.writeFileSync(path.join(host.home, 'secret'), 'member secret');
    const other = path.join(host.dir, 'other-repo');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'file'), 'other');
    // The real sandbox-exec and sw_vers, never the stand-ins; the member's temp directory holds the test's files.
    const connection = startOn(executable, host, open, { PATH: [host.tools, '/usr/bin', '/bin'].join(path.delimiter), TMPDIR: fs.realpathSync(host.dir) });
    expect(await init(connection, { provider: 'seatbelt' })).toMatchObject({ ok: true });
    const at = placeIn(host.dir);
    await openPlace(connection, at);

    const { end, output } = await exec(connection, { argv: ['probe', path.join(host.home, 'secret'), host.home, path.join(other, 'file'), path.join(host.dir, 'outside.txt'), at.git], cwd: at.worktree });

    expect(end).toMatchObject({ event: 'exited', code: 0 });
    expect(JSON.parse(output)).toEqual({ readHome: 'EPERM', listHome: 'EPERM', readOther: 'EPERM', writeOutside: 'EPERM', writeWorktree: 'ok', writeOwnHome: 'ok', readGit: 'ok', writeDotGit: 'EPERM' });
    expect(fs.readFileSync(at.dotGit, 'utf8')).toBe(`gitdir: ${at.git}\n`);
    expect(fs.readFileSync(path.join(at.worktree, 'made.txt'), 'utf8')).toBe('made');
    expect(fs.existsSync(path.join(host.dir, 'outside.txt'))).toBe(false);
  });

  it("reads a tool in a bin under the member's home, never what sits beside that bin or what the step's own PATH names", async () => {
    const local = path.join(host.home, '.local');
    fs.mkdirSync(path.join(local, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(local, 'share', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(local, 'share', 'opencode', 'auth.json'), '{"token":"member"}');
    fs.mkdirSync(path.join(host.home, '.config'));
    fs.writeFileSync(path.join(host.home, '.config', 'login'), 'member login');
    fs.writeFileSync(path.join(local, 'bin', 'probe'), `#!${process.execPath}\nconst fs = require('node:fs');\nconsole.log(JSON.stringify(process.argv.slice(2).map((at) => { try { fs.readFileSync(at); return 'ok'; } catch (error) { return error.code; } })));\n`, { mode: 0o755 });
    const connection = startOn(executable, host, open, { PATH: [path.join(local, 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), TMPDIR: fs.realpathSync(host.dir) });
    expect(await init(connection, { provider: 'seatbelt' })).toMatchObject({ ok: true });
    const at = placeIn(host.dir);
    await openPlace(connection, at);

    const { end, output } = await exec(connection, {
      argv: ['probe', path.join(local, 'bin', 'probe'), path.join(local, 'share', 'opencode', 'auth.json'), path.join(host.home, '.config', 'login')],
      env: { PATH: [path.join(local, 'bin'), path.join(host.home, '.config'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter) },
      cwd: at.worktree,
    });

    expect(end).toMatchObject({ event: 'exited', code: 0 });
    expect(JSON.parse(output)).toEqual(['ok', 'EPERM', 'EPERM']);
  });

  /** Each named try's outcome, `ok` or its error code, as one JSON line. */
  const TRIES = `
const fs = require('node:fs'); const net = require('node:net'); const { execFileSync } = require('node:child_process');
const connects = (at) => new Promise((resolve) => { const socket = net.connect(at); socket.on('data', () => { socket.destroy(); resolve('ok'); }); socket.on('error', (error) => resolve(error.code)); });
const tries = JSON.parse(process.argv[2]);
(async () => {
  const out = {};
  for (const [name, op, ...args] of tries) {
    try {
      if (op === 'kill') { process.kill(Number(args[0]), args[1]); out[name] = 'ok'; }
      else if (op === 'connect') out[name] = await connects(args[0]);
      else if (op === 'ps') out[name] = execFileSync('/bin/ps', ['-p', args[0], '-o', 'pid='], { encoding: 'utf8' }).trim() === args[0] ? 'ok' : 'unseen';
      else if (op === 'rename') { fs.renameSync(args[0], args[1]); out[name] = 'ok'; }
      else if (op === 'write') { fs.mkdirSync(require('node:path').dirname(args[0]), { recursive: true }); fs.writeFileSync(args[0], 'planted'); out[name] = 'ok'; }
      else if (op === 'remove') { fs.rmSync(args[0], { recursive: true }); out[name] = 'ok'; }
    } catch (error) { out[name] = error.code ?? String(error.status ?? error.message); }
  }
  console.log(JSON.stringify(out));
})();`;

  /** A server on the Unix socket `at` that greets each client, closed by the returned function. */
  async function listenOn(at: string): Promise<() => Promise<void>> {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    const server = net.createServer((socket) => socket.end('hi\n'));
    await new Promise<void>((resolve) => { server.listen(at, resolve); });

    return () => new Promise((resolve) => { server.close(() => resolve()); });
  }

  /** The runtime on the real sandbox-exec, with node on its PATH, and `extra` over its environment; its place under `root`. */
  async function onThisMac(extra: NodeJS.ProcessEnv = {}, root = host.dir): Promise<{ connection: Connection; at: ReturnType<typeof placeIn> }> {
    host.tool('tries', TRIES);
    const connection = startOn(executable, host, open, { PATH: [host.tools, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), TMPDIR: fs.realpathSync(host.dir), ...extra });
    expect(await init(connection, { provider: 'seatbelt' })).toMatchObject({ ok: true });

    return { connection, at: placeIn(root) };
  }

  it('keeps a step from signalling or listing a process it did not start, and from a Unix socket outside its place', async () => {
    // A short place, so a socket in its worktree fits the Unix limit.
    const short = fs.realpathSync(fs.mkdtempSync('/tmp/tsp-'));
    const { connection, at } = await onThisMac({}, short);
    await openPlace(connection, at);
    const sleeper = spawn('sleep', ['61'], { detached: true, stdio: 'ignore' });
    const outside = fs.mkdtempSync('/tmp/tsb-');
    const closeOutside = await listenOn(path.join(outside, 's.sock'));
    const closeInside = await listenOn(path.join(at.worktree, 's.sock'));

    try {
      const { end, output } = await exec(connection, {
        argv: ['tries', JSON.stringify([['signal', 'kill', String(sleeper.pid), 'SIGCONT'], ['probe', 'kill', String(sleeper.pid), 0], ['list', 'ps', String(sleeper.pid)], ['outside', 'connect', path.join(outside, 's.sock')], ['inside', 'connect', path.join(at.worktree, 's.sock')]])],
        cwd: at.worktree,
      });

      expect(end).toMatchObject({ event: 'exited', code: 0 });
      expect(JSON.parse(output)).toMatchObject({ signal: 'EPERM', probe: 'EPERM', outside: 'EPERM', inside: 'ok' });
      expect(JSON.parse(output).list).not.toBe('ok');
    } finally {
      sleeper.kill('SIGKILL');
      await closeOutside();
      await closeInside();
      connection.send({ type: 'close', handle: HANDLE });
      await connection.next((message) => message.event === 'closed' && message.handle === HANDLE);
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(short, { recursive: true, force: true });
    }
  });

  it("keeps a step from a container engine's socket in the member's home", async () => {
    // A short home, so the socket's path fits the Unix limit.
    const home = fs.realpathSync(fs.mkdtempSync('/tmp/tsh-'));
    const sockets = ['.docker/run/docker.sock', '.colima/default/docker.sock', '.orbstack/run/docker.sock', '.lima/default/sock/docker.sock', '.rd/docker.sock'].map((at) => path.join(home, at));
    const closes = await Promise.all(sockets.map(listenOn));

    try {
      const { connection, at } = await onThisMac({ HOME: home });
      await openPlace(connection, at);
      const { end, output } = await exec(connection, { argv: ['tries', JSON.stringify(sockets.map((at, index) => [String(index), 'connect', at]))], cwd: at.worktree });

      expect(end).toMatchObject({ event: 'exited', code: 0 });
      expect(Object.values(JSON.parse(output))).toEqual(sockets.map(() => 'EPERM'));
      connection.send({ type: 'close', handle: HANDLE });
      await connection.next((message) => message.event === 'closed' && message.handle === HANDLE);
    } finally {
      await Promise.all(closes.map((close) => close()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps a step from moving aside, or removing, a folder that holds a git file it may only read', async () => {
    const { connection, at } = await onThisMac();
    // A clone's own git directory inside the worktree, one folder down.
    const gitDir = path.join(at.worktree, 'repo', '.git');
    fs.mkdirSync(path.join(gitDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n');
    await openPlace(connection, at, { readonly: [at.git, at.dotGit, gitDir] });

    const { end, output } = await exec(connection, {
      argv: ['tries', JSON.stringify([
        ['config', 'write', path.join(gitDir, 'config')],
        ['hook', 'write', path.join(gitDir, 'hooks', 'pre-commit')],
        ['moveGit', 'rename', gitDir, path.join(at.worktree, 'repo', 'aside')],
        ['moveParent', 'rename', path.join(at.worktree, 'repo'), path.join(at.worktree, 'aside')],
        ['removeParent', 'remove', path.join(at.worktree, 'repo')],
        ['ownFile', 'write', path.join(at.worktree, 'repo', 'file.txt')],
      ])],
      cwd: at.worktree,
    });

    expect(end).toMatchObject({ event: 'exited', code: 0 });
    expect(JSON.parse(output)).toEqual({ config: 'EPERM', hook: 'EPERM', moveGit: 'EPERM', moveParent: 'EPERM', removeParent: 'EPERM', ownFile: 'ok' });
    expect(fs.readFileSync(path.join(gitDir, 'config'), 'utf8')).toBe('[core]\n');
    expect(fs.existsSync(path.join(gitDir, 'hooks', 'pre-commit'))).toBe(false);
  });
});

describe('seatbelt: never the outer of an app runtime', () => {
  it('opens a place for a tool with no attempt socket, as it confines files only', async () => {
    const connection = start();
    await init(connection, { provider: 'seatbelt' }, { env: ['ANTHROPIC_API_KEY'], logins: [] });
    const { accepted } = await openPlace(connection, placeIn(host.dir), { tool: 'claude' });

    expect(accepted.handle).toBe(HANDLE);
  });
});
