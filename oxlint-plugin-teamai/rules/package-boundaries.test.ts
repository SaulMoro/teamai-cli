import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/package-boundaries', { filename: 'packages/tool-core/src/sessions.ts' });

const workspace = {
  'package.json': JSON.stringify({ name: 'teamai-cli', workspaces: ['packages/*'], dependencies: { zod: '^4.0.0' } }),
  'packages/tool-core/package.json': JSON.stringify({ name: '@teamai/tool-core', private: true }),
  'packages/tool-core/src/definition.ts': 'export const definition = 1;',
  'packages/runtime-sandbox/package.json': JSON.stringify({ name: '@teamai/runtime-sandbox', private: true }),
  'packages/runtime-protocol/package.json': JSON.stringify({ name: '@teamai/runtime-protocol', private: true }),
  'packages/tool-claude/package.json': JSON.stringify({ name: '@teamai/tool-claude', private: true }),
  'packages/tool-codex/package.json': JSON.stringify({ name: '@teamai/tool-codex', private: true }),
  'packages/tool-definitions/package.json': JSON.stringify({ name: '@teamai/tool-definitions', private: true }),
  'packages/tool-testing/package.json': JSON.stringify({ name: '@teamai/tool-testing', private: true }),
  'src/locate.ts': 'export const locate = 1;',
  'scripts/check-docs.mjs': 'export const check = 1;',
};
const inWorkspace = (filename: string, files: Readonly<Record<string, string>> = {}) => ({ filename, files: { ...workspace, ...files } });

