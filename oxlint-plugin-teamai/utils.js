/** @import { Context, ESTree } from '@oxlint/plugins' */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * The linted file's path with `/` separators, so a rule can scope itself on any platform.
 * @param {Context} context
 * @returns {string}
 */
export function lintedPath(context) {
  return context.filename.split('\\').join('/');
}

/**
 * Whether the linted file is one of `files`, given relative to the repository root.
 * @param {Context} context
 * @param {readonly string[]} files
 * @returns {boolean}
 */
export function isOneOf(context, files) {
  const file = lintedPath(context);

  return files.some((relative) => file.endsWith(`/${relative}`));
}

/** @type {Map<string, string | undefined>} */
const packageRoots = new Map();

/**
 * The nearest directory at or above `dir` holding a `package.json`.
 * @param {string} dir
 * @returns {string | undefined}
 */
function packageRoot(dir) {
  if (packageRoots.has(dir)) return packageRoots.get(dir);
  const parent = path.posix.dirname(dir);
  const root = fs.existsSync(`${dir}/package.json`) ? dir : parent === dir ? undefined : packageRoot(parent);
  packageRoots.set(dir, root);

  return root;
}

const ManifestSchema = z.object({ name: z.string().optional(), private: z.boolean().optional(), workspaces: z.unknown().optional(), dependencies: z.record(z.string(), z.string()).optional() });

/**
 * The package.json at `dir`, or undefined when it is missing or unreadable.
 * @param {string} dir
 */
export function manifest(dir) {
  const file = `${dir}/package.json`;

  if (!fs.existsSync(file)) return undefined;
  const parsed = ManifestSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));

  return parsed.success ? parsed.data : undefined;
}

/** @type {Map<string, string | undefined>} */
const roots = new Map();

/**
 * The nearest directory at or above `dir` whose package.json declares workspaces.
 * @param {string} dir
 * @returns {string | undefined}
 */
export function workspaceRoot(dir) {
  if (roots.has(dir)) return roots.get(dir);
  const parent = path.posix.dirname(dir);
  const root = manifest(dir)?.workspaces !== undefined ? dir : parent === dir ? undefined : workspaceRoot(parent);
  roots.set(dir, root);

  return root;
}

/**
 * The linted file's path from its package root, so a checkout cloned under some `src/` directory keeps `scripts/` out.
 * @param {Context} context
 * @returns {string}
 */
export function sourcePath(context) {
  const file = lintedPath(context);
  const root = packageRoot(path.posix.dirname(file));

  return root === undefined ? file : path.posix.relative(root, file);
}

/**
 * Whether the linted file is production source: under `src/` of its package or of a `packages/<name>/` folder, outside `src/__tests__/`, and not a test beside its source.
 * @param {Context} context
 * @returns {boolean}
 */
export function inProductionSource(context) {
  const relative = sourcePath(context).replace(/^packages\/[^/]+\//, '');

  return relative.startsWith('src/') && !relative.startsWith('src/__tests__/') && !/\.test\.[cm]?[jt]sx?$/.test(relative);
}

/**
 * The repository files a rule is scoped to. A rename throws when lint loads the rule, instead of leaving it guarding nothing.
 * @param {readonly string[]} files relative to the repository root
 * @returns {readonly string[]}
 */
export function scopedFiles(files) {
  const missing = files.filter((file) => !fs.existsSync(new URL(`../${file}`, import.meta.url)));

  if (missing.length > 0) throw new Error(`Lint rule scope file missing: ${missing.join(', ')}. Point the rule at the file's new path.`);

  return files;
}

/**
 * The text of a string literal; undefined for any other node, and for a number, boolean, null, bigint or RegExp literal.
 * @param {ESTree.Node | null | undefined} node
 * @returns {string | undefined}
 */
export function stringLiteralValue(node) {
  // oxlint-disable-next-line teamai/no-runtime-typeof -- an ESTree Literal's value is a string, number, boolean, null, bigint or RegExp, and typeof is how ESTree tells them apart
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}
