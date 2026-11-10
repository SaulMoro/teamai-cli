/** @import { ESTree } from '@oxlint/plugins' */
import fs from 'node:fs';
import path from 'node:path';

import { defineRule } from '@oxlint/plugins';
import { z } from 'zod';

import { fsFunctionOf } from '../fs-calls.js';
import { repositoryPath, stringLiteralValue } from '../utils.js';

/** The calls that open a path for writing whatever it holds: a FIFO there waits for a reader. */
const WRITES = new Set(['createWriteStream', 'appendFile', 'appendFileSync']);

/** The calls that open a path, writing when their flags say so. */
const OPENS = new Set(['open', 'openSync']);

/** The `fs.constants` an open only reads with; any other constant, such as `O_WRONLY` or `O_CREAT`, counts as a write. */
const READ_FLAGS = new Set(['O_RDONLY', 'O_NONBLOCK', 'O_NOFOLLOW', 'O_NOATIME', 'O_CLOEXEC', 'O_DIRECTORY', 'O_SYNC', 'O_DSYNC']);

const MESSAGE = 'Open a file for writing in src/workflow with openRegularFileForWrite or appendRegularFile from @teamai/shared/regular-file, or write it whole with writeJsonAtomic: a step writes the paths the engine writes to, and a FIFO it leaves there blocks a plain open for writing until a reader comes, past every deadline. The helper opens without blocking and refuses anything but a regular file.';

/** The rule's option, as `meta.schema` lets it be written; unset lists nothing. */
const OptionsSchema = z.tuple([z.object({ stillAppends: z.array(z.string()) }).strict()]).or(z.tuple([]));

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
 * The constant names `node` ORs together, such as `O_WRONLY` of `fs.constants.O_WRONLY`; undefined when any part is
 * not a named constant.
 * @param {ESTree.Node} node
 * @returns {string[] | undefined}
 */
function constantNames(node) {
  if (node.type === 'BinaryExpression' && node.operator === '|') {
    const left = constantNames(node.left);
    const right = constantNames(node.right);

    return left && right && [...left, ...right];
  }

  return node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' ? [node.property.name] : undefined;
}

/**
 * Whether `flags`, an open's second argument, may write: a string with `w`, `a` or `+`, a constant that is not a read
 * constant, or anything this rule cannot read, which counts as a write so the rule fails closed.
 * @param {ESTree.Node | undefined} flags
 * @returns {boolean}
 */
function writesWith(flags) {
  if (flags === undefined) return false;
  const text = stringLiteralValue(flags);

  if (text !== undefined) return /[wa+]/.test(text);
  const names = constantNames(flags);

  return names === undefined || names.some((name) => !READ_FLAGS.has(name));
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Open files for writing in src/workflow only through the helper that refuses a FIFO or a device.' },
    // `stillAppends`: files, from the repository root, that still open a file for writing plainly, until their owner
    // converts them. The list only shrinks: an entry that no longer opens one, or whose file is gone, fails until it is removed.
    schema: [{ type: 'object', properties: { stillAppends: { type: 'array', items: { type: 'string' } } }, required: ['stillAppends'], additionalProperties: false }],
  },
  create(context) {
    const { root, relative } = repositoryPath(context);

    if (!isWriteChecked(relative)) return {};
    const { sourceCode } = context;
    const listed = OptionsSchema.parse(context.options)[0]?.stillAppends ?? [];
    const isListed = listed.includes(relative);
    // Each file checks the entries of its own folder, so a removed file fails lint instead of staying listed.
    const gone = listed.filter((file) => path.posix.dirname(file) === path.posix.dirname(relative) && !fs.existsSync(path.posix.join(root, file)));
    let writes = false;

    return {
      CallExpression(node) {
        const called = fsFunctionOf(sourceCode, node.callee);

        if (called === undefined || !(WRITES.has(called) || (OPENS.has(called) && writesWith(node.arguments[1])))) return;
        writes = true;

        if (!isListed) context.report({ node, message: MESSAGE });
      },
      'Program:exit'(/** @type {ESTree.Program} */ node) {
        for (const file of gone) context.report({ node, message: `${file} is listed in stillAppends but does not exist. Remove it from the teamai/step-path-writes option.` });

        if (isListed && !writes) context.report({ node, message: `${relative} no longer opens a file for writing. Remove it from stillAppends in the teamai/step-path-writes option.` });
      },
    };
  },
});
