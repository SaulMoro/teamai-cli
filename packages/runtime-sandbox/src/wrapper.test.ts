import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { InitInstance } from '@teamai/runtime-protocol';
import { LAUNCHABLE } from './providers/cli.js';
import { bundleRuntime, connect, fakeEngine, tempDir, type Connection, type FakeEngine, type Message } from './testing/harness.js';
import { closeLeftovers, expectNothingLeft } from './testing/leaks.js';

// The sandbox wrapper through its `tool-exec` entry point (`teamai-sandbox-<tool>`, the runtime's executable under
// another name), against the runtime over its stdio on a fake docker, with this test as the inner runtime that
// registers on the attempt socket.

const IMAGE = 'ghcr.io/acme/agent:1';
const RUN = 'r0123abcd';
const ATTEMPT = 'a0123abcd';
const PLACE = `teamai-${RUN}-${ATTEMPT}`;
const SECRET = 'sk-ant-oat01-wrapper-test-value';

/** A tool in the sandbox that reports where it ran, with what, and copies its stdin to stdout. */
const TOOL = `
if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const names = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ACME_CLAUDE_CONFIG_DIR', 'APP_ONLY'];
const report = { tool: require('node:path').basename(process.argv[1]), args: process.argv.slice(2), cwd: process.cwd(), set: names.filter((name) => process.env[name] !== undefined), home: process.env.CLAUDE_CONFIG_DIR ?? process.env.ACME_CLAUDE_CONFIG_DIR ?? null };
let input = '';
process.stdin.on('data', (data) => { input += data; });
process.stdin.on('end', () => { console.log(JSON.stringify({ ...report, input })); process.exit(Number(/exit ([0-9]+)/.exec(input)?.[1] ?? 7)); });
`;

const ACME_CLAUDE = { name: 'acme-claude', tool: 'claude', command: 'acme-claude', home: { dir: '/home/m/.acme-claude', env: 'ACME_CLAUDE_CONFIG_DIR' } } satisfies InitInstance;

let executable: string;
let dir: string;
let engine: FakeEngine;
/** A directory on the member's PATH, outside any sandbox, with the host's own tools. */
let hostBin: string;
let wrappers: string;
const opened: Connection[] = [];
const registered: net.Socket[] = [];

beforeAll(async () => {
  executable = await bundleRuntime(tempDir());
}, 60_000);

beforeEach(() => {
  dir = tempDir();
  engine = fakeEngine(dir);
  engine.image(IMAGE, { claude: TOOL, codex: TOOL, opencode: TOOL, 'acme-claude': TOOL });
  fs.mkdirSync(path.join(dir, 'home'));
  hostBin = path.join(dir, 'host-bin');
  wrappers = path.join(dir, 'wrappers');
  fs.mkdirSync(hostBin);
  fs.mkdirSync(wrappers);

  for (const tool of ['claude', 'codex', 'acme-claude']) {
    fs.writeFileSync(path.join(hostBin, tool), `#!/bin/sh\necho "host ${tool} $*"\n`, { mode: 0o755 });
  }
});

afterEach(async () => {
  for (const socket of registered.splice(0)) socket.destroy();
  const connections = opened.splice(0);
  await Promise.all(connections.map((connection) => connection.end()));
  const recovered = await closeLeftovers(connections);
  expect([...connections.flatMap((connection) => connection.invalid), ...recovered]).toEqual([]);
  expectNothingLeft({ dir, containers: engine.containers });
  fs.rmSync(dir, { recursive: true, force: true });
});

function start(): Connection {
  const connection = connect(executable, { ...engine.env(), HOME: path.join(dir, 'home') });
  opened.push(connection);

  return connection;
}

async function init(connection: Connection, instances: Message[] = [], image = IMAGE): Promise<Message> {
  connection.send({ type: 'init', protocol: 1, mode: 'unattended', options: { provider: 'docker', image }, credentials: { env: ['CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'], logins: [] }, instances });

  return connection.next((message) => message.type === 'init', 30_000);
}

interface Place {
  worktree: string;
  result: string;
  runDir: string;
  toolHome: string;
}

