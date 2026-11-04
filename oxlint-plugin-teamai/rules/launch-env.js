import { defineRule } from '@oxlint/plugins';
import { inProductionSource, isOneOf, stringLiteralValue } from '../utils.js';

const LAUNCH_CONTEXT = 'Import RUN_MODE_ENV, LAUNCHED_BY_ENV or ATTEMPT_ENV from launch-context.ts instead of repeating launch variable names.';
const RUNTIME_PROTOCOL = 'Import RUN_DIR_ENV from @teamai/runtime-protocol instead of repeating launch variable names.';

/** Each launch variable, with the one file that spells it and what the others import instead. */
const OWNERS = new Map([
  ['TEAMAI_MODE', { file: 'src/launch-context.ts', message: LAUNCH_CONTEXT }],
  ['TEAMAI_LAUNCHED_BY', { file: 'src/launch-context.ts', message: LAUNCH_CONTEXT }],
  ['TEAMAI_WORKFLOW_ATTEMPT', { file: 'src/launch-context.ts', message: LAUNCH_CONTEXT }],
  ['TEAMAI_RUN_DIR', { file: 'packages/runtime-protocol/src/protocol.ts', message: RUNTIME_PROTOCOL }],
]);

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Keep launch environment variable spellings in the module that owns each.' } },
  create(context) {
    if (!inProductionSource(context)) return {};

    /** @param {import('@oxlint/plugins').ESTree.Node} node @param {string} value */
    const check = (node, value) => {
      const owner = OWNERS.get(value);

      if (owner && !isOneOf(context, [owner.file])) context.report({ node, message: owner.message });
    };

    return {
      Literal(node) {
        const value = stringLiteralValue(node);

        if (value !== undefined) check(node, value);
      },
      TemplateLiteral(node) {
        if (node.expressions.length === 0) check(node, node.quasis[0]?.value.raw ?? '');
      },
      MemberExpression(node) {
        if (
          !node.computed &&
          node.object.type === 'MemberExpression' &&
          !node.object.computed &&
          node.object.object.type === 'Identifier' &&
          node.object.object.name === 'process' &&
          node.object.property.type === 'Identifier' &&
          node.object.property.name === 'env' &&
          node.property.type === 'Identifier'
        ) check(node.property, node.property.name);
      },
    };
  },
});
