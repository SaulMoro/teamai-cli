import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bundleRuntime, tempDir, type Connection, type Message } from '../testing/harness.js';
import { exec, failStandIn, HANDLE, init, nativeHost, openPlace, placeIn, startOn, type NativeHost } from '../testing/native-harness.js';

// The bwrap provider through the runtime's stdio entry point, on a stand-in bwrap that records its argv and runs the
// command. Only a Linux host proves what the namespaces hide; this one proves what the runtime asks bwrap for.

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

/** The `[flag, at]` binds of the last bwrap that ran a step, in order, and the command after `--`. */
function lastSandbox(): { binds: Array<[string, string]>; options: string[]; command: string[] } {
  const call = host.calls().findLast(([name, ...args]) => name === 'bwrap' && args.includes('--chdir')) ?? [];
  const end = call.indexOf('--');
  const args = call.slice(1, end);
  const binds: Array<[string, string]> = [];

  for (const [index, flag] of args.entries()) if (['--bind', '--ro-bind-try', '--ro-bind'].includes(flag)) binds.push([flag, args[index + 1] ?? '']);

  return { binds, options: args, command: call.slice(end + 1) };
}

describe('bwrap: init', () => {
  it('offers the tools on this machine that sign in, at isolation sandbox, unattended included', async () => {
    const reply = await init(start(), { provider: 'bwrap' }, { env: ['CLAUDE_CODE_OAUTH_TOKEN'], logins: [] });

    expect(reply).toMatchObject({ ok: true, can: { isolation: 'sandbox', env: true, unattended: true, setup: true, tools: ['claude'] } });
    expect(reply.can).not.toHaveProperty('network');
    expect(reply.can).not.toHaveProperty('confined');
  });

  it('fails sandbox_unavailable naming how to install it when bwrap is missing, and runs nothing', async () => {
    fs.rmSync(path.join(host.fakes, 'bwrap'));
    const reply = await init(start(), { provider: 'bwrap' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(String((reply.error as Message).message)).toContain('sudo apt install bubblewrap');
  });

  it('fails sandbox_unavailable naming the AppArmor fix when the kernel refuses its namespaces', async () => {
    failStandIn(host, 'bwrap', 'bwrap: setting up uid map: Permission denied');
    const reply = await init(start(), { provider: 'bwrap' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    const { message } = reply.error as { message: string };

    expect(message).toContain('setting up uid map: Permission denied');
    expect(message).toContain('kernel.apparmor_restrict_unprivileged_userns=0');
  });

  it('takes no option but provider', async () => {
    expect(await init(start(), { provider: 'bwrap', warm: { prepare: 'npm ci' } })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'warm' } });
  });
});

describe('bwrap: a step', () => {
  it("binds the place at its host paths, the git paths and this machine's tools read only, and never the member's home", async () => {
    const connection = start();
    await init(connection, { provider: 'bwrap' }, { env: ['CLAUDE_CODE_OAUTH_TOKEN'], logins: [] });
    const at = placeIn(host.dir);
    const { ready } = await openPlace(connection, at, { tool: 'claude' });

    expect(ready).toMatchObject({ event: 'ready', display: { label: `${HANDLE} (bwrap)` } });

    const { end, output } = await exec(connection, { argv: ['claude', '-p', 'Review it.'], credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'step-token' }, env: { CLAUDE_CONFIG_DIR: at.toolHome }, unset: ['GITHUB_TOKEN'], cwd: at.worktree });

    expect(end).toMatchObject({ event: 'exited', code: 0 });
    expect(output).toBe('reviewed\n');
    const { binds, options, command } = lastSandbox();
    const real = (file: string): string => fs.realpathSync(file);

    expect(command).toEqual(['claude', '-p', 'Review it.']);
    expect(options).toEqual(expect.arrayContaining(['--unshare-all', '--share-net', '--die-with-parent', '--new-session']));
    expect(binds).toEqual(expect.arrayContaining([['--bind', real(at.worktree)], ['--bind', real(at.result)], ['--bind', real(at.toolHome)], ['--bind', real(at.runDir)], ['--ro-bind-try', real(at.git)], ['--ro-bind-try', real(host.tools)]]));
    expect(binds.map(([, bound]) => bound)).not.toContain(real(host.home));
    // A deeper bind comes after the one it sits in, so it wins.
    const depths = binds.map(([, bound]) => bound.split('/').length);

    expect(depths).toEqual([...depths].sort((left, right) => left - right));
    expect(JSON.stringify(host.calls())).not.toContain('step-token');
  });

  it("gives the step a home and temp directory of its own, the exec's credentials, and none of the runtime's other variables", async () => {
    host.tool('env-names', "console.log(JSON.stringify({ names: Object.keys(process.env).sort(), home: process.env.HOME, tmp: process.env.TMPDIR, token: process.env.CLAUDE_CODE_OAUTH_TOKEN === 'step-token' }))");
    const connection = start({ MEMBER_SECRET: 'member-only', GITHUB_TOKEN: 'forge' });
    await init(connection, { provider: 'bwrap' });
    const at = placeIn(host.dir);
    await openPlace(connection, at);

    const { output } = await exec(connection, { argv: ['env-names'], credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'step-token' }, unset: ['GITHUB_TOKEN'], cwd: at.worktree });
    const seen = JSON.parse(output) as { names: string[]; home: string; tmp: string; token: boolean };
    const own = path.join(fs.realpathSync(host.home), '.teamai', 'runtime-state', 'sandbox', 'bwrap', HANDLE);

    expect(seen.names).not.toContain('MEMBER_SECRET');
    expect(seen.names).not.toContain('GITHUB_TOKEN');
    expect(seen).toMatchObject({ home: path.join(own, 'home'), tmp: path.join(own, 'tmp'), token: true });
  });

  it('cancels a running step by ending its process group', async () => {
    host.tool('waits', "console.log('started'); setInterval(() => {}, 1000);");
    const connection = start();
    await init(connection, { provider: 'bwrap' });
    const at = placeIn(host.dir);
    await openPlace(connection, at);
    const op = 'op-0000beef';
    connection.send({ type: 'exec', op, handle: HANDLE, argv: ['waits'], env: {}, unset: [], credentials: {}, cwd: at.worktree });
    await connection.next((message) => message.op === op && message.event === 'output');
    connection.send({ type: 'cancel', op });

    expect(await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)))).toMatchObject({ event: 'cancelled' });
  });

  it('passes a URL on this machine to the step at its loopback, as the step shares its network', async () => {
    host.tool('base-url', 'console.log(new URL(process.env.ANTHROPIC_BASE_URL).host)');
    const connection = start();
    await init(connection, { provider: 'bwrap' });
    const at = placeIn(host.dir);
    const { ready } = await openPlace(connection, at, { credentials: { ANTHROPIC_BASE_URL: 'http://localhost:8317/anthropic' } });

    expect(ready).toMatchObject({ event: 'ready' });
    const { end, output } = await exec(connection, { argv: ['base-url'], credentials: { ANTHROPIC_BASE_URL: 'http://localhost:8317/anthropic' }, cwd: at.worktree });

    expect(end).toMatchObject({ event: 'exited', code: 0 });
    expect(output.trim()).toBe('127.0.0.1:8317');
  });
});

