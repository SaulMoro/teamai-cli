/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { inProductionSource, isOneOf, scopedFiles, stringLiteralValue } from '../utils.js';

/** The one module that starts a process through cross-spawn, behind `spawnCommand`, `spawnCommandSync` and `execCommand`. */
const OWNER = scopedFiles(['packages/tool-core/src/exec.ts']);

const MESSAGE = 'Start a process with spawnCommand or spawnCommandSync from @teamai/tool-core/exec, not cross-spawn: on Windows they run an npm .cmd shim under the system cmd.exe with its arguments escaped twice, and refuse arguments cmd.exe cannot carry, where cross-spawn escapes a shim outside node_modules/.bin once.';

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Launch through spawnCommand, the one Windows launch path, rather than cross-spawn.' },
  },
  create(context) {
    if (!inProductionSource(context) || isOneOf(context, OWNER)) return {};

    return {
      ImportDeclaration(node) {
        if (node.source.value === 'cross-spawn') context.report({ node, message: MESSAGE });
      },
      ImportExpression(node) {
        if (stringLiteralValue(node.source) === 'cross-spawn') context.report({ node, message: MESSAGE });
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && stringLiteralValue(node.arguments[0]) === 'cross-spawn') context.report({ node, message: MESSAGE });
      },
    };
  },
});
