import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { ruleHarness } from '../test/harness.ts';
import { isWriteChecked } from './step-path-writes.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A file the fixtures list as still appending, and one listed whose file is gone. */
const LISTED = 'src/workflow/listed/journal.ts';
const GONE = 'src/workflow/gone/gone.ts';

const rule = ruleHarness('teamai/step-path-writes', { filename: 'src/workflow/steps/outcome.ts', options: [{ stillWrites: [LISTED, GONE] }] });

const MESSAGE = 'Write a file in src/workflow with writeRegularFile, appendRegularFile or openRegularFileForWrite';

rule.invalid('rejects an open of fs.promises with a write flag', `import fs from 'node:fs';
export const open = (file: string) => fs.promises.open(file, 'a');`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects a named import of openSync with a write flag, under any local name', `import { openSync as at } from 'node:fs';
export const open = (file: string) => at(file, 'w+');`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects write flags given as constants', `import fs from 'node:fs';
export const open = (file: string) => fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT);`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects flags it cannot read, as a write', `import fs from 'node:fs/promises';
export const open = (file: string, flags: string) => fs.open(file, flags);`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects a write stream and an append, from node:fs and fs-extra', `import fs from 'node:fs';
import fse from 'fs-extra';
import { appendFile } from 'node:fs/promises';
export const all = async (file: string) => [fs.createWriteStream(file), fs.appendFileSync(file, 'x'), await fse.appendFile(file, 'x'), await appendFile(file, 'x')];`, (output) => {
  expect(output.match(/Write a file in src\/workflow/g)).toHaveLength(4);
});

rule.invalid('rejects a write in a folder no rule names, so new code is in scope', `import fs from 'node:fs/promises';
export const add = (file: string) => fs.appendFile(file, 'x');`, (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'src/workflow/zzz-new/x.ts' });

rule.invalid('rejects a whole-file write, which waits on a FIFO as an open for writing does', `import fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
export const all = async (file: string) => [await fs.promises.writeFile(file, 'x', 'utf-8'), fs.writeFileSync(file, 'x'), await writeFile(file, 'x', { mode: 0o600 })];`, (output) => {
  expect(output.match(/Write a file in src\/workflow/g)).toHaveLength(3);
});

rule.invalid('rejects a copy, which opens its destination for writing', `import fs from 'node:fs/promises';
import fse from 'fs-extra';
export const all = async (from: string, to: string) => [await fs.copyFile(from, to), fse.copyFileSync(from, to)];`, (output) => {
  expect(output.match(/Write a file in src\/workflow/g)).toHaveLength(2);
});

rule.invalid('rejects fs-extra\'s writers of a whole file', `import fse from 'fs-extra';
export const all = async (file: string) => [await fse.outputFile(file, 'x'), await fse.writeJson(file, {}), fse.outputJsonSync(file, {}), fse.writeJSONSync(file, {})];`, (output) => {
  expect(output.match(/Write a file in src\/workflow/g)).toHaveLength(4);
});

rule.valid('allows the helper and an atomic JSON write', `import { appendRegularFile, openRegularFileForWrite, writeRegularFile } from '@teamai/shared/regular-file';
import { writeJsonAtomic } from '../../utils/fs.js';
export const all = async (file: string) => [await appendRegularFile(file, 'x'), await openRegularFileForWrite(file, { append: false }), await writeRegularFile(file, 'x'), await writeJsonAtomic(file, {})];`);

rule.valid('allows a whole-file write that only creates, which fails at once on anything already there', `import fs from 'node:fs/promises';
export const create = async (file: string) => [await fs.writeFile(file, 'x', { mode: 0o600, flag: 'wx' }), await fs.writeFile(file, 'x', { flag: 'ax' })];`);

rule.invalid('rejects a whole-file write whose flag it cannot read, as one that may replace', `import fs from 'node:fs/promises';
export const write = async (file: string, flag: string) => fs.writeFile(file, 'x', { flag });`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.valid('allows an open for reading, with no flag, a read flag or read constants', `import fs from 'node:fs';
export const open = (file: string) => [fs.promises.open(file), fs.openSync(file, 'r'), fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)];`);

rule.valid('allows an open method that is no file module\'s', `export const open = (runtime: { open: (view: string, flags: string) => void }, flags: string) => runtime.open('view', flags);`);

rule.valid('allows writes outside src/workflow', `import fs from 'node:fs/promises';
export const add = (file: string) => fs.appendFile(file, 'x');`, { filename: 'src/commands/status.ts' });

rule.valid('allows writes in tests', `import fs from 'node:fs/promises';
export const add = (file: string) => fs.appendFile(file, 'x');`, { filename: 'src/workflow/steps/outcome.test.ts' });

rule.valid('leaves a file listed in stillWrites alone while it still writes plainly', `import fs from 'node:fs/promises';
export const add = (file: string) => fs.appendFile(file, 'x');`, { filename: LISTED });

rule.invalid('fails a file left on stillWrites once it no longer writes plainly', `export const add = () => 1;`, (output) => {
  expect(output).toContain(`${LISTED} no longer opens a file for writing. Remove it from stillWrites`);
}, { filename: LISTED });

rule.invalid('fails a listed file that no longer exists, from any file of its folder', `export const nothing = 1;`, (output) => {
  expect(output).toContain(`${GONE} is listed in stillWrites but does not exist`);
}, { filename: 'src/workflow/gone/other.ts' });

it('matches the production source of src/workflow in this checkout, and nothing outside it', () => {
  const files = fs.readdirSync(path.join(REPO, 'src'), { recursive: true, encoding: 'utf8' }).map((file) => `src/${file.split(path.sep).join('/')}`);
  const matched = files.filter(isWriteChecked);

  expect(matched.length).toBeGreaterThan(100);
  expect(matched.filter((file) => !file.startsWith('src/workflow/') || /\.test\.|\/__tests__\/|\/testing\//.test(file))).toEqual([]);
});

it('lists in its stillWrites option only files that exist in this checkout', () => {
  const config = fs.readFileSync(path.join(REPO, '.oxlintrc.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const rules = z.object({ rules: z.record(z.string(), z.unknown()) }).parse(JSON.parse(config)).rules;
  const [, options] = z.tuple([z.literal('error'), z.object({ stillWrites: z.array(z.string()) })]).parse(rules['teamai/step-path-writes']);

  for (const file of options.stillWrites) expect(fs.existsSync(path.join(REPO, file)), file).toBe(true);
});
