import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/regular-file-reads', { filename: 'src/workflow/steps/result.ts' });

const MESSAGE = 'Read a file in src/workflow with readRegularFile or openRegularFile';

rule.invalid('rejects fs.promises.readFile of the result file a step wrote', `import fs from 'node:fs/promises';
export const read = (resultPath: string) => fs.readFile(resultPath, 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects readFileSync off a namespace import of node:fs', `import * as fs from 'node:fs';
export const read = (file: string) => fs.readFileSync(file, 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects readFile off the promises of node:fs, and off fs-extra', `import fs from 'node:fs';
import fse from 'fs-extra';
export const read = async (file: string) => [await fs.promises.readFile(file), await fse.readFile(file)];`, (output) => {
  expect(output.match(/Read a file in src\/workflow/g)).toHaveLength(2);
});

rule.invalid('rejects a stream opened on a path', `import fs from 'node:fs';
export const stream = (file: string) => fs.createReadStream(file);`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects a named import of a read, under any local name', `import { readFile as read } from 'node:fs/promises';
export const text = (file: string) => read(file, 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects a copy of a path, and fs-extra reading JSON off one', `import fs from 'node:fs/promises';
import fse from 'fs-extra';
export const copy = async (from: string, to: string) => [await fs.copyFile(from, to), await fse.readJson(from), fse.readJSONSync(from)];`, (output) => {
  expect(output.match(/Read a file in src\/workflow/g)).toHaveLength(3);
});

rule.invalid('rejects the read wrappers of src/utils/fs.ts, which call fs.readFile', `import { readFileSafe, writeFileAtomic } from '../../utils/fs.js';
export const text = (file: string) => readFileSafe(file);
export const write = writeFileAtomic;`, (output) => {
  expect(output.match(/Read a file in src\/workflow/g)).toHaveLength(1);
});

rule.invalid('rejects every export of src/utils/fs.ts not known to leave file contents unread, readJson among them', `import { readJson, readJsonObject, fileHash, pathExists, writeJsonAtomic } from '../../utils/fs.js';
export const all = [readJson, readJsonObject, fileHash, pathExists, writeJsonAtomic];`, (output) => {
  expect(output.match(/Read a file in src\/workflow/g)).toHaveLength(3);
});

rule.valid('allows the helper, and a read of an open handle it returned', `import { openRegularFile, readRegularFile } from '@teamai/shared/regular-file';
export const text = (file: string) => readRegularFile(file, 'utf8');
export const head = async (file: string) => {
  const handle = await openRegularFile(file);
  try { return await handle.readFile('utf8'); } finally { await handle.close(); }
};`);

rule.valid('allows the other calls of a file module, writes among them', `import fs from 'node:fs/promises';
export const write = (file: string) => fs.writeFile(file, '{}');
export const list = (dir: string) => fs.readdir(dir);`);

rule.valid('allows reads outside src/workflow', `import fs from 'node:fs/promises';
export const read = (file: string) => fs.readFile(file, 'utf8');`, { filename: 'src/commands/status.ts' });

rule.valid('allows reads in tests', `import fs from 'node:fs/promises';
export const read = (file: string) => fs.readFile(file, 'utf8');`, { filename: 'src/workflow/steps/result.test.ts' });
