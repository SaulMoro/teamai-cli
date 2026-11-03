import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

async function init(connection: Connection, options: Message, mode = 'unattended'): Promise<Message> {
  connection.send({ type: 'init', protocol: 1, mode, options });

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
    const reply = await init(start(), { provider: 'sbx', agent: 'claude' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'provider' } });
    expect(JSON.stringify(reply)).toContain('docker');
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
