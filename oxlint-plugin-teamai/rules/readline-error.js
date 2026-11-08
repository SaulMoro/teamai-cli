/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { stringLiteralValue } from '../utils.js';

/** The methods that add a listener to an emitter. */
const LISTENS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);

const MESSAGE = 'Listen for errors on this interface: readline re-emits its input\'s errors on the interface, which throws them when nothing listens there, so a socket or stream that fails ends the process. Add .on(\'error\', …) to it, or read it with for await, which rejects instead.';

/**
 * The `input` an options object gives `createInterface`, when it gives one.
 * @param {ESTree.Node | undefined} options
 */
function inputOf(options) {
  if (options?.type !== 'ObjectExpression') return undefined;
  const input = options.properties.find((candidate) => candidate.type === 'Property' && !candidate.computed && candidate.key.type === 'Identifier' && candidate.key.name === 'input');

  return input?.type === 'Property' ? input.value : undefined;
}

/**
 * Whether `node` is `process.stdin`: a terminal's input, whose error ends the command as it should.
 * @param {ESTree.Node} node
 */
function isProcessInput(node) {
  return node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === 'process' && node.property.type === 'Identifier' && node.property.name === 'stdin';
}

/**
 * Whether `node` is a call to `createInterface`, as readline's export or a name it was imported as.
 * @param {ESTree.CallExpression} node
 */
function isCreateInterface(node) {
  const { callee } = node;

  return (callee.type === 'Identifier' && callee.name === 'createInterface') || (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'createInterface');
}

/**
 * Whether the member `node` is `[Symbol.asyncIterator]`.
 * @param {ESTree.MemberExpression} node
 */
function isAsyncIterator(node) {
  const key = node.property;

  return node.computed && key.type === 'MemberExpression' && key.object.type === 'Identifier' && key.object.name === 'Symbol' && key.property.type === 'Identifier' && key.property.name === 'asyncIterator';
}

/**
 * Whether `call` adds an `error` listener to its callee's object.
 * @param {ESTree.CallExpression} call
 */
function listensForErrors(call) {
  const { callee } = call;

  return callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && LISTENS.has(callee.property.name) && stringLiteralValue(call.arguments[0]) === 'error';
}

/**
 * Whether what reads `node`, an interface, handles its errors: an error listener on the chain of calls it starts, its
 * async iterator, or `for await` over it.
 * @param {ESTree.Node} node
 */
function isHandledWhereMade(node) {
  /** @type {ESTree.Node} */
  let current = node;

  for (;;) {
    const { parent } = current;

    if (parent?.type === 'ForOfStatement' && parent.await && parent.right === current) return true;

    if (parent?.type !== 'MemberExpression' || parent.object !== current) return false;

    if (isAsyncIterator(parent)) return true;
    const call = parent.parent;

    if (call?.type !== 'CallExpression' || call.callee !== parent) return false;

    if (listensForErrors(call)) return true;
    current = call;
  }
}

/**
 * The name the interface `node` is bound to, as `const lines = createInterface(…)`, when it is bound to one.
 * @param {ESTree.Node} node
 */
function boundName(node) {
  const { parent } = node;

  if (parent?.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier') return parent.id.name;

  if (parent?.type === 'AssignmentExpression' && parent.right === node && parent.left.type === 'Identifier') return parent.left.name;

  return undefined;
}

/**
 * The name a chain of calls and members starts from, as `lines` for `lines.on('line', f).on('error', g)`.
 * @param {ESTree.Node} node
 */
function rootName(node) {
  /** @type {ESTree.Node} */
  let current = node;

  while (current.type === 'MemberExpression' || current.type === 'CallExpression') current = current.type === 'MemberExpression' ? current.object : current.callee;

  return current.type === 'Identifier' ? current.name : undefined;
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Listen for errors on every readline interface over a socket or stream: readline re-emits its input\'s errors there and throws them when nothing listens.' },
  },
  create(context) {
    /** @type {Array<{ node: ESTree.Node; name: string }>} */
    const bound = [];
    /** @type {Set<string>} */
    const handled = new Set();

    return {
      /** @param {ESTree.CallExpression} node */
      CallExpression(node) {
        if (listensForErrors(node) && node.callee.type === 'MemberExpression') {
          const name = rootName(node.callee.object);

          if (name !== undefined) handled.add(name);
        }

        if (!isCreateInterface(node)) return;
        const input = inputOf(node.arguments[0]);

        if (input === undefined || isProcessInput(input) || isHandledWhereMade(node)) return;
        const name = boundName(node);

        if (name === undefined) context.report({ node, message: MESSAGE });
        else bound.push({ node, name });
      },
      /** @param {ESTree.ForOfStatement} node */
      ForOfStatement(node) {
        if (node.await && node.right.type === 'Identifier') handled.add(node.right.name);
      },
      /** @param {ESTree.MemberExpression} node */
      MemberExpression(node) {
        if (isAsyncIterator(node) && node.object.type === 'Identifier') handled.add(node.object.name);
      },
      'Program:exit'() {
        for (const { node, name } of bound) {
          if (!handled.has(name)) context.report({ node, message: MESSAGE });
        }
      },
    };
  },
});
