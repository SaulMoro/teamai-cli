import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bundleRuntime, connect, fakeEngine, tempDir, type Connection, type FakeEngine, type Message } from '../testing/harness.js';
import { expectNothingLeft } from '../testing/leaks.js';

// One spec for the container providers, through the runtime's stdio entry point, run against the fake engine
// (testing/fake-engine.mjs) always, and against the real engines CONTAINER_SPEC_ENGINES names (`docker,podman,sbx`).
// What the fake answers is then checked against what the engine does: a drift fails here instead of hiding a bug
// (after sandcastle's tests/local/helpers/containerProviderSpec.ts). A named engine that does not run fails the suite.
//
// Every command runs through `/bin/sh` by its absolute path, which every real image here has, and the fake runs on
// the host.


type Engine = z.infer<typeof EngineSchema>;

/** One engine the spec runs against: the runtime's environment for it, its options, and what it holds. */
interface Target {
  label: string;
  engine: Engine;
  options: Message;
  /** Readies the engine (an image), once; the returned function removes what it made. */
  prepare(dir: string): Promise<() => void>;
  env(dir: string): NodeJS.ProcessEnv;
  /** The names of the containers (sbx: sandboxes) that exist. */
  containers(dir: string): string[];
}

/** What `sbx ls --json` lists, as the sbx provider reads it. */
const SbxListSchema = z.array(z.object({ name: z.string() }));

const RUN = 'r0c0ffee1';
const ATTEMPT = 'a0c0ffee1';
const FAKE_IMAGE = 'ghcr.io/acme/spec:1';
const REAL_IMAGE = 'teamai-spec/agent:1';

let fakes: FakeEngine | undefined;

/** The fake engine answering as `engine`. */
function fakeTarget(engine: Engine): Target {
  return {
    label: `fake ${engine}`,
    engine,
    options: engine === 'sbx' ? { provider: 'sbx' } : { provider: engine, image: FAKE_IMAGE },
    async prepare(dir) {
      fakes = fakeEngine(dir);
      fakes.image(FAKE_IMAGE, {});
      fakes.image('shell', {});

      return () => undefined;
    },
    env: () => fakes?.env() ?? {},
    containers: () => fakes?.containers() ?? [],
  };
}

/** The engine `engine` on this machine, as the member runs it. */
function realTarget(engine: Engine): Target {
  const cli = (args: string[]): string => execFileSync(engine, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });

  return {
    label: `real ${engine}`,
    engine,
    options: engine === 'sbx' ? { provider: 'sbx' } : { provider: engine, image: REAL_IMAGE },
    async prepare(dir) {
      if (engine === 'sbx') {
        // sbx finds its daemon and sign-in through HOME, which each case sets to a home of its own.
        const shim = path.join(dir, 'sbx-bin');
        fs.mkdirSync(shim, { recursive: true });
        fs.writeFileSync(path.join(shim, 'sbx'), `#!/bin/sh\nHOME='${os.homedir()}' exec '${execFileSync('/bin/sh', ['-c', 'command -v sbx'], { encoding: 'utf8' }).trim()}' "$@"\n`, { mode: 0o755 });

        return () => undefined;
      }
      const context = path.join(dir, 'image');
      fs.mkdirSync(context, { recursive: true });
      fs.writeFileSync(path.join(context, 'Containerfile'), 'FROM docker.io/library/alpine:3\n');
      cli(['build', '-q', '-t', REAL_IMAGE, '-f', path.join(context, 'Containerfile'), context]);

      return () => { spawnSync(engine, ['rmi', '-f', REAL_IMAGE], { stdio: 'ignore' }); };
    },
    env: (dir) => ({ PATH: engine === 'sbx' ? [path.join(dir, 'sbx-bin'), process.env.PATH].join(path.delimiter) : process.env.PATH, ...(process.env.DOCKER_HOST && { DOCKER_HOST: process.env.DOCKER_HOST }), ...(process.env.CONTAINER_HOST && { CONTAINER_HOST: process.env.CONTAINER_HOST }) }),
    containers: (dir) => (engine === 'sbx'
      ? SbxListSchema.parse(JSON.parse(execFileSync(path.join(dir, 'sbx-bin', 'sbx'), ['ls', '--json'], { encoding: 'utf8' }))).map(({ name }) => name)
      : cli(['ps', '-a', '--format', '{{.Names}}']).split('\n')).filter((name) => name.includes(`${RUN}-${ATTEMPT}`)),
  };
}

