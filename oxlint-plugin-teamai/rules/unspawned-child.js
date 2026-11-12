/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { importedName } from '../imports.js';
import { variableOf } from '../utils.js';

const MESSAGE = 'A ChildProcess built with new, through a class that extends it, or by calling it on an object, holds a native handle no process was spawned for, and its kill() signals pid 0: the whole process group of whatever runs it, which on a CI runner is the runner itself. Spawn a real process, or build a fake with no handle: Object.create(ChildProcess.prototype).';

/** The modules `ChildProcess` comes from. */
const MODULE = new Set(['child_process', 'node:child_process']);

const CALLS_ON = new Set(['call', 'apply']);
const REFLECT_CALLS = new Set(['apply', 'construct']);

/**
 * The function a call runs as a constructor or on an object it chose: `f` of `f.call(...)`, `f.apply(...)`,
 * `Reflect.apply(f, ...)` and `Reflect.construct(f, ...)`.
 * @param {ESTree.CallExpression} node
 */
function calledOn(node) {
  const { callee } = node;

  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return undefined;

  if (callee.object.type === 'Identifier' && callee.object.name === 'Reflect') return REFLECT_CALLS.has(callee.property.name) ? node.arguments[0] : undefined;

  return CALLS_ON.has(callee.property.name) ? callee.object : undefined;
}

/**
 * Whether `node` names `ChildProcess` of node:child_process: imported by that name or another, or read off any object.
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
    docs: { description: 'Never construct a ChildProcess, extend it, or call it on an object: its handle backs no process, and its kill signals pid 0, the whole process group.' },
  },
  create(context) {
    /** @param {ESTree.Class} node */
    const checkClass = (node) => {
      if (node.superClass && isChildProcessClass(context.sourceCode, node.superClass)) context.report({ node, message: MESSAGE });
    };

    return {
      /** @param {ESTree.NewExpression} node */
      NewExpression(node) {
        if (isChildProcessClass(context.sourceCode, node.callee)) context.report({ node, message: MESSAGE });
      },
      /** @param {ESTree.CallExpression} node */
      CallExpression(node) {
        const target = calledOn(node);

        if (target && isChildProcessClass(context.sourceCode, target)) context.report({ node, message: MESSAGE });
      },
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
    };
  },
});
