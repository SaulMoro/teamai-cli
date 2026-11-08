import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

/** A runtime the fixtures list as not yet on the kit, and one listed whose file is gone. */
const LISTED = 'packages/runtime-listed/src/main.ts';
const GONE = 'packages/runtime-gone/src/main.ts';

const rule = ruleHarness('teamai/runtime-serve', { filename: 'packages/runtime-t3/src/conversation.ts', options: [{ notYetOnTheKit: [LISTED, GONE] }] });

rule.invalid('rejects a runtime writing an op\'s end itself', `export const end = (write: (line: object) => void, op: string) => write({ op, event: 'finished', result: {} });`, (output) => {
  expect(output).toContain("End an operation through the runtime kit's ledger");
  expect(output).toContain("'finished' line");
});

rule.invalid('rejects a new runtime reading the process input with readline', `import readline from 'node:readline';
export const lines = readline.createInterface({ input: process.stdin });`, (output) => {
  expect(output).toContain('Leave reading lines to the runtime kit');
  expect(output).toContain('Leave the process input to serveRuntime');
}, { filename: 'packages/runtime-x/src/main.ts' });

rule.invalid('rejects importing readline in a runtime, whatever it reads, and its promises form', `import { createInterface } from 'node:readline';
import * as promises from 'readline/promises';
export const serve = (input: NodeJS.ReadableStream) => [createInterface({ input }), promises];`, (output) => {
  expect(output.match(/Leave reading lines to the runtime kit/g)).toHaveLength(2);
});

rule.invalid('rejects reading the process input however it is reached', `import { stdin } from 'node:process';
import process, { stdin as input } from 'process';
const { stdin: aliased } = process;
export const reads = [stdin, input, aliased, process.stdin.on('data', () => {}), process['stdin']];`, (output) => {
  expect(output.match(/Leave the process input to serveRuntime/g)).toHaveLength(5);
});

rule.invalid('rejects loading readline at run time', `export const later = () => import('node:readline');
export const now = () => require('readline');`, (output) => {
  expect(output.match(/Leave reading lines to the runtime kit/g)).toHaveLength(2);
});

rule.invalid('rejects a runtime parsing requests itself', `import { RuntimeRequestSchema } from '@teamai/runtime-protocol';
export const read = (line: string) => RuntimeRequestSchema.safeParse(JSON.parse(line));`, (output) => {
  expect(output).toContain('Leave parsing requests to serveRuntime');
});

rule.valid('allows an adapter returning how an op ended as a state', `export const finished = (op: string) => ({ op, state: 'finished', result: {} });`);

rule.valid('allows a failure for a place, which ends no operation', `export const failed = (handle: string) => ({ event: 'failed', handle, failure: { code: 'x', message: 'y' } });`);

rule.valid('allows a runtime reading a socket\'s lines through the kit', `import { eachLine } from '@teamai/runtime-kit/serve';
export const read = (client: NodeJS.ReadableStream, on: (line: string) => void) => eachLine(client, on);`);

rule.valid('allows a runtime\'s own value named stdin that is not the process input', `export const forward = (child: { stdin: NodeJS.WritableStream }) => child.stdin.write('x');`);

rule.valid('allows the runtime kit to serve the protocol', `import readline from 'node:readline';
import { RuntimeRequestSchema } from '@teamai/runtime-protocol';
export const serve = (input: NodeJS.ReadableStream, write: (line: object) => void) => readline.createInterface({ input }).on('line', (line) => {
  const request = RuntimeRequestSchema.parse(JSON.parse(line));
  write({ op: request.type, event: 'failed', failure: {} });
});`, { filename: 'packages/runtime-kit/src/serve.ts' });

rule.valid('allows a runtime\'s tests and test harness to read its lines', `import readline from 'node:readline';
export const lines = (input: NodeJS.ReadableStream) => readline.createInterface({ input });
export const exited = { op: 'op-1', event: 'exited', code: 0, stdout: '' };`, { filename: 'packages/runtime-t3/src/testing/harness.ts' });

rule.valid('leaves a runtime not yet on the kit alone while it still serves the protocol', `export const end = (write: (line: object) => void, op: string) => write({ op, event: 'cancelled' });`, { filename: LISTED });

rule.invalid('fails a runtime left on the list once it no longer serves the protocol itself', `export const nothing = 1;`, (output) => {
  expect(output).toContain(`${LISTED} no longer reads requests or writes an op's end itself`);
}, { filename: LISTED });

rule.invalid('fails a listed file that no longer exists, from any source of its runtime', `export const nothing = 1;`, (output) => {
  expect(output).toContain(`${GONE} is listed in notYetOnTheKit but does not exist`);
}, { filename: 'packages/runtime-gone/src/other.ts' });
