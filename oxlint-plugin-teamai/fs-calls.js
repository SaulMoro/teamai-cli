/** @import { ESTree } from '@oxlint/plugins' */
import { importedName } from './imports.js';
import { variableOf } from './utils.js';

/** The modules a file is opened from. */
export const FS = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'fs-extra']);

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
export function isFsModule(sourceCode, node) {
  if (node.type === 'MemberExpression') {
    return !node.computed && node.property.type === 'Identifier' && node.property.name === 'promises' && isFsModule(sourceCode, node.object);
  }

  if (node.type !== 'Identifier') return false;
  const imported = importOf(variableOf(sourceCode, node, node.name));

  return imported !== undefined && FS.has(imported.from) && (imported.name === 'default' || imported.name === '*' || imported.name === 'promises');
}

/**
 * The file module function `callee` calls: `fs.open`, `fs.promises.open` and a named import of `open` from a file module,
 * under any local name, all give `open`. Undefined for any other callee.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node} callee
 * @returns {string | undefined}
 */
export function fsFunctionOf(sourceCode, callee) {
  if (callee.type === 'MemberExpression') {
    return !callee.computed && callee.property.type === 'Identifier' && isFsModule(sourceCode, callee.object) ? callee.property.name : undefined;
  }

  if (callee.type !== 'Identifier') return undefined;
  const imported = importOf(variableOf(sourceCode, callee, callee.name));

  return imported !== undefined && FS.has(imported.from) && imported.name !== 'default' && imported.name !== '*' ? imported.name : undefined;
}
