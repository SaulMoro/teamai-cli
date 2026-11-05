import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitCredentials } from '@teamai/runtime-protocol';
import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import { bundleRuntime, connect, fakeEngine, tempDir, type Connection, type FakeEngine, type Message } from './testing/harness.js';

// The runtime through its stdio entry point, as teamai spawns it, on a fake docker / podman (testing/fake-engine.mjs).

const IMAGE = 'ghcr.io/acme/agent:1';
const CLAUDE = "if (process.argv.includes('--version')) console.log('2.1.0 (Claude Code)')";

let executable: string;
let dir: string;
let engine: FakeEngine;
const open: Connection[] = [];

beforeAll(async () => {
  executable = await bundleRuntime(tempDir());
}, 60_000);

beforeEach(() => {
  dir = tempDir();
  engine = fakeEngine(dir);
  engine.image(IMAGE, { claude: CLAUDE });
  fs.mkdirSync(path.join(dir, 'home'));
});

afterEach(async () => {
  const connections = open.splice(0);
  await Promise.all(connections.map((connection) => connection.end()));

  // Every line the runtime wrote is one runtime protocol 1 allows.
  expect(connections.flatMap((connection) => connection.invalid)).toEqual([]);
  fs.rmSync(dir, { recursive: true, force: true });
});

function start(extra: NodeJS.ProcessEnv = {}): Connection {
  const connection = connect(executable, { ...engine.env(), HOME: path.join(dir, 'home'), ...extra });
  open.push(connection);

  return connection;
}

async function init(connection: Connection, options: Message, mode = 'unattended', credentials?: InitCredentials): Promise<Message> {
  connection.send({ type: 'init', protocol: 1, mode, options, ...(credentials && { credentials }) });

  return connection.next((message) => message.type === 'init', 30_000);
}

describe('init', () => {
  it('fails on an option it does not take, naming the key', async () => {
    expect(await init(start(), { provider: 'docker', image: IMAGE, imgae: 'x' })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'imgae' } });
  });

  it('names a misspelled key rather than the key it replaced', async () => {
    expect(await init(start(), { provider: 'docker', imgae: IMAGE })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'imgae' } });
  });

  it('fails on a provider this version does not run, naming the ones it does', async () => {
    const reply = await init(start(), { provider: 'bwrap' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'provider' } });
    expect(JSON.stringify(reply)).toMatch(/sbx.*docker.*podman/);
  });

  it('fails without an image', async () => {
    expect(await init(start(), { provider: 'podman' })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'image' } });
  });

  it('fails with sandbox_unavailable and the command that fixes it when the engine is not running, and never offers the host', async () => {
    engine.daemon(false);
    const reply = await init(start(), { provider: 'docker', image: IMAGE });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(JSON.stringify(reply)).toMatch(/Docker Desktop|systemctl start docker/);
  });

  it('fails with sandbox_unavailable when the engine is not installed', async () => {
    const empty = path.join(dir, 'empty-bin');
    fs.mkdirSync(empty);
    const reply = await init(start({ PATH: empty }), { provider: 'podman', image: IMAGE });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(JSON.stringify(reply)).toContain('podman');
  });

  it('fails when the image cannot be pulled, naming it', async () => {
    const reply = await init(start(), { provider: 'docker', image: 'ghcr.io/acme/missing:1' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(JSON.stringify(reply)).toContain('ghcr.io/acme/missing:1');
  });

  it('offers a sandbox with the tools the image holds, and declares no network', async () => {
    const reply = await init(start(), { provider: 'docker', image: IMAGE });

    expect(reply).toMatchObject({ ok: true, can: { isolation: 'sandbox', env: true, unattended: true, setup: true, workspace: ['read-only', 'new', 'continue'], tools: ['claude'] } });
    expect(reply.can).not.toHaveProperty('network');
    expect(reply.can).not.toHaveProperty('hitl');
  });
});

const RUN = 'r0123abcd';
const ATTEMPT = 'a0123abcd';
const HANDLE = `teamai-${RUN}-${ATTEMPT}`;
let opCount = 0;

function newOp(): string {
  opCount += 1;

  return `op-${opCount.toString(16).padStart(8, '0')}`;
}

interface Place {
  worktree: string;
  git: string;
  result: string;
  runDir: string;
  toolHome: string;
}

function place(): Place {
  const at = { worktree: path.join(dir, 'worktree'), git: path.join(dir, 'repo.git'), result: path.join(dir, 'attempts', ATTEMPT, 'out'), runDir: path.join(dir, 'runs', RUN, 'scratch'), toolHome: path.join(dir, 'attempts', ATTEMPT, 'tool-home', 'claude') };
  fs.mkdirSync(at.worktree, { recursive: true });
  fs.mkdirSync(at.git, { recursive: true });

  return at;
}

/** Opens the attempt's place, with its tool home, and the credentials teamai sends on `open`. */
async function openPlace(connection: Connection, at: Place, op = newOp(), { credentials = {} }: { credentials?: Record<string, string> } = {}): Promise<{ accepted: Message; ready: Message }> {
  connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
  const accepted = await connection.next((message) => message.op === op && message.event === 'accepted');
  const ready = await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000);

  return { accepted, ready };
}

/** Every file the runtime's journal holds. */
function journalFiles(): string[] {
  const journal = path.join(dir, 'home', '.teamai', 'runtime-state', 'sandbox');

  return fs.readdirSync(journal, { recursive: true }).map((file) => path.join(journal, String(file))).filter((file) => fs.statSync(file).isFile());
}

async function exec(connection: Connection, request: { argv: string[]; env?: Record<string, string>; unset?: string[]; credentials?: Record<string, string>; cwd: string }, op = newOp()): Promise<{ end: Message; output: string }> {
  connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, ...request });
  const end = await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 30_000);
  const output = connection.messages.filter((message) => message.op === op && message.event === 'output' && message.stream === 'stdout').map((message) => String(message.data)).join('');

  return { end, output };
}

