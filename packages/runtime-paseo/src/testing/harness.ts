import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { RuntimeMessageSchema, type RuntimeMessage, type RuntimeRequestSchema } from '@teamai/runtime-protocol';
import type { z } from 'zod';
import { buildSync } from 'esbuild';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(SOURCE, '..', '..', '..');

/** What the bundle is built from besides the package: the workspace packages it imports, and the locked dependencies. */
const BUNDLED = [path.join(ROOT, 'packages', 'runtime-protocol', 'src'), path.join(ROOT, 'packages', 'tool-core', 'src')];

/** Every source file under `dir` but its tests, which the bundle's cache key covers. */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);

    return entry.isDirectory() ? sources(file) : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : [];
  });
}

/**
 * teamai-runtime-paseo bundled into one file with its dependencies, as it ships. One build per source revision is kept in
 * the temp directory, so every test file and worker reuses it.
 */
export function bundledRuntime(): string {
  const hash = createHash('sha256');

  for (const file of [SOURCE, ...BUNDLED].flatMap(sources).sort()) hash.update(fs.readFileSync(file));
  hash.update(fs.readFileSync(path.join(ROOT, 'package-lock.json')));
  const file = path.join(os.tmpdir(), `teamai-paseo-runtime-${hash.digest('hex').slice(0, 16)}`, 'runtime.mjs');

  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const building = `${file}.${process.pid}.tmp`;
  buildSync({
    entryPoints: [path.join(SOURCE, 'main.ts')], outfile: building, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
    banner: { js: "import { createRequire as __teamaiCreateRequire } from 'node:module';\nconst require = __teamaiCreateRequire(import.meta.url);" },
  });
  fs.renameSync(building, file);

  return file;
}

export interface Runtime {
  child: ChildProcess;
  send(request: z.input<typeof RuntimeRequestSchema>): void;
  /** The next line that matches, waiting for it; every line is checked against the protocol on the way. */
  next(match: (message: RuntimeMessage) => boolean): Promise<RuntimeMessage>;
  /** Every line read so far. */
  lines: RuntimeMessage[];
  /** Ends its stdin, as teamai does when it is done, and waits for it to exit. */
  stop(): Promise<void>;
  /** Kills it outright, as `kill -9` does. */
  kill(): Promise<void>;
}

/** The Paseo client the tests run against: the one installed for this repository's tests, as a member's paseo brings it. */
export const TEST_CLIENT = path.join(ROOT, 'node_modules', '@getpaseo', 'client');

/**
 * Starts the runtime with its journal under `home`, as teamai spawns it, finding the test client through
 * `PASEO_CLIENT_PATH`; `env` sets or, with undefined, removes names over that.
 */
export function startRuntime(home: string, env: Record<string, string | undefined> = {}): Runtime {
  const merged = { ...process.env, HOME: home, PASEO_CLIENT_PATH: TEST_CLIENT, ...env };
  const given = Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
  // Its stderr reaches the test's own, through a pipe a test can close as teamai does when it stops reading.
  const child = spawn(process.execPath, [bundledRuntime()], { env: given, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr?.on('data', (data: Buffer) => { process.stderr.write(data); });
  const lines: RuntimeMessage[] = [];
  const waiters: Array<() => void> = [];

  const exited = new Promise<void>((resolve) => child.once('exit', () => {
    for (const wake of waiters.splice(0)) wake();
    resolve();
  }));

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(RuntimeMessageSchema.parse(JSON.parse(line)));

    for (const wake of waiters.splice(0)) wake();
  });

  const taken = new Set<number>();

  return {
    child,
    lines,
    send: (request) => child.stdin?.write(`${JSON.stringify(request)}\n`),
    next(match) {
      return new Promise((resolve, reject) => {
        const look = (): void => {
          const at = lines.findIndex((line, index) => !taken.has(index) && match(line));
          const line = lines[at];

          if (line) {
            taken.add(at);
            resolve(line);
          } else if (child.exitCode !== null || child.signalCode !== null) {
            reject(new Error(`the runtime exited before the line came; it wrote ${JSON.stringify(lines)}`));
          } else {
            waiters.push(look);
          }
        };

        look();
      });
    },
    async stop() {
      child.stdin?.end();
      await exited;
    },
    async kill() {
      child.kill('SIGKILL');
      await exited;
    },
  };
}
