/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { lintedPath, scopedFiles, stringLiteralValue } from '../utils.js';

/** The runtime packages that are the protocol itself: its schemas, the kit that serves it, and the kit tests use. */
const PROTOCOL_PACKAGES = new Set(['runtime-protocol', 'runtime-kit', 'runtime-testing']);

/** The events that end an exec or a prompt, which only the runtime kit's ledger writes; an open's `ready` is counted all the same. */
const ENDS = new Set(['exited', 'finished', 'cancelled', 'failed']);

/**
 * Runtimes that still serve protocol 1 themselves, until each adopts the runtime kit. A new runtime starts on the kit;
 * this list only shrinks, and an entry that no longer serves the protocol itself fails until it is removed.
 */
const NOT_YET_ON_THE_KIT = new Set(scopedFiles([
  // Until the sandbox adopts them.
  'packages/runtime-sandbox/src/runtime.ts',
]));

/**
 * The linted file's path from the repository root, as `{ relative }`, when it is a runtime package's production source,
 * else undefined.
 * @param {string} file
 */
function runtimeSource(file) {
  const match = /(?:^|\/)(packages\/(runtime-[^/]+)\/src\/(.+))$/.exec(file);

  if (!match) return undefined;
  const [, relative = '', folder = '', rest = ''] = match;

  if (PROTOCOL_PACKAGES.has(folder) || rest.startsWith('testing/') || /\.test\.[cm]?[jt]sx?$/.test(rest)) return undefined;

  return { relative };
}

/**
 * The property of `object` named `name`, when it has one written out.
 * @param {ESTree.ObjectExpression} object
 * @param {string} name
 */
function property(object, name) {
  return object.properties.find((candidate) => candidate.type === 'Property' && !candidate.computed && candidate.key.type === 'Identifier' && candidate.key.name === name);
}

/**
 * Whether `node` is the process input: `process.stdin`, `stdin` from `node:process`, or a value named `input`, the name
 * the runtime kit gives it.
 * @param {ESTree.Node | undefined} node
 */
function isProcessInput(node) {
  if (node?.type === 'Identifier') return node.name === 'input' || node.name === 'stdin';

  return node?.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier'
    && (node.property.name === 'input' || (node.property.name === 'stdin' && node.object.type === 'Identifier' && node.object.name === 'process'));
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Serve runtime protocol 1 only through the runtime kit: no runtime reads requests or writes an op\'s end itself.' },
  },
  create(context) {
    const source = runtimeSource(lintedPath(context));

    if (source === undefined) return {};
    const isBaseline = NOT_YET_ON_THE_KIT.has(source.relative);
    let serves = false;

    /** @param {ESTree.Node} node @param {string} message */
    const report = (node, message) => {
      serves = true;

      if (!isBaseline) context.report({ node, message });
    };

    return {
      /** @param {ESTree.CallExpression} node */
      CallExpression(node) {
        const { callee } = node;
        const name = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' ? callee.property.name : undefined;
        const [options] = node.arguments;

        if (name === 'createInterface' && options !== undefined) {
          const input = options.type === 'ObjectExpression' ? property(options, 'input') : undefined;

          if ((input?.type === 'Property' && isProcessInput(input.value)) || isProcessInput(options)) {
            report(node, 'Read requests with serveRuntime from @teamai/runtime-kit/serve, not a readline over the process input: the kit answers an unreadable line and a handler that threw as protocol 1 says, for every runtime alike.');
          }
        }

        if ((name === 'parse' || name === 'safeParse') && callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'RuntimeRequestSchema') {
          report(node, 'Leave parsing requests to serveRuntime from @teamai/runtime-kit/serve: a handler gets its request already parsed, by type.');
        }
      },
      /** @param {ESTree.ObjectExpression} node */
      ObjectExpression(node) {
        const event = property(node, 'event');
        const ended = event?.type === 'Property' ? stringLiteralValue(event.value) : undefined;

        if (ended !== undefined && ENDS.has(ended) && property(node, 'op') !== undefined) {
          report(node, `End an operation through the runtime kit's ledger (ledger.end or ledger.settle from @teamai/runtime-kit/ledger), not a '${ended}' line of its own: the ledger writes each op's end once, and keeps one it could not journal.`);
        }
      },
      /** @param {ESTree.Program} node */
      'Program:exit'(node) {
        if (isBaseline && !serves) {
          context.report({ node, message: `${source.relative} no longer serves runtime protocol 1 itself: remove it from NOT_YET_ON_THE_KIT in oxlint-plugin-teamai/rules/runtime-serve.js.` });
        }
      },
    };
  },
});
