import { defineRule } from '@oxlint/plugins';
import fs from 'node:fs';
import { inProductionSource, lintedPath, scopedFiles } from '../utils.js';

// Each ToolLauncher adapter, and the test that runs the launcher conformance suite (toolLauncherConformance) on it.
const ADAPTERS = {
  'packages/runtime-tools/src/step.ts': 'packages/runtime-tools/src/step.test.ts',
  'packages/runtime-sandbox/src/step.ts': 'packages/runtime-sandbox/src/step.test.ts',
  'src/workflow/steps/runtime-steps.ts': 'src/__tests__/workflow-runtime-launcher.test.ts',
};

scopedFiles([...Object.keys(ADAPTERS), ...Object.values(ADAPTERS)]);

const untested = Object.values(ADAPTERS).filter((test) => !fs.readFileSync(new URL(`../../${test}`, import.meta.url), 'utf8').includes('toolLauncherConformance('));

if (untested.length > 0) throw new Error(`teamai/launcher-conformance: ${untested.join(', ')} calls no toolLauncherConformance. Run the suite on its adapter again, or point ADAPTERS at the test that does.`);

const MESSAGE = 'A ToolLauncher adapter runs the launcher conformance suite: call toolLauncherConformance on it in a test, and add this file and that test to ADAPTERS in oxlint-plugin-teamai/rules/launcher-conformance.js.';

/** Whether `annotation` is `: ToolLauncher`. */
const isLauncherType = (/** @type {any} */ annotation) => annotation?.type === 'TSTypeAnnotation'
  && annotation.typeAnnotation.type === 'TSTypeReference'
  && annotation.typeAnnotation.typeName.type === 'Identifier'
  && annotation.typeAnnotation.typeName.name === 'ToolLauncher';

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Keep every ToolLauncher adapter under the launcher conformance suite.' } },
  create(context) {
    if (!inProductionSource(context)) return {};
    const file = lintedPath(context);
    const isAdapter = Object.keys(ADAPTERS).some((adapter) => file.endsWith(`/${adapter}`));

    const declared = (/** @type {any} */ node) => {
      if (!isAdapter) context.report({ node, message: MESSAGE });
    };

    const returnsLauncher = (/** @type {any} */ node) => {
      if (isLauncherType(node.returnType)) declared(node);
    };

    return {
      FunctionDeclaration: returnsLauncher,
      FunctionExpression: returnsLauncher,
      ArrowFunctionExpression: returnsLauncher,
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && isLauncherType(node.id.typeAnnotation)) declared(node);
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'runStepLaunch') return;
        const [options] = node.arguments;

        if (options?.type !== 'ObjectExpression') return;

        // A launcher written into the launch is an adapter no test can run the suite on.
        for (const property of options.properties) {
          if (property.type === 'Property' && property.key.type === 'Identifier' && property.key.name === 'start' && property.value.type.endsWith('FunctionExpression')) context.report({ node: property, message: MESSAGE });
        }
      },
    };
  },
});
