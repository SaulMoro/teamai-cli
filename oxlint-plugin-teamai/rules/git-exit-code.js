/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';
import { inProductionSource, stringLiteralValue } from '../utils.js';

/**
 * Git commands that answer only with their exit code, printing nothing either way: the subcommand, and the flags any of
 * which makes it one.
 */
const EXIT_CODE_ANSWERS = new Map([
  ['merge-base', ['--is-ancestor']],
  ['cat-file', ['-e']],
  ['diff', ['--quiet', '--exit-code']],
  ['diff-index', ['--quiet', '--exit-code']],
  ['diff-files', ['--quiet', '--exit-code']],
  ['diff-tree', ['--quiet', '--exit-code']],
  ['show-ref', ['--quiet', '-q', '--exists']],
  ['check-ignore', ['--quiet', '-q']],
]);

/**
 * The literal text of each argument of `node`, an array expression; undefined for an argument that is not literal.
 * @param {ESTree.Node | undefined} node
 * @returns {Array<string | undefined>}
 */
function literalArgs(node) {
  if (node?.type !== 'ArrayExpression') return [];

  return node.elements.map((element) => {
    if (element?.type === 'TemplateLiteral' && element.expressions.length === 0) return element.quasis[0]?.value.cooked ?? undefined;

    return stringLiteralValue(element);
  });
}

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Ask git questions answered by the exit code through a git that returns it, not simple-git raw.' } },
  create(context) {
    if (!inProductionSource(context)) return {};

    return {
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression' || node.callee.property.type !== 'Identifier' || node.callee.property.name !== 'raw') return;
        const [command, ...rest] = literalArgs(node.arguments[0]);
        const flags = command === undefined ? undefined : EXIT_CODE_ANSWERS.get(command);

        if (!flags || !rest.some((arg) => arg !== undefined && flags.includes(arg))) return;
        context.report({
          node,
          message: `git ${command} answers with its exit code alone, and simple-git raw resolves on a non-zero exit with nothing on stderr, so this check always passes. Use git() from src/workflow/worktree.ts, which returns the exit code.`,
        });
      },
    };
  },
});
