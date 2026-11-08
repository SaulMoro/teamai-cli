import fs from 'node:fs';
import path from 'node:path';
import { defineRule } from '@oxlint/plugins';
import { z } from 'zod';

import { importVisitors } from '../imports.js';
import { lintedPath, scopedFiles } from '../utils.js';

/**
 * Tests that still reach past a seam of their package, as `<test> -> <module>` from the repository root. A new test
 * reaches only its own module, src/testing/ and the package's exports; this list only shrinks, and an entry the test
 * no longer imports fails until it is removed.
 */
const PAST_A_SEAM = new Set([
  // The Paseo runtime's own test reads two helpers of its runtime module, until they have tests of their own.
  'packages/runtime-paseo/src/runtime-paseo.test.ts -> packages/runtime-paseo/src/runtime.ts',
  'packages/runtime-paseo/src/runtime-paseo.test.ts -> packages/runtime-paseo/src/daemon.ts',
  // The T3 runtime's test reads how a step thread's session is found, until its test is split by module.
  'packages/runtime-t3/src/runtime-t3.test.ts -> packages/runtime-t3/src/sessions.ts',
  // The sandbox wrapper's test reads the provider's command runner, until the sandbox is split by module.
  'packages/runtime-sandbox/src/wrapper.test.ts -> packages/runtime-sandbox/src/providers/cli.ts',
  // Tool families whose tests are named apart from the module they test, or read their launch adapter.
  'packages/tool-agy/src/agy-session-adapter.test.ts -> packages/tool-agy/src/session-adapter.ts',
  'packages/tool-claude/src/project-dir.test.ts -> packages/tool-claude/src/sessions.ts',
  'packages/tool-claude/src/testing/fake-agent.test.ts -> packages/tool-claude/src/launch.ts',
  'packages/tool-cursor/src/cursor-bubble-range.test.ts -> packages/tool-cursor/src/cursor-store.ts',
  'packages/tool-muse/src/muse-session-adapter.test.ts -> packages/tool-muse/src/session-adapter.ts',
  'packages/tool-opencode/src/testing/fake-agent.test.ts -> packages/tool-opencode/src/launch.ts',
]);

// A listed test that moves fails when lint loads the rule, instead of keeping its entry for good.
scopedFiles([...PAST_A_SEAM].map((entry) => entry.split(' -> ')[0] ?? entry));

const ExportsSchema = z.object({ exports: z.union([z.string().transform((target) => ({ '.': target })), z.record(z.string(), z.string())]).optional() });

/**
 * The files a package's `exports` map names, relative to its folder.
 * @param {string} root
 * @returns {Set<string>}
 */
function exported(root) {
  const manifest = ExportsSchema.safeParse(JSON.parse(fs.readFileSync(path.posix.join(root, 'package.json'), 'utf8')));
  const targets = Object.values((manifest.success ? manifest.data.exports : undefined) ?? {});

  return new Set(targets.map((target) => `./${path.posix.normalize(target)}`));
}

/**
 * `file` with a TypeScript extension for the `.js` an ESM import names.
 * @param {string} file
 */
function sourceOf(file) {
  return file.replace(/\.([cm]?)js$/, '.$1ts');
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Test a package through its seams: the module the test is named after, src/testing/, and the package\'s exports.' },
  },
  create(context) {
    const file = lintedPath(context);
    const match = /(?:^|\/)(packages\/[^/]+)\/src\/(.+\.test\.[cm]?[jt]sx?)$/.exec(file);

    if (!match) return {};
    const [, pkg = '', test = ''] = match;
    const root = file.slice(0, file.length - `src/${test}`.length - 1);
    const from = `${pkg}/src/${test}`;
    const own = `src/${test.replace(/\.test(\.[cm]?[jt]sx?)$/, '$1')}`;
    const exports = exported(root);
    const listed = [...PAST_A_SEAM].filter((entry) => entry.startsWith(`${from} -> `));
    const reached = new Set();

    return {
      ...importVisitors(({ node, specifier }) => {
        if (!specifier.startsWith('.')) return;
        const target = sourceOf(path.posix.relative(root, path.posix.resolve(path.posix.dirname(file), specifier)));

        // Another package, or src/, reached by path: package-boundaries owns that.
        if (target.startsWith('..')) return;

        if (target === sourceOf(own) || target.startsWith('src/testing/') || exports.has(`./${target}`)) return;
        const entry = `${from} -> ${pkg}/${target}`;
        reached.add(entry);

        if (!PAST_A_SEAM.has(entry)) {
          context.report({ node, message: `${from} reaches ${target}, past its package's seams. Test it through ${own.replace(/^src\//, './').replace(/\.ts$/, '.js')}, src/testing/ or an entry of the package's exports, or give ${target} a test of its own.` });
        }
      }),
      'Program:exit'(node) {
        for (const entry of listed.filter((known) => !reached.has(known))) {
          context.report({ node, message: `${entry} is no longer imported: remove it from PAST_A_SEAM in oxlint-plugin-teamai/rules/test-seams.js.` });
        }
      },
    };
  },
});
