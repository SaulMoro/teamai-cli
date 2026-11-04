import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACKAGE = path.join(ROOT, 'packages', 'runtime-paseo', 'src');
/** What the bundle is built from besides the package: the workspace packages it imports, and the locked dependencies. */
const BUNDLED = [path.join(ROOT, 'packages', 'runtime-protocol', 'src'), path.join(ROOT, 'packages', 'tool-core', 'src')];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);

    return entry.isDirectory() ? sources(file) : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : [];
  });
}

/** `entry` of packages/runtime-paseo built as one executable file, cached in the temp directory per source revision. */
function bundled(entry: string, name: string): string {
  const hash = createHash('sha256');

  for (const file of [PACKAGE, ...BUNDLED].flatMap(sources).sort()) hash.update(fs.readFileSync(file));
  hash.update(fs.readFileSync(path.join(ROOT, 'package-lock.json')));
  const file = path.join(os.tmpdir(), `teamai-paseo-e2e-runtime-${hash.digest('hex').slice(0, 16)}`, name);

  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const building = `${file}.${process.pid}.tmp`;
  buildSync({
    entryPoints: [path.join(PACKAGE, entry)], outfile: building, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
    banner: { js: "import { createRequire as __teamaiCreateRequire } from 'node:module';\nconst require = __teamaiCreateRequire(import.meta.url);" },
  });
  fs.renameSync(building, file);

  return file;
}

/**
 * teamai-runtime-paseo bundled into one file as it ships, and a fake Paseo daemon (packages/runtime-paseo/src/testing/fake-daemon.ts)
 * running as its own process for the test file, which it outlives only until its stdin closes. `behave` sets how the
 * daemon's next agents behave; `args` start the runtime with its journal under `state`.
 */
export async function paseoOnFakeDaemon(): Promise<{ url: string; args: (state: string) => string[]; behave: (behaviour: Record<string, unknown>) => void }> {
  const runtime = bundled('main.ts', 'runtime.mjs');
  const daemon = bundled(path.join('testing', 'fake-daemon.ts'), 'fake-daemon.mjs');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fake-paseo-'));
  const child = spawn(process.execPath, [daemon, '--state', state], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.unref();
  process.once('exit', () => {
    child.kill('SIGKILL');
    fs.rmSync(state, { recursive: true, force: true });
  });
  const [line] = await Promise.race([
    readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]().next().then((next) => [next.value]),
    new Promise<never>((_, reject) => child.once('exit', (code) => reject(new Error(`the fake Paseo daemon exited with ${code}`)))),
  ]);
  const { url } = JSON.parse(String(line)) as { url: string };

  return {
    url,
    // The runtime loads the client the member's Paseo installed; here, the one installed for the tests.
    args: (home) => [`HOME=${path.join(home, 'home')}`, `PASEO_CLIENT_PATH=${path.join(ROOT, 'node_modules', '@getpaseo', 'client')}`, process.execPath, runtime],
    behave: (behaviour) => fs.writeFileSync(path.join(state, 'behaviour.json'), JSON.stringify(behaviour)),
  };
}