const EngineSchema = z.enum(['docker', 'podman', 'sbx'], { error: (issue) => `CONTAINER_SPEC_ENGINES names ${String(issue.input)}; name docker, podman or sbx` });
const named = (process.env.CONTAINER_SPEC_ENGINES ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '');
const TARGETS: Target[] = [fakeTarget('docker'), fakeTarget('podman'), fakeTarget('sbx'), ...named.map((name) => realTarget(EngineSchema.parse(name)))];

/** A command that waits until `file` exists, at most 20 s. */
const waitFor = (file: string): string => `i=0; while [ ! -e '${file}' ] && [ $i -lt 200 ]; do sleep 0.1; i=$((i+1)); done`;

for (const target of TARGETS) {
  describe(`container provider spec: ${target.label}`, () => {
    let executable: string;
    let dir: string;
    let home: string;
    let removeImage: () => void;
    const open: Connection[] = [];
    let ops = 0;

    const newOp = (): string => {
      ops += 1;

      return `op-${ops.toString(16).padStart(8, '0')}`;
    };

    beforeAll(async () => {
      if (target.label.startsWith('real') && spawnSync(target.engine, ['version'], { stdio: 'ignore', timeout: 30_000 }).status !== 0) {
        throw new Error(`CONTAINER_SPEC_ENGINES names ${target.engine}, which does not run here. Start it, or leave it out of CONTAINER_SPEC_ENGINES`);
      }

      executable = await bundleRuntime(tempDir());
      dir = tempDir();
      removeImage = await target.prepare(dir);
    }, 600_000);

    afterAll(() => {
      removeImage();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(dir, 'home-'));
    });

    afterEach(async () => {
      const connections = open.splice(0);
      await Promise.all(connections.map((connection) => connection.end()));
      expect(connections.flatMap((connection) => connection.invalid)).toEqual([]);
      // Every case closes what it opened: no container of the attempt, process or attempt's state is left.
      expect(target.containers(dir)).toEqual([]);
      expectNothingLeft({ dir: home });
    });

    function start(extra: NodeJS.ProcessEnv = {}): Connection {
      const connection = connect(executable, { ...target.env(dir), HOME: home, ...extra });
      open.push(connection);

      return connection;
    }

    interface Opened { connection: Connection; handle: string; worktree: string; git: string }

    async function opened(extra: NodeJS.ProcessEnv = {}): Promise<Opened> {
      const connection = start(extra);
      connection.send({ type: 'init', protocol: 1, mode: 'unattended', options: target.options, credentials: { env: [], logins: [] } });
      expect(await connection.next((message) => message.type === 'init', 300_000)).toMatchObject({ ok: true });
      const root = fs.mkdtempSync(path.join(dir, 'place-'));
      const worktree = path.join(root, 'worktree');
      const git = path.join(root, 'repo.git');
      fs.mkdirSync(worktree, { recursive: true });
      fs.mkdirSync(git, { recursive: true });
      fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
      const op = newOp();
      connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials: {}, view: { worktree, readonly: [git], result: path.join(root, 'out'), runDir: path.join(root, 'run'), toolHome: {} } });
      const accepted = await connection.next((message) => message.op === op && (message.event === 'accepted' || message.event === 'failed'));
      expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 300_000)).toMatchObject({ event: 'ready' });

      return { connection, handle: String(accepted.handle), worktree, git };
    }

    async function exec({ connection, handle }: Opened, request: { script: string; cwd: string; env?: Record<string, string>; credentials?: Record<string, string> }, op = newOp()): Promise<{ end: Message; stdout: string; stderr: string }> {
      connection.send({ type: 'exec', op, handle, argv: ['/bin/sh', '-c', request.script], env: request.env ?? {}, unset: [], credentials: request.credentials ?? {}, cwd: request.cwd });
      const end = await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 120_000);
      const printed = (stream: string): string => connection.messages.filter((message) => message.op === op && message.event === 'output' && message.stream === stream).map((message) => String(message.data)).join('');

      return { end, stdout: printed('stdout'), stderr: printed('stderr') };
    }

    async function close({ connection, handle }: Opened): Promise<void> {
      connection.send({ type: 'close', handle });
      expect(await connection.next((message) => message.handle === handle && (message.event === 'closed' || message.event === 'failed'), 300_000)).toMatchObject({ event: 'closed' });
    }

    it('makes one sandbox for the attempt at open, and removes it at close', async () => {
      const place = await opened();

      expect(target.containers(dir)).toHaveLength(1);
      await close(place);
      expect(target.containers(dir)).toEqual([]);
    }, 600_000);

    it("passes the exit status, stdout and stderr apart, the working directory, and only the exec's own variables", async () => {
      const place = await opened({ MEMBER_CANARY: 'member-canary-value' });
      const { end, stdout, stderr } = await exec(place, {
        script: 'pwd; echo "named=$NAMED key=$STEP_KEY canary=${MEMBER_CANARY:-unset}"; echo oops >&2; exit 7',
        cwd: place.worktree, env: { NAMED: 'given' }, credentials: { STEP_KEY: 'step-secret' },
      });

      expect(end).toMatchObject({ event: 'exited', code: 7 });
      expect(stdout).toBe(`${place.worktree}\nnamed=given key=step-secret canary=unset\n`);
      expect(stderr).toBe('oops\n');
      await close(place);
    }, 600_000);

    it("streams output while the exec runs", async () => {
      const place = await opened();
      const op = newOp();
      const ended = exec(place, { script: `echo first; ${waitFor(path.join(place.worktree, 'go'))}; echo second`, cwd: place.worktree }, op);

      expect(await place.connection.next((message) => message.op === op && message.event === 'output', 120_000)).toMatchObject({ stream: 'stdout', data: 'first\n' });
      fs.writeFileSync(path.join(place.worktree, 'go'), '');
      expect(await ended).toMatchObject({ end: { event: 'exited', code: 0 }, stdout: 'first\nsecond\n' });
      await close(place);
    }, 600_000);

    it('writes the worktree on this machine', async () => {
      const place = await opened();

      expect(await exec(place, { script: 'echo made > made.txt', cwd: place.worktree })).toMatchObject({ end: { event: 'exited', code: 0 } });
      expect(fs.readFileSync(path.join(place.worktree, 'made.txt'), 'utf8')).toBe('made\n');
      await close(place);
    }, 600_000);

    // The fake runs its processes on this machine, where nothing makes a read-only mount read only.
    it.runIf(target.label.startsWith('real'))('keeps the git paths read only', async () => {
      const place = await opened();
      const { end, stdout } = await exec(place, { script: `if echo x > '${place.git}/HEAD' 2>/dev/null; then echo git=written; else echo git=refused; fi`, cwd: place.worktree });

      expect(end).toMatchObject({ event: 'exited', code: 0 });
      expect(stdout).toBe('git=refused\n');
      expect(fs.readFileSync(path.join(place.git, 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
      await close(place);
    }, 600_000);

    it('cancels a running exec, and runs the next one', async () => {
      const place = await opened();
      const op = newOp();
      const ended = exec(place, { script: `echo started; ${waitFor(path.join(place.worktree, 'never'))}; echo late > late.txt`, cwd: place.worktree }, op);
      await place.connection.next((message) => message.op === op && message.event === 'output', 120_000);
      place.connection.send({ type: 'cancel', op });

      expect((await ended).end).toMatchObject({ event: 'cancelled' });
      expect(await exec(place, { script: 'echo again', cwd: place.worktree })).toMatchObject({ end: { event: 'exited', code: 0 }, stdout: 'again\n' });
      expect(fs.existsSync(path.join(place.worktree, 'late.txt'))).toBe(false);
      await close(place);
    }, 600_000);

    it.runIf(target.engine !== 'sbx')('fails init naming an image that cannot be pulled', async () => {
      const connection = start();
      connection.send({ type: 'init', protocol: 1, mode: 'unattended', options: { ...target.options, image: 'localhost:1/teamai-spec/missing:1' } });
      const reply = await connection.next((message) => message.type === 'init', 300_000);

      expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
      expect(JSON.stringify(reply)).toContain('localhost:1/teamai-spec/missing:1');
    }, 600_000);
  });
}
