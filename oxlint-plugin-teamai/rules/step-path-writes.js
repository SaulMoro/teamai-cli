/** @import { ESTree } from '@oxlint/plugins' */
import fs from 'node:fs';
import path from 'node:path';

import { defineRule } from '@oxlint/plugins';
import { z } from 'zod';

import { fsFunctionOf, openKindOf } from '../fs-calls.js';
import { repositoryPath, stringLiteralValue } from '../utils.js';

/**
 * The calls that open a path for writing whatever it holds: a FIFO there waits for a reader. A copy opens its
 * destination so; fs-extra's writers of a whole file too.
 */
const WRITES = new Set([
  'createWriteStream', 'appendFile', 'appendFileSync', 'copyFile', 'copyFileSync',
  'outputFile', 'outputFileSync', 'writeJson', 'writeJsonSync', 'writeJSON', 'writeJSONSync', 'outputJson', 'outputJsonSync', 'outputJSON', 'outputJSONSync',
]);

/** The calls that write a whole file, replacing it unless their options' `flag` only creates. */
const WHOLE_WRITES = new Set(['writeFile', 'writeFileSync']);

/** The calls that open a path, writing when their flags say so. */
const OPENS = new Set(['open', 'openSync']);

const MESSAGE = 'Write a file in src/workflow with writeRegularFile, appendRegularFile or openRegularFileForWrite from @teamai/shared/regular-file, or with writeJsonAtomic: a step writes the paths the engine writes to, and a FIFO it leaves there blocks a plain open for writing until a reader comes, past every deadline and past process.exit. The helper opens without blocking and refuses anything but a regular file. A create that fails on anything already there (flag wx) is allowed.';

/** The rule's option, as `meta.schema` lets it be written; unset lists nothing. */
const OptionsSchema = z.tuple([z.object({ stillWrites: z.array(z.string()) }).strict()]).or(z.tuple([]));

/**
 * Whether the rule checks `file`, given from the repository root: production source under `src/workflow/`, so a new
 * folder there is in scope with no rule edit. Tests, `__tests__/` and `testing/` support are not.
 * @param {string} file
 * @returns {boolean}
 */
export function isWriteChecked(file) {
  return /^src\/workflow\/.+\.[cm]?[jt]sx?$/.test(file) && !/\.test\.[cm]?[jt]sx?$|\/(?:__tests__|testing)\//.test(file);
}

/**
 * Whether `options`, a whole-file write's third argument, may replace what is there: anything but an object literal whose
 * `flag` is a string with `x`, which only creates and fails at once on a FIFO. What the rule cannot read replaces.
 * @param {ESTree.Node | undefined} options
 * @returns {boolean}
 */
function replacesWith(options) {
  if (options?.type !== 'ObjectExpression') return true;
  const flag = options.properties.find((property) => property.type === 'Property' && !property.computed && property.key.type === 'Identifier' && property.key.name === 'flag');
  const text = flag?.type === 'Property' ? stringLiteralValue(flag.value) : undefined;

  return text === undefined || !text.includes('x');
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Write files in src/workflow only through the helpers that refuse a FIFO or a device.' },
    // `stillWrites`: files, from the repository root, that still write a file plainly, until their owner converts them.
    // The list only shrinks: an entry that no longer writes one, or whose file is gone, fails until it is removed.
    schema: [{ type: 'object', properties: { stillWrites: { type: 'array', items: { type: 'string' } } }, required: ['stillWrites'], additionalProperties: false }],
  },
  create(context) {
    const { root, relative } = repositoryPath(context);

    if (!isWriteChecked(relative)) return {};
    const { sourceCode } = context;
    const listed = OptionsSchema.parse(context.options)[0]?.stillWrites ?? [];
    const isListed = listed.includes(relative);
    // Each file checks the entries of its own folder, so a removed file fails lint instead of staying listed.
    const gone = listed.filter((file) => path.posix.dirname(file) === path.posix.dirname(relative) && !fs.existsSync(path.posix.join(root, file)));
    let writes = false;

    return {
      CallExpression(node) {
        const called = fsFunctionOf(sourceCode, node.callee);

        const [, flags, options] = node.arguments;

        if (called === undefined || !(WRITES.has(called) || (WHOLE_WRITES.has(called) && replacesWith(options)) || (OPENS.has(called) && openKindOf(flags) !== 'read'))) return;
        writes = true;

        if (!isListed) context.report({ node, message: MESSAGE });
      },
      'Program:exit'(/** @type {ESTree.Program} */ node) {
        for (const file of gone) context.report({ node, message: `${file} is listed in stillWrites but does not exist. Remove it from the teamai/step-path-writes option.` });

        if (isListed && !writes) context.report({ node, message: `${relative} no longer opens a file for writing. Remove it from stillWrites in the teamai/step-path-writes option.` });
      },
    };
  },
});
