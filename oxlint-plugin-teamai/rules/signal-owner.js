/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { importedName } from '../imports.js';
import { isOneOf, scopedFiles, stringLiteralValue, variableOf } from '../utils.js';

/** The one module that calls `process.kill`, behind `signalPid` and `signalGroup`. */
export const OWNER = scopedFiles(['packages/shared/src/process-group.ts']);

/**
 * Programs node runs as they are, with no bundler or loader, so they cannot load the owner; each keeps the owner's
 * check inline: no signal to a pid below 2.
 */
export const RUN_AS_IS = scopedFiles(['packages/runtime-sandbox/src/testing/fake-engine.mjs']);

/**
 * Files whose string literals hold the source of a program a test runs, which signals its own process or the one that
 * started it, or lints: the text is that program's, which lint does not read as code.
 */
export const SCRIPT_TEXT = scopedFiles([
  'oxlint-plugin-teamai/rules/signal-owner.test.ts',
  'packages/runtime-sandbox/src/providers/containment.test.ts',
  'src/__tests__/e2e/benchmark-checks.test.ts',
  'src/__tests__/e2e/workflow-pass-scoring.test.ts',
  'src/__tests__/env-exec.test.ts',
  'src/__tests__/helpers/benchmark-fixture.ts',
]);

const MESSAGE = 'Send a signal through signalPid or signalGroup from @teamai/shared/process-group, not process.kill: they send nothing to a pid below 2, which kill reads as the caller\'s own process group (0), every process it may signal (-1) or init (1), and they tell what the signal came to instead of throwing. A test observes signals with vi.spyOn(process, \'kill\').';

const TEXT_MESSAGE = 'This text calls process.kill in a program a test runs, which lint does not read as code. Signal through @teamai/shared/process-group in code, or name the file in SCRIPT_TEXT (oxlint-plugin-teamai/rules/signal-owner.js) and keep the pid it signals above 1.';

/** The modules `process` is also imported from. */
const PROCESS_MODULES = new Set(['process', 'node:process']);

/** The executables that signal a pid they are given. */
const KILL_EXECUTABLES = new Set(['kill', 'pkill', 'killall']);

/** The calls that start an executable named by their first argument. */
const STARTERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'spawnCommand', 'spawnCommandSync', 'execCommand']);

/** The calls that run their first argument as a shell command line. */
const SHELLS = new Set(['exec', 'execSync']);

/** The text of a string literal, or of a template literal with no placeholder. */
function textOf(/** @type {ESTree.Node | null | undefined} */ node) {
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;

  return stringLiteralValue(node);
}

/** The name a call is made by: `f` of `f(…)` and of `o.f(…)`. */
function calleeName(/** @type {ESTree.Node} */ callee) {
  if (callee.type === 'Identifier') return callee.name;

  return callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' ? callee.property.name : undefined;
}

/**
 * Whether `node` is Node's `process`: the global, `globalThis.process`, the `process` module imported or required
 * whole, or a name bound to one of these.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
function isProcess(sourceCode, node) {
  switch (node.type) {
    case 'Identifier': {
      const def = variableOf(sourceCode, node, node.name)?.defs[0];

      if (def === undefined) return node.name === 'process';

      // A default or namespace import of the process module; `import { kill }` is checked where it is imported.
      if (def.type === 'ImportBinding') return def.node.type !== 'ImportSpecifier' && def.parent?.type === 'ImportDeclaration' && PROCESS_MODULES.has(String(def.parent.source.value));

      return def.type === 'Variable' && def.node.type === 'VariableDeclarator' && def.node.id.type === 'Identifier' && def.node.init !== null && def.node.init !== undefined && isProcess(sourceCode, def.node.init);
    }

    case 'MemberExpression': {
      if (node.computed || node.property.type !== 'Identifier') return false;

      if (node.property.name === 'process') return node.object.type === 'Identifier' && (node.object.name === 'globalThis' || node.object.name === 'global');

      return node.property.name === 'default' && isProcess(sourceCode, node.object);
    }

    case 'CallExpression':
      return node.callee.type === 'Identifier' && node.callee.name === 'require' && PROCESS_MODULES.has(textOf(node.arguments[0]) ?? '');
    case 'ImportExpression':
      return PROCESS_MODULES.has(textOf(node.source) ?? '');
    case 'AwaitExpression':
      return isProcess(sourceCode, node.argument);
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
    case 'ParenthesizedExpression':
      return isProcess(sourceCode, node.expression);
    default:
      return false;
  }
}

/** Whether `node` reads key `kill`: `.kill`, `['kill']` or ``[`kill`]``. */
function readsKill(/** @type {ESTree.MemberExpression} */ node) {
  return node.computed ? textOf(node.property) === 'kill' : node.property.type === 'Identifier' && node.property.name === 'kill';
}

