import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ruleHarness } from '../test/harness.ts';
import { FACTS_FILES, STARTUP_ENTRIES, isFactsModule } from './family-facts.js';
import { FAMILY } from '../utils.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rule = ruleHarness('teamai/family-facts', { filename: 'src/index.ts' });

const manifest = (name: string, exports: Record<string, string>) => JSON.stringify({ name, private: true, exports });

/** A workspace with one family, `tool-acme`, whose facts entry holds data and whose index holds its adapters. */
const workspace = {
  'package.json': JSON.stringify({ name: 'teamai-cli', workspaces: ['packages/*'] }),
  'packages/tool-definitions/package.json': manifest('@teamai/tool-definitions', { '.': './src/registry.ts', './facts': './src/facts.ts' }),
  'packages/tool-definitions/src/registry.ts': `import { family as acme } from '@teamai/tool-acme';\nexport const BUILT_IN_TOOLS = { acme };\n`,
  'packages/tool-definitions/src/facts.ts': `import { facts as acme } from '@teamai/tool-acme/facts';\nexport const BUILT_IN_FACTS = { acme };\n`,
  'packages/tool-acme/package.json': manifest('@teamai/tool-acme', { '.': './src/index.ts', './facts': './src/facts.ts' }),
  'packages/tool-acme/src/index.ts': `import { platforms } from './sessions.js';\nexport const family = { platforms };\n`,
  'packages/tool-acme/src/sessions.ts': `import { AcmeAdapter } from './session-adapter.js';\nexport const platforms = { acme: { adapter: () => new AcmeAdapter() } };\n`,
  'packages/tool-acme/src/session-adapter.ts': 'export class AcmeAdapter {}\n',
  'packages/tool-acme/src/facts.ts': `import { tools } from './definitions.js';\nexport const facts = { tools };\n`,
  'packages/tool-acme/src/definitions.ts': 'export const tools = { acme: {} };\n',
  'packages/tool-core/package.json': manifest('@teamai/tool-core', { './definition': './src/definition.ts', './formats/*': './src/formats/*.ts' }),
  'packages/tool-core/src/definition.ts': 'export const UNKNOWN = "unknown";\n',
  'packages/tool-core/src/formats/claude-jsonl.ts': 'export const schema = {};\n',
  'src/tools.ts': `import { BUILT_IN_FACTS } from '@teamai/tool-definitions/facts';\nexport const TOOLS = { acme: BUILT_IN_FACTS.acme.tools.acme };\n`,
  'src/tools-from-registry.ts': `import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';\nexport const TOOLS = BUILT_IN_TOOLS;\n`,
  'src/hooks.ts': `import { TOOLS } from './tools.js';\nexport const hooks = TOOLS;\n`,
  'src/stale-hooks.ts': `import { TOOLS } from './tools-from-registry.js';\nexport const hooks = TOOLS;\n`,
  'src/launch-registry.ts': `import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';\nexport const LAUNCH = BUILT_IN_TOOLS;\n`,
  'src/hook-dispatch-cli.ts': 'export {};\n',
};
/** The workspace around a fixture at `filename`, without the workspace's own copy of that file. */
const inWorkspace = (filename: string) => ({ filename, files: Object.fromEntries(Object.entries(workspace).filter(([file]) => file !== filename)) });

