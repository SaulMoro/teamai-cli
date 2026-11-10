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

const rule = ruleHarness('teamai/step-path-writes', { filename: 'src/workflow/steps/outcome.ts', options: [{ stillAppends: [LISTED, GONE] }] });

const MESSAGE = 'Open a file for writing in src/workflow with openRegularFileForWrite or appendRegularFile';

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
  expect(output.match(/Open a file for writing in src\/workflow/g)).toHaveLength(4);
});

rule.invalid('rejects a write in a folder no rule names, so new code is in scope', `import fs from 'node:fs/promises';
export const add = (file: string) => fs.appendFile(file, 'x');`, (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'src/workflow/zzz-new/x.ts' });

rule.valid('allows the helper, an atomic JSON write and a whole-file write', `import fs from 'node:fs/promises';
import { appendRegularFile, openRegularFileForWrite } from '@teamai/shared/regular-file';
import { writeJsonAtomic } from '../../utils/fs.js';
export const all = async (file: string) => [await appendRegularFile(file, 'x'), await openRegularFileForWrite(file, { append: false }), await writeJsonAtomic(file, {}), await fs.writeFile(file, 'x')];`);

rule.valid('allows an open for reading, with no flag, a read flag or read constants', `import fs from 'node:fs';
export const open = (file: string) => [fs.promises.open(file), fs.openSync(file, 'r'), fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)];`);

rule.valid('allows an open method that is no file module\'s', `export const open = (runtime: { open: (view: string, flags: string) => void }, flags: string) => runtime.open('view', flags);`);

rule.valid('allows writes outside src/workflow', `import fs from 'node:fs/promises';
export const add = (file: string) => fs.appendFile(file, 'x');`, { filename: 'src/commands/status.ts' });

rule.valid('allows writes in tests', `import fs from 'node:fs/promises';
export const add = (file: string) => fs.appendFile(file, 'x');`, { filename: 'src/workflow/steps/outcome.test.ts' });

rule.valid('leaves a file listed in stillAppends alone while it still appends', `import fs from 'node:fs/promises';
export const add = (file: string) => fs.appendFile(file, 'x');`, { filename: LISTED });

rule.invalid('fails a file left on stillAppends once it no longer appends', `export const add = () => 1;`, (output) => {
  expect(output).toContain(`${LISTED} no longer opens a file for writing. Remove it from stillAppends`);
}, { filename: LISTED });

rule.invalid('fails a listed file that no longer exists, from any file of its folder', `export const nothing = 1;`, (output) => {
  expect(output).toContain(`${GONE} is listed in stillAppends but does not exist`);
}, { filename: 'src/workflow/gone/other.ts' });

it('matches the production source of src/workflow in this checkout, and nothing outside it', () => {
  const files = fs.readdirSync(path.join(REPO, 'src'), { recursive: true, encoding: 'utf8' }).map((file) => `src/${file.split(path.sep).join('/')}`);
  const matched = files.filter(isWriteChecked);

  expect(matched.length).toBeGreaterThan(100);
  expect(matched.filter((file) => !file.startsWith('src/workflow/') || /\.test\.|\/__tests__\/|\/testing\//.test(file))).toEqual([]);
});

it('lists in its stillAppends option only files that exist in this checkout', () => {
  const config = fs.readFileSync(path.join(REPO, '.oxlintrc.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const rules = z.object({ rules: z.record(z.string(), z.unknown()) }).parse(JSON.parse(config)).rules;
  const [, options] = z.tuple([z.literal('error'), z.object({ stillAppends: z.array(z.string()) })]).parse(rules['teamai/step-path-writes']);

  for (const file of options.stillAppends) expect(fs.existsSync(path.join(REPO, file)), file).toBe(true);
});