rule.invalid('rejects a package importing src/', `import { locate } from '../../../src/locate.js';`, (output) => {
  expect(output).toContain('A workspace package imports only its own files and other workspace packages by name');
  expect(output).toContain('packages/tool-core/src/sessions.ts -> src/locate.js');
}, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.invalid('rejects a type-only import of src/ from a package', `import type { Locate } from '../../../src/locate.js';`, undefined, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.invalid('rejects a package test importing src/', `import { locate } from '../../../src/locate.js';`, undefined, inWorkspace('packages/tool-core/src/sessions.test.ts'));

rule.invalid('rejects a package importing a repository script', `import { check } from '../../../scripts/check-docs.mjs';`, undefined, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.invalid('rejects a package mocking src/', `vi.mock('../../../src/locate.js');`, undefined, inWorkspace('packages/tool-core/src/sessions.test.ts'));

rule.invalid('rejects a relative import into another package', `import { definition } from '../../tool-core/src/definition.js';`, (output) => {
  expect(output).toContain('Import a workspace package by its package name');
  expect(output).toContain('@teamai/tool-core');
}, inWorkspace('packages/runtime-sandbox/src/index.ts'));

rule.invalid('rejects a relative import from src/ into a package', `import { definition } from '../packages/tool-core/src/definition.js';`, (output) => {
  expect(output).toContain('@teamai/tool-core');
}, inWorkspace('src/tools.ts'));

rule.invalid('rejects src/ importing a runtime package', `import { runtime } from '@teamai/runtime-sandbox';`, (output) => {
  expect(output).toContain('src/ never imports a runtime package');
  expect(output).toContain('src/workflow/engine.ts -> @teamai/runtime-sandbox');
}, inWorkspace('src/workflow/engine.ts'));

rule.invalid('rejects src/ importing a runtime package subpath', `export { runtime } from '@teamai/runtime-sandbox/protocol';`, undefined, inWorkspace('src/workflow/engine.ts'));

rule.invalid('rejects src/ loading a runtime package dynamically', `export const load = () => import('@teamai/runtime-sandbox');`, undefined, inWorkspace('src/workflow/engine.ts'));

rule.invalid('rejects a unit test importing a runtime package', `vi.mock('@teamai/runtime-sandbox');`, undefined, inWorkspace('src/__tests__/engine.test.ts'));

rule.invalid('rejects a file in a package that is not private', `export const definition = 1;`, (output) => {
  expect(output).toContain('A workspace package is private');
  expect(output).toContain('packages/tool-public/package.json');
}, inWorkspace('packages/tool-public/src/index.ts', { 'packages/tool-public/package.json': JSON.stringify({ name: '@teamai/tool-public' }) }));

rule.invalid('rejects a file in a packages/ folder with no package.json', `export const definition = 1;`, (output) => {
  expect(output).toContain('packages/tool-orphan/package.json');
}, inWorkspace('packages/tool-orphan/src/index.ts'));

rule.invalid('rejects a family importing another family', `import { family } from '@teamai/tool-codex';`, (output) => {
  expect(output).toContain('Only @teamai/tool-definitions imports a tool family');
  expect(output).toContain('packages/tool-claude/src/index.ts -> @teamai/tool-codex');
}, inWorkspace('packages/tool-claude/src/index.ts'));

rule.invalid('rejects src/ importing a family', `import { family } from '@teamai/tool-claude';`, undefined, inWorkspace('src/tools.ts'));

rule.invalid('rejects a unit test mocking a family', `vi.mock('@teamai/tool-claude');`, undefined, inWorkspace('src/__tests__/tools.test.ts'));

rule.invalid('rejects tool-core importing a family', `import { family } from '@teamai/tool-claude';`, undefined, inWorkspace('packages/tool-core/src/registry.ts'));

rule.invalid('rejects production code importing the test kit', `import { describeFamily } from '@teamai/tool-testing/conformance';`, (output) => {
  expect(output).toContain('@teamai/tool-testing is test-only');
}, inWorkspace('packages/tool-claude/src/index.ts'));

rule.valid('allows tool-definitions importing every family', `import { family as claude } from '@teamai/tool-claude';
import { family as codex } from '@teamai/tool-codex';`, inWorkspace('packages/tool-definitions/src/registry.ts'));

rule.valid('allows a family test importing the test kit', `import { describeFamily } from '@teamai/tool-testing/conformance';`, inWorkspace('packages/tool-claude/src/conformance.test.ts'));

rule.valid('allows a package importing its own files', `import { definition } from './definition.js';`, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.valid('allows a package importing another package by name', `import { definition } from '@teamai/tool-core/definition';`, inWorkspace('packages/runtime-sandbox/src/index.ts'));

rule.valid('allows src/ importing the runtime protocol', `import { RuntimeRequestSchema } from '@teamai/runtime-protocol';`, inWorkspace('src/workflow/runtimes/stdio.ts'));

rule.valid('allows a runtime package importing the runtime protocol', `import { RuntimeRequestSchema } from '@teamai/runtime-protocol';`, inWorkspace('packages/runtime-sandbox/src/main.ts'));

rule.invalid('still rejects src/ importing a runtime package beside the protocol', `import { RuntimeRequestSchema } from '@teamai/runtime-protocol';
import { runtime } from '@teamai/runtime-sandbox';`, (output) => {
  expect(output).toContain('src/workflow/runtimes/stdio.ts -> @teamai/runtime-sandbox');
  expect(output).not.toContain('-> @teamai/runtime-protocol');
}, inWorkspace('src/workflow/runtimes/stdio.ts'));

rule.invalid('rejects src/ importing a runtime package whose name only starts like the protocol', `import { runtime } from '@teamai/runtime-protocol-next';`, undefined, inWorkspace('src/workflow/engine.ts', {
  'packages/runtime-protocol-next/package.json': JSON.stringify({ name: '@teamai/runtime-protocol-next', private: true }),
}));

rule.valid('allows src/ importing a package that is not a runtime', `import { definition } from '@teamai/tool-core/definition';`, inWorkspace('src/tools.ts'));

rule.valid('allows src/ importing src/', `import { locate } from './locate.js';`, inWorkspace('src/tools.ts'));

rule.valid('leaves a checkout without workspaces alone', `import { locate } from '../../../src/locate.js';`, { filename: 'packages/tool-core/src/sessions.ts' });

rule.invalid('rejects src/ importing a value from a package teamai-cli does not depend on, which the bundle would carry', `import { DaemonClient } from '@getpaseo/server';`, (output) => {
  expect(output).toContain('src/ imports values only from Node, the workspace packages and the dependencies in package.json');
  expect(output).toContain('@getpaseo/server');
}, inWorkspace('src/workflow/runtimes/sources.ts'));

rule.invalid('rejects src/ loading a package teamai-cli does not depend on at run time', `const ws = await import('ws');`, undefined, inWorkspace('src/workflow/runtimes/sources.ts'));

rule.invalid('rejects src/ importing a file of an npm package whose name is also a Node module', `import { StringDecoder } from 'string_decoder/lib/string_decoder.js';`, undefined, inWorkspace('src/workflow/runtimes/sources.ts'));

rule.invalid('rejects src/ re-exporting a value of a package teamai-cli does not depend on', `export { WebSocket } from 'ws';`, undefined, inWorkspace('src/workflow/runtimes/sources.ts'));

rule.valid('allows src/ to import only the types of a package teamai-cli does not depend on', `import type { DaemonClient } from '@getpaseo/server';`, inWorkspace('src/workflow/runtimes/sources.ts'));

rule.valid('allows src/ a dependency, a subpath of one, Node and a workspace package', [
  `import { z } from 'zod';`, `import { toJSONSchema } from 'zod/v4';`, `import fs from 'node:fs';`, `import path from 'path';`, `import { readFile } from 'fs/promises';`, `import { definition } from '@teamai/tool-core';`,
].join('\n'), inWorkspace('src/workflow/runtimes/sources.ts'));

rule.valid('allows a src/ test a package teamai-cli does not ship', `import { WebSocket } from 'ws';`, inWorkspace('src/__tests__/paseo.test.ts'));
