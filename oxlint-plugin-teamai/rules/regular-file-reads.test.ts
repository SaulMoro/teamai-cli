import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { ruleHarness } from '../test/harness.ts';
import { BaselineSchema, isReadChecked } from './regular-file-reads.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the fixtures keep their baseline, from the fixture's root, as the repository keeps its own. */
const BASELINE = 'lint/regular-file-reads.json';
/** A fixture file the baseline lists with two reads, and one it lists whose file is gone. */
const LISTED = 'src/config/listed.ts';
const GONE = 'src/config/gone.ts';
const files = { [BASELINE]: JSON.stringify({ [LISTED]: 2, [GONE]: 1 }) };

const rule = ruleHarness('teamai/regular-file-reads', { filename: 'src/workflow/steps/result.ts', options: [{ baseline: BASELINE }] });

type Options = { filename?: string; files?: Readonly<Record<string, string>> };
/** Every fixture lints beside a baseline file, as the repository does. */
const valid = (name: string, source: string, options: Options = {}) => rule.valid(name, source, { files, ...options });
const invalid = (name: string, source: string, assertion?: (output: string) => void, options: Options = {}) => rule.invalid(name, source, assertion, { files, ...options });

const MESSAGE = 'Read a file with readRegularFile or openRegularFile';

invalid('rejects fs.promises.readFile of the result file a step wrote', `import fs from 'node:fs/promises';
export const read = (resultPath: string) => fs.readFile(resultPath, 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
});

invalid('rejects readFileSync off a namespace import of node:fs', `import * as fs from 'node:fs';
export const read = (file: string) => fs.readFileSync(file, 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
});

invalid('rejects readFile off the promises of node:fs, and off fs-extra', `import fs from 'node:fs';
import fse from 'fs-extra';
export const read = async (file: string) => [await fs.promises.readFile(file), await fse.readFile(file)];`, (output) => {
  expect(output.match(/Read a file with readRegularFile/g)).toHaveLength(2);
});

invalid('rejects a stream opened on a path', `import fs from 'node:fs';
export const stream = (file: string) => fs.createReadStream(file);`, (output) => {
  expect(output).toContain(MESSAGE);
});

invalid('rejects a named import of a read, under any local name', `import { readFile as read } from 'node:fs/promises';
export const text = (file: string) => read(file, 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
});

invalid('rejects a copy of a path, and fs-extra reading JSON off one', `import fs from 'node:fs/promises';
import fse from 'fs-extra';
export const copy = async (from: string, to: string) => [await fs.copyFile(from, to), await fse.readJson(from), fse.readJSONSync(from)];`, (output) => {
  expect(output.match(/Read a file with readRegularFile/g)).toHaveLength(3);
});

invalid('rejects an open for reading, with no flag, a read flag or read constants', `import fs from 'node:fs';
export const open = async (file: string) => [await fs.promises.open(file), fs.openSync(file, 'r'), fs.openSync(file, fs.constants.O_RDONLY)];`, (output) => {
  expect(output.match(/Read a file with readRegularFile/g)).toHaveLength(3);
});

valid('allows an open for writing, which the write rule guards where a step writes', `import fs from 'node:fs';
export const open = (file: string) => fs.openSync(file, 'w');`);

invalid('rejects a read under computed access, destructured from a file module, or off one imported at run time', `import fs from 'node:fs';
const { readFileSync: readNow } = fs;
export const all = async (file: string) => {
  const fsp = await import('node:fs/promises');
  const { readFile } = await import('node:fs/promises');
  return [fs['readFileSync'](file), readNow(file), await fsp.readFile(file), await readFile(file), await (await import('node:fs/promises')).readFile(file)];
};`, (output) => {
  expect(output.match(/Read a file with readRegularFile/g)).toHaveLength(5);
});

invalid('rejects a read passed on as a value, which a later call makes', `import { readFile } from 'node:fs/promises';
export const texts = (files: string[]) => Promise.all(files.map(readFile));`, (output) => {
  expect(output).toContain(MESSAGE);
});

invalid('counts each call of a named import, not the import once, against the baseline', `import { readFileSync } from 'node:fs';
export const all = (file: string) => [readFileSync(file), readFileSync(file), readFileSync(file)];`, (output) => {
  expect(output).toContain(`${LISTED} has 3 plain reads; the baseline allows 2.`);
}, { filename: LISTED });

valid('allows the read wrappers of src/utils/fs.ts, which open through the helper', `import { readFileSafe, readJson, fileHash } from '../../utils/fs.js';
export const all = (file: string) => Promise.all([readFileSafe(file), readJson(file), fileHash(file)]);`);

invalid('rejects a plain read inside src/utils/fs.ts itself, so a new wrapper is checked where it is written', `import fse from 'fs-extra';
export const readFileSafe = (file: string) => fse.readFile(file, 'utf-8');`, (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'src/utils/fs.ts' });

valid('allows the helper\'s own read of the descriptor it checked', `import fs from 'node:fs';
export const read = (fd: number) => fs.readFileSync(fd, 'utf8');`, { filename: 'packages/shared/src/regular-file.ts' });

valid('allows the hook fast path\'s copy of the helper, which runs before the bundle that holds it', `import fs from 'node:fs';
export const read = (fd: number) => fs.readFileSync(fd, 'utf8');`, { filename: 'src/hook-fast-path.ts' });

valid('allows the helper, and a read of an open handle it returned', `import { openRegularFile, readRegularFile } from '@teamai/shared/regular-file';
export const text = (file: string) => readRegularFile(file, 'utf8');
export const head = async (file: string) => {
  const handle = await openRegularFile(file);
  try { return await handle.readFile('utf8'); } finally { await handle.close(); }
};`);

valid('allows the other calls of a file module, writes among them', `import fs from 'node:fs/promises';
export const write = (file: string) => fs.writeFile(file, '{}');
export const list = (dir: string) => fs.readdir(dir);`);

invalid('rejects a read in src/ outside src/workflow, such as a scorer reading evidence a step wrote', `import fs from 'node:fs';
export const read = (file: string) => fs.readFileSync(file, 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'src/scorers/x.ts', files });