function place(): Place {
  const at = { worktree: path.join(dir, 'worktree'), result: path.join(dir, 'attempts', ATTEMPT, 'out'), runDir: path.join(dir, 'runs', RUN, 'scratch'), toolHome: path.join(dir, 'attempts', ATTEMPT, 'tool-home', 'claude') };
  fs.mkdirSync(path.join(at.worktree, 'src'), { recursive: true });

  return at;
}

let opCount = 0;

/** Opens the attempt's place for a prompt on `tool`, as teamai opens the outer of a composed entry. */
async function openFor(connection: Connection, at: Place, { tool = 'claude', variable = 'CLAUDE_CONFIG_DIR', credentials = { CLAUDE_CODE_OAUTH_TOKEN: SECRET } }: { tool?: string; variable?: string; credentials?: Record<string, string> } = {}): Promise<string> {
  opCount += 1;
  const op = `op-${opCount.toString(16).padStart(8, '0')}`;
  connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, tool, credentials, view: { worktree: at.worktree, readonly: [], result: at.result, runDir: at.runDir, toolHome: { [variable]: at.toolHome } } });
  const accepted = await connection.next((message) => message.op === op && message.event === 'accepted');
  expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000)).toMatchObject({ event: 'ready' });

  return String(accepted.handle);
}

const HandleSchema = z.object({ place: z.string(), socket: z.string() });

/** The attempt socket's path, from the handle teamai passes to the inner runtime as `outer`. */
function socketOf(handle: string): string {
  return HandleSchema.parse(JSON.parse(handle)).socket;
}

