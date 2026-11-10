import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readRegularFileSync } from '@teamai/shared/regular-file';

/**
 * teamai's own package directory. This file sits one level below it, in src/ and in the bundle in dist/ alike, as
 * `default-workflows.ts` does.
 */
export function teamaiPackageDir(): string {
  const modulePath = fileURLToPath(import.meta.url);
  let moduleDir: string;

  try {
    moduleDir = path.dirname(fs.realpathSync(modulePath));
  } catch {
    moduleDir = path.dirname(modulePath);
  }

  return path.join(moduleDir, '..');
}

/** The file of the driver definition teamai ships as `name`, under `drivers/` in the package root. */
export function shippedDriverFile(name: string): string {
  return path.join(teamaiPackageDir(), 'drivers', `${name}.yaml`);
}

const PackageBinSchema = z.object({ bin: z.record(z.string(), z.string()).optional() });

/**
 * The built file of step runtime `name` that teamai ships: the `teamai-runtime-<name>` entry of the package's `bin`,
 * in `packageDir`, or undefined when it ships none. Found here, a stray executable of that name on PATH never shadows it.
 */
export function shippedRuntimeFile(name: string, packageDir = teamaiPackageDir()): string | undefined {
  let manifest: z.infer<typeof PackageBinSchema>;

  try {
    manifest = PackageBinSchema.parse(JSON.parse(readRegularFileSync(path.join(packageDir, 'package.json'), 'utf8')));
  } catch {
    return undefined;
  }

  const entry = manifest.bin?.[`teamai-runtime-${name}`];

  if (entry === undefined) return undefined;
  const file = path.resolve(packageDir, entry);

  // A bin entry that leaves the package is not one teamai ships.
  if (path.relative(packageDir, file).startsWith('..') || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;

  return file;
}
