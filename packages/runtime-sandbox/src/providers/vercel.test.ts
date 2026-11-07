import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { connect, tempDir, type Connection, type Message } from '../testing/harness.js';
import { ATTEMPT, exec, HANDLE, newOp, openPlace, placeIn, RUN, type Place } from '../testing/native-harness.js';

// The vercel provider through the runtime's stdio entry point, bundled as it ships but with `@vercel/sandbox` replaced
// by a stand-in (testing/vercel-fake-sdk.ts) whose hosted sandboxes are directories on this machine. Only a Vercel
// account proves the real SDK; this proves what the runtime asks of it and what it copies back.

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A tool in Vercel's image: prints its args, writes into its working directory and its tool home. */
const CLAUDE = `
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
fs.writeFileSync('README.md', 'add(a, b) returns a + b.\\n');
fs.rmSync('obsolete.txt', { force: true });
fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/session.jsonl', '{}\\n');
console.log(JSON.stringify({ names: Object.keys(process.env).sort() }));`;

let executable: string;
let dir: string;
let stateDir: string;
let imageDir: string;
const open: Connection[] = [];

beforeAll(async () => {
  const out = tempDir();
  executable = path.join(out, 'teamai-runtime-sandbox.mjs');
  await build({
    entryPoints: [path.join(HERE, '..', 'main.ts')], outfile: executable, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
    alias: { '@vercel/sandbox': path.join(HERE, '..', 'testing', 'vercel-fake-sdk.ts') },
    banner: { js: "import { createRequire as __teamaiCreateRequire } from 'node:module';\nconst require = __teamaiCreateRequire(import.meta.url);" },
  });
}, 60_000);

beforeEach(() => {
  dir = tempDir();
  stateDir = path.join(dir, 'vercel-state');
  imageDir = path.join(dir, 'image');
  fs.mkdirSync(imageDir);
  fs.mkdirSync(path.join(dir, 'home'));
  fs.writeFileSync(path.join(imageDir, 'claude'), `#!${process.execPath}\n${CLAUDE}\n`, { mode: 0o755 });
});

afterEach(async () => {
  const connections = open.splice(0);
  await Promise.all(connections.map((connection) => connection.end()));
  expect(connections.flatMap((connection) => connection.invalid)).toEqual([]);
  // A sandbox a test left open holds read-only git paths.
  execFileSync('chmod', ['-R', 'u+w', dir]);
  fs.rmSync(dir, { recursive: true, force: true });
});

const AUTH = { VERCEL_TOKEN: 'vercel-token-value', VERCEL_TEAM_ID: 'team_acme', VERCEL_PROJECT_ID: 'prj_acme' };

function start(extra: NodeJS.ProcessEnv = AUTH): Connection {
  const connection = connect(executable, { PATH: '/usr/bin:/bin', HOME: path.join(dir, 'home'), FAKE_VERCEL_STATE: stateDir, FAKE_VERCEL_IMAGE: imageDir, ...extra });
  open.push(connection);

  return connection;
}

async function init(connection: Connection, options: Message = { provider: 'vercel' }, credentials = { env: ['CLAUDE_CODE_OAUTH_TOKEN'], logins: [] }): Promise<Message> {
  connection.send({ type: 'init', protocol: 1, mode: 'unattended', options, credentials });

  return connection.next((message) => message.type === 'init', 30_000);
}

const CallSchema = z.looseObject({ call: z.string() });

function calls(): Array<z.infer<typeof CallSchema>> {
  const file = path.join(stateDir, 'calls.log');

  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => CallSchema.parse(JSON.parse(line))) : [];
}

/** The sandbox's own copy of host path `at`. */
const inSandbox = (name: string, at: string): string => path.join(stateDir, 'sandboxes', name, 'root', at);

function sandboxNames(): string[] {
  const root = path.join(stateDir, 'sandboxes');

  return fs.existsSync(root) ? fs.readdirSync(root) : [];
}

