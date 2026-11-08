import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/runtime-serve', { filename: 'packages/runtime-t3/src/conversation.ts' });

rule.invalid('rejects a runtime writing an op\'s end itself', `export const end = (write: (line: object) => void, op: string) => write({ op, event: 'finished', result: {} });`, (output) => {
  expect(output).toContain("End an operation through the runtime kit's ledger");
  expect(output).toContain("'finished' line");
});

rule.invalid('rejects a new runtime reading the process input with readline', `import readline from 'node:readline';
export const lines = readline.createInterface({ input: process.stdin });`, (output) => {
  expect(output).toContain('Read requests with serveRuntime');
}, { filename: 'packages/runtime-x/src/main.ts' });

rule.invalid('rejects a readline over the input a runtime is served on', `import { createInterface } from 'node:readline';
export const serve = (input: NodeJS.ReadableStream) => createInterface({ input });`);

rule.invalid('rejects a readline over stdin from node:process, or given positionally', `import { stdin } from 'node:process';
import { createInterface } from 'node:readline';
export const named = createInterface({ input: stdin });
export const positional = createInterface(process.stdin);`, (output) => {
  expect(output.match(/Read requests with serveRuntime/g)).toHaveLength(2);
});

rule.invalid('rejects a runtime parsing requests itself', `import { RuntimeRequestSchema } from '@teamai/runtime-protocol';
export const read = (line: string) => RuntimeRequestSchema.safeParse(JSON.parse(line));`, (output) => {
  expect(output).toContain('Leave parsing requests to serveRuntime');
});

rule.valid('allows an adapter returning how an op ended as a state', `export const finished = (op: string) => ({ op, state: 'finished', result: {} });`);

rule.valid('allows a failure for a place, which ends no operation', `export const failed = (handle: string) => ({ event: 'failed', handle, failure: { code: 'x', message: 'y' } });`);

rule.valid('allows a readline over a socket a runtime reads', `import readline from 'node:readline';
export const read = (client: NodeJS.ReadableStream) => readline.createInterface({ input: client });`);

rule.valid('allows the runtime kit to serve the protocol', `import readline from 'node:readline';
import { RuntimeRequestSchema } from '@teamai/runtime-protocol';
export const serve = (input: NodeJS.ReadableStream, write: (line: object) => void) => readline.createInterface({ input }).on('line', (line) => {
  const request = RuntimeRequestSchema.parse(JSON.parse(line));
  write({ op: request.type, event: 'failed', failure: {} });
});`, { filename: 'packages/runtime-kit/src/serve.ts' });

rule.valid('allows a runtime\'s tests and test harness to read its lines', `import readline from 'node:readline';
export const lines = (input: NodeJS.ReadableStream) => readline.createInterface({ input });
export const exited = { op: 'op-1', event: 'exited', code: 0, stdout: '' };`, { filename: 'packages/runtime-t3/src/testing/harness.ts' });

rule.valid('leaves a runtime not yet on the kit alone while it still serves the protocol', `export const end = (write: (line: object) => void, op: string) => write({ op, event: 'cancelled' });`, { filename: 'packages/runtime-paseo/src/runtime.ts' });

rule.invalid('fails a runtime left on the list once it no longer serves the protocol itself', `export const nothing = 1;`, (output) => {
  expect(output).toContain('packages/runtime-paseo/src/runtime.ts no longer serves runtime protocol 1 itself');
}, { filename: 'packages/runtime-paseo/src/runtime.ts' });
