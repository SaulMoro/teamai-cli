import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The file of the driver definition teamai ships as `name`, under `drivers/` in the package root. This file sits one
 * level below the root, in src/ and in the bundle in dist/ alike, as `default-workflows.ts` does.
 */
export function shippedDriverFile(name: string): string {
  const modulePath = fileURLToPath(import.meta.url);
  let moduleDir: string;

  try {
    moduleDir = path.dirname(fs.realpathSync(modulePath));
  } catch {
    moduleDir = path.dirname(modulePath);
  }

  return path.join(moduleDir, '..', 'drivers', `${name}.yaml`);
}