describe('a prompt attempt in a container', () => {
  it('opens one container per attempt with the place view, the run directory included, at its host paths, as the member, and shows it in the dashboard', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    const { accepted, ready } = await openPlace(connection, at);

    expect(accepted.handle).toBe(HANDLE);
    expect(ready).toMatchObject({ event: 'ready', display: { label: `${HANDLE} (docker)`, fields: { container: HANDLE, image: IMAGE } } });
    // A new open of the same attempt finds that container instead of creating a second.
    expect((await openPlace(connection, at)).accepted.handle).toBe(HANDLE);
    expect(engine.containers()).toEqual([HANDLE]);

    const run = engine.calls().find(([, command, detached]) => command === 'run' && detached === '-d') ?? [];
    const joined = run.join(' ');

    expect(joined).toContain(`--label teamai.run=${RUN} --label teamai.attempt=${ATTEMPT}`);
    expect(joined).toContain(`--user ${process.getuid?.()}:${process.getgid?.()}`);
    expect(run).toEqual(expect.arrayContaining([`${at.worktree}:${at.worktree}:rw`, `${at.result}:${at.result}:rw`, `${at.toolHome}:${at.toolHome}:rw`, `${at.runDir}:${at.runDir}:rw`, `${at.git}:${at.git}:ro`]));
    // The tool home exists on the host before the engine mounts it, so the member owns it.
    expect(fs.existsSync(at.toolHome)).toBe(true);
  });

  it('maps the member with keep-id on podman', async () => {
    const connection = start();
    await init(connection, { provider: 'podman', image: IMAGE });
    const { ready } = await openPlace(connection, place());

    expect(ready).toMatchObject({ event: 'ready', display: { label: `${HANDLE} (podman)` } });
    expect(engine.calls().find(([name, command, detached]) => name === 'podman' && command === 'run' && detached === '-d')?.join(' ')).toContain('--userns keep-id');
  });

  it("runs the image's tool, not the host's", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);

    expect(await exec(connection, { argv: ['claude', '--version'], cwd: at.worktree })).toMatchObject({ end: { event: 'exited', code: 0, stdout: '2.1.0 (Claude Code)\n' }, output: '2.1.0 (Claude Code)\n' });
  });

  it("gives an exec its names and the credentials it brings, never a value in an argv, on disk, nor any other name of teamai's environment", async () => {
    const connection = start({ GITHUB_TOKEN: 'forge-value-1' });
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const credentials = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-1' };
    // Says whether each name is set, and whether the token is the one teamai gave, never a credential's value. The
    // glob matches that value alone, without writing it in the argv this test checks.
    const script = 'token=unset; [ -n "${CLAUDE_CODE_OAUTH_TOKEN+x}" ] && token=other; case "${CLAUDE_CODE_OAUTH_TOKEN-}" in oauth-value-[1]) token=given;; esac; printf "%s|%s|%s" "${STEP_VALUE-unset}" "$token" "${GITHUB_TOKEN+set}"; exit 3';

    expect((await exec(connection, { argv: ['/bin/sh', '-c', script], env: { STEP_VALUE: 'step-value-1' }, credentials, cwd: at.worktree })).end)
      .toEqual({ op: expect.any(String), event: 'exited', code: 3, stdout: 'step-value-1|given|' });
    // A credential the exec withholds is not set.
    expect((await exec(connection, { argv: ['/bin/sh', '-c', script], unset: ['CLAUDE_CODE_OAUTH_TOKEN'], credentials, cwd: at.worktree })).end).toMatchObject({ stdout: 'unset|unset|' });

    const argvs = JSON.stringify(engine.calls());

    expect(argvs).not.toContain('oauth-value-1');
    expect(argvs).not.toContain('step-value-1');
    expect(engine.calls().filter(([, command]) => command === 'run').join(' ')).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    // The runtime's journal keeps no credential.
    const kept = journalFiles();

    expect(kept.length).toBeGreaterThan(0);
    expect(kept.map((file) => fs.readFileSync(file, 'utf8')).join('\n')).not.toContain('oauth-value-1');
  });

  it('keeps a credential the tool printed off disk, and answers a repeated id with it masked', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    // A tool that echoes its token: a fake value, written by the test.
    const request = { argv: ['/bin/sh', '-c', 'printf "token=%s" "$CLAUDE_CODE_OAUTH_TOKEN"'], credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-echoed' }, cwd: at.worktree };
    const op = newOp();

    // teamai gets the complete stdout, and masks it itself.
    expect((await exec(connection, request, op)).end).toMatchObject({ event: 'exited', code: 0, stdout: 'token=oauth-value-echoed' });
    expect((await exec(connection, request, op)).end).toMatchObject({ event: 'exited', code: 0, stdout: 'token=<REDACTED:CLAUDE_CODE_OAUTH_TOKEN>' });

    expect(journalFiles().map((file) => fs.readFileSync(file, 'utf8')).join('\n')).not.toContain('oauth-value-echoed');
  });

  it("sets no credential on an exec that brings none, as a command step's, whatever the attempt's open carried", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at, newOp(), { credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-1' } });

    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'if [ -n "${CLAUDE_CODE_OAUTH_TOKEN+x}" ]; then printf set; else printf unset; fi'], cwd: at.worktree })).end).toMatchObject({ event: 'exited', stdout: 'unset' });
  });

  it('records the end of an exec that outlives teamai, even once its stdout is gone', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    const marker = path.join(at.worktree, 'started');
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], cwd: at.worktree, argv: ['/bin/sh', '-c', `touch started; i=0; while [ $i -lt 20 ]; do echo line $i; i=$((i+1)); sleep 0.05; done; echo done`] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    expect(fs.existsSync(marker) || await new Promise((resolve) => setTimeout(() => resolve(fs.existsSync(marker)), 500))).toBe(true);
    // teamai is gone: nobody reads the runtime's stdout, and its stdin ends.
    first.child.stdout.destroy();
    await first.end();

    const second = start();
    await init(second, { provider: 'docker', image: IMAGE });
    second.send({ type: 'reattach', handle: HANDLE });

    expect(await second.next((message) => message.event === 'alive' || message.event === 'gone')).toMatchObject({
      event: 'alive', ops: [{ op, state: 'exited', code: 0, stdout: expect.stringMatching(/line 19\ndone\n$/) }],
    });
  });

  it('answers a repeated exec id with the same outcome without running it again', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    const first = await exec(connection, { argv: ['/bin/sh', '-c', 'echo x >> runs; echo once'], cwd: at.worktree }, op);

    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'echo x >> runs; echo once'], cwd: at.worktree }, op)).end).toEqual(first.end);
    expect(fs.readFileSync(path.join(at.worktree, 'runs'), 'utf8')).toBe('x\n');
  });

  it('runs an exec id sent twice at once only once', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    const request = { type: 'exec', op, handle: HANDLE, env: {}, unset: [], cwd: at.worktree, argv: ['/bin/sh', '-c', 'echo x >> runs'] };
    connection.send(request);
    connection.send(request);
    await connection.next((message) => message.op === op && message.event === 'exited', 30_000);
    // The other request's end, had it run, would be written by now.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(fs.readFileSync(path.join(at.worktree, 'runs'), 'utf8')).toBe('x\n');
    expect(connection.messages.filter((message) => message.op === op && message.event === 'exited')).toHaveLength(1);
  });

  it("finds the engine on teamai's PATH when the step sets its own PATH for the container", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);

    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'printf "%s" "$PATH"'], env: { PATH: '/opt/step/bin:/usr/bin:/bin' }, cwd: at.worktree })).end)
      .toMatchObject({ event: 'exited', code: 0, stdout: '/opt/step/bin:/usr/bin:/bin' });
  });

  it('answers a prompt with failed: it runs the tool teamai builds, as an exec', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    connection.send({
      type: 'prompt', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree,
      lease: { step: 'review', tool: 'claude', prompt: 'Review it.', result: path.join(at.result, 'result.json'), permissions: 'unattended', interactive: false },
    });

    expect(await connection.next((message) => message.op === op && message.event !== 'accepted')).toMatchObject({ op, event: 'failed', failure: { code: 'prompt_unsupported' } });
    expect(engine.calls().filter(([, command]) => command === 'exec')).toEqual([]);
  });

  it('answers close_failed when the engine cannot remove the container, and keeps the place to close again', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openPlace(connection, place());
    engine.failRemove(true);
    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => message.handle === HANDLE && (message.event === 'closed' || message.event === 'close_failed'))).toMatchObject({
      event: 'close_failed', handle: HANDLE, failure: { code: 'sandbox_failed', message: expect.stringContaining(`docker rm --force`) },
    });
    expect(engine.containers()).toEqual([HANDLE]);

    engine.failRemove(false);
    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => message.handle === HANDLE && (message.event === 'closed' || message.event === 'close_failed'))).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  });

  it('stops an exec still running when teamai closes its place, ends it as cancelled, then answers closed', async () => {
    engine.stopLag(1_000);
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });

    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => (message.op === op && message.event !== 'output') || message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ op, event: 'cancelled' });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  });

  it('never counts an exec whose runtime died as cancelled when the engine could not stop it', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    first.child.kill('SIGKILL');
    await first.end();
    const second = start();
    await init(second, { provider: 'docker', image: IMAGE });
    engine.daemon(false);

    second.send({ type: 'cancel', op });

    expect(await second.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 30_000)).toMatchObject({
      op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('docker rm --force') },
    });
    engine.daemon(true);
    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed')).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  });

  it('fails a cancel the engine could not stop, with how to remove the container, and keeps it to remove at close', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; while :; do sleep 1; done'] });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    engine.daemon(false);

    connection.send({ type: 'cancel', op });

    expect(await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 5_000)).toMatchObject({
      op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(`docker rm --force`) },
    });
    engine.daemon(true);
    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
    // The exec's own end, once close removed its container, is not a second outcome.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(connection.messages.filter((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)))).toHaveLength(1);
  });

  /** Starts an exec that runs until something stops it, and waits until it runs. */
  async function runForever(connection: Connection, at: Place): Promise<string> {
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; while :; do sleep 1; done'] });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });

    return op;
  }

  const ended = (op: string) => (message: Message): boolean => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event));

  // teamai ends a live exec whose cancel has no outcome 15 s after it sent the cancel.
  it.each<{ options: Message; remove: string }>([
    { options: { provider: 'docker', image: IMAGE }, remove: 'docker rm --force' },
    { options: { provider: 'sbx', agent: 'claude' }, remove: 'sbx rm --force' },
  ])('answers the cancel of a live exec within 15 s when the $options.provider stop stalls, with cancel_failed and how to remove it', async ({ options, remove }) => {
    engine.image('claude', { claude: CLAUDE });
    const connection = start();
    await init(connection, options);
    const at = place();
    await openPlace(connection, at);
    const op = await runForever(connection, at);
    engine.stopDelay(60_000);
    const sent = Date.now();

    connection.send({ type: 'cancel', op });

    expect(await connection.next(ended(op), 15_000)).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(remove) } });
    expect(Date.now() - sent).toBeLessThan(15_000);
    engine.stopDelay(0);
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  }, 60_000);

  it('answers the cancel of a live exec within 15 s with cancel_failed when its process does not end after the stop', async () => {
    engine.stopLag(16_000);
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = await runForever(connection, at);
    const sent = Date.now();

    connection.send({ type: 'cancel', op });

    expect(await connection.next(ended(op), 15_000)).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(`teamai workflow cancel ${RUN}`) } });
    expect(Date.now() - sent).toBeLessThan(15_000);
  }, 60_000);

  it('reports a retried cancel running until its stop is confirmed, never the failure the cancel before left, then cancelled', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = await runForever(connection, at);
    engine.daemon(false);
    connection.send({ type: 'cancel', op });
    expect(await connection.next(ended(op), 15_000)).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed' } });
    engine.daemon(true);
    engine.stopDelay(1_500);

    connection.send({ type: 'cancel', op });
    connection.send({ type: 'reattach', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'alive', 5_000)).toMatchObject({ event: 'alive', ops: [{ op, state: 'running' }] });
    await vi.waitFor(async () => {
      connection.send({ type: 'reattach', handle: HANDLE });
      expect(await connection.next((message) => message.event === 'alive', 5_000)).toMatchObject({ ops: [{ op, state: 'cancelled' }] });
    }, { timeout: 15_000, interval: 200 });
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  }, 60_000);

  it('fails a cancel the engine could not stop for an exec a runtime teamai left still runs, and that exec is not kept again after close', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; while :; do sleep 1; done'] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    // teamai is gone: the first runtime keeps running the exec.
    first.child.stdin.end();
    const second = start();
    await init(second, { provider: 'docker', image: IMAGE });
    engine.daemon(false);

    second.send({ type: 'cancel', op });

    expect(await second.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 5_000)).toMatchObject({
      op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('docker rm --force') },
    });
    engine.daemon(true);
    second.send({ type: 'close', handle: HANDLE });

    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    await first.end();
    expect(engine.containers()).toEqual([]);
    expect(journalFiles().filter((file) => file.includes(op))).toEqual([]);
  });

  it('answers a runtime restarted while the engine is down, whose init failed, from its own record, and keeps the sandbox to close later', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    first.child.kill('SIGKILL');
    await first.end();
    engine.daemon(false);
    const second = start();

    expect(await init(second, { provider: 'docker', image: IMAGE })).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    second.send({ type: 'cancel', op });
    expect(await second.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 5_000)).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining("stays this attempt's") } });
    // teamai resends the exec after a restart: it is answered from the journal, and the place stays.
    second.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    expect(await second.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 5_000)).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed' } });
    second.send({ type: 'reattach', handle: HANDLE });
    expect(await second.next((message) => message.event === 'alive' || message.event === 'gone', 5_000)).toMatchObject({ event: 'alive', handle: HANDLE, ops: [{ op, state: 'failed' }] });
    second.send({ type: 'reattach', handle: 'teamai-r0123abcd-a99999999' });
    expect(await second.next((message) => message.handle === 'teamai-r0123abcd-a99999999', 5_000)).toEqual({ event: 'gone', handle: 'teamai-r0123abcd-a99999999' });
    second.send({ type: 'collect', handle: HANDLE });
    expect(await second.next((message) => message.event === 'collected' || message.event === 'collect_failed', 5_000)).toEqual({ event: 'collected', handle: HANDLE });
    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 5_000)).toMatchObject({ event: 'close_failed', handle: HANDLE, failure: { code: 'sandbox_unavailable', message: expect.stringContaining("stays this attempt's") } });

    engine.daemon(true);
    const third = start();
    await init(third, { provider: 'docker', image: IMAGE });
    third.send({ type: 'close', handle: HANDLE });
    expect(await third.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  });

  it('opens in recover mode while the engine is down without running it, and offers nothing', async () => {
    engine.daemon(false);
    const connection = start();

    expect(await init(connection, { provider: 'docker', image: IMAGE }, 'recover')).toEqual({ type: 'init', ok: true, can: {} });
    expect(engine.calls()).toEqual([]);
  });

  it("stops and removes a dead runtime's exec in recover mode, running the engine only for the stop and the removal", async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    first.child.kill('SIGKILL');
    await first.end();
    const before = engine.calls().length;
    const second = start();

    expect(await init(second, { provider: 'docker', image: IMAGE }, 'recover')).toEqual({ type: 'init', ok: true, can: {} });
    second.send({ type: 'cancel', op });
    expect(await second.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 30_000)).toEqual({ op, event: 'cancelled' });
    second.send({ type: 'reattach', handle: HANDLE });
    expect(await second.next((message) => message.event === 'alive' || message.event === 'gone' || message.event === 'failed')).toMatchObject({ event: 'alive', handle: HANDLE, ops: [{ op, state: 'cancelled' }] });
    second.send({ type: 'collect', handle: HANDLE });
    expect(await second.next((message) => message.handle === HANDLE && message.event !== 'alive')).toEqual({ event: 'collected', handle: HANDLE });
    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });

    expect(engine.calls().slice(before).map(([, command]) => command)).toEqual(['restart', 'rm']);
    expect(engine.containers()).toEqual([]);
  });

  it('answers a reattach from its journal alone, without asking the engine, even while the engine is down', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openPlace(connection, place());
    engine.daemon(false);
    const before = engine.calls().length;
    connection.send({ type: 'reattach', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'alive' || message.event === 'gone' || message.event === 'failed')).toEqual({ event: 'alive', handle: HANDLE, ops: [], display: { label: `${HANDLE} (docker)`, fields: { container: HANDLE, image: IMAGE } } });
    expect(engine.calls().slice(before)).toEqual([]);
    // An error line would fail every request teamai is waiting on.
    expect(connection.messages.filter((message) => message.event === 'error')).toEqual([]);
  });

  // teamai's order after a driver died: cancel the exec, reattach until it no longer runs, collect, close.
  it.each<{ options: Message; remove: string }>([
    { options: { provider: 'docker', image: IMAGE }, remove: 'docker rm --force' },
    { options: { provider: 'sbx', agent: 'claude' }, remove: 'sbx rm --force' },
  ])("keeps a dead runtime's $options.provider sandbox through a reattach while the engine is down, and removes it at close", async ({ options, remove }) => {
    engine.image('claude', { claude: CLAUDE });
    const first = start();
    await init(first, options);
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    first.child.kill('SIGKILL');
    await first.end();
    const second = start();
    await init(second, options);
    engine.daemon(false);

    second.send({ type: 'cancel', op });
    await second.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 30_000);
    second.send({ type: 'reattach', handle: HANDLE });

    // Not gone: the journal still holds the place, so it is still this attempt's, and the cleanup command is the op's.
    expect(await second.next((message) => message.event === 'alive' || message.event === 'gone', 30_000)).toMatchObject({
      event: 'alive', handle: HANDLE, ops: [{ op, state: 'failed', failure: { message: expect.stringContaining(remove) } }],
    });
    expect(second.messages.filter((message) => message.event === 'error')).toEqual([]);
    second.send({ type: 'collect', handle: HANDLE });
    await second.next((message) => message.event === 'collected' || message.event === 'collect_failed');
    engine.daemon(true);
    second.send({ type: 'close', handle: HANDLE });

    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  });

  it("answers an exec, a close and a reattach it cannot read the journal for with their own failure, naming the record, so teamai never waits on them", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const record = journalFiles().find((file) => file.includes(`${path.sep}places${path.sep}`)) ?? '';
    fs.writeFileSync(record, '{"run":');
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'echo ran'] });

    expect(await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 5_000)).toMatchObject({ op, event: 'failed', failure: { code: 'runtime_failed', message: expect.stringContaining(record) } });
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.handle === HANDLE && message.event !== 'ready', 5_000)).toMatchObject({ event: 'failed', handle: HANDLE, failure: { code: 'runtime_failed', message: expect.stringContaining(record) } });
    connection.send({ type: 'reattach', handle: HANDLE });
    expect(await connection.next((message) => message.handle === HANDLE, 5_000)).toMatchObject({ event: 'failed', handle: HANDLE, failure: { code: 'runtime_failed', message: expect.stringContaining(record) } });
    // An error line would fail every other request teamai is waiting on.
    expect(connection.messages.filter((message) => message.event === 'error')).toEqual([]);
    // Nothing is taken as absent: the container and its record stay for a close once the journal is mended.
    expect(engine.containers()).toEqual([HANDLE]);
    expect(fs.existsSync(record)).toBe(true);
  });

  it('answers a resent exec whose own record it cannot read with that exec\'s failure, never silence', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    await exec(connection, { argv: ['/bin/sh', '-c', 'echo ran'], cwd: at.worktree }, op);
    const record = journalFiles().find((file) => file.endsWith(`${op}.json`)) ?? '';
    fs.writeFileSync(record, '{"handle":');
    const before = connection.messages.length;
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'echo ran'] });

    expect(await connection.next((message) => message.op === op && connection.messages.indexOf(message) >= before && message.event !== 'output', 5_000)).toMatchObject({ op, event: 'failed', failure: { code: 'runtime_failed', message: expect.stringContaining(record) } });
    expect(connection.messages.filter((message) => message.event === 'error')).toEqual([]);
  });

  it('collects with the work already at its host path, and close removes the container', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    await exec(connection, { argv: ['/bin/sh', '-c', 'echo kept > work.txt; exit 1'], cwd: at.worktree });

    connection.send({ type: 'collect', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'collected')).toEqual({ event: 'collected', handle: HANDLE });
    expect(fs.readFileSync(path.join(at.worktree, 'work.txt'), 'utf8')).toBe('kept\n');
    expect(fs.statSync(path.join(at.worktree, 'work.txt')).uid).toBe(process.getuid?.());

    connection.send({ type: 'close', handle: HANDLE });
    await connection.next((message) => message.event === 'closed');
    expect(engine.containers()).toEqual([]);
    connection.send({ type: 'reattach', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'gone' || message.event === 'alive')).toEqual({ event: 'gone', handle: HANDLE });
  });

  it('fails an open when the engine stopped since init, with what it said', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    engine.daemon(false);

    expect((await openPlace(connection, place())).ready).toMatchObject({ event: 'failed', failure: { code: 'sandbox_failed', message: expect.stringContaining('Cannot connect') } });
  });
});

