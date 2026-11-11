import path from 'node:path';
import { defineRule } from '@oxlint/plugins';
import { importVisitors, sourceImport, sourceModules } from '../imports.js';
import { FAMILY, lintedPath, scopedFiles, sourcePath, workspaceFile, workspaceRoot } from '../utils.js';

/**
 * The facts modules outside a family: the list of every family's facts and the app modules that read only facts. A
 * family's own `src/facts.ts`, `src/definitions.ts` and `src/detect.ts` are facts modules too, in any `tool-<name>`
 * package (FAMILY), with no edit here. Paths are from the repository root.
 */
export const FACTS_FILES = new Set(scopedFiles([
  'packages/tool-definitions/src/facts.ts',
  'packages/tool-core/src/definition.ts',
  'src/tools.ts',
  'src/session-flow/adapters/platform-facts.ts',
]));

/**
 * The modules every command and every hook loads before it does anything: the CLI entry, the hook dispatch every hook
 * runs, the dashboard collector it loads to resolve each hook's scope, and the session captures each SessionStart
 * records before its agent goes on.
 */
export const STARTUP_ENTRIES = new Set(scopedFiles(['src/index.ts', 'src/hook-dispatch-cli.ts', 'src/dashboard-collector.ts', 'src/session-flow/captures.ts']));

/**
 * Whether `relative`, from the repository root, is a facts module: data a tool family declares, which loads nothing
 * else of the family.
 * @param {string} relative
 */
export function isFactsModule(relative) {
  const family = /^packages\/([^/]+)\/src\/(facts|definitions|detect)\.ts$/.exec(relative)?.[1];

  return FACTS_FILES.has(relative) || (family !== undefined && FAMILY.test(family));
}

/**
 * Whether `relative` is a family's behaviour: any other module of a family package, or of the list of families
 * (`@teamai/tool-definitions`), whose session adapters, launch profiles, token readers and schemas cost every command
 * that loads them.
 * @param {string} relative
 */
function isFamilyBehaviour(relative) {
  const folder = /^packages\/([^/]+)\/src\//.exec(relative)?.[1];

  return folder !== undefined && (FAMILY.test(folder) || folder === 'tool-definitions') && !isFactsModule(relative) && !relative.endsWith('.test.ts');
}

/**
 * The module a non-type import of `from` names, from the repository root: a relative path or a workspace package's
 * export. Undefined for a dependency or a node: module.
 * @param {string} root
 * @param {string} from
 * @param {string} specifier
 */
function resolved(root, from, specifier) {
  if (specifier.startsWith('.')) {
    const file = sourceImport(path.posix.join(root, from), specifier);

    return file === undefined ? undefined : path.posix.relative(root, file);
  }

  return specifier.startsWith('@teamai/') ? workspaceFile(root, specifier) : undefined;
}

/**
 * The chain of static, non-type imports from `start` to the first family behaviour module it reaches, or undefined.
 * `seen` is shared across the entry's imports, so a module is followed once per lint of the entry.
 * @param {string} root
 * @param {string} start
 * @param {Set<string>} seen
 * @returns {string[] | undefined}
 */
function chainToBehaviour(root, start, seen) {
  /** @type {Map<string, string | undefined>} */
  const previous = new Map([[start, undefined]]);
  const queue = [start];

  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (isFamilyBehaviour(file)) {
      const chain = [];

      for (let step = /** @type {string | undefined} */ (file); step !== undefined; step = previous.get(step)) chain.unshift(step);

      return chain;
    }

    if (seen.has(file)) continue;
    seen.add(file);

    for (const specifier of new Set(sourceModules(path.posix.join(root, file), false))) {
      const next = resolved(root, file, specifier);

      if (next !== undefined && !previous.has(next)) {
        previous.set(next, file);
        queue.push(next);
      }
    }
  }

  return undefined;
}

const FIX = 'Read a family at startup only through its facts (@teamai/tool-definitions/facts), and load its behaviour with a dynamic import() where it is first needed.';

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Startup and the facts modules load a tool family\'s facts only, never its session adapters, launch profiles, token readers or schemas.' } },
  create(context) {
    const file = lintedPath(context);
    const root = workspaceRoot(path.posix.dirname(file));
    const from = root === undefined ? sourcePath(context) : path.posix.relative(root, file);

    if (isFactsModule(from)) {
      return importVisitors(({ node, specifier, typeOnly }) => {
        if (typeOnly) return;
        const to = root === undefined ? undefined : resolved(root, from, specifier);

        if (to !== undefined && isFactsModule(to)) return;
        context.report({
          node,
          message: `${from} is a facts module (oxlint-plugin-teamai/rules/family-facts.js), which every command loads, so it imports only other facts modules: `
            + `a family's src/facts.ts, src/definitions.ts and src/detect.ts, and FACTS_FILES. ${specifier} is not one. Move the data it needs into a facts module, or read it where the behaviour is loaded.`,
        });
      });
    }

    if (!STARTUP_ENTRIES.has(from) || root === undefined) return {};
    const seen = new Set();

    return importVisitors(({ node, specifier, typeOnly }) => {
      if (typeOnly || node.type === 'ImportExpression') return;
      const to = resolved(root, from, specifier);
      const chain = to === undefined ? undefined : chainToBehaviour(root, to, seen);

      if (chain === undefined) return;
      context.report({
        node,
        message: `${from} starts every command and hook, and through ${specifier} it loads a tool family's behaviour at startup: ${[from, ...chain].join(' -> ')}. ${FIX}`,
      });
    });
  },
});
