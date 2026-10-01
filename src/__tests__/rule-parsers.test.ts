import { describe, expect, it } from 'vitest';
import { teamRuleToCursorMdc } from '../resources/cursor-mdc.js';
import { loadCursorRuleParser, ruleParserBundle } from './helpers/rule-parsers.js';

/**
 * Each render read back by the tool's own parser, taken from its installed
 * bundle (`TEAMAI_RULE_PARSER_BUNDLES`, see helpers/rule-parsers.ts). Skipped
 * where the bundle is absent; the contract tests pin the bytes everywhere.
 */
const BODY = 'Use named exports.\n\n---\n\nA rule with a horizontal rule in it.';

const cursorBundle = ruleParserBundle('cursor');

describe.skipIf(!cursorBundle)('Cursor reads the .mdc render as intended', () => {
  const parser = cursorBundle ? loadCursorRuleParser(cursorBundle) : undefined;

  it.each([
    ['an unscoped rule', BODY, true, undefined],
    ['an inline list', `---\npaths: ["src/**/*.ts", "test/**"]\n---\n\n${BODY}`, false, ['src/**/*.ts', 'test/**']],
    ['a block list', `---\npaths:\n  - "src/**/*.ts"\n  - test/**\n---\n\n${BODY}`, false, ['src/**/*.ts', 'test/**']],
    ['a brace glob', `---\npaths:\n  - "src/{a,b}/**"\n  - "**/*.{ts,tsx}"\n---\n\n${BODY}`, false, ['src/{a,b}/**', '**/*.{ts,tsx}']],
    ['an unquoted alias-like glob', `---\npaths: **/*.ts\n---\n\n${BODY}`, false, ['**/*.ts']],
  ])('%s', (_label, source, alwaysApply, globs) => {
    const parsed = parser!.parse(teamRuleToCursorMdc(source));

    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.alwaysApply).toBe(alwaysApply);
    expect(parser!.globs(parsed!.frontmatter.globs)).toEqual(globs);
    expect(parsed!.body).toBe(BODY);
  });
});