// A judge's tools: each lists the files it can see from its working directory, says which credential names it got
// (names only), and replies as the real tool does on stdout.
const SEES = "const fs = require('node:fs'); const sees = fs.readdirSync('.', { recursive: true }).map(String).filter((file) => fs.statSync(file).isFile()).sort();";
const NAMES = "const names = ['ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'HTTPS_PROXY'].filter((name) => process.env[name] !== undefined); const given = Object.keys(process.env).filter((name) => process.env[name].includes('given')).sort();";
const JUDGE_CLAUDE = `if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
${SEES} ${NAMES}
if (process.argv.includes('--hang')) setInterval(() => {}, 1000);
else console.log(JSON.stringify({ type: 'result', is_error: false, session_id: 'claude-session-1', result: '', structured_output: { answer: { label: 'good', reasoning: JSON.stringify({ sees, names, given, argv: process.argv.slice(2) }) } }, usage: { input_tokens: 12, output_tokens: 5 } }));`;
const JUDGE_CODEX = `${SEES} ${NAMES}
const schema = require('node:fs').readFileSync(process.argv[process.argv.indexOf('--output-schema') + 1], 'utf8');
const argv = process.argv.slice(2);
const retried = argv.at(-1).includes('flaky network') ? [{ type: 'error', message: 'Reconnecting... 1/5' }] : [];
for (const line of [{ type: 'thread.started', thread_id: 'codex-thread-1' }, ...retried, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ answer: { label: 'bad', reasoning: JSON.stringify({ sees, names, given, schema, argv }) } }) } }, { type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 7 } }]) console.log(JSON.stringify(line));`;

