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

/** What a runtime's manifest says of it: `exec: false` when it runs no command, as every `init` of it answers. */
export const RuntimeFactsSchema = z.object({ exec: z.boolean().optional().catch(undefined) }).catch({});

/** The runtime facts in a package manifest: under `teamai`, `runtimes.<name>` for each runtime teamai ships, by the name `use` gives it. */
const PackageSchema = z.object({
  bin: z.record(z.string(), z.string()).optional(),
  teamai: z.object({ runtimes: z.record(z.string(), RuntimeFactsSchema).optional().catch(undefined) }).optional().catch(undefined),
});

/**
 * The step runtime `name` that teamai ships: its built file, the `teamai-runtime-<name>` entry of the package's `bin`,
 * in `packageDir`, and what the package manifest says of it beside that (`teamai.runtimes.<name>`); undefined when it
 * ships none. Found here, a stray executable of that name on PATH never shadows it.
 */
export function shippedRuntime(name: string, packageDir = teamaiPackageDir()): { file: string; exec?: boolean } | undefined {
  let manifest: z.infer<typeof PackageSchema>;

  try {
    manifest = PackageSchema.parse(JSON.parse(readRegularFileSync(path.join(packageDir, 'package.json'), 'utf8')));
  } catch {
    return undefined;
  }

  const entry = manifest.bin?.[`teamai-runtime-${name}`];

  if (entry === undefined) return undefined;
  const file = path.resolve(packageDir, entry);

  // A bin entry that leaves the package is not one teamai ships.
  if (path.relative(packageDir, file).startsWith('..') || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;
  const exec = manifest.teamai?.runtimes?.[name]?.exec;

  return { file, ...(exec !== undefined && { exec }) };
}
