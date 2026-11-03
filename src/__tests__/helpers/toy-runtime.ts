import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE = path.join(ROOT, 'src', '__tests__', 'fixtures', 'runtime-toy', 'runtime.mjs');
const PROTOCOL = path.join(ROOT, 'packages', 'runtime-protocol', 'src', 'protocol.ts');

/**
 * The toy built as one executable file, as a runtime ships: its source with @teamai/runtime-protocol bundled in. One
 * build per source revision is kept in the temp directory, so every test file and worker reuses it.
 */
function bundledToy(): string {
  const revision = createHash('sha256').update(fs.readFileSync(SOURCE)).update(fs.readFileSync(PROTOCOL)).digest('hex').slice(0, 16);
  const file = path.join(os.tmpdir(), `teamai-toy-runtime-${revision}`, 'runtime.mjs');

  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const building = `${file}.${process.pid}.tmp`;
  buildSync({ entryPoints: [SOURCE], outfile: building, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error' });
  fs.chmodSync(building, 0o755);
  fs.renameSync(building, file);

  return file;
}

/**
 * The toy step runtime: a stdio program that runs each `exec` on the host, keeps its handles and outcomes in its
 * `state` option's directory, and with `die_at` kills the teamai that spawned it at a named point.
 */
export const TOY_RUNTIME = bundledToy();
