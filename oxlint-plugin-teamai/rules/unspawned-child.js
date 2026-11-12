/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { importedName } from '../imports.js';
import { variableOf } from '../utils.js';

const MESSAGE = 'new ChildProcess() holds a native handle no process was spawned for, and its kill() signals pid 0: the whole process group of whatever runs it, which on a CI runner is the runner itself. Spawn a real process, or build a fake with no handle: Object.create(ChildProcess.prototype).';

/** The modules `ChildProcess` comes from. */
const MODULE = new Set(['child_process', 'node:child_process']);

/**
 * Whether `node` names `ChildProcess` of node:child_process: imported by that name or another, or read off the module.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node} node
 */
function isChildProcessClass(sourceCode, node) {
  if (node.type === 'MemberExpression') return !node.computed && node.property.type === 'Identifier' && node.property.name === 'ChildProcess';

  if (node.type !== 'Identifier') return false;
  const def = variableOf(sourceCode, node, node.name)?.defs[0];

  if (def?.type !== 'ImportBinding') return false;

  return def.node.type === 'ImportSpecifier' && def.parent?.type === 'ImportDeclaration' && MODULE.has(String(def.parent.source.value))
    && importedName(def.node) === 'ChildProcess';
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Never construct a ChildProcess: its handle backs no process, and its kill signals pid 0, the whole process group.' },
  },
  create(context) {
    return {
      /** @param {ESTree.NewExpression} node */
      NewExpression(node) {
        if (isChildProcessClass(context.sourceCode, node.callee)) context.report({ node, message: MESSAGE });
      },
    };
  },
});
