import path from 'node:path';
import { RuntimeMessageSchema, type RuntimeMessage } from '@teamai/runtime-protocol';
import { getUserHome } from '@teamai/tool-core/home';
import { journal } from './journal.js';
import { serve } from './runtime.js';

// teamai-runtime-paseo: teamai spawns it for a driver definition that uses runtime `paseo`, and speaks runtime protocol
// 1 to it over stdio. Its stdout carries only protocol lines; anything for a person goes to stderr.

let stdoutOpen = true;

process.stdout.on('error', () => { stdoutOpen = false; });

await serve({
  input: process.stdin,
  // A line teamai could not read is a bug here: it fails where it is written.
  write: (message: RuntimeMessage) => {
    if (stdoutOpen) process.stdout.write(`${JSON.stringify(RuntimeMessageSchema.parse(message))}\n`);
  },
  journal: journal(path.join(getUserHome(), '.teamai', 'runtime-state', 'paseo')),
});

process.exit(0);