/** A place whose worktree holds a README, a file the step deletes, and a `.git` pointer into the read-only git path. */
function preparedPlace(): Place {
  const at = placeIn(dir);
  fs.writeFileSync(path.join(at.worktree, 'README.md'), 'add(a, b) returns a - b.\n');
  fs.writeFileSync(path.join(at.worktree, 'obsolete.txt'), 'old\n');
  fs.writeFileSync(path.join(at.git, 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(at.toolHome, { recursive: true });
  fs.writeFileSync(path.join(at.toolHome, 'settings.json'), '{}\n');

  return at;
}

async function collect(connection: Connection): Promise<Message> {
  connection.send({ type: 'collect', handle: HANDLE });

  return connection.next((message) => message.handle === HANDLE && (message.event === 'collected' || message.event === 'failed'), 30_000);
}

describe('vercel: init', () => {
  it('offers a hosted sandbox with Claude, which its image ships, signed in by the credential teamai gives', async () => {
    const reply = await init(start());

    expect(reply).toMatchObject({ ok: true, can: { isolation: 'sandbox', env: true, unattended: true, setup: true, tools: ['claude'] } });
    expect(reply.can).not.toHaveProperty('network');
    expect(reply.can).not.toHaveProperty('confined');
  });

  it('fails sandbox_unavailable naming the variables to set when it has no Vercel sign-in', async () => {
    const reply = await init(start({}));

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(String((reply.error as Message).message)).toMatch(/VERCEL_TOKEN.*VERCEL_TEAM_ID.*VERCEL_PROJECT_ID.*VERCEL_OIDC_TOKEN/s);
  });

  it('reads the provider auth a definition names, from another variable or a file', async () => {
    fs.writeFileSync(path.join(dir, 'token'), 'vercel-token-from-file\n');
    const reply = await init(start({ ACME_VERCEL_TEAM: 'team_acme', VERCEL_PROJECT_ID: 'prj_acme' }), { provider: 'vercel', provider_auth: { VERCEL_TOKEN: `file:${path.join(dir, 'token')}`, VERCEL_TEAM_ID: 'env:ACME_VERCEL_TEAM' } });

    expect(reply).toMatchObject({ ok: true });
  });

  it('refuses provider auth it does not know, a value that is not env: or file:, and a lifetime Vercel does not take', async () => {
    expect(await init(start(), { provider: 'vercel', provider_auth: { VERCEL_TOKN: 'env:VERCEL_TOKEN' } })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'provider_auth.VERCEL_TOKN' } });
    expect(await init(start(), { provider: 'vercel', provider_auth: { VERCEL_TOKEN: 'abc' } })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'provider_auth.VERCEL_TOKEN' } });
    expect(await init(start(), { provider: 'vercel', timeout: '9h' })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'timeout' } });
    expect(await init(start(), { provider: 'vercel', timeout: 'soon' })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'timeout' } });
  });
});

