import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { reachesSource, sourceModules } from '../imports.js';
import { ruleHarness } from '../test/harness.ts';
import { FAMILY, PROCESS_STARTERS } from '../utils.js';
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

rule.invalid('rejects every value of the shared exec module, and child_process loaded at run time', `import { execCommand } from '@teamai/shared/exec';
export const run = () => [execCommand('sqlite3', []), require('child_process')];`, (output) => {
  expect(output).toContain('imports @teamai/shared/exec');
  expect(output).toContain('imports child_process');
}, { filename: 'packages/tool-codex/src/launch.ts' });

rule.invalid('rejects a workspace module that starts a process for its caller, and cross-spawn', `import { execVersion } from '@teamai/tool-core/detect';
import spawn from 'cross-spawn';
export const detect = { zzz: () => execVersion('zzz') };
export const run = () => spawn('zzz');`, (output) => {
  expect(output).toContain('imports @teamai/tool-core/detect');
  expect(output).toContain('imports cross-spawn');
}, { filename: 'packages/tool-zzz/src/detect.ts' });

rule.valid('allows the types of the shared exec module', `import type { ExecResult } from '@teamai/shared/exec';
export const ok = (result: ExecResult) => result.code === 0;`, { filename: 'packages/tool-codex/src/launch.ts' });

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

rule.valid('leaves the launch library alone', `import { spawn } from 'node:child_process';
export const run = () => spawn('x');`, { filename: 'packages/tool-launch/src/run-step-launch.ts' });

rule.valid('leaves a family\'s tests alone', `import { execFileSync } from 'node:child_process';
export const fifo = () => execFileSync('mkfifo', ['x']);`, { filename: 'packages/tool-claude/src/launch.test.ts' });

rule.valid('leaves a family\'s test support alone', `import { spawn } from 'node:child_process';
export const fake = () => spawn('claude');`, { filename: 'packages/tool-claude/src/testing/fake-claude.ts' });

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

/**
 * The module names each workspace package but a family exports, with the source file behind each; a `*` export gives
 * one per file. Families are left out: only @teamai/tool-definitions may import one (teamai/package-boundaries).
 */
function workspaceModules(): Array<[string, string]> {
  const ManifestSchema = z.object({ name: z.string(), exports: z.record(z.string(), z.string()).optional() });

  return fs.readdirSync(path.join(REPO, 'packages')).flatMap((folder) => {
    const file = path.join(REPO, 'packages', folder, 'package.json');

    if (FAMILY.test(folder) || !fs.existsSync(file)) return [];
    const { name, exports = {} } = ManifestSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));

    return Object.entries(exports).filter(([, target]) => target.endsWith('.ts')).flatMap(([subpath, target]): Array<[string, string]> => {
      if (!target.includes('*')) return [[`${name}${subpath.slice(1)}`, path.join(REPO, 'packages', folder, target)]];
      const dir = path.join(REPO, 'packages', folder, path.dirname(target));

      return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
        .map((entry): [string, string] => [`${name}${subpath.slice(1).replace('*', entry.replace(/\.ts$/, '').split(path.sep).join('/'))}`, path.join(dir, entry)]);
    });
  });
}

it('lists every workspace module that starts a process, so a new wrapper of one is caught', () => {
  const NODE_STARTERS = new Set(['child_process', 'node:child_process', 'cross-spawn']);
  const starts = (file: string) => sourceModules(file, false).some((specifier) => NODE_STARTERS.has(specifier));
  const starters = workspaceModules().filter(([, file]) => reachesSource(file, starts, false) !== undefined).map(([name]) => name);

  expect(starters).toContain('@teamai/shared/exec');
  expect(starters.filter((name) => !PROCESS_STARTERS.has(name))).toEqual([]);
});
