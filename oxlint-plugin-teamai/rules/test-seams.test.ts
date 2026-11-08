import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/test-seams', { filename: 'packages/runtime-x/src/connect.test.ts' });

const pkg = { 'packages/runtime-x/package.json': JSON.stringify({ name: '@teamai/runtime-x', private: true, exports: { './serve': './src/serve.ts' } }) };

rule.valid('allows a test the module it is named after', `import { connect } from './connect.js';`, { files: pkg });

rule.valid('allows a test its package\'s test support', `import { harness } from './testing/harness.js';`, { files: pkg });

rule.valid('allows a test an entry of its package\'s exports', `import { serveRuntime } from './serve.js';`, { files: pkg });

rule.valid('leaves a test\'s imports of other packages by name alone', `import { opLedger } from '@teamai/runtime-kit/ledger';`, { files: pkg });

rule.invalid('rejects a test reaching another module of its package', `import { agentIdOf } from './runtime.js';`, (output) => {
  expect(output).toContain('packages/runtime-x/src/connect.test.ts reaches src/runtime.ts, past its package\'s seams');
  expect(output).toContain('Test it through ./connect.js');
}, { files: pkg });

rule.invalid('rejects a test in a folder reaching a module above it', `import { launch } from '../launch.js';`, (output) => {
  expect(output).toContain('reaches src/launch.ts');
}, { filename: 'packages/runtime-x/src/daemon/connect.test.ts', files: pkg });

rule.valid('leaves a listed test reaching past a seam alone while it still does', `import { sessionSince } from './sessions.js';`, {
  filename: 'packages/runtime-t3/src/runtime-t3.test.ts', files: { 'packages/runtime-t3/package.json': JSON.stringify({ name: '@teamai/runtime-t3', private: true }) },
});

rule.invalid('fails a listed test once it no longer reaches past that seam', `export const nothing = 1;`, (output) => {
  expect(output).toContain('packages/runtime-t3/src/runtime-t3.test.ts -> packages/runtime-t3/src/sessions.ts is no longer imported');
}, { filename: 'packages/runtime-t3/src/runtime-t3.test.ts', files: { 'packages/runtime-t3/package.json': JSON.stringify({ name: '@teamai/runtime-t3', private: true }) } });