invalid('rejects a read in a package folder no rule names, so a new package is in scope', `import { readFile } from 'node:fs/promises';
export const read = (file: string) => readFile(file, 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'packages/tool-zzz/src/x.ts', files });

valid('allows the helper in a package', `import { readRegularFileSync } from '@teamai/shared/regular-file';
export const read = (file: string) => readRegularFileSync(file, 'utf8');`, { filename: 'packages/tool-zzz/src/x.ts', files });

valid('allows a baselined file its counted reads', `import fs from 'node:fs';
export const read = (file: string) => [fs.readFileSync(file, 'utf8'), fs.readFileSync(\`\${file}.bak\`, 'utf8')];`, { filename: LISTED, files: { [BASELINE]: JSON.stringify({ [LISTED]: 2 }) } });

invalid('rejects a read added to a baselined file past its count', `import fs from 'node:fs';
export const read = (file: string) => [fs.readFileSync(file), fs.readFileSync(file), fs.readFileSync(file)];`, (output) => {
  expect(output).toContain(`${LISTED} has 3 plain reads; the baseline allows 2`);
}, { filename: LISTED, files: { [BASELINE]: JSON.stringify({ [LISTED]: 2 }) } });

invalid('rejects a baselined file whose reads fell below its entry, until the entry is lowered', `import fs from 'node:fs';
export const read = (file: string) => fs.readFileSync(file);`, (output) => {
  expect(output).toContain(`${LISTED} has 1 plain read; lower its entry in ${BASELINE} from 2 to 1`);
}, { filename: LISTED, files: { [BASELINE]: JSON.stringify({ [LISTED]: 2 }) } });

invalid('rejects a baseline entry for a file that no longer exists', `export const nothing = 1;`, (output) => {
  expect(output).toContain(`${GONE} is in ${BASELINE} but does not exist`);
}, { filename: 'src/config/other.ts', files });

valid('allows reads in tests', `import fs from 'node:fs/promises';
export const read = (file: string) => fs.readFile(file, 'utf8');`, { filename: 'src/workflow/steps/result.test.ts' });

it('matches the production source of src/ and of every package in this checkout', () => {
  const sources = (dir: string) => fs.readdirSync(path.join(REPO, dir), { recursive: true, encoding: 'utf8' })
    .map((file) => `${dir}/${file.split(path.sep).join('/')}`)
    .filter((file) => !file.includes('node_modules'));
  const matched = [...sources('src'), ...sources('packages')].filter(isReadChecked);

  expect(matched.filter((file) => file.startsWith('src/')).length).toBeGreaterThan(500);
  expect(matched.filter((file) => file.startsWith('packages/')).length).toBeGreaterThan(150);
  expect(matched.filter((file) => /\.test\.|\/__tests__\/|\/testing\//.test(file))).toEqual([]);
});

it('lists in its baseline only files that exist, each with a positive count', () => {
  const config = fs.readFileSync(path.join(REPO, '.oxlintrc.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const rules = z.object({ rules: z.record(z.string(), z.unknown()) }).parse(JSON.parse(config)).rules;
  const [, options] = z.tuple([z.literal('error'), z.object({ baseline: z.string() })]).parse(rules['teamai/regular-file-reads']);
  const baseline = BaselineSchema.parse(JSON.parse(fs.readFileSync(path.join(REPO, options.baseline), 'utf8')));

  for (const [file, count] of Object.entries(baseline)) {
    expect(fs.existsSync(path.join(REPO, file)), file).toBe(true);
    expect(count, file).toBeGreaterThan(0);
  }
});