describe('teamai/family-facts', () => {
  describe('the startup entries', () => {
    rule.invalid('refuses the CLI entry when an import reaches a family\'s behaviour through the list of families', `import { hooks } from './stale-hooks.js';`, (output) => {
      expect(output).toContain('src/index.ts -> src/stale-hooks.ts -> src/tools-from-registry.ts -> packages/tool-definitions/src/registry.ts');
      expect(output).toContain('@teamai/tool-definitions/facts');
    }, inWorkspace('src/index.ts'));
    rule.invalid('refuses the hook dispatch too', `import { LAUNCH } from './launch-registry.js';`, (output) => {
      expect(output).toContain('src/hook-dispatch-cli.ts starts every command and hook');
    }, inWorkspace('src/hook-dispatch-cli.ts'));
    rule.invalid('refuses a re-export that reaches a family\'s adapters', `export { platforms } from '@teamai/tool-acme';`, undefined, inWorkspace('src/index.ts'));
    rule.valid('allows an entry whose imports reach only facts', `import { hooks } from './hooks.js';\nimport { UNKNOWN } from '@teamai/tool-core/definition';`, inWorkspace('src/index.ts'));
    rule.valid('allows a dynamic import, which loads the behaviour on first use', `const { LAUNCH } = await import('./launch-registry.js');`, inWorkspace('src/index.ts'));
    rule.valid('allows a type-only import, which the build erases', `import type { LAUNCH } from './launch-registry.js';`, inWorkspace('src/index.ts'));
    rule.valid('leaves a module that is not a startup entry alone', `import { LAUNCH } from './launch-registry.js';`, inWorkspace('src/doctor.ts'));
  });

  describe('the facts modules', () => {
    rule.invalid('refuses a family\'s facts entry importing its session adapters', `import { platforms } from './sessions.js';\nexport const facts = { platforms };`, (output) => {
      expect(output).toContain('packages/tool-acme/src/facts.ts is a facts module');
    }, inWorkspace('packages/tool-acme/src/facts.ts'));
    rule.invalid('refuses a family\'s definitions importing a shared format', `import { schema } from '@teamai/tool-core/formats/claude-jsonl';\nexport const tools = { schema };`, undefined, inWorkspace('packages/tool-acme/src/definitions.ts'));
    rule.invalid('refuses platform-facts reading the list of families', `import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';\nexport const SESSION_PLATFORM_FACTS = BUILT_IN_TOOLS;`, undefined, inWorkspace('src/session-flow/adapters/platform-facts.ts'));
    rule.invalid('refuses the list of facts importing a family\'s index', `import { family } from '@teamai/tool-acme';\nexport const BUILT_IN_FACTS = { acme: family };`, undefined, inWorkspace('packages/tool-definitions/src/facts.ts'));
    rule.invalid('refuses a dynamic import in a facts module', `export const later = () => import('./sessions.js');`, undefined, inWorkspace('packages/tool-acme/src/facts.ts'));
    rule.invalid('refuses a dependency in a facts module', `import { z } from 'zod';\nexport const tools = { z };`, undefined, inWorkspace('packages/tool-acme/src/definitions.ts'));
    rule.invalid('holds the facts entry of a family in a new package, with no rule edit', `import { launch } from './launch.js';\nexport const facts = { launch };`, (output) => {
      expect(output).toContain('packages/tool-newcomer/src/facts.ts is a facts module');
    }, inWorkspace('packages/tool-newcomer/src/facts.ts'));
    rule.valid('allows a family\'s facts entry to import its definitions and tool-core\'s definition', `import { tools } from './definitions.js';\nimport { UNKNOWN } from '@teamai/tool-core/definition';\nimport type { AcmeAdapter } from './session-adapter.js';\nexport const facts = { tools, UNKNOWN };`, inWorkspace('packages/tool-acme/src/facts.ts'));
    rule.valid('allows the list of facts to import each family\'s facts entry', `import { facts as acme } from '@teamai/tool-acme/facts';\nexport const BUILT_IN_FACTS = { acme };`, inWorkspace('packages/tool-definitions/src/facts.ts'));
    rule.valid('leaves a family\'s behaviour modules to import what they need', `import { AcmeAdapter } from './session-adapter.js';\nexport const platforms = { AcmeAdapter };`, inWorkspace('packages/tool-acme/src/sessions.ts'));
    rule.valid('leaves tool-core and tool-launch out of the families', `import { z } from 'zod';\nexport const facts = { z };`, inWorkspace('packages/tool-launch/src/facts.ts'));
  });

  describe('in this checkout', () => {
    const families = fs.readdirSync(path.join(REPO, 'packages')).filter((folder) => FAMILY.test(folder));

    it('holds every family\'s facts entry and definitions, so the rule matches files here', () => {
      const matched = families.flatMap((folder) => ['facts', 'definitions'].map((name) => `packages/${folder}/src/${name}.ts`)).filter((file) => fs.existsSync(path.join(REPO, file)));

      expect(families.length).toBeGreaterThan(0);
      expect(matched.length).toBe(families.length * 2);
      expect(matched.every(isFactsModule)).toBe(true);
    });

    it('names only files that exist in FACTS_FILES and STARTUP_ENTRIES', () => {
      expect([...FACTS_FILES, ...STARTUP_ENTRIES].filter((file) => !fs.existsSync(path.join(REPO, file)))).toEqual([]);
    });
  });
});
