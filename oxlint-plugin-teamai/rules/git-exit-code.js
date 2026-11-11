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

/**
 * The exit-code question `node`, an array of git arguments, asks: its subcommand, when it is one; undefined otherwise.
 * @param {ESTree.Node | undefined} node
 * @returns {string | undefined}
 */
function exitCodeQuestion(node) {
  const [command, ...rest] = literalArgs(node);
  const flags = command === undefined ? undefined : EXIT_CODE_ANSWERS.get(command);

  return flags && rest.some((arg) => arg !== undefined && flags.includes(arg)) ? command : undefined;
}

/** The helper that reads an exit-code answer, telling a no from a git that never ran. */
const ANSWER_READER = 'gitAnswer';

/**
 * Whether `node`, a call, is read through `gitAnswer(...)`, awaited or not.
 * @param {ESTree.CallExpression} node
 */
function readAsAnswer(node) {
  const value = node.parent?.type === 'AwaitExpression' ? node.parent : node;
  const reader = value.parent;

  return reader?.type === 'CallExpression' && reader.callee.type === 'Identifier' && reader.callee.name === ANSWER_READER && reader.arguments[0] === value;
}

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Ask git questions answered by the exit code through a git that returns it, and read the answer through gitAnswer.' } },
  create(context) {
    if (!inProductionSource(context)) return {};

    return {
      CallExpression(node) {
        const isRaw = node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier' && node.callee.property.name === 'raw';

        if (isRaw) {
          const command = exitCodeQuestion(node.arguments[0]);

          if (command === undefined) return;
          context.report({
            node,
            message: `git ${command} answers with its exit code alone, and simple-git raw resolves on a non-zero exit with nothing on stderr, so this check always passes. Use git() from src/workflow/worktree.ts, which returns the exit code.`,
          });

          return;
        }

        const command = node.arguments.map(exitCodeQuestion).find((asked) => asked !== undefined);

        if (command === undefined || readAsAnswer(node)) return;
        context.report({
          node,
          message: `git ${command} answers with its exit code alone, and a git that did not start answers nothing, which a bare exit-code check reads as a no. `
            + `Read the result through ${ANSWER_READER}() from src/workflow/worktree.ts, and handle its 'nothing'.`,
        });
      },
    };
  },
});
