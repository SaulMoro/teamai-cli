/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { stringLiteralValue } from '../utils.js';

/** The methods that add a listener to an emitter. */
const LISTENS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);

const MESSAGE = 'Listen for errors on this interface: readline re-emits its input\'s errors on the interface, which throws them when nothing listens there, so a socket or stream that fails ends the process. Add .on(\'error\', …) to it, or read it with for await, which rejects instead.';

/**
 * The `input` `createInterface` reads: its options object's `input`, or its first argument itself, as the positional
 * form passes the stream, or an options object the rule cannot see into, which it checks all the same.
 * @param {ESTree.Node | undefined} first
 */
function inputOf(first) {
  if (first === undefined || first.type === 'SpreadElement') return undefined;

  if (first.type !== 'ObjectExpression') return first;
  const input = first.properties.find((candidate) => candidate.type === 'Property' && !candidate.computed && candidate.key.type === 'Identifier' && candidate.key.name === 'input');

  return input?.type === 'Property' ? input.value : undefined;
}

/** The node types that start a scope of their own for a name bound with `const` or `let` inside them. */
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/**
 * The functions `node` is in, innermost first, then the program: the scopes a name it uses may be bound in.
 * @param {ESTree.Node} node
 * @returns {ESTree.Node[]}
 */
function scopesOf(node) {
  /** @type {ESTree.Node[]} */
  const scopes = [];

  for (let current = node.parent; current; current = current.parent) {
    if (FUNCTIONS.has(current.type) || current.type === 'Program') scopes.push(current);
  }

  return scopes;
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
    /** @type {Array<{ node: ESTree.Node; name: string; scope: ESTree.Node | undefined }>} */
    const bound = [];
    /**
     * Where a name is handled: the name, and the scopes of the code that handles it, innermost first.
     * @type {Array<{ name: string; scopes: ESTree.Node[] }>}
     */
    const handlers = [];

    /**
     * @param {string | undefined} name
     * @param {ESTree.Node} node
     */
    const handles = (name, node) => {
      if (name !== undefined) handlers.push({ name, scopes: scopesOf(node) });
    };

    return {
      /** @param {ESTree.CallExpression} node */
      CallExpression(node) {
        if (listensForErrors(node) && node.callee.type === 'MemberExpression') handles(rootName(node.callee.object), node);

        if (!isCreateInterface(node)) return;
        const input = inputOf(node.arguments[0]);

        if (input === undefined || isProcessInput(input) || isHandledWhereMade(node)) return;
        const name = boundName(node);

        if (name === undefined) context.report({ node, message: MESSAGE });
        else bound.push({ node, name, scope: scopesOf(node)[0] });
      },
      /** @param {ESTree.ForOfStatement} node */
      ForOfStatement(node) {
        if (node.await && node.right.type === 'Identifier') handles(node.right.name, node);
      },
      /** @param {ESTree.MemberExpression} node */
      MemberExpression(node) {
        if (isAsyncIterator(node) && node.object.type === 'Identifier') handles(node.object.name, node);
      },
      'Program:exit'() {
        // A handler reaches the interface bound to its name in the innermost scope around it that binds one, as the
        // name itself resolves: an interface of the same name in another function is another interface.
        const reached = new Set(handlers.flatMap(({ name, scopes }) => {
          const scope = scopes.find((candidate) => bound.some((each) => each.name === name && each.scope === candidate));

          return bound.filter((each) => each.name === name && each.scope === scope);
        }));

        for (const each of bound) {
          if (!reached.has(each)) context.report({ node: each.node, message: MESSAGE });
        }
      },
    };
  },
});