/** Whether the object pattern `node`, of a declaration or an assignment, takes key `kill`. */
function takesKill(/** @type {ESTree.ObjectPattern | ESTree.ObjectAssignmentTarget} */ node) {
  return node.properties.some((property) => property.type === 'Property' && (property.computed ? textOf(property.key) === 'kill' : property.key.type === 'Identifier' && property.key.name === 'kill'));
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Send every signal by pid through @teamai/shared/process-group, which refuses a pid below 2.' },
  },
  create(context) {
    if (isOneOf(context, OWNER) || isOneOf(context, RUN_AS_IS)) return {};
    const { sourceCode } = context;
    const report = (/** @type {ESTree.Node} */ node) => { context.report({ node, message: MESSAGE }); };
    const isScriptText = isOneOf(context, SCRIPT_TEXT);

    /** @param {ESTree.Node} node */
    const checkText = (node) => {
      const text = node.type === 'TemplateLiteral' ? node.quasis.map((quasi) => quasi.value.cooked ?? '').join('') : stringLiteralValue(node);

      if (!isScriptText && text !== undefined && /\bprocess\s*\.\s*kill\s*\(/.test(text)) context.report({ node, message: TEXT_MESSAGE });
    };

    return {
      /** @param {ESTree.MemberExpression} node */
      MemberExpression(node) {
        if (readsKill(node) && isProcess(sourceCode, node.object)) report(node);
      },
      /** @param {ESTree.VariableDeclarator} node */
      VariableDeclarator(node) {
        if (node.id.type === 'ObjectPattern' && node.init && takesKill(node.id) && isProcess(sourceCode, node.init)) report(node);
      },
      /** @param {ESTree.AssignmentExpression} node */
      AssignmentExpression(node) {
        if (node.left.type === 'ObjectPattern' && takesKill(node.left) && isProcess(sourceCode, node.right)) report(node);
      },
      /** @param {ESTree.ImportDeclaration} node */
      ImportDeclaration(node) {
        if (!PROCESS_MODULES.has(String(node.source.value))) return;

        for (const specifier of node.specifiers) if (importedName(specifier) === 'kill') report(specifier);
      },
      /** @param {ESTree.CallExpression} node */
      CallExpression(node) {
        const { callee } = node;
        const name = calleeName(callee);

        // Reflect.get(process, 'kill') reads it with no member expression.
        if (name === 'get' && callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'Reflect'
          && textOf(node.arguments[1]) === 'kill' && node.arguments[0] && isProcess(sourceCode, node.arguments[0])) report(node);
        const first = textOf(node.arguments[0]);

        if (first === undefined || name === undefined) return;

        if (STARTERS.has(name) && KILL_EXECUTABLES.has(first)) report(node);

        if (SHELLS.has(name) && KILL_EXECUTABLES.has(first.trim().split(/\s+/)[0] ?? '')) report(node);
      },
      Literal: checkText,
      TemplateLiteral: checkText,
    };
  },
});
