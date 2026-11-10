import { defineRule } from '@oxlint/plugins';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { importVisitors } from '../imports.js';
import { lintedPath, scopedFiles, sourcePath, workspaceRoot } from '../utils.js';

/**
 * What `teamai` (src/bin.ts, the tsup `index` entry) loads before the compile
 * cache is on and the CLI bundle is imported: every hook pays for it, and the
 * hook fast path exits on it alone (#1788). Paths are from the repository root.
 */
export const UNCACHED = new Set(scopedFiles([
  'src/bin.ts',
  'src/hook-fast-path.ts',
  'src/utils/hook-stdin.ts',
  'packages/tool-core/src/debug-log.ts',
  'packages/tool-core/src/home.ts',
]));

const ExportsSchema = z.object({ name: z.string(), exports: z.record(z.string(), z.unknown()).optional() });

/**
 * The file a workspace package specifier names through its package's exports map, from the repository root
 * (`@teamai/tool-core/home` → `packages/tool-core/src/home.ts`); undefined for any other specifier.
 * @param {string} root
 * @param {string} specifier
 */
function workspaceFile(root, specifier) {
  const dir = `${root}/packages`;

  for (const folder of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const file = `${dir}/${folder}/package.json`;

    if (!fs.existsSync(file)) continue;
    const parsed = ExportsSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));

    if (!parsed.success || (specifier !== parsed.data.name && !specifier.startsWith(`${parsed.data.name}/`))) continue;
    const target = z.string().safeParse(parsed.data.exports?.[`.${specifier.slice(parsed.data.name.length)}`]);

    return target.success ? path.posix.join('packages', folder, target.data) : undefined;
  }

  return undefined;
}

export default defineRule({
  meta: { type: 'problem', docs: { description: 'What runs before the CLI bundle imports only node: modules and itself.' } },
  create(context) {
    const file = lintedPath(context);
    const root = workspaceRoot(path.posix.dirname(file));
    const from = root === undefined ? sourcePath(context) : path.posix.relative(root, file);

    if (!UNCACHED.has(from)) return {};

    return importVisitors(({ node, specifier, typeOnly }) => {
      if (typeOnly || specifier.startsWith('node:')) return;

      const to = specifier.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)).replace(/\.js$/, '.ts')
        : root === undefined ? undefined : workspaceFile(root, specifier);

      if (to !== undefined && UNCACHED.has(to)) return;

      context.report({
        node,
        message: `${from} runs before the CLI bundle loads, for every hook (#1788), so it imports only node: modules and the files in UNCACHED `
          + `(oxlint-plugin-teamai/rules/uncached-entry.js). Import ${specifier} from code the CLI bundle runs instead, `
          + 'or add a file to UNCACHED once it imports nothing else.',
      });
    });
  },
});