/** Registers `agent` on the attempt socket, as an inner runtime does, and resolves with each answer it gets. */
async function register(handle: string, agent: string | null): Promise<{ answers: Message[]; next: () => Promise<Message> }> {
  const socket = net.connect(socketOf(handle));
  registered.push(socket);
  await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const answers: Message[] = [];
  let wake: (() => void) | undefined;
  readline.createInterface({ input: socket }).on('line', (line) => {
    answers.push(z.record(z.string(), z.json()).parse(JSON.parse(line)));
    wake?.();
  });
  socket.write(`${JSON.stringify({ register: { agent } })}\n`);
  let read = 0;

  return {
    answers,
    next: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer on the socket; got ${JSON.stringify(answers)}`)), 10_000);

      const look = (): void => {
        const answer = answers[read];

        if (answer === undefined) return;
        read += 1;
        clearTimeout(timer);
        wake = undefined;
        resolve(answer);
      };

      wake = look;
      look();
    }),
  };
}

interface Ran {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Runs `teamai-sandbox-<name>` (a link to the runtime's executable) as the member's app runs a tool's binary. */
function wrapper(name: string, args: string[], { cwd, env = {}, stdin = '', signal }: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; signal?: { once: string; send: NodeJS.Signals } }): Promise<Ran> {
  const link = path.join(wrappers, `teamai-sandbox-${name}`);

  if (!fs.existsSync(link)) fs.symlinkSync(executable, link);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [link, ...args], { cwd, env: { PATH: `${hostBin}${path.delimiter}/usr/bin${path.delimiter}/bin`, HOME: path.join(dir, 'home'), APP_ONLY: 'from-the-app', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      stdout += data;

      if (signal !== undefined && stdout.includes(signal.once)) child.kill(signal.send);
    });
    child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });

    if (signal === undefined) child.stdin.end(stdin);
    else child.stdin.write(stdin);
    child.on('close', (code, ended) => resolve({ code, signal: ended, stdout, stderr }));
  });
}

const ReportSchema = z.object({ tool: z.string(), args: z.array(z.string()), cwd: z.string(), set: z.array(z.string()), home: z.string().nullable(), input: z.string() });

function reportOf(ran: Ran): z.infer<typeof ReportSchema> {
  return ReportSchema.parse(JSON.parse(ran.stdout));
}

/** The engine calls that ran a process in a container, as `[engine, 'exec', ...]`, less the runtime's own probes. */
function execsIn(): string[][] {
  return engine.calls().filter(([, command]) => command === 'exec').filter((call) => !call.some((arg) => arg.includes('command -v')));
}

/** The container an exec call ran in: the argument before what runs there. */
function containerOf(call: string[]): string | undefined {
  return call[call.findIndex((arg) => arg === 'env' || arg === '/bin/sh') - 1];
}

/** The container the runtime made for the attempt, as its journal keeps it. */
function attemptContainer(): string {
  const record = path.join(dir, 'home', '.teamai', 'runtime-state', 'sandbox', 'places', `${PLACE}.json`);

  return z.object({ id: z.string() }).parse(JSON.parse(fs.readFileSync(record, 'utf8'))).id;
}

describe('teamai-sandbox-<tool> as teamai-cli installs it', () => {
  it('is a bin of teamai-cli for each tool the sandbox launches, on the runtime\'s own executable', () => {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
    const bins = z.object({ bin: z.record(z.string(), z.string()) }).parse(JSON.parse(fs.readFileSync(manifest, 'utf8'))).bin;
    const wrappersOf = Object.fromEntries(Object.entries(bins).filter(([name]) => name.startsWith('teamai-sandbox-')));

    expect(wrappersOf).toEqual(Object.fromEntries(LAUNCHABLE.map((tool) => [`teamai-sandbox-${tool}`, bins['teamai-runtime-sandbox']])));
  });
});

describe('teamai-sandbox-<tool> on Windows', () => {
  const ON_WINDOWS = { SANDBOX_TEST_PLATFORM: 'win32' };

  it('refuses, naming why and WSL2, even for --version', async () => {
    for (const args of [['-p', 'Review it.'], ['--version']]) {
      const ran = await wrapper('claude', args, { cwd: dir, env: ON_WINDOWS });

      expect(ran.code).toBe(2);
      expect(ran.stdout).toBe('');
      expect(ran.stderr).toContain('does not run on Windows');
      expect(ran.stderr).toContain('WSL');
    }
  });

  it('refuses as an npm .cmd shim runs it, with no name of its own, rather than wait for runtime protocol on stdin', async () => {
    // An npm shim runs `node <bundle> <args>`: argv[1] is the bundle, never the bin's name.
    const ran = await new Promise<Ran>((resolve) => {
      const child = spawn(process.execPath, [executable, '-p', 'Review it.'], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: path.join(dir, 'home'), ...ON_WINDOWS }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; });
      child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });
      child.on('close', (code, ended) => resolve({ code, signal: ended, stdout, stderr }));
    });

    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain('does not run on Windows');
  });
});

describe('teamai-sandbox-<tool> outside an attempt', () => {
  it("prints the host tool's own version, with no attempt and no sandbox", async () => {
    const ran = await wrapper('claude', ['--version'], { cwd: dir });

    expect(ran).toMatchObject({ code: 0, stdout: 'host claude --version\n' });
    expect(engine.calls()).toEqual([]);
  });

  it('exits non-zero and runs nothing outside a teamai attempt, and for a name it does not know', async () => {
    const outside = await wrapper('claude', ['-p', 'hello'], { cwd: dir });
    const unknown = await wrapper('ghost', ['-p', 'hello'], { cwd: dir });

    expect(outside).toMatchObject({ code: 2, stdout: '' });
    expect(outside.stderr).toBe('teamai-sandbox-claude runs only inside a teamai attempt; use the plain tool or instance\n');
    expect(unknown).toMatchObject({ code: 2, stdout: '', stderr: 'teamai-sandbox: unknown tool ghost\n' });
    expect(engine.calls()).toEqual([]);
  });

  it("runs the host's codex app-server for Paseo's agentless model listing, and nothing else of the kind", async () => {
    const listing = await wrapper('codex', ['app-server'], { cwd: dir, env: { PASEO_HOME: path.join(dir, 'paseo') } });
    const notUnderPaseo = await wrapper('codex', ['app-server'], { cwd: dir });
    const withAgent = await wrapper('codex', ['app-server'], { cwd: dir, env: { PASEO_HOME: path.join(dir, 'paseo'), PASEO_AGENT_ID: 'agent-1' } });

    expect(listing).toMatchObject({ code: 0, stdout: 'host codex app-server\n' });
    expect(notUnderPaseo).toMatchObject({ code: 2, stdout: '' });
    expect(withAgent).toMatchObject({ code: 2, stdout: '' });
  });
});

describe('teamai-sandbox-<tool> inside an attempt', () => {
  it("runs the tool in the attempt's sandbox with argv, stdin, stdout and exit status passed through, and tells the inner runtime it connected", async () => {
    const connection = start();
    await init(connection);
    const at = place();
    const handle = await openFor(connection, at);
    const inner = await register(handle, null);
    const ran = await wrapper('claude', ['-p', '--output-format', 'stream-json'], { cwd: path.join(at.worktree, 'src'), stdin: 'the prompt, exit 3' });

    expect(ran.code).toBe(3);
    expect(reportOf(ran)).toMatchObject({ tool: 'claude', args: ['-p', '--output-format', 'stream-json'], cwd: path.join(at.worktree, 'src'), input: 'the prompt, exit 3' });
    expect(await inner.next()).toEqual({ connected: { agent: null } });
    expect(execsIn()).toHaveLength(1);
    expect(execsIn()[0]).toEqual(expect.arrayContaining(['exec', '-i', '-w', path.join(at.worktree, 'src'), 'claude', '-p']));
    expect(containerOf(execsIn()[0] ?? [])).toBe(attemptContainer());
  });

  it("runs OpenCode in the attempt's sandbox with no sign-in teamai gives, as its free models need none", async () => {
    const connection = start();

    expect(await init(connection)).toMatchObject({ ok: true, can: { tools: expect.arrayContaining(['opencode']) } });
    const at = place();
    const handle = await openFor(connection, at, { tool: 'opencode', variable: 'XDG_DATA_HOME', credentials: {} });
    await register(handle, null);
    const ran = await wrapper('opencode', ['run', 'Review it.'], { cwd: at.worktree, stdin: 'exit 0' });

    expect(ran).toMatchObject({ code: 0, stderr: '' });
    expect(reportOf(ran)).toMatchObject({ tool: 'opencode', args: ['run', 'Review it.'], set: [] });
    expect(execsIn()[0]).toEqual(expect.arrayContaining(['-e', 'XDG_DATA_HOME', 'opencode', 'run']));
  });

  it('runs in a worktree teamai names through a symlink, at the path the sandbox mounts', async () => {
    const connection = start();
    await init(connection);
    fs.symlinkSync(dir, path.join(dir, 'via'));
    const at = { ...place(), worktree: path.join(dir, 'via', 'worktree') };
    const handle = await openFor(connection, at);
    await register(handle, null);
    const ran = await wrapper('claude', ['-p'], { cwd: path.join(at.worktree, 'src'), stdin: 'exit 0' });

    expect(ran).toMatchObject({ code: 0, stderr: '' });
    expect(execsIn()[0]).toEqual(expect.arrayContaining(['-w', path.join(at.worktree, 'src')]));
  });

  it("gives the tool the step's credentials and its home at the attempt's tool home, never the app's env, and no value in any argv or file", async () => {
    const connection = start();
    await init(connection);
    const at = place();
    const handle = await openFor(connection, at);
    await register(handle, null);
    const ran = await wrapper('claude', ['-p'], { cwd: at.worktree });

    expect(reportOf(ran)).toMatchObject({ set: ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'], home: at.toolHome });
    expect(execsIn()[0]).toEqual(expect.arrayContaining(['-e', 'CLAUDE_CODE_OAUTH_TOKEN', '-e', 'CLAUDE_CONFIG_DIR']));
    expect(engine.calls().flat().join('\n')).not.toContain(SECRET);
    const kept = fs.readdirSync(path.join(dir, 'home'), { recursive: true }).map((file) => path.join(dir, 'home', String(file))).filter((file) => fs.statSync(file).isFile());
    expect(kept.filter((file) => fs.readFileSync(file, 'utf8').includes(SECRET))).toEqual([]);
  });

  it('passes a signal the app sends the wrapper on to the tool in the sandbox', async () => {
    engine.image(IMAGE, { claude: "process.on('SIGTERM', () => { require('node:fs').writeFileSync('got-term', 'term'); process.exit(143); }); console.log('started'); setInterval(() => {}, 1000);" });
    const connection = start();
    await init(connection);
    const at = place();
    const handle = await openFor(connection, at);
    await register(handle, null);
    const ran = await wrapper('claude', ['-p'], { cwd: at.worktree, signal: { once: 'started', send: 'SIGTERM' } });

    expect(ran.code).toBe(143);
    expect(fs.readFileSync(path.join(at.worktree, 'got-term'), 'utf8')).toBe('term');
  });

  it('lands in the attempt named by PASEO_AGENT_CWD when the app starts it elsewhere, for the registered agent only', async () => {
    const connection = start();
    await init(connection);
    const at = place();
    const handle = await openFor(connection, at);
    const inner = await register(handle, 'agent-1');
    const helper = await wrapper('claude', ['-p'], { cwd: dir, env: { PASEO_AGENT_CWD: at.worktree, PASEO_AGENT_ID: 'agent-title' } });
    const ran = await wrapper('claude', ['-p'], { cwd: dir, env: { PASEO_AGENT_CWD: at.worktree, PASEO_AGENT_ID: 'agent-1' } });
    const again = await wrapper('claude', ['-p'], { cwd: dir, env: { PASEO_AGENT_CWD: at.worktree, PASEO_AGENT_ID: 'agent-1' } });

    expect(helper).toMatchObject({ code: 2, stdout: '' });
    expect(helper.stderr).toContain('agent-title');
    expect(reportOf(ran).cwd).toBe(at.worktree);
    expect(await inner.next()).toEqual({ connected: { agent: 'agent-1' } });
    expect(execsIn().map((call) => containerOf(call))).toEqual([attemptContainer(), attemptContainer()]);
    expect(again.code).toBe(7);
  });

  it('refuses a wrapper with an agent id after a registration with none, and one with none before any registration', async () => {
    const connection = start();
    await init(connection);
    const at = place();
    const handle = await openFor(connection, at);
    const unregistered = await wrapper('claude', ['-p'], { cwd: at.worktree });
    await register(handle, null);
    const withAgent = await wrapper('claude', ['-p'], { cwd: at.worktree, env: { PASEO_AGENT_ID: 'agent-1' } });

    expect(unregistered).toMatchObject({ code: 2, stdout: '' });
    expect(withAgent).toMatchObject({ code: 2, stdout: '' });
    expect(execsIn()).toEqual([]);
  });

  it("runs codex app-server in the attempt's sandbox, not on the host, even under a Paseo daemon", async () => {
    const connection = start();
    await init(connection);
    const at = place();
    const handle = await openFor(connection, at, { tool: 'codex', variable: 'CODEX_HOME' });
    await register(handle, 'agent-1');
    const ran = await wrapper('codex', ['app-server'], { cwd: at.worktree, env: { PASEO_HOME: path.join(dir, 'paseo'), PASEO_AGENT_ID: 'agent-1' } });

    expect(reportOf(ran)).toMatchObject({ tool: 'codex', args: ['app-server'] });
    expect(ran.stdout).not.toContain('host codex');
  });

  it('asks no socket whose directory others may write, and runs nothing', async () => {
    const connection = start();
    await init(connection);
    const at = place();
    const handle = await openFor(connection, at);
    await register(handle, null);
    fs.chmodSync(path.dirname(socketOf(handle)), 0o777);
    const ran = await wrapper('claude', ['-p'], { cwd: at.worktree, stdin: 'exit 0' });

    expect(ran).toMatchObject({ code: 2, stdout: '' });
    expect(ran.stderr).toContain(path.dirname(socketOf(handle)));
    expect(execsIn()).toEqual([]);
  });

  it("serves its socket at 0600 in a 0700 directory, and removes it at close, though a client sits on it saying nothing", async () => {
    const connection = start();
    await init(connection);
    const at = place();
    const handle = await openFor(connection, at);
    const socket = socketOf(handle);
    const idle = net.connect(socket);
    registered.push(idle);
    await new Promise<void>((resolve, reject) => idle.once('connect', resolve).once('error', reject));

    expect(fs.statSync(socket).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(socket)).mode & 0o777).toBe(0o700);
    connection.send({ type: 'close', handle });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 15_000)).toEqual({ event: 'closed', handle });
    expect(fs.existsSync(socket)).toBe(false);
    expect(engine.containers()).toEqual([]);
  });
});

describe('an instance through the wrapper', () => {
  it("grants an instance's command with its home variable at the attempt's tool home, through a link named after it", async () => {
    const connection = start();
    await init(connection, [ACME_CLAUDE]);
    const at = place();
    const handle = await openFor(connection, at, { tool: 'acme-claude', variable: 'ACME_CLAUDE_CONFIG_DIR' });
    await register(handle, null);
    const ran = await wrapper('acme-claude', ['-p'], { cwd: at.worktree });

    expect(reportOf(ran)).toMatchObject({ tool: 'acme-claude', home: at.toolHome, set: ['CLAUDE_CODE_OAUTH_TOKEN', 'ACME_CLAUDE_CONFIG_DIR'] });
  });

  it('names the record it cannot read, and runs nothing, rather than take a broken record as none', async () => {
    const state = path.join(dir, 'home', '.teamai', 'runtime-state', 'sandbox');
    fs.mkdirSync(path.join(state, 'places'), { recursive: true });
    fs.writeFileSync(path.join(state, 'instances.json'), '{"acme-claude":');
    fs.writeFileSync(path.join(state, 'places', 'teamai-broken.json'), 'not json');

    const instance = await wrapper('acme-claude', ['--version'], { cwd: dir });
    fs.writeFileSync(path.join(state, 'instances.json'), '{}');
    const tool = await wrapper('claude', ['-p'], { cwd: dir });

    expect(instance).toMatchObject({ code: 2, stdout: '' });
    expect(instance.stderr).toContain(path.join(state, 'instances.json'));
    expect(tool).toMatchObject({ code: 2, stdout: '' });
    expect(tool.stderr).toContain(path.join(state, 'places', 'teamai-broken.json'));
  });

  it('refuses an instance whose command the sandbox lacks, naming the command', async () => {
    const claudeOnly = 'ghcr.io/acme/claude-only:1';
    engine.image(claudeOnly, { claude: TOOL });
    const connection = start();
    await init(connection, [ACME_CLAUDE], claudeOnly);
    const at = place();
    const handle = await openFor(connection, at, { tool: 'acme-claude', variable: 'ACME_CLAUDE_CONFIG_DIR' });
    await register(handle, null);
    const ran = await wrapper('acme-claude', ['-p'], { cwd: at.worktree });

    expect(ran).toMatchObject({ code: 2, stdout: '' });
    expect(ran.stderr).toContain('tool_unsupported');
    expect(ran.stderr).toContain(`acme-claude is not installed in this sandbox (image ${claudeOnly})`);
  });

  it("prints an instance's host version outside an attempt, once a runtime's init named it", async () => {
    await init(start(), [ACME_CLAUDE]);

    expect(await wrapper('acme-claude', ['--version'], { cwd: dir })).toMatchObject({ code: 0, stdout: 'host acme-claude --version\n' });
  });
});

describe('after the runtime restarts', () => {
  it('leaves the socket to the runtime that still serves it when another reattaches the place, as a stop of the run does', async () => {
    const first = start();
    await init(first);
    const at = place();
    const handle = await openFor(first, at);
    await register(handle, null);
    const stopping = start();
    stopping.send({ type: 'init', protocol: 1, mode: 'recover', options: { provider: 'docker', image: IMAGE } });
    await stopping.next((message) => message.type === 'init', 30_000);
    stopping.send({ type: 'reattach', handle });
    expect(await stopping.next((message) => message.handle === handle)).toMatchObject({ event: 'alive', handle });
    const ran = await wrapper('claude', ['-p'], { cwd: at.worktree, stdin: 'exit 0' });

    expect(ran).toMatchObject({ code: 0, stderr: '' });
  });

  it("refuses asks with credentials_pending until teamai's reattach brings the credentials back, then grants", async () => {
    const first = start();
    await init(first);
    const at = place();
    const handle = await openFor(first, at);
    await first.end();
    const second = start();
    await init(second);
    second.send({ type: 'reattach', handle });
    expect(await second.next((message) => message.handle === handle)).toMatchObject({ event: 'alive', handle });
    await register(handle, null);
    const pending = await wrapper('claude', ['-p'], { cwd: at.worktree });

    expect(pending).toMatchObject({ code: 2, stdout: '' });
    expect(pending.stderr).toContain('credentials_pending');
    second.send({ type: 'reattach', handle, credentials: { CLAUDE_CODE_OAUTH_TOKEN: SECRET } });
    await second.next((message) => message.handle === handle && message.event === 'alive');
    const granted = await wrapper('claude', ['-p'], { cwd: at.worktree });

    expect(reportOf(granted).set).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});
