/** @import { ESTree } from '@oxlint/plugins' */
import fs from 'node:fs';
import path from 'node:path';

import { defineRule } from '@oxlint/plugins';
import { z } from 'zod';

import { fsFunctionOf, openKindOf } from '../fs-calls.js';
import { repositoryPath } from '../utils.js';

/** The calls that open a path to read it as they find it, and so wait on a FIFO there: reads, copies, and fs-extra's JSON reads. */
const READS = new Set([
  'readFile', 'readFileSync', 'createReadStream', 'copyFile', 'copyFileSync',
  'readJson', 'readJsonSync', 'readJSON', 'readJSONSync',
]);

/** The calls that open a path, reading when their flags say so. */
const OPENS = new Set(['open', 'openSync']);

/**
 * Whether `node` is used as a value where it stands, rather than naming something: not an import, a declared name, a
 * property key, the object or property of a longer member access.
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
function refersToValue(node) {
  const { parent } = node;

  switch (parent?.type) {
    case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier':
      return false;
    case 'MemberExpression':
      return parent.object !== node && parent.computed;
    case 'Property':
      return parent.value === node && parent.parent?.type !== 'ObjectPattern';
    case 'VariableDeclarator':
      return parent.init === node;
    default:
      return true;
  }
}

/**
 * Whether `node`, a reference to a file module function, is that call's callee rather than the function passed on.
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
function isCalled(node) {
  return node.parent?.type === 'CallExpression' && node.parent.callee === node;
}

const MESSAGE = 'Read a file with readRegularFile or openRegularFile from @teamai/shared/regular-file: a step writes the paths the engine reads, and a FIFO it leaves there blocks a plain read until a writer comes, past every deadline. The helper opens without blocking and refuses anything but a regular file.';

/** The baseline file: how many plain reads each file still has, by its path from the repository root. */
export const BaselineSchema = z.record(z.string(), z.number().int().positive());

/** The rule's option: the baseline file, from the repository root. */
const OptionsSchema = z.tuple([z.object({ baseline: z.string() }).strict()]);

/**
 * Whether the rule checks `file`, given from the repository root: production source under `src/` or a package's `src/`,
 * so a new folder or package is in scope with no rule edit. Tests, `__tests__/` and `testing/` support are not.
 * @param {string} file
 * @returns {boolean}
 */
export function isReadChecked(file) {
  return /^(?:packages\/[^/]+\/)?src\/.+\.[cm]?[jt]sx?$/.test(file) && !/\.test\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|testing)\//.test(file.replace(/^(?:packages\/[^/]+\/)?src\//, ''));
}

/** @type {Map<string, z.infer<typeof BaselineSchema>>} */
const baselines = new Map();

/**
 * The baseline at `file`, read once per lint run.
 * @param {string} file
 */
function baselineAt(file) {
  const cached = baselines.get(file);

  if (cached !== undefined) return cached;
  const baseline = BaselineSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  baselines.set(file, baseline);

  return baseline;
}

/** @param {number} count */
const reads = (count) => `${count} plain read${count === 1 ? '' : 's'}`;

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Read files in production source only through the helper that refuses a FIFO or a device.' },
    // `baseline`: a JSON file, from the repository root, of the plain reads each file still has. It only shrinks: a read past a
    // file's count fails, a count that fell fails until its entry is lowered, and an entry whose file is gone fails.
    schema: [{ type: 'object', properties: { baseline: { type: 'string' } }, required: ['baseline'], additionalProperties: false }],
  },
  create(context) {
    const { root, relative } = repositoryPath(context);

    if (!isReadChecked(relative)) return {};
    const { sourceCode } = context;
    const [{ baseline: baselineFile }] = OptionsSchema.parse(context.options);
    const baseline = baselineAt(path.posix.join(root, baselineFile));
    const allowed = baseline[relative] ?? 0;
    // Each file checks the entries of its own folder, so a removed file fails lint instead of staying listed.
    const gone = Object.keys(baseline).filter((file) => path.posix.dirname(file) === path.posix.dirname(relative) && !fs.existsSync(path.posix.join(root, file)));
    /** @type {ESTree.Node[]} */
    const found = [];

    return {
      'Program:exit'(/** @type {ESTree.Program} */ node) {
        for (const file of gone) context.report({ node, message: `${file} is in ${baselineFile} but does not exist. Remove its entry.` });

        if (found.length > allowed) {
          const counted = allowed === 0 ? '' : ` ${relative} has ${reads(found.length)}; the baseline allows ${allowed}.`;

          for (const read of found) context.report({ node: read, message: `${MESSAGE}${counted}` });
        } else if (found.length < allowed) {
          context.report({ node, message: `${relative} has ${reads(found.length)}; lower its entry in ${baselineFile} from ${allowed} to ${found.length}${found.length === 0 ? ' by removing it' : ''}.` });
        }
      },
      // Each call counts, as does a read passed on as a value, such as `.then(readFile)`, which a later call makes.
      CallExpression(node) {
        const called = fsFunctionOf(sourceCode, node.callee);

        if (called !== undefined && (READS.has(called) || (OPENS.has(called) && openKindOf(node.arguments[1]) !== 'write'))) found.push(node);
      },
      'Identifier, MemberExpression'(/** @type {ESTree.Node} */ node) {
        if (isCalled(node) || !refersToValue(node)) return;
        const used = fsFunctionOf(sourceCode, node);

        if (used !== undefined && READS.has(used)) found.push(node);
      },
    };
  },
});
