import fs from 'node:fs';
import path from 'node:path';

/** Track detached children before their parent exits, so a fixture can join them. */
export function trackDetachedProcesses(root: string): { nodeOptions: string; waitForExit: () => Promise<void> } {
  const children = path.join(root, 'detached-children');
  fs.mkdirSync(children);
  const preload = path.join(root, 'track-detached.cjs');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const spawn = cp.spawn;
cp.spawn = function (...args) {
  const child = spawn.apply(this, args);
  if (args[2]?.detached && child.pid) {
    fs.writeFileSync(path.join(${JSON.stringify(children)}, String(child.pid)), '');
  }
  return child;
};
require('node:module').syncBuiltinESMExports();
`);
  return {
    nodeOptions: `--require ${JSON.stringify(preload)}`,
    async waitForExit() {
      const deadline = Date.now() + 60_000;
      while (true) {
        const pending = fs.readdirSync(children);
        if (pending.length === 0) return;
        for (const name of pending) {
          try {
            process.kill(Number(name), 0);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
            fs.unlinkSync(path.join(children, name));
          }
        }
        if (Date.now() >= deadline) throw new Error(`Detached fixture processes did not exit: ${fs.readdirSync(children).join(', ')}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    },
  };
}