describe('bwrap: the outer of an app runtime', () => {
  it("runs the tool the wrapper asks for through bwrap, on the attempt's binds, with the step's credentials and none of the app's env", async () => {
    host.tool('claude', "console.log(JSON.stringify({ args: process.argv.slice(2), token: process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined, app: process.env.APP_ONLY !== undefined, home: process.env.CLAUDE_CONFIG_DIR }))");
    const connection = start();
    await init(connection, { provider: 'bwrap' }, { env: ['CLAUDE_CODE_OAUTH_TOKEN'], logins: [] });
    const at = placeIn(host.dir);
    const { accepted } = await openPlace(connection, at, { tool: 'claude', credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-bwrap-test' } });
    const { socket } = z.object({ socket: z.string() }).parse(JSON.parse(String(accepted.handle)));
    const inner = net.connect(socket);
    await new Promise<void>((resolve) => inner.once('connect', resolve));
    inner.write(`${JSON.stringify({ register: { agent: null } })}\n`);
    const ran = spawnSync(process.execPath, [executable, 'tool-exec', 'claude', '-p'], { cwd: at.worktree, env: { ...host.env(), APP_ONLY: 'from-the-app' }, encoding: 'utf8' });
    inner.destroy();

    expect(ran.status).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({ args: ['-p'], token: true, app: false, home: at.toolHome });
    expect(lastSandbox().command).toEqual(['claude', '-p']);
    expect(lastSandbox().binds).toContainEqual(['--bind', fs.realpathSync(at.worktree)]);
    expect(host.calls().flat().join(' ')).not.toContain('sk-ant-oat01-bwrap-test');
  });
});
