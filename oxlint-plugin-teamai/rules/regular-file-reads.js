/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { importedName } from '../imports.js';
import { inProductionSource, sourcePath, variableOf } from '../utils.js';

/** The modules a file is read from. */
const FS = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'fs-extra']);

/** The reads that open a path as they find it, and so wait on a FIFO there. */
const READS = new Set(['readFile', 'readFileSync', 'createReadStream']);

/** The wrappers of `fs.readFile` in `src/utils/fs.ts`. */
const WRAPPERS = new Set(['readFileSafe', 'readFileIfExists']);

const MESSAGE = 'Read a file in src/workflow with readRegularFile or openRegularFile from @teamai/shared/regular-file: a step writes the paths the engine reads, and a FIFO it leaves there blocks a plain read until a writer comes, past every deadline. The helper opens without blocking and refuses anything but a regular file.';

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
    docs: { description: 'Read files in src/workflow only through the helper that refuses a FIFO or a device.' },
  },
  create(context) {
    if (!inProductionSource(context) || !sourcePath(context).startsWith('src/workflow/')) return {};
    const { sourceCode } = context;

    return {
      ImportDeclaration(node) {
        const from = String(node.source.value);
        const reads = FS.has(from) ? READS : from.endsWith('/utils/fs.js') ? WRAPPERS : undefined;

        if (reads === undefined || node.importKind === 'type') return;

        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier' && reads.has(importedName(specifier))) context.report({ node: specifier, message: MESSAGE });
        }
      },
      CallExpression(node) {
        const { callee } = node;

        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier' || !READS.has(callee.property.name)) return;

        if (isFsModule(sourceCode, callee.object)) context.report({ node, message: MESSAGE });
      },
    };
  },
});
