import { defineRule } from '@oxlint/plugins';
import fs from 'node:fs';
import { inProductionSource, isOneOf, scopedFiles } from '../utils.js';

// A ToolLauncher is branded: only the mint `toolLauncher` makes one, so the type check refuses a launcher from anywhere
// else. This rule keeps the mint's calls in the adapters below, one each, and refuses a cast that forges the brand.

// Each ToolLauncher adapter, and the test that runs the launcher conformance suite (toolLauncherConformance) on it.
const ADAPTERS = {
  'packages/runtime-tools/src/step.ts': 'packages/runtime-tools/src/step.test.ts',
  'packages/runtime-sandbox/src/step.ts': 'packages/runtime-sandbox/src/step.test.ts',
  'src/workflow/steps/runtime-steps.ts': 'src/__tests__/workflow-runtime-launcher.test.ts',
};

// The port's own file, where the mint casts.
const PORT = 'packages/tool-launch/src/run-step-launch.ts';

const MINT = 'toolLauncher';

scopedFiles([PORT, ...Object.keys(ADAPTERS), ...Object.values(ADAPTERS)]);

const readRepositoryFile = (/** @type {string} */ file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

// A call on a line of its own: one in a comment or a string does not run the suite. An adapter that no longer mints
// leaves an entry that guards nothing.
const unchecked = [
  ...Object.values(ADAPTERS).filter((test) => !/^\s*toolLauncherConformance\(/mu.test(readRepositoryFile(test))).map((test) => `${test} calls no toolLauncherConformance`),
  ...Object.keys(ADAPTERS).filter((adapter) => !new RegExp(`\\b${MINT}\\(`, 'u').test(readRepositoryFile(adapter))).map((adapter) => `${adapter} calls no ${MINT}`),
];

if (unchecked.length > 0) throw new Error(`teamai/launcher-conformance: ${unchecked.join('; ')}. Run the suite on the adapter again, or point ADAPTERS at the adapter and the test that runs it.`);

const OUTSIDE = `A ToolLauncher is made only in an adapter the launcher conformance suite runs on: call ${MINT} there, run toolLauncherConformance on it in a test, and add this file and that test to ADAPTERS in oxlint-plugin-teamai/rules/launcher-conformance.js.`;

const SECOND = `An adapter makes one ToolLauncher, the one its conformance test runs: build this launch on that one, or move this launcher to an adapter of its own with its own conformance test.`;

const CAST = `A cast to ToolLauncher forges a launcher the conformance suite never ran on: make it with ${MINT} in an adapter the suite runs on.`;

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Keep every ToolLauncher adapter under the launcher conformance suite.' } },
  create(context) {
    if (!inProductionSource(context)) return {};
    const isAdapter = isOneOf(context, Object.keys(ADAPTERS));
    const isPort = isOneOf(context, [PORT]);
    /** @type {Set<string>} the names the mint goes by in this file */
    const mints = new Set([MINT]);
    let minted = 0;

    return {
      ImportSpecifier(node) {
        if (node.imported.type === 'Identifier' && node.imported.name === MINT) mints.add(node.local.name);
      },
      CallExpression(node) {
        const { callee } = node;
        const isMint = (callee.type === 'Identifier' && mints.has(callee.name)) || (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === MINT);

        if (!isMint || isPort) return;

        minted++;

        if (!isAdapter) context.report({ node, message: OUTSIDE });
        else if (minted > 1) context.report({ node, message: SECOND });
      },
      // The mint held or exported under another name makes launchers no call above sees.
      Identifier(node) {
        const { parent } = node;

        const isCalled = (/** @type {any} */ at) => at.parent?.type === 'CallExpression' && at.parent.callee === at;

        if (isPort || !mints.has(node.name) || parent.type === 'ImportSpecifier' || isCalled(node) || (parent.type === 'MemberExpression' && parent.property === node && isCalled(parent))) return;

        context.report({ node, message: OUTSIDE });
      },
      TSTypeReference(node) {
        if (isPort || node.typeName.type !== 'Identifier' || node.typeName.name !== 'ToolLauncher') return;

        // Up through the type's own nodes only: a launcher's return type inside a cast expression is no cast to the port.
        for (let /** @type {any} */ at = node.parent; at?.type.startsWith('TS'); at = at.parent) {
          if (at.type === 'TSAsExpression' || at.type === 'TSTypeAssertion') {
            context.report({ node, message: CAST });

            return;
          }
        }
      },
    };
  },
});
