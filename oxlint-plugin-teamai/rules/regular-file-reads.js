/** @import { ESTree } from '@oxlint/plugins' */
import fs from 'node:fs';
import path from 'node:path';

import { defineRule } from '@oxlint/plugins';
import { z } from 'zod';

import { importedName } from '../imports.js';
import { repositoryPath, scopedFiles, variableOf } from '../utils.js';

/** The modules a file is read from. */
const FS = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'fs-extra']);

/** The calls that open a path to read it as they find it, and so wait on a FIFO there: reads, copies, and fs-extra's JSON reads. */
const READS = new Set([
  'readFile', 'readFileSync', 'createReadStream', 'copyFile', 'copyFileSync',
  'readJson', 'readJsonSync', 'readJSON', 'readJSONSync',
]);

/**
 * The helper itself, which reads only the descriptor it opened without blocking and checked. Only this file reads
 * plainly by design; `scopedFiles` fails lint if it moves.
 */
const HELPER = scopedFiles(['packages/shared/src/regular-file.ts'])[0];

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

/**
 * The module `variable` imports, and the name it imports from it (`default` or `*` for the module itself); undefined
 * when it is no import.
 * @param {import('@oxlint/plugins').Variable | undefined} variable
 */
function importOf(variable) {
  const def = variable?.defs[0];

  if (def?.type !== 'ImportBinding' || def.parent?.type !== 'ImportDeclaration') return undefined;
  const { node } = def;

  if (node.type !== 'ImportSpecifier' && node.type !== 'ImportDefaultSpecifier' && node.type !== 'ImportNamespaceSpecifier') return undefined;

  return { from: String(def.parent.source.value), name: importedName(node) };
}

/**
 * Whether `node` is a file module itself: a default or namespace import of one, or its `promises`.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
function isFsModule(sourceCode, node) {
  if (node.type === 'MemberExpression') {
    return !node.computed && node.property.type === 'Identifier' && node.property.name === 'promises' && isFsModule(sourceCode, node.object);
  }

  if (node.type !== 'Identifier') return false;
  const imported = importOf(variableOf(sourceCode, node, node.name));

  return imported !== undefined && FS.has(imported.from) && (imported.name === 'default' || imported.name === '*' || imported.name === 'promises');
}

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

    if (!isReadChecked(relative) || relative === HELPER) return {};
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
      ImportDeclaration(node) {
        if (!FS.has(String(node.source.value)) || node.importKind === 'type') return;

        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') continue;

          if (READS.has(importedName(specifier))) found.push(specifier);
        }
      },
      CallExpression(node) {
        const { callee } = node;

        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier' || !READS.has(callee.property.name)) return;

        if (isFsModule(sourceCode, callee.object)) found.push(node);
      },
    };
  },
});
