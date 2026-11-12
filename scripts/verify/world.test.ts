import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { socketPathOf } from '../../packages/runtime-sandbox/src/attempt-socket.js';
import { REPO_ROOT, updateWorld, worldCommandNames, worldEnv, worldTmpDir, writeCommandLog, type World } from './world.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();

  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('the commands a world puts on PATH', () => {
  it('are git, every tool, every sandbox provider teamai runs on this machine, and the T3 and Paseo commands', async () => {
    // docs/dev/glossary.md, Sandbox provider: docker, podman, sbx, seatbelt (macOS's /usr/bin/sandbox-exec), bwrap; vercel runs elsewhere.
    expect(await worldCommandNames()).toEqual(expect.arrayContaining(['git', 'claude', 'codex', 'codebuddy', 'opencode', 'docker', 'podman', 'sbx', '/usr/bin/sandbox-exec', 'bwrap', 't3', 'paseo']));
  });

  /** A checkout whose teamai ships `runtime-fake` as an executable, and whose package declares `exports` in its package.json. */
  function checkoutWithRuntime(exports: Record<string, string> | undefined): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'world-runtimes-'));
    roots.push(root);
    const pkg = path.join(root, 'packages', 'runtime-fake');
    fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ bin: { teamai: 'dist/index.js', 'teamai-runtime-fake': 'dist/runtime-fake.js' } }));
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@teamai/runtime-fake', ...(exports && { exports }) }));
    fs.writeFileSync(path.join(pkg, 'src', 'host-commands.ts'), "export const HOST_COMMANDS = ['fakeapp'];\n");

    return root;
  }

  it('include the command a new runtime package declares, with no edit to the harness', async () => {
    expect(await worldCommandNames({ root: checkoutWithRuntime({ './host-commands': './src/host-commands.ts' }) })).toEqual(['git', 'claude', 'codex', 'codebuddy', 'opencode', 'fakeapp']);
  });

  it('refuse a runtime teamai ships as an executable whose package declares no host commands', async () => {
    await expect(worldCommandNames({ root: checkoutWithRuntime(undefined) })).rejects.toThrow(/packages\/runtime-fake ships dist\/runtime-fake\.js but declares no host commands/);
  });

  it("reach Node through the world's own tools folder, never Node's folder, which holds every global npm command", () => {
    const env = worldEnv({ home: '/w/home', tmp: '/tmp/w', bin: '/w/install/node_modules/.bin', fakes: '/w/fakes', tools: '/w/tools', npmCache: '/w/npm-cache' });

    expect(env.PATH.split(':')).toEqual(['/w/fakes', '/w/install/node_modules/.bin', '/w/tools', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  });
});

describe('the basic world', () => {
  // Every module of a step runtime's package the harness loads for its basic verbs, each a path and nothing else.
  const COMMAND_NAMES = new Set(['runtime-sandbox/src/journal-root.ts']);

  it('allows only modules that exist', () => {
    for (const module of COMMAND_NAMES) expect(fs.existsSync(path.join(REPO_ROOT, 'packages', module)), module).toBe(true);
  });

  it("loads no step runtime's modules beyond the command names it puts on PATH", () => {
    // module.register, not registerHooks, which Node 20 lacks. Hooks registered later run first, so this one goes after
    // the TypeScript loader verify.mjs registers, which settles a relative import without asking the hooks before it.
    const loader = `import fs from 'node:fs';
      export async function resolve(specifier, context, next) { const resolved = await next(specifier, context); fs.writeSync(2, 'LOADED ' + resolved.url + '\\n'); return resolved; }`;
    const hook = `import { register } from 'node:module';
      register(${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'typescript-loader.mjs')).href)});
      register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)});`;
    const ran = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, 'scripts/verify/verify.ts', 'help'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const runtimes = [...new Set(ran.stderr.split('\n').flatMap((line) => /^LOADED file:\/\/.*\/packages\/(runtime-(?!protocol\/)[^/]+\/src\/.+)$/.exec(line)?.[1] ?? []))];

    expect(ran.status).toBe(0);
    expect(runtimes.filter((module) => !COMMAND_NAMES.has(module))).toEqual([]);
    expect(runtimes.length).toBeGreaterThan(0);
  });
});

describe("a world's TMPDIR", () => {
  // A unix socket path holds at most 103 bytes on macOS (sun_path is 104 with its NUL), 107 on Linux.
  it.each([
    ['the world', undefined],
    ['a member with the longest name', 'abcdefghijkl'],
  ])('leaves room for the deepest attempt socket teamai makes there, for %s', (_who, member) => {
    const tmp = worldTmpDir({ root: '/private/tmp', runId: '20261112T113044-479be0', member });
    vi.stubEnv('TMPDIR', tmp);
    // A result path past what a socket binds sends the socket to the temp directory, its deepest place.
    const socket = socketPathOf({ result: path.join('/private/var/folders/xx', 'y'.repeat(120), 'result'), place: 'teamai-r0123456789abcdef-a01234567' });

    expect(socket.startsWith(`${tmp}/`)).toBe(true);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
  });

  it('is one of its own per world and per member, named after the run so it is found again', () => {
    const runId = '20261112T113044-479be0';

    expect(new Set([worldTmpDir({ root: '/tmp', runId }), worldTmpDir({ root: '/tmp', runId, member: 'bob' }), worldTmpDir({ root: '/tmp', runId: '20261112T113044-000000' })]).size).toBe(3);
    expect(worldTmpDir({ root: '/tmp', runId })).toContain(runId);
  });
});

describe("a world's world.json", () => {
  /** A world whose world.json is written in a folder of its own, as `createWorld` leaves it. */
  function writtenWorld(): World {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-json-'));
    roots.push(dir);
    const world: World = {
      runId: '20261112T113044-479be0', dir, project: `${dir}/project`, team: `${dir}/team.git`, home: `${dir}/home`, tmp: `${dir}/tmp`, logs: `${dir}/logs`, bin: `${dir}/bin`,
      build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' },
      createdAt: '2026-11-12T11:30:44.000Z',
      baseline: { teamRefs: {}, checkoutStatus: [] },
    };
    fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(world));

    return world;
  }

  it('keeps a change another command of the world wrote since this one loaded it', () => {
    const loaded = writtenWorld();

    updateWorld(loaded, (fresh) => ({ ...fresh, driverSeen: true }));
    updateWorld(loaded, (fresh) => ({ ...fresh, cleanedAt: '2026-11-12T12:00:00.000Z' }));

    expect(JSON.parse(fs.readFileSync(path.join(loaded.dir, 'world.json'), 'utf8'))).toMatchObject({ driverSeen: true, cleanedAt: '2026-11-12T12:00:00.000Z' });
  });

  it("keeps each command's log when another command of the world took the next number first", () => {
    const { logs } = writtenWorld();
    fs.mkdirSync(logs);
    // Another command counted the same one log and wrote number 2 before this one did.
    fs.writeFileSync(path.join(logs, '2-sh.log'), 'the other command\n');

    const file = writeCommandLog({ logs }, ['sh', '-c', 'true'], 'out\n', 0);

    expect(fs.readFileSync(path.join(logs, '2-sh.log'), 'utf8')).toBe('the other command\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('$ sh -c true\nout\nexit 0\n');
  });
});
