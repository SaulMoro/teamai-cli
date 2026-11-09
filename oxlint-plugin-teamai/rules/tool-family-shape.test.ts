import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { ruleHarness } from '../test/harness.ts';
import { familySource } from './tool-family-shape.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A family file the fixtures list as still spawning, and one listed whose file is gone. */
const LISTED = 'packages/tool-listed/src/store.ts';
const GONE = 'packages/tool-gone/src/store.ts';

const rule = ruleHarness('teamai/tool-family-shape', { filename: 'packages/tool-claude/src/launch.ts', options: [{ stillSpawns: [LISTED, GONE] }] });

rule.valid('allows a family\'s launch profile that builds a step\'s argv', `export const launch = { claude: { step: { evidence: 'verified', unattended: 'none', args: (input: { prompt: string }) => ['-p', input.prompt] } } } as const;`);

rule.invalid('rejects a family spawning its tool', `import { spawn } from 'node:child_process';
export const run = () => spawn('codex', ['exec']);`, (output) => {
  expect(output).toContain('A tool family builds argv and reads output, and never starts a process: packages/tool-codex/src/launch.ts imports node:child_process');
}, { filename: 'packages/tool-codex/src/launch.ts' });

rule.invalid('rejects the spawn helpers of tool-core, and child_process loaded at run time', `import { spawnCommand, execCommand } from '@teamai/tool-core/exec';
export const run = () => [spawnCommand('codex', [], {}), execCommand, require('child_process')];`, (output) => {
  expect(output).toContain('imports spawnCommand from @teamai/tool-core/exec');
  expect(output).not.toContain('execCommand from');
  expect(output).toContain('imports child_process');
}, { filename: 'packages/tool-codex/src/launch.ts' });

rule.invalid('rejects an index.ts exporting more than family', `export const family = {} as const;
export { ClaudeCodeAdapter } from './session-adapter.js';`, (output) => {
  expect(output).toContain("A tool family's index.ts exports only `family`");
  expect(output).toContain('also exports ClaudeCodeAdapter');
}, { filename: 'packages/tool-claude/src/index.ts', files: { 'packages/tool-claude/src/session-adapter.ts': 'export class ClaudeCodeAdapter {}' } });

rule.valid('allows an index.ts that exports only family', `import { tools } from './definitions.js';
export const family = { tools } as const;
export type { Family } from './definitions.js';`, { filename: 'packages/tool-claude/src/index.ts', files: { 'packages/tool-claude/src/definitions.ts': 'export const tools = {}; export type Family = 1;' } });

rule.invalid('covers a family package added later, in a folder of its own, with no rule edit', `import { execFile } from 'node:child_process';
export const run = () => execFile('zzz');`, (output) => {
  expect(output).toContain('packages/tool-zzz/src/readers/run.ts imports node:child_process');
}, { filename: 'packages/tool-zzz/src/readers/run.ts' });

rule.valid('leaves the infrastructure packages, a family\'s tests and its test support alone', `import { spawn } from 'node:child_process';
export const run = () => spawn('x');`, { filename: 'packages/tool-launch/src/run-step-launch.ts' });

rule.valid('leaves a family\'s tests alone', `import { execFileSync } from 'node:child_process';
export const fifo = () => execFileSync('mkfifo', ['x']);`, { filename: 'packages/tool-claude/src/launch.test.ts' });

rule.valid('leaves a family file listed in stillSpawns alone while it still starts a process', `import { spawnSync } from 'node:child_process';
export const read = () => spawnSync('sqlite3');`, { filename: LISTED });

rule.invalid('fails a file left on stillSpawns once it no longer starts a process', `export const read = () => 1;`, (output) => {
  expect(output).toContain(`${LISTED} no longer starts a process`);
}, { filename: LISTED });

rule.invalid('fails a listed file that no longer exists, from any source of its family', `export const nothing = 1;`, (output) => {
  expect(output).toContain(`${GONE} is listed in stillSpawns but does not exist`);
}, { filename: 'packages/tool-gone/src/other.ts' });

it('matches every family\'s production source in this checkout, and no infrastructure package', () => {
  const files = fs.readdirSync(path.join(REPO, 'packages'), { recursive: true, encoding: 'utf8' })
    .filter((file) => !file.includes('node_modules'))
    .map((file) => `packages/${file.split(path.sep).join('/')}`);
  const matched = files.filter((file) => familySource(file) !== undefined);
  const families = new Set(matched.map((file) => file.split('/')[1]));

  expect(matched.length).toBeGreaterThan(50);
  expect(families).toContain('tool-claude');
  expect(families).toContain('tool-opencode');
  expect([...families].filter((folder) => /^tool-(?:core|testing|definitions|launch)$/.test(folder))).toEqual([]);
  expect(matched.filter((file) => /\.test\.ts$|\/src\/testing\//.test(file))).toEqual([]);
});

it('lists in its stillSpawns option only files that exist in this checkout', () => {
  const config = fs.readFileSync(path.join(REPO, '.oxlintrc.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const rules = z.object({ rules: z.record(z.string(), z.unknown()) }).parse(JSON.parse(config)).rules;
  const [, options] = z.tuple([z.literal('error'), z.object({ stillSpawns: z.array(z.string()).min(1) })]).parse(rules['teamai/tool-family-shape']);

  for (const file of options.stillSpawns) expect(fs.existsSync(path.join(REPO, file)), file).toBe(true);
});
