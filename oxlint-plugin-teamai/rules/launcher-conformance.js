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

// A call on a line of its own: one in a comment or a string does not run the suite.
const untested = Object.values(ADAPTERS).filter((test) => !/^\s*toolLauncherConformance\(/mu.test(fs.readFileSync(new URL(`../../${test}`, import.meta.url), 'utf8')));

if (untested.length > 0) throw new Error(`teamai/launcher-conformance: ${untested.join(', ')} calls no toolLauncherConformance. Run the suite on its adapter again, or point ADAPTERS at the test that does.`);

const MESSAGE = 'A ToolLauncher adapter runs the launcher conformance suite: call toolLauncherConformance on it in a test, and add this file and that test to ADAPTERS in oxlint-plugin-teamai/rules/launcher-conformance.js.';

// The calls that run a launcher, by the name of their option that takes it.
const LAUNCHES = new Set(['runStepLaunch', 'stepLauncher']);

const isFunction = (/** @type {any} */ node) => node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression' || node?.type === 'FunctionDeclaration';

/**
 * Whether a `ToolLauncher` type at `node` says what a value is, as a return type, an annotation, `satisfies` or `as`
 * do, rather than what a parameter or a property takes, or the port's own definition.
 */
const isLauncherClaim = (/** @type {any} */ node) => {
  for (let at = node.parent; at; at = at.parent) {
    if (at.type === 'TSPropertySignature' || at.type === 'TSTypeAliasDeclaration' || at.type === 'TSInterfaceDeclaration' || at.type === 'TSFunctionType') return false;

    if (at.type === 'TSSatisfiesExpression' || at.type === 'TSAsExpression') return true;

    // A function's return type, or a constant's: a parameter's annotation takes a launcher.
    if (at.type === 'TSTypeAnnotation') return isFunction(at.parent) || (at.parent?.type === 'Identifier' && at.parent.parent?.type === 'VariableDeclarator');
  }

  return false;
};

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Keep every ToolLauncher adapter under the launcher conformance suite.' } },
  create(context) {
    if (!inProductionSource(context)) return {};
    const file = lintedPath(context);
    const isAdapter = Object.keys(ADAPTERS).some((adapter) => file.endsWith(`/${adapter}`));
    /** @type {Map<string, any>} what each name this file declares holds: its function, or its initial value */
    const declared = new Map();
    /** @type {any[]} the launchers this file passes to a launch */
    const passed = [];

    /**
     * Whether `value`, a launch's launcher, is one this file makes: a function it writes, or one a function of its own builds.
     * @returns {boolean}
     */
    const isMadeHere = (/** @type {any} */ value, depth = 0) => {
      if (depth > 4 || value === undefined || value === null) return false;

      if (isFunction(value)) return true;

      if (value.type === 'Identifier') return declared.has(value.name) && isMadeHere(declared.get(value.name), depth + 1);

      if (value.type === 'CallExpression' && value.callee.type === 'Identifier') return isFunction(declared.get(value.callee.name));

      return value.type === 'TSAsExpression' || value.type === 'TSSatisfiesExpression' ? isMadeHere(value.expression, depth + 1) : false;
    };

    return {
      TSTypeReference(node) {
        if (!isAdapter && node.typeName.type === 'Identifier' && node.typeName.name === 'ToolLauncher' && isLauncherClaim(node)) context.report({ node, message: MESSAGE });
      },
      FunctionDeclaration(node) {
        if (node.id) declared.set(node.id.name, node);
      },
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && node.init) declared.set(node.id.name, node.init);
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || !LAUNCHES.has(node.callee.name)) return;

        for (const options of node.arguments) {
          if (options.type !== 'ObjectExpression') continue;

          for (const property of options.properties) {
            if (property.type === 'Property' && property.key.type === 'Identifier' && property.key.name === 'start') passed.push(property);
          }
        }
      },
      'Program:exit'() {
        // A launcher this file makes is an adapter no test runs the suite on; in an adapter's file, one written into the
        // launch is not the one the suite runs.
        for (const property of passed) if (isAdapter ? isFunction(property.value) : isMadeHere(property.value)) context.report({ node: property, message: MESSAGE });
      },
    };
  },
});