describe('a judge (a confined prompt) in a container of its own', () => {
  const SCHEMA = { type: 'object', properties: { answer: { type: 'object' } }, required: ['answer'] };
  let evidence: string;

  beforeEach(() => {
    engine.image(IMAGE, { claude: JUDGE_CLAUDE, codex: JUDGE_CODEX, node: '' });
    evidence = path.join(dir, 'runs', RUN, 'scratch', 'a0000beef');
    fs.mkdirSync(path.join(evidence, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(evidence, 'transcript.jsonl'), '{}\n');
    fs.writeFileSync(path.join(evidence, 'nested', 'diff.patch'), '');
  });

  /** Opens a confined prompt's place: no view of the host, and the credentials teamai gives the judge. */
  async function openJudge(connection: Connection, credentials: Record<string, string>): Promise<Message> {
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials });
    const first = await connection.next((message) => message.op === op && (message.event === 'accepted' || message.event === 'failed'));

    return first.event === 'failed' ? first : connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000);
  }

  async function judge(connection: Connection, { tool = 'claude', credentials, op = newOp(), lease = {}, ms = 30_000 }: { tool?: string; credentials: Record<string, string>; op?: string; lease?: Message; ms?: number }): Promise<Message> {
    connection.send({
      type: 'prompt', op, handle: HANDLE, env: {}, unset: [], credentials, cwd: evidence,
      lease: { step: 'review', tool, prompt: 'Judge the work in this directory.', result: path.join(dir, 'attempts', ATTEMPT, 'out', 'result.json'), permissions: 'approval-required', interactive: false, ...lease },
      confined: { dir: evidence, level: 'verified', access: 'read', schema: SCHEMA },
    });

    return connection.next((message) => message.op === op && ['finished', 'failed', 'cancelled'].includes(String(message.event)), ms);
  }

  const reasoning = (end: Message): { sees: string[]; names: string[]; given: string[]; argv?: string[]; schema?: string } => {
    const parsed: unknown = JSON.parse(String((end as { result: { output: { answer: { reasoning: string } } } }).result.output.answer.reasoning));

    return parsed as { sees: string[]; names: string[]; given: string[]; argv?: string[]; schema?: string };
  };

  // teamai gives a judge on a runtime the definition's credentials that a confined run of its tool reads: the common
  // names (proxies, CA files, PATH, HOME…) and its profile's own. The judge's tool gets every profile name but its home,
  // and none of the host's own: its one way out is the filter, and a host path means nothing in the container.
  it.each([
    { tool: 'claude', profile: BUILT_IN_TOOLS.claude.launch.claude.confined },
    { tool: 'codex', profile: BUILT_IN_TOOLS.codex.launch.codex.confined },
  ])("gives a $tool judge each name its confined profile reads but its home, and none of this machine's own", async ({ tool, profile }) => {
    const own = Object.fromEntries(profile.env.map((name) => [name, name.endsWith('_BASE_URL') ? 'https://given.llm.acme.internal/v1' : `given-${name.toLowerCase()}`]));
    const credentials = { ...own, HTTPS_PROXY: 'http://given-proxy.acme.internal:3128', HTTP_PROXY: 'http://given-proxy.acme.internal:3128', NO_PROXY: 'given.acme.internal', SSL_CERT_FILE: '/Users/given/ca.pem', NODE_EXTRA_CA_CERTS: '/Users/given/ca.pem', PATH: '/Users/given/bin', HOME: '/Users/given' };
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE }, 'unattended', { env: Object.keys(credentials), logins: [] });
    await openJudge(connection, credentials);

    expect(reasoning(await judge(connection, { tool, credentials })).given).toEqual(profile.env.filter((name) => name !== profile.homeEnv).sort());
  });

  it('offers no judge on podman, whose rootless network cannot hold the filter', async () => {
    const reply = await init(start(), { provider: 'podman', image: IMAGE });

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] } });
    expect(reply).not.toHaveProperty('confinedPrompt');
  });

  it("signs a codex judge in with an OPENAI_API_KEY under Codex's own variable, and points it at the base URL by its config", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const credentials = { OPENAI_API_KEY: 'judge-key-2', OPENAI_BASE_URL: 'https://llm.acme.internal:8443/v1' };
    await openJudge(connection, credentials);
    const end = await judge(connection, { tool: 'codex', credentials });

    expect(reasoning(end).names).toEqual(['CODEX_API_KEY', 'OPENAI_API_KEY', 'HTTPS_PROXY']);
    expect(reasoning(end).argv).toEqual(expect.arrayContaining(['-c', 'openai_base_url="https://llm.acme.internal:8443/v1"']));
    // Claude's tool names would send Codex looking for tools it does not have.
    expect(JSON.stringify(reasoning(end).argv)).not.toMatch(/\b(Read|Grep|Glob)\b/);
    // The base URL reaches Codex from the container's env, never in teamai's argv.
    expect(JSON.stringify(engine.calls())).not.toContain('llm.acme.internal:8443/v1');
    expect(JSON.stringify(engine.calls())).not.toContain('judge-key-2');
  });

  it('signs a codex judge in with a CODEX_API_KEY as it is given', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE }, 'unattended', { env: ['CODEX_API_KEY'], logins: [] });
    await openJudge(connection, { CODEX_API_KEY: 'judge-key-3' });

    expect(reasoning(await judge(connection, { tool: 'codex', credentials: { CODEX_API_KEY: 'judge-key-3' } })).names).toEqual(['CODEX_API_KEY', 'HTTPS_PROXY']);
  });

  it('accepts a codex reply after Codex reconnected on its way there', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { OPENAI_API_KEY: 'judge-key-2' });

    expect(await judge(connection, { tool: 'codex', credentials: { OPENAI_API_KEY: 'judge-key-2' }, lease: { prompt: 'Judge it over a flaky network.' } })).toMatchObject({ event: 'finished', result: { output: { answer: { label: 'bad' } } } });
  });

  it('keeps DNS and the host out of the judge network', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' } });

    expect(engine.calls().find(([, command, action]) => command === 'network' && action === 'create')).toEqual(expect.arrayContaining(['--internal', '-o', 'com.docker.network.bridge.inhibit_ipv4=true']));
  });

  it('says it answers confined prompts, and offers the tools the image holds at verified, with what each can do there', async () => {
    // Claude gets only its file tools; Codex runs with the container as its sandbox, so it can run commands there.
    expect(await init(start(), { provider: 'docker', image: IMAGE })).toMatchObject({
      ok: true, confinedPrompt: true, can: { confined: [{ level: 'verified', access: 'read', tools: ['claude'] }, { level: 'verified', access: 'full', tools: ['codex'] }] },
    });
  });

  it.each<{ env: string[]; logins: string[]; offered: Message[] }>([
    { env: ['ANTHROPIC_API_KEY'], logins: [], offered: [{ level: 'verified', access: 'read', tools: ['claude'] }] },
    { env: ['OPENAI_API_KEY', 'GITHUB_TOKEN'], logins: ['claude'], offered: [{ level: 'verified', access: 'full', tools: ['codex'] }] },
    { env: ['CODEX_API_KEY'], logins: [], offered: [{ level: 'verified', access: 'full', tools: ['codex'] }] },
  ])('offers a judge only on the tools whose credentials the definition names: $env', async ({ env, logins, offered }) => {
    expect(await init(start(), { provider: 'docker', image: IMAGE }, 'unattended', { env, logins })).toMatchObject({ ok: true, confinedPrompt: true, can: { confined: offered } });
  });

  it.each<{ env: string[]; logins: string[] }>([
    { env: [], logins: ['claude', 'codex'] },
    { env: ['GITHUB_TOKEN'], logins: [] },
  ])('offers no judge when it could sign none in, so teamai judges on a later runtime: $env $logins', async ({ env, logins }) => {
    const reply = await init(start(), { provider: 'docker', image: IMAGE }, 'unattended', { env, logins });

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] } });
    expect(reply).not.toHaveProperty('confinedPrompt');
    expect(reply.can).not.toHaveProperty('confined');
  });

  it.each([
    ['ANTHROPIC_BASE_URL', 'http://127.0.0.1:4000'],
    ['ANTHROPIC_BASE_URL', 'http://localhost:4000/v1'],
    ['OPENAI_BASE_URL', 'http://[::1]:8080/v1'],
    ['OPENAI_BASE_URL', 'https://127.8.9.10/v1'],
    ['ANTHROPIC_BASE_URL', 'http://localhost.:4000'],
    ['OPENAI_BASE_URL', 'http://[::ffff:127.0.0.1]:8080/v1'],
    ['ANTHROPIC_BASE_URL', 'http://0.0.0.0:4000'],
  ])("refuses a judge whose %s points at this machine's loopback, naming the variable and never its value", async (name, value) => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const opened = await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1', OPENAI_API_KEY: 'judge-key-2', [name]: value });

    expect(opened).toMatchObject({ event: 'failed', failure: { code: 'bad_option', key: `credentials.${name}` } });
    const message = String((opened.failure as Message).message);

    expect(message).toContain(name);
    expect(message).toContain('host.docker.internal');
    expect(message).not.toContain(new URL(value).hostname.replace(/\.$/, ''));
    expect(engine.containers()).toEqual([]);
    expect(engine.networks()).toEqual([]);
  });

  it("refuses a step whose base URL points at this machine's loopback, before it creates the container", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials: { ANTHROPIC_API_KEY: 'step-key', ANTHROPIC_BASE_URL: 'http://localhost:4000' }, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });

    expect(await connection.next((message) => message.op === op && (message.event === 'failed' || message.event === 'ready'))).toMatchObject({ event: 'failed', failure: { code: 'bad_option', key: 'credentials.ANTHROPIC_BASE_URL' } });
    expect(engine.containers()).toEqual([]);
  });

  it('mounts the evidence at /evidence alone, and names it there in the prompt, so the judge never sees where it lives on the host', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    const end = await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, lease: { prompt: `Read only the files under ${evidence}:\nthe diff in ${evidence}/nested/diff.patch, and the schema in ${evidence}/answer.schema.json.` } });
    const seen = reasoning(end);
    const judgeRun = engine.calls().find((call) => call.includes(HANDLE) && call.includes('-d')) ?? [];
    const toolExec = engine.calls().find(([, command]) => command === 'exec') ?? [];

    expect(seen.sees).toEqual(['nested/diff.patch', 'transcript.jsonl']);
    expect(judgeRun.filter((arg, index) => judgeRun[index - 1] === '-v')).toEqual([`${evidence}:/evidence:ro`]);
    expect(toolExec.slice(toolExec.indexOf('-w'), toolExec.indexOf('-w') + 2)).toEqual(['-w', '/evidence']);
    expect(seen.argv).toEqual(expect.arrayContaining(['Read only the files under /evidence:\nthe diff in /evidence/nested/diff.patch, and the schema in /evidence/answer.schema.json.']));
    expect(JSON.stringify(seen.argv)).not.toContain(dir);
  });

  it("leaves a sibling of the evidence directory as the prompt wrote it, since it is not what the judge sees at /evidence", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    const { argv = [] } = reasoning(await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, lease: { prompt: `Read ${evidence}/diff.patch, not ${evidence}-old/diff.patch nor ${evidence}.bak, and end at ${evidence}.` } }));

    expect(argv).toContain(`Read /evidence/diff.patch, not ${evidence}-old/diff.patch nor ${evidence}.bak, and end at /evidence.`);
  });

  it('offers no confined prompt from an image without node, which runs the network filter', async () => {
    engine.image('ghcr.io/acme/native-claude:1', { claude: JUDGE_CLAUDE });
    const reply = await init(start(), { provider: 'docker', image: 'ghcr.io/acme/native-claude:1' });

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude'] } });
    expect(reply).not.toHaveProperty('confinedPrompt');
    expect(reply.can).not.toHaveProperty('confined');
  });

  it('answers with only the evidence directory mounted, read-only, on a network that reaches only the model provider, and reports verified', async () => {
    const connection = start({ GITHUB_TOKEN: 'forge-value-1' });
    await init(connection, { provider: 'docker', image: IMAGE });

    expect(await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' })).toMatchObject({ event: 'ready' });
    // Nothing is created before the prompt names its directory.
    expect(engine.containers()).toEqual([]);

    const end = await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, lease: { model: { name: 'claude-sonnet-4-5' } } });

    expect(end).toMatchObject({
      event: 'finished', session: { tool: 'claude', id: 'claude-session-1' }, result: { output: { answer: { label: 'good' } } },
      usage: { input: 12, output: 5 }, confined: { level: 'verified', access: 'read' },
    });
    const seen = reasoning(end);

    expect(seen.sees).toEqual(['nested/diff.patch', 'transcript.jsonl']);
    expect(seen.names).toEqual(['ANTHROPIC_API_KEY', 'HTTPS_PROXY']);
    expect(seen.argv).toEqual(expect.arrayContaining(['--tools', 'Read,Grep,Glob', '--model', 'claude-sonnet-4-5', '--json-schema', JSON.stringify(SCHEMA)]));

    const runs = engine.calls().filter(([, command, detached]) => command === 'run' && detached === '-d');
    const judgeRun = runs.find((call) => call.includes(HANDLE)) ?? [];
    const proxyRun = runs.find((call) => call.includes(`${HANDLE}-proxy`)) ?? [];

    // Only the evidence directory, read-only.
    expect(judgeRun.filter((arg, index) => judgeRun[index - 1] === '-v')).toEqual([`${evidence}:/evidence:ro`]);
    expect(judgeRun.join(' ')).toContain(`--network ${HANDLE}-net`);
    expect(judgeRun.join(' ')).toContain('--cap-drop ALL');
    expect(engine.calls()).toContainEqual(['docker', 'network', 'create', '--internal', '-o', 'com.docker.network.bridge.inhibit_ipv4=true', '--label', `teamai.run=${RUN}`, '--label', `teamai.attempt=${ATTEMPT}`, `${HANDLE}-net`]);
    // The filter in front of that network lets through only the provider's host.
    expect(proxyRun.at(-2)).toBe('3128');
    expect(proxyRun.at(-1)).toBe('api.anthropic.com:443');
    expect(proxyRun.filter((arg, index) => proxyRun[index - 1] === '-v')).toEqual([]);
    expect(engine.calls()).toContainEqual(['docker', 'network', 'connect', `${HANDLE}-net`, `${HANDLE}-proxy`]);
    expect(JSON.stringify(engine.calls())).not.toContain('judge-key-1');

    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed')).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
    expect(engine.networks()).toEqual([]);
  });

  it.each<{ tool: string; credentials: Record<string, string> }>([
    { tool: 'claude', credentials: { ANTHROPIC_API_KEY: 'judge-key-1' } },
    { tool: 'codex', credentials: { OPENAI_API_KEY: 'judge-key-2' } },
  ])('tells a $tool judge it may list, search and read the files it judges', async ({ tool, credentials }) => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, credentials);
    const { argv = [] } = reasoning(await judge(connection, { tool, credentials }));

    expect(argv.at(-1)).toContain('List, search and read the files in this directory');
  });

  it('lets a judge reach only the base URL its credentials name, in place of the public API', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const credentials = { ANTHROPIC_API_KEY: 'judge-key-1', ANTHROPIC_BASE_URL: 'https://llm-gateway.acme.internal:8443/anthropic' };
    await openJudge(connection, credentials);

    expect(await judge(connection, { credentials })).toMatchObject({ event: 'finished' });
    const proxyRun = engine.calls().find((call) => call.includes(`${HANDLE}-proxy`) && call.includes('-d')) ?? [];

    expect(proxyRun.slice(-2)).toEqual(['3128', 'llm-gateway.acme.internal:8443']);
  });

  it('judges on codex with its reply schema, and returns its own session', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { OPENAI_API_KEY: 'judge-key-2' });
    const end = await judge(connection, { tool: 'codex', credentials: { OPENAI_API_KEY: 'judge-key-2' } });

    expect(end).toMatchObject({
      event: 'finished', session: { tool: 'codex', id: 'codex-thread-1' }, result: { output: { answer: { label: 'bad' } } },
      usage: { input: 30, output: 7, cachedInput: 10 }, confined: { level: 'verified', access: 'full' },
    });
    expect(JSON.parse(String(reasoning(end).schema))).toEqual(SCHEMA);
    expect(reasoning(end).sees).toEqual(['nested/diff.patch', 'transcript.jsonl']);
    expect((engine.calls().find((call) => call.includes(`${HANDLE}-proxy`) && call.includes('-d')) ?? []).at(-1)).toBe('api.openai.com:443');
  });

  it('refuses a judge that brings no credential, as a login-only definition, naming the env credential to add', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const opened = await openJudge(connection, {});

    expect(opened).toMatchObject({ event: 'failed', failure: { code: 'credential_missing' } });
    expect(String((opened.failure as Message).message)).toMatch(/OPENAI_API_KEY: env:OPENAI_API_KEY/);
    expect(String((opened.failure as Message).message)).toMatch(/codex: login/);
    expect(engine.containers()).toEqual([]);
  });

  it("refuses a judge whose credentials are not its tool's, before it starts anything", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    const end = await judge(connection, { tool: 'codex', credentials: { ANTHROPIC_API_KEY: 'judge-key-1' } });

    expect(end).toMatchObject({ event: 'failed', failure: { code: 'credential_missing', message: expect.stringContaining('OPENAI_API_KEY') } });
    expect(engine.containers()).toEqual([]);
  });

  it('answers a repeated prompt id with the same outcome, and reattach reports it', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    const op = newOp();
    const first = await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, op });

    expect(await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, op })).toEqual(first);
    // The tool ran once.
    expect(engine.calls().filter(([, command]) => command === 'exec')).toHaveLength(1);
    connection.send({ type: 'reattach', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'alive' || message.event === 'gone')).toMatchObject({ event: 'alive', ops: [{ op, state: 'finished', session: { tool: 'claude' } }] });
  });

  it("answers a prompt whose judge's place record it cannot read with that prompt's failure, never silence", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    const record = journalFiles().find((file) => file.includes(`${path.sep}places${path.sep}`)) ?? '';
    fs.writeFileSync(record, '{"run":');

    expect(await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, ms: 5_000 })).toMatchObject({ event: 'failed', failure: { code: 'runtime_failed', message: expect.stringContaining(record) } });
    expect(connection.messages.filter((message) => message.event === 'error')).toEqual([]);
  });

  it('stops a judge on cancel', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    const op = newOp();
    const ended = judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, op, lease: { model: { name: '--hang' } } });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    await new Promise((resolve) => setTimeout(resolve, 500));
    connection.send({ type: 'cancel', op });

    expect(await ended).toEqual({ op, event: 'cancelled' });
    // The judge's container is gone, so an exec still on its way to the engine has nothing to start in.
    expect(engine.containers()).toEqual([`${HANDLE}-proxy`]);
  });

  it('keeps a numeric score when a setting the judge is given is a number, and its place still closes', async () => {
    engine.image(IMAGE, { node: '', claude: `if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
console.log(JSON.stringify({ type: 'result', is_error: false, session_id: 'claude-session-1', result: '', structured_output: { answer: { label: 'good', score: 1, passed: true } } }));` });
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const credentials = { ANTHROPIC_API_KEY: 'judge-key-1', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' };
    await openJudge(connection, credentials);

    expect(await judge(connection, { credentials, ms: 10_000 })).toMatchObject({ event: 'finished', result: { output: { answer: { label: 'good', score: 1, passed: true } } } });
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed')).toEqual({ event: 'closed', handle: HANDLE });
  });

  it("removes a judge's container at close after a restarted runtime that offers no judge refused its resent prompt", async () => {
    const credentials = { ANTHROPIC_API_KEY: 'judge-key-1' };
    const lease = { model: { name: '--hang' } };
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    await openJudge(first, credentials);
    const op = newOp();
    judge(first, { credentials, op, lease }).catch(() => {});
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(engine.calls().some(([, command]) => command === 'exec')).toBe(true); }, { timeout: 10_000 });
    first.child.kill('SIGKILL');
    await first.end();
    // The definition now gives this runtime no judge key, so it offers no judge.
    const second = start();
    expect(await init(second, { provider: 'docker', image: IMAGE }, 'unattended', { env: [], logins: [] })).not.toHaveProperty('confinedPrompt');

    expect(await judge(second, { credentials, op, lease })).toMatchObject({ op, event: 'failed' });
    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
    expect(engine.networks()).toEqual([]);
  });

  it("gives a judge only its own tool's credentials", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const credentials = { ANTHROPIC_API_KEY: 'judge-key-1', OPENAI_API_KEY: 'judge-key-2' };
    await openJudge(connection, credentials);

    expect(reasoning(await judge(connection, { credentials })).names).toEqual(['ANTHROPIC_API_KEY', 'HTTPS_PROXY']);
  });

  it("refuses an exec in a judge's place", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' } });

    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'echo ran'], cwd: evidence })).end).toMatchObject({ event: 'failed', failure: { code: 'bad_request' } });
    expect(engine.calls().filter(([, command]) => command === 'exec')).toHaveLength(1);
  });

  it('offers no judge on a docker that lets DNS out of an internal network', async () => {
    const reply = await init(start({ FAKE_ENGINE_VERSION: '25.0.3' }), { provider: 'docker', image: IMAGE });

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] } });
    expect(reply.can).not.toHaveProperty('confined');
  });

  it('refuses a confined prompt in a place opened with a view of the host', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openPlace(connection, place());

    expect(await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' } })).toMatchObject({ event: 'failed', failure: { code: 'bad_request' } });
  });
});

