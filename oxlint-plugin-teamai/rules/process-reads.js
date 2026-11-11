/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { inProductionSource, stringLiteralValue } from '../utils.js';

const MESSAGE = 'This reads a process from /proc, which Linux answers from /proc where macOS runs ps, and the agent wait budget runs on Linux, so CI would not see the wait macOS has. Tell the read with tellProcessRead from @teamai/shared/process-group, as the ps macOS runs for it, or read it through process-group.';

/** The one call that tells a process read, which a module reading `/proc` makes. */
const TELL = 'tellProcessRead';

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'A module that reads a process from /proc tells the read, so the agent wait budget counts it on Linux.' },
  },
  create(context) {
    if (!inProductionSource(context)) return {};
    /** @type {ESTree.Node[]} */
    const reads = [];
    let isTelling = false;

    return {
      /** @param {ESTree.Literal} node */
      Literal(node) {
        if (stringLiteralValue(node)?.startsWith('/proc/') === true) reads.push(node);
      },
      /** @param {ESTree.TemplateLiteral} node */
      TemplateLiteral(node) {
        if (node.quasis[0]?.value.cooked?.startsWith('/proc/') === true) reads.push(node);
      },
      /** @param {ESTree.IdentifierReference} node */
      Identifier(node) {
        if (node.name === TELL) isTelling = true;
      },
      'Program:exit'() {
        if (isTelling) return;

        for (const node of reads) context.report({ node, message: MESSAGE });
      },
    };
  },
});
