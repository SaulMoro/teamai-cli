import fs from 'node:fs';
import path from 'node:path';

/**
 * Rule parsers taken from a tool's installed bundle, so a render is checked
 * against the code that reads it (#946). The bundles are not vendored: point
 * `TEAMAI_RULE_PARSER_BUNDLES` at them, as `<tool>=<path>` entries separated
 * by the platform's path delimiter, e.g.
 *
 *   TEAMAI_RULE_PARSER_BUNDLES=cursor=$HOME/.local/share/cursor-agent/versions/<v>
 *
 * A test whose tool has no entry is skipped; CI runs the byte-exact contract
 * tests instead. A loader for another tool goes here beside Cursor's.
 */

/** The path given for `tool`, or undefined when there is none. */
export function ruleParserBundle(tool: string): string | undefined {
  for (const entry of (process.env.TEAMAI_RULE_PARSER_BUNDLES ?? '').split(path.delimiter)) {
    const at = entry.indexOf('=');
    if (at > 0 && entry.slice(0, at) === tool) return entry.slice(at + 1);
  }
  return undefined;
}

/** The source of the function declaration that starts at `start`, braces matched. */
function functionSource(source: string, start: number): string {
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced function body');
}

/** The last `function NAME(...)` matching `pattern` before `before`. */
function lastFunctionBefore(source: string, pattern: RegExp, before: number): { name: string; start: number } {
  let found: { name: string; start: number } | undefined;
  for (const match of source.slice(0, before).matchAll(pattern)) found = { name: match[1], start: match.index };
  if (!found) throw new Error(`no function matching ${pattern} in the bundle`);
  return found;
}

export interface CursorRuleParser {
  /** Cursor's `.mdc` frontmatter parse: `{ frontmatter, body }`, or null without frontmatter. */
  parse(text: string): { frontmatter: Record<string, unknown>; body: string } | null;
  /** How Cursor turns `frontmatter.globs` into globs before matching. */
  globs(value: unknown): string[] | undefined;
}

/**
 * Cursor CLI's rule parser, out of `index.js` in a cursor-agent version
 * directory (checked against 2026.09.22 and 2026.09.28). The minified names
 * change per build, so the functions are found by their code: the line
 * parser by its `metadata.disabledEnvironments` keys and `rawFrontmatter`
 * result, its scalar reader by `"true"===`, and the glob splitter by its
 * brace-depth comma split.
 */
export function loadCursorRuleParser(bundle: string): CursorRuleParser {
  const file = fs.statSync(bundle).isDirectory() ? path.join(bundle, 'index.js') : bundle;
  const source = fs.readFileSync(file, 'utf8');

  const parseAt = source.indexOf('rawFrontmatter:`---\\n${');
  if (parseAt < 0) throw new Error(`no Cursor rule parser in ${file}`);
  const parse = lastFunctionBefore(source, /function ([\w$]+)\((\w)\)\{const (\w)=\2\.trimStart\(\);if\(!\3\.startsWith\("---"\)\)return null/g, parseAt);
  const scalar = lastFunctionBefore(source, /function ([\w$]+)\((\w)\)\{const (\w)=\2\.trim\(\);return"true"===\3\|\|"false"!==\3&&/g, parse.start);
  const splitAt = source.search(/if\("\{"===(\w)\)(\w)\+\+;else if\("\}"===\1&&\2>0\)\2--;else if\(","===\1&&0===\2\)/);
  if (splitAt < 0) throw new Error(`no Cursor glob splitter in ${file}`);
  const split = lastFunctionBefore(source, /function ([\w$]+)\((\w)\)\{if\("string"==typeof \2\)/g, splitAt);

  const factory = new Function([
    functionSource(source, scalar.start),
    functionSource(source, parse.start),
    functionSource(source, split.start),
    `return { parse: ${parse.name}, globs: ${split.name} };`,
  ].join('\n'));
  return factory() as CursorRuleParser;
}