// ─── sbx (Docker Sandboxes): a microVM per attempt, from the agent's template ───

const SBX_CODEX = `if (process.argv.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
const fs = require('node:fs'); const path = require('node:path');
// Codex signs in from its home's auth.json, or from OPENAI_API_KEY, here the placeholder sbx's proxy swaps for the stored login.
const login = fs.existsSync(path.join(process.env.CODEX_HOME, 'auth.json')) ? 'file' : process.env.OPENAI_API_KEY === 'proxy-managed' ? 'proxy' : 'none';
fs.mkdirSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'sessions', 'rollout.jsonl'), '{}\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-1', login }));
process.exit(login === 'none' ? 1 : 0);`;

describe('an attempt in an sbx sandbox', () => {
  beforeEach(() => {
    engine.image('claude', { claude: CLAUDE });
    engine.image('codex', { codex: SBX_CODEX });
    engine.image('shell', {});
  });

  it('fails init without an agent, since the bare shell template holds none, naming the key', async () => {
    const missing = await init(start(), { provider: 'sbx' });

    expect(missing).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'agent' } });
    expect(JSON.stringify(missing)).toMatch(/agent: claude/);
    expect(await init(start(), { provider: 'sbx', agent: 'shell' })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'agent' } });
  });

  it("fails init on an option sbx does not take, as a container's image", async () => {
    expect(await init(start(), { provider: 'sbx', agent: 'claude', image: IMAGE })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'image' } });
  });

  it('fails init with sandbox_unavailable and how to install it when sbx is not on PATH', async () => {
    const empty = path.join(dir, 'empty-bin');
    fs.mkdirSync(empty);
    const reply = await init(start({ PATH: empty }), { provider: 'sbx', agent: 'claude' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(JSON.stringify(reply)).toContain('Docker Sandboxes');
  });

  it('fails init with sandbox_unavailable when sandboxd is down, with what sbx said and the command that starts it', async () => {
    engine.daemon(false);
    const reply = await init(start(), { provider: 'sbx', agent: 'claude' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable', message: expect.stringContaining('cannot connect to sandboxd') } });
    expect(JSON.stringify(reply)).toContain('sbx daemon start');
  });

  it('fails init with sandbox_unavailable, naming the command, when no network policy was ever set, and never sets one itself', async () => {
    engine.policy(false);
    const reply = await init(start(), { provider: 'sbx', agent: 'claude' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable', message: expect.stringContaining('sbx policy init balanced') } });
    expect(engine.calls().filter(([name, command, action]) => name === 'sbx' && command === 'policy' && action !== 'ls')).toEqual([]);
  });

  it("offers a sandbox with the agent's tool, no network, and no judge", async () => {
    const reply = await init(start(), { provider: 'sbx', agent: 'codex' }, 'unattended', { env: ['OPENAI_API_KEY'], logins: [] });

    expect(reply).toMatchObject({ ok: true, can: { isolation: 'sandbox', env: true, unattended: true, setup: true, workspace: ['read-only', 'new', 'continue'], tools: ['codex'] } });
    expect(reply.can).not.toHaveProperty('network');
    expect(reply.can).not.toHaveProperty('confined');
    expect(reply).not.toHaveProperty('confinedPrompt');
  });

  it("opens one sandbox per attempt from the agent's template, at the place's host paths, git paths read-only, with no credential, and shows it in the dashboard", async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    const at = place();
    const { accepted, ready } = await openPlace(connection, at, newOp(), { credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-1' } });

    expect(accepted.handle).toBe(HANDLE);
    expect(ready).toMatchObject({ event: 'ready', display: { label: `${HANDLE} (sbx)`, fields: { sandbox: HANDLE, agent: 'claude' } } });
    // A new open of the same attempt finds that sandbox by its name instead of creating a second.
    expect((await openPlace(connection, at)).ready).toMatchObject({ event: 'ready' });
    expect(engine.containers()).toEqual([HANDLE]);

    const creates = engine.calls().filter(([name, command]) => name === 'sbx' && command === 'create');

    expect(creates).toHaveLength(1);
    // The worktree is the primary workspace; every other path keeps its host path, the git paths read-only.
    expect(creates[0]).toEqual(['sbx', 'create', '--name', HANDLE, '--no-progress', 'claude', at.worktree, at.result, at.runDir, at.toolHome, `${at.git}:ro`]);
    expect(JSON.stringify(engine.calls())).not.toContain('oauth-value-1');
    expect(fs.existsSync(at.toolHome)).toBe(true);
  });

  it('runs an exec with its credentials by name only, unsets the withheld names, and keeps the rest of the sandbox env', async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    const at = place();
    await openPlace(connection, at);
    const script = 'token=unset; case "${CLAUDE_CODE_OAUTH_TOKEN-}" in oauth-value-[1]) token=given;; esac; printf "%s|%s|%s|%s" "${STEP_VALUE-unset}" "$token" "${GH_TOKEN-unset}" "$(pwd)"; exit 4';

    expect((await exec(connection, { argv: ['/bin/sh', '-c', script], env: { STEP_VALUE: 'step-value-1' }, credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-1' }, cwd: at.worktree })).end)
      .toEqual({ op: expect.any(String), event: 'exited', code: 4, stdout: `step-value-1|given|proxy-managed|${at.worktree}` });
    // A strict step withholds the forge names, which sbx's own env sets as placeholders.
    expect((await exec(connection, { argv: ['/bin/sh', '-c', script], unset: ['GH_TOKEN'], cwd: at.worktree })).end).toMatchObject({ stdout: `unset|unset|unset|${at.worktree}` });
    expect(JSON.stringify(engine.calls())).not.toMatch(/oauth-value-1|step-value-1/);
    expect(journalFiles().map((file) => fs.readFileSync(file, 'utf8')).join('\n')).not.toContain('oauth-value-1');
  });

  it("runs codex on the login sbx's proxy holds (sbx secret set openai --oauth), with no login file in the attempt's tool home", async () => {
    engine.secret('openai', true);
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'codex' });
    const at = { ...place(), toolHome: path.join(dir, 'attempts', ATTEMPT, 'tool-home', 'codex') };
    connection.send({ type: 'open', op: newOp(), run: RUN, attempt: ATTEMPT, credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CODEX_HOME: at.toolHome } } });
    await connection.next((message) => message.event === 'ready' || message.event === 'failed', 30_000);

    const { end } = await exec(connection, { argv: ['codex', 'exec', '--json', 'Review it.'], env: { CODEX_HOME: at.toolHome }, cwd: at.worktree });

    expect(end).toMatchObject({ event: 'exited', code: 0, stdout: expect.stringContaining('"login":"proxy"') });
    expect(fs.existsSync(path.join(at.toolHome, 'sessions', 'rollout.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(at.toolHome, 'auth.json'))).toBe(false);
  });

  it('runs an exec in a sandbox sbx stopped while idle, and keeps its start notice out of the stdout', async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    const at = place();
    await openPlace(connection, at);
    // sbx stops an idle sandbox on its own.
    const stop = execFileSync(path.join(engine.bin, 'sbx'), ['stop', HANDLE], { env: engine.env(), encoding: 'utf8' });

    expect(stop).toContain('Stopped');
    const op = newOp();

    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'claude --version; echo step-err >&2'], cwd: at.worktree }, op)).end).toMatchObject({ event: 'exited', code: 0, stdout: '2.1.0 (Claude Code)\n' });
    expect(connection.messages.filter((message) => message.op === op && message.stream === 'stderr').map((message) => message.data).join('')).toBe('step-err\n');
  });

  it("keeps the sandbox's own HOME when an exec names one, and still reaches sbx", async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    const at = place();
    await openPlace(connection, at);

    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'printf "%s" "$HOME"'], env: { HOME: path.join(dir, 'elsewhere') }, cwd: at.worktree })).end)
      .toMatchObject({ event: 'exited', code: 0, stdout: expect.not.stringContaining('elsewhere') });
  });

  it('offers the tools a kit brings, found in a scratch sandbox it then removes', async () => {
    engine.image('./kits/review', { claude: CLAUDE, codex: SBX_CODEX });
    const reply = await init(start(), { provider: 'sbx', agent: './kits/review' });

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] } });
    expect(engine.containers()).toEqual([]);
  });

  it('fails init, naming the command, when it cannot remove the scratch sandbox it probed a kit in', async () => {
    engine.image('./kits/review', { claude: CLAUDE });
    engine.failRemove(true);
    const reply = await init(start(), { provider: 'sbx', agent: './kits/review' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable', message: expect.stringMatching(/sbx rm --force teamai-tools-[0-9a-f]{8}/) } });
  });

  it('stops the step on cancel and keeps the sandbox for the next exec; close removes it, and reattach then says gone', async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    connection.send({ type: 'cancel', op });

    expect(await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 30_000)).toEqual({ op, event: 'cancelled' });
    expect(engine.containers()).toEqual([HANDLE]);
    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'echo again'], cwd: at.worktree })).end).toMatchObject({ event: 'exited', code: 0, stdout: 'again\n' });

    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed')).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
    connection.send({ type: 'reattach', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'gone' || message.event === 'alive')).toEqual({ event: 'gone', handle: HANDLE });
  });

  it('reattaches by name after the runtime is killed mid-step, reports the exec it lost, and close then leaves no sandbox', async () => {
    const first = start();
    await init(first, { provider: 'sbx', agent: 'claude' });
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; while [ ! -f release ]; do sleep 0.05; done; echo finished'] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    first.child.kill('SIGKILL');
    await first.end();

    const second = start();
    await init(second, { provider: 'sbx', agent: 'claude' });
    second.send({ type: 'reattach', handle: HANDLE });

    expect(await second.next((message) => message.event === 'alive' || message.event === 'gone')).toMatchObject({
      event: 'alive', handle: HANDLE, display: { label: `${HANDLE} (sbx)` }, ops: [{ op, state: 'failed', failure: { code: 'runtime_lost' } }],
    });

    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed')).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  });

  it('keeps a place whose sandbox was removed meanwhile until close finds it absent, and reattach then says gone', async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    await openPlace(connection, place());
    execFileSync(path.join(engine.bin, 'sbx'), ['rm', '--force', HANDLE], { env: engine.env() });
    connection.send({ type: 'reattach', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'gone' || message.event === 'alive')).toMatchObject({ event: 'alive', handle: HANDLE, ops: [] });
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed')).toEqual({ event: 'closed', handle: HANDLE });
    connection.send({ type: 'reattach', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'gone' || message.event === 'alive')).toEqual({ event: 'gone', handle: HANDLE });
  });

  it('answers close_failed with the command that removes it when sbx cannot, and keeps the place to close again', async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    await openPlace(connection, place());
    engine.failRemove(true);
    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed')).toMatchObject({
      event: 'close_failed', handle: HANDLE, failure: { code: 'sandbox_failed', message: expect.stringContaining(`sbx rm --force ${HANDLE}`) },
    });
    engine.failRemove(false);
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed')).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  });
});
