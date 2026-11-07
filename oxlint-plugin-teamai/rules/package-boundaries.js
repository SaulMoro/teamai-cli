import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { defineRule } from '@oxlint/plugins';

import { importVisitors } from '../imports.js';
import { lintedPath, manifest, workspaceRoot } from '../utils.js';

/** @type {Map<string, Map<string, string>>} */
const packageNames = new Map();

/**
 * Each workspace package's name, mapped to its folder under `packages/`.
 * @param {string} root
 * @returns {Map<string, string>}
 */
function packagesByName(root) {
  const cached = packageNames.get(root);

  if (cached) return cached;
  /** @type {Map<string, string>} */
  const names = new Map();
  const dir = `${root}/packages`;

  for (const folder of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const name = manifest(`${dir}/${folder}`)?.name;

    if (name !== undefined) names.set(name, folder);
  }

  packageNames.set(root, names);

  return names;
}

/** A tool family's folder: every `tool-*` package but the contract, the test kit and the list of families. */
const FAMILY = /^tool-(?!(?:core|testing|definitions)$)/;

/** The one package that imports the families. */
const DEFINITIONS = 'tool-definitions';

/** The conformance kit families test with. */
const TEST_KIT = 'tool-testing';

/** The runtime protocol, which teamai and every runtime parse with: the one runtime package src/ imports. */
const RUNTIME_PROTOCOL = 'runtime-protocol';

/**
 * The package a bare specifier names: `@scope/name` or `name`, without a subpath.
 * @param {string} specifier
 */
function packageOf(specifier) {
  const parts = specifier.split('/');

  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier;
}

/**
 * Whether src/ may load `specifier` at run time: one of Node's modules, a workspace package, or a dependency of
 * teamai-cli. tsup bundles whatever src/ loads, so anything else would ship inside dist/, as a runtime's provider SDK
 * that the member installs would. Every new package fails until teamai-cli depends on it.
 * @param {string} root
 * @param {string} specifier
 */
function shipsWithTeamai(root, specifier) {
  const name = packageOf(specifier);

  if (isBuiltin(specifier)) return true;

  if (packagesByName(root).has(name)) return true;
  const dependencies = manifest(root)?.dependencies;

  return dependencies !== undefined && Object.hasOwn(dependencies, name);
}

/**
 * The `packages/<folder>` a path relative to the workspace root sits in, if any.
 * @param {string} relative
 */
function packageFolder(relative) {
  return /^packages\/([^/]+)\//.exec(relative)?.[1];
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Keep workspace packages and src/ on their sides of the package boundary.' },
  },
  create(context) {
    const file = lintedPath(context);
    const root = workspaceRoot(path.posix.dirname(file));

    if (root === undefined) return {};
    const from = path.posix.relative(root, file);
    const own = packageFolder(from);
    const inApp = from.startsWith('src/');
    const isTest = from.startsWith('src/__tests__/') || /\.test\.[cm]?[jt]sx?$/.test(from);

    if (own === undefined && !inApp) return {};

    return {
      Program(node) {
        if (own !== undefined && manifest(`${root}/packages/${own}`)?.private !== true) {
          context.report({ node, message: `A workspace package is private: set "private": true in packages/${own}/package.json, so it ships only inside teamai-cli.` });
        }
      },
      ...importVisitors(({ node, specifier, typeOnly }) => {
        if (inApp && !isTest && !typeOnly && !specifier.startsWith('.') && !shipsWithTeamai(root, specifier)) {
          context.report({ node, message: `src/ imports values only from Node, the workspace packages and the dependencies in package.json, since tsup bundles whatever src/ loads into dist/: ${from} -> ${specifier}. Import only its types (import type), or add it to dependencies if teamai-cli ships it.` });
        }

        if (specifier.startsWith('.')) {
          const to = path.posix.relative(root, path.posix.resolve(path.posix.dirname(file), specifier));
          const target = packageFolder(to);

          if (target === own) return;

          if (target === undefined) {
            context.report({ node, message: `A workspace package imports only its own files and other workspace packages by name, never src/ or other repository files: ${from} -> ${to}.` });
          } else {
            const name = [...packagesByName(root)].find(([, folder]) => folder === target)?.[0] ?? `the name in packages/${target}/package.json`;
            context.report({ node, message: `Import a workspace package by its package name, so only its exports map is reachable: ${from} -> ${to}. Use '${name}'.` });
          }

          return;
        }

        for (const [name, folder] of packagesByName(root)) {
          if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;

          if (inApp && folder.startsWith('runtime-') && folder !== RUNTIME_PROTOCOL) {
            context.report({ node, message: `src/ never imports a runtime package: teamai reaches a runtime only through its executable over stdio, and reads its lines with @teamai/runtime-protocol. ${from} -> ${specifier}.` });
          }

          if (FAMILY.test(folder) && own !== DEFINITIONS && own !== folder) {
            context.report({ node, message: `Only @teamai/tool-definitions imports a tool family: the app reads tools through it, and a family depends on tool-core alone. ${from} -> ${specifier}.` });
          }

          if (folder === TEST_KIT && !isTest) {
            context.report({ node, message: `@teamai/tool-testing is test-only: import it from a *.test.ts file, so the conformance kit and vitest never ship in teamai-cli. ${from} -> ${specifier}.` });
          }
        }
      }),
    };
  },
});
