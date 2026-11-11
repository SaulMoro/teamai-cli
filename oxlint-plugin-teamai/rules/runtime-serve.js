/** @import { ESTree } from '@oxlint/plugins' */
import fs from 'node:fs';

import { defineRule } from '@oxlint/plugins';
import { z } from 'zod';

import { lintedPath, stringLiteralValue } from '../utils.js';

/** The runtime packages that are the protocol itself: its schemas, the kit that serves it, and the kit tests use. */
const PROTOCOL_PACKAGES = new Set(['runtime-protocol', 'runtime-kit', 'runtime-testing']);

/** The events that end an exec or a prompt, which only the runtime kit's ledger writes; an open's `ready` is counted all the same. */
const ENDS = new Set(['exited', 'finished', 'cancelled', 'failed']);

/** The modules that read lines: only the runtime kit reads a runtime's input, and a socket's lines go through its `eachLine`. */
const LINE_READERS = new Set(['readline', 'node:readline', 'readline/promises', 'node:readline/promises']);

/** The rule's option, as `meta.schema` lets it be written; unset lists nothing. */
const OptionsSchema = z.tuple([z.object({ notYetOnTheKit: z.array(z.string()) })]).or(z.tuple([]));

/** The module whose `stdin` is the process input. */
const PROCESS_MODULES = new Set(['process', 'node:process']);

/**
 * The linted file's path from the repository root, as `{ relative, root, src }`, when it is a runtime package's
 * production source, else undefined. `root` is the repository's directory, and `src` the runtime's source directory
 * from it.
 * @param {string} file
 */
function runtimeSource(file) {
  const match = /(?:^|\/)(packages\/(runtime-[^/]+)\/src\/(.+))$/.exec(file);

  if (!match) return undefined;
  const [, relative = '', folder = '', rest = ''] = match;

  if (PROTOCOL_PACKAGES.has(folder) || rest.startsWith('testing/') || /\.test\.[cm]?[jt]sx?$/.test(rest)) return undefined;

  return { relative, root: file.slice(0, file.length - relative.length), src: `packages/${folder}/src/` };
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
 * Whether `node` names the property `stdin`, written out or as a string.
 * @param {ESTree.Node} node
 */
function isStdinKey(node) {
  return (node.type === 'Identifier' && node.name === 'stdin') || stringLiteralValue(node) === 'stdin';
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Serve runtime protocol 1 only through the runtime kit: no runtime reads its input, imports a line reader, parses requests or writes an op\'s end itself.' },
    // `notYetOnTheKit`: files, from the repository root, that still read requests or write an op's end themselves, until
    // their runtime adopts the kit. A new runtime starts on the kit; the list only shrinks: an entry that no longer does
    // either, or whose file is gone, fails until it is removed.
    schema: [{ type: 'object', properties: { notYetOnTheKit: { type: 'array', items: { type: 'string' } } }, required: ['notYetOnTheKit'], additionalProperties: false }],
  },
  create(context) {
    const source = runtimeSource(lintedPath(context));

    if (source === undefined) return {};
    const listed = OptionsSchema.parse(context.options)[0]?.notYetOnTheKit ?? [];
    const isBaseline = listed.includes(source.relative);
    // Each source of a runtime checks its entries, so a renamed or removed file fails lint instead of staying listed.
    const gone = listed.filter((file) => file.startsWith(source.src) && !fs.existsSync(`${source.root}${file}`));
    let serves = false;

    /** @param {ESTree.Node} node @param {string} message */
    const report = (node, message) => {
      serves = true;

      if (!isBaseline) context.report({ node, message });
    };

    const readsLines = (/** @type {ESTree.Node} */ node) => report(node, 'Leave reading lines to the runtime kit: serveRuntime from @teamai/runtime-kit/serve reads requests, and eachLine from the same module reads a socket\'s lines. A runtime that imports a line reader can serve the protocol around the kit.');
    const readsInput = (/** @type {ESTree.Node} */ node) => report(node, 'Leave the process input to serveRuntime from @teamai/runtime-kit/serve, which reads requests from it: a runtime that reads its input itself serves the protocol around the kit.');

    return {
      /** @param {ESTree.ImportDeclaration} node */
      ImportDeclaration(node) {
        const from = String(node.source.value);

        if (LINE_READERS.has(from)) readsLines(node);

        if (PROCESS_MODULES.has(from)) {
          for (const specifier of node.specifiers) {
            if (specifier.type === 'ImportSpecifier' && isStdinKey(specifier.imported)) readsInput(specifier);
          }
        }
      },
      /** @param {ESTree.ImportExpression} node */
      ImportExpression(node) {
        const from = stringLiteralValue(node.source);

        if (from !== undefined && LINE_READERS.has(from)) readsLines(node);
      },
      /** @param {ESTree.MemberExpression} node */
      MemberExpression(node) {
        if (node.object.type === 'Identifier' && node.object.name === 'process' && isStdinKey(node.property)) readsInput(node);
      },
      /** @param {ESTree.VariableDeclarator} node */
      VariableDeclarator(node) {
        if (node.id.type !== 'ObjectPattern' || node.init?.type !== 'Identifier' || node.init.name !== 'process') return;

        for (const entry of node.id.properties) {
          if (entry.type === 'Property' && isStdinKey(entry.key)) readsInput(entry);
        }
      },
      /** @param {ESTree.CallExpression} node */
      CallExpression(node) {
        const { callee } = node;
        const [first] = node.arguments;

        if (callee.type === 'Identifier' && callee.name === 'require' && first !== undefined) {
          const from = stringLiteralValue(first);

          if (from !== undefined && LINE_READERS.has(from)) readsLines(node);
        }

        if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && (callee.property.name === 'parse' || callee.property.name === 'safeParse') && callee.object.type === 'Identifier' && callee.object.name === 'RuntimeRequestSchema') {
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
          context.report({ node, message: `${source.relative} no longer reads requests or writes an op's end itself: remove it from notYetOnTheKit, teamai/runtime-serve's option in .oxlintrc.json.` });
        }

        for (const file of gone) {
          context.report({ node, message: `${file} is listed in notYetOnTheKit but does not exist: remove it from teamai/runtime-serve's option in .oxlintrc.json, or point it at the file's new path.` });
        }
      },
    };
  },
});
