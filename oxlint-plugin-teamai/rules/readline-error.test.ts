import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/readline-error', { filename: 'packages/runtime-x/src/socket.ts' });

const MESSAGE = 'readline re-emits its input\'s errors on the interface';

rule.invalid('rejects reading a socket\'s lines with no error listener', `import net from 'node:net';
import readline from 'node:readline';
export const read = (client: net.Socket) => readline.createInterface({ input: client }).on('line', () => {});`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects an interface bound to a name that only listens for lines', `import { createInterface } from 'node:readline';
export const read = (stream: NodeJS.ReadableStream) => {
  const lines = createInterface({ input: stream });
  lines.on('line', () => {});
  lines.on('close', () => {});
};`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects a child\'s output read in a test without an error listener', `import { spawn } from 'node:child_process';
import readline from 'node:readline';
const child = spawn('x');
readline.createInterface({ input: child.stdout }).on('line', () => {});`, (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'src/__tests__/x.test.ts' });

rule.invalid('rejects an error listener on another name than the interface', `import readline from 'node:readline';
export const read = (input: NodeJS.ReadableStream, other: NodeJS.EventEmitter) => {
  const lines = readline.createInterface({ input });
  other.on('error', () => {});
  return lines;
};`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.valid('allows an error listener chained on the interface', `import readline from 'node:readline';
export const read = (input: NodeJS.ReadableStream) => readline.createInterface({ input }).on('line', () => {}).once('error', () => {});`);

rule.valid('allows an error listener on the name the interface is bound to', `import readline from 'node:readline';
export const read = (input: NodeJS.ReadableStream) => {
  const lines = readline.createInterface({ input });
  lines.on('error', () => {});
  lines.on('line', () => {});
};`);

rule.valid('allows reading the lines with for await, which rejects on an error', `import fs from 'node:fs';
import readline from 'node:readline';
export async function count(file: string): Promise<number> {
  let n = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const _ of lines) n += 1;
  for await (const _ of readline.createInterface({ input: fs.createReadStream(file) })) n += 1;
  return n;
}`);

rule.valid('allows the async iterator, which rejects on an error', `import readline from 'node:readline';
export const first = (input: NodeJS.ReadableStream) => readline.createInterface({ input })[Symbol.asyncIterator]().next();`);

rule.valid('leaves a terminal\'s process input alone, where an error ends the command', `import { createInterface } from 'node:readline/promises';
export const ask = () => createInterface({ input: process.stdin, output: process.stderr }).question('?');`);
