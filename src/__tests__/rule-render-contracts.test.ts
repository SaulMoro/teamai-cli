import { describe, expect, it } from 'vitest';
import { teamRuleToCodebuddyRule } from '../resources/codebuddy-rule.js';
import { teamRuleToKiroSteering } from '../resources/kiro-steering.js';
import { teamRuleToQoderRule } from '../resources/qoder-rule.js';

/**
 * The exact bytes each tool's rule render writes (#946). Kiro and Qoder ship
 * no parser to run, so these pin the documented form.
 */
const UNSCOPED = 'Use named exports.\n';
const INLINE = '---\npaths: ["src/**/*.ts", "test/**"]\n---\n\nUse named exports.\n';
const BLOCK = '---\npaths:\n  - "src/**/*.ts"\n  - test/**\n---\n\nUse named exports.\n';
const BRACE = '---\npaths:\n  - "src/{a,b}/**"\n---\n\nUse named exports.\n';

describe('Kiro steering render', () => {
  it('makes an unscoped rule always included', () => {
    expect(teamRuleToKiroSteering(UNSCOPED)).toBe('---\ninclusion: always\n---\n\nUse named exports.\n');
  });

  it.each([
    ['an inline list', INLINE],
    ['a block list', BLOCK],
  ])('scopes %s with fileMatch and a fileMatchPattern list', (_label, source) => {
    expect(teamRuleToKiroSteering(source)).toBe(
      '---\ninclusion: fileMatch\nfileMatchPattern: ["src/**/*.ts", "test/**"]\n---\n\nUse named exports.\n',
    );
  });

  it('keeps a brace glob whole, since the pattern list does not split on commas', () => {
    expect(teamRuleToKiroSteering(BRACE)).toBe(
      '---\ninclusion: fileMatch\nfileMatchPattern: ["src/{a,b}/**"]\n---\n\nUse named exports.\n',
    );
  });
});

describe('Qoder rule render', () => {
  it('makes an unscoped rule always on', () => {
    expect(teamRuleToQoderRule(UNSCOPED)).toBe('---\ntrigger: always_on\n---\n\nUse named exports.\n');
  });

  it.each([
    ['an inline list', INLINE],
    ['a block list', BLOCK],
  ])('scopes %s with trigger glob and one comma-joined glob line, as Qoder Desktop writes it', (_label, source) => {
    expect(teamRuleToQoderRule(source)).toBe(
      '---\ntrigger: glob\nglob: src/**/*.ts, test/**\n---\n\nUse named exports.\n',
    );
  });

  it('expands a brace glob, since the glob line is split on every comma', () => {
    expect(teamRuleToQoderRule(BRACE)).toBe(
      '---\ntrigger: glob\nglob: src/a/**, src/b/**\n---\n\nUse named exports.\n',
    );
  });

  it('expands a brace glob given as a comma-separated paths string', () => {
    const source = '---\npaths: "src/{a,b}/**, test/**"\n---\n\nUse named exports.\n';
    expect(teamRuleToQoderRule(source)).toBe(
      '---\ntrigger: glob\nglob: src/a/**, src/b/**, test/**\n---\n\nUse named exports.\n',
    );
  });
});

describe('CodeBuddy rule render (CodeBuddy and WorkBuddy)', () => {
  const SCOPED = '---\nalwaysApply: false\npaths:\n  - "src/**/*.ts"\n  - "test/**"\n---\n\nUse named exports.\n';

  it('makes an unscoped rule always applied', () => {
    expect(teamRuleToCodebuddyRule(UNSCOPED)).toBe('---\nalwaysApply: true\n---\n\nUse named exports.\n');
  });

  // Its frontmatter parser reads lines, not YAML: an inline list keeps its
  // brackets in the globs, so the render always writes a block list.
  it.each([
    ['an inline list', INLINE],
    ['a block list', BLOCK],
    ['a comma-separated string', '---\npaths: src/**/*.ts, test/**\n---\n\nUse named exports.\n'],
  ])('scopes %s with alwaysApply false and paths as a block list', (_label, source) => {
    expect(teamRuleToCodebuddyRule(source)).toBe(SCOPED);
  });

  it('keeps a brace glob whole, since a list item is not split on commas', () => {
    expect(teamRuleToCodebuddyRule(BRACE)).toBe(
      '---\nalwaysApply: false\npaths:\n  - "src/{a,b}/**"\n---\n\nUse named exports.\n',
    );
  });
});

describe('team rule paths, shared by every render', () => {
  // gray-matter caches a parse by content, failures included: the retry that
  // quotes `**/*.ts` must not lose to a cached failure on the next render.
  it('scopes an unquoted alias-like glob on every render, not just the first', () => {
    const source = '---\npaths: **/*.ts\n---\n\nUse named exports.\n';
    const scoped = '---\ninclusion: fileMatch\nfileMatchPattern: ["**/*.ts"]\n---\n\nUse named exports.\n';
    expect(teamRuleToKiroSteering(source)).toBe(scoped);
    expect(teamRuleToKiroSteering(source)).toBe(scoped);
  });
});