describe('vercel: an attempt', () => {
  it('creates one sandbox with persistence off and no credential, recreates the place at its host paths, and runs the step there', async () => {
    const connection = start();
    await init(connection, { provider: 'vercel', runtime: 'node24', timeout: '2h' });
    const at = preparedPlace();
    const { ready } = await openPlace(connection, at, { tool: 'claude' });

    expect(ready).toMatchObject({ event: 'ready' });
    const [name = ''] = sandboxNames();
    const created = calls().find((call) => call.call === 'create');

    expect(created).toMatchObject({ persistent: false, timeout: 2 * 3_600_000, runtime: 'node24', auth: ['token', 'teamId', 'projectId'] });
    expect(fs.readFileSync(inSandbox(name, path.join(at.worktree, 'README.md')), 'utf8')).toBe('add(a, b) returns a - b.\n');
    expect(fs.readFileSync(inSandbox(name, path.join(at.toolHome, 'settings.json')), 'utf8')).toBe('{}\n');
    expect(fs.existsSync(inSandbox(name, at.result))).toBe(true);
    // The git paths are read-only inside.
    expect(fs.statSync(inSandbox(name, path.join(at.git, 'HEAD'))).mode & 0o222).toBe(0);

    const { end, output } = await exec(connection, { argv: ['claude', '-p', 'Fix it.'], credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'step-token' }, env: { CLAUDE_CONFIG_DIR: at.toolHome }, unset: ['GITHUB_TOKEN'], cwd: at.worktree });

    expect(end).toMatchObject({ event: 'exited', code: 0 });
    const { names } = z.object({ names: z.array(z.string()) }).parse(JSON.parse(output));

    // The step gets the exec's credential, and none of the provider's auth.
    expect(names).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(names.filter((variable) => variable.startsWith('VERCEL_'))).toEqual([]);
    expect(JSON.stringify(calls())).not.toMatch(/vercel-token-value|step-token/);
  });

  it('copies the work back at collect: changes, deletions and the tool home, never the git paths', async () => {
    const connection = start();
    await init(connection);
    const at = preparedPlace();
    await openPlace(connection, at, { tool: 'claude' });
    await exec(connection, { argv: ['claude', '-p', 'Fix it.'], env: { CLAUDE_CONFIG_DIR: at.toolHome }, cwd: at.worktree });
    const [name = ''] = sandboxNames();
    fs.chmodSync(inSandbox(name, path.join(at.git, 'HEAD')), 0o644);
    fs.writeFileSync(inSandbox(name, path.join(at.git, 'HEAD')), 'planted\n');

    expect(await collect(connection)).toMatchObject({ event: 'collected' });
    expect(fs.readFileSync(path.join(at.worktree, 'README.md'), 'utf8')).toBe('add(a, b) returns a + b.\n');
    expect(fs.existsSync(path.join(at.worktree, 'obsolete.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(at.toolHome, 'session.jsonl'), 'utf8')).toBe('{}\n');
    expect(fs.readFileSync(path.join(at.git, 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
  });

  it('brings a symlink the step planted back as a link, and writes nothing through it or outside the place', async () => {
    fs.writeFileSync(path.join(imageDir, 'plant'), `#!${process.execPath}\nconst fs = require('node:fs'); fs.mkdirSync('../outside'); fs.symlinkSync('../outside', 'escape'); fs.writeFileSync('escape/through.txt', 'x');\n`, { mode: 0o755 });
    const connection = start();
    await init(connection);
    const at = preparedPlace();
    await openPlace(connection, at);

    expect((await exec(connection, { argv: ['plant'], cwd: at.worktree })).end).toMatchObject({ event: 'exited', code: 0 });
    expect(await collect(connection)).toMatchObject({ event: 'collected' });
    expect(fs.readlinkSync(path.join(at.worktree, 'escape'))).toBe('../outside');
    expect(fs.existsSync(path.join(dir, 'outside'))).toBe(false);
  });

  it('fails the open on timeout, naming both times, when the lifetime ends before the attempt may, and creates nothing', async () => {
    const connection = start();
    await init(connection, { provider: 'vercel', timeout: '10m' });
    const at = preparedPlace();
    const op = newOp();
    const deadline = new Date(Date.now() + 3_600_000).toISOString();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, deadline, credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
    const failed = await connection.next((message) => message.op === op && message.event === 'failed', 30_000);

    expect(failed).toMatchObject({ failure: { code: 'bad_option', key: 'timeout' } });
    expect(String((failed.failure as Message).message)).toContain(deadline);
    expect(calls().filter((call) => call.call === 'create')).toEqual([]);
  });

  it('refuses a credential on this machine itself, which a hosted sandbox cannot reach, naming the variable', async () => {
    const connection = start();
    await init(connection);
    const { ready } = await openPlace(connection, preparedPlace(), { credentials: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' } });

    expect(ready).toMatchObject({ event: 'failed', failure: { code: 'bad_option', key: 'credentials.ANTHROPIC_BASE_URL' } });
    expect(sandboxNames()).toEqual([]);
  });

  it('cancels a running step, then deletes the sandbox at close', async () => {
    fs.writeFileSync(path.join(imageDir, 'waits'), `#!${process.execPath}\nconsole.log('started'); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const connection = start();
    await init(connection);
    const at = preparedPlace();
    await openPlace(connection, at);
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, argv: ['waits'], env: {}, unset: [], credentials: {}, cwd: at.worktree });
    await connection.next((message) => message.op === op && message.event === 'output');
    connection.send({ type: 'cancel', op });

    expect(await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)))).toMatchObject({ event: 'cancelled' });
    connection.send({ type: 'close', handle: HANDLE });
    await connection.next((message) => message.event === 'closed' && message.handle === HANDLE);

    expect(sandboxNames()).toEqual([]);
    expect(calls().filter((call) => call.call === 'delete')).toHaveLength(1);
  });

  it('reaches the sandbox by its name from a runtime started again: a cancel stops the step a killed runtime left, and close deletes it', async () => {
    fs.writeFileSync(path.join(imageDir, 'waits'), `#!${process.execPath}\nconsole.log('started'); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const first = start();
    await init(first);
    const at = preparedPlace();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, argv: ['waits'], env: {}, unset: [], credentials: {}, cwd: at.worktree });
    await first.next((message) => message.op === op && message.event === 'output');
    first.child.kill('SIGKILL');
    await first.end();

    const second = start();
    second.send({ type: 'reattach', handle: HANDLE });

    expect(await second.next((message) => message.handle === HANDLE && message.event === 'alive')).toMatchObject({ ops: [{ op, state: 'running' }] });
    await init(second);
    second.send({ type: 'cancel', op });

    expect(await second.next((message) => message.op === op && ['cancelled', 'failed'].includes(String(message.event)))).toMatchObject({ event: 'cancelled' });
    second.send({ type: 'close', handle: HANDLE });
    await second.next((message) => message.event === 'closed' && message.handle === HANDLE);

    expect(sandboxNames()).toEqual([]);
  });
});
