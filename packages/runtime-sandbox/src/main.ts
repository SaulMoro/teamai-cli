import fs from 'node:fs';
import path from 'node:path';
import { getUserHome } from '@teamai/tool-core/home';
import { journal } from './journal.js';
import type { RuntimeMessage } from '@teamai/runtime-protocol';
import type { SandboxOptions } from './options.js';
import type { Provider } from './provider.js';
import { containerProvider } from './providers/container.js';
import { sbxProvider } from './providers/sbx.js';
import { serve } from './runtime.js';

// teamai-runtime-sandbox: teamai spawns it for a driver definition that uses runtime `sandbox`, and speaks runtime
// protocol 1 to it over stdio. Its stdout carries only protocol lines; anything for a person goes to stderr.

// When teamai is gone, a line it would have read goes nowhere: an exec still running keeps going and records its end.
let stdoutOpen = true;

process.stdout.on('error', () => { stdoutOpen = false; });

const uid = process.getuid?.();
const gid = process.getgid?.();

serve({
  input: process.stdin,
  write: (message: RuntimeMessage) => {
    if (stdoutOpen) process.stdout.write(`${JSON.stringify(message)}\n`);
  },
  journal: journal(path.join(getUserHome(), '.teamai', 'runtime-state', 'sandbox')),
  provider: providerOf,
});

function providerOf(options: SandboxOptions): Provider {
  switch (options.provider) {
    case 'sbx':
      return sbxProvider({ agent: options.agent, env: process.env });
    case 'docker':
    case 'podman':
      return containerProvider({
        engine: options.provider,
        image: options.image,
        host: { user: uid !== undefined && gid !== undefined ? { uid, gid } : undefined, selinux: fs.existsSync('/sys/fs/selinux/enforce'), env: process.env },
      });
    default: {
      const unhandled: never = options;

      return unhandled;
    }
  }
}
