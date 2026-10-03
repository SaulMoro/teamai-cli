import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackDetachedProcesses } from './helpers/detached-processes.js';

it('waits for a detached writer after its spawning parent has exited', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-detached-fixture-'));
  const tracker = trackDetachedProcesses(root);
  const output = path.join(root, 'late-write');
  try {
    const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(output)}, 'finished'), 300)`;
    const parent = spawnSync(process.execPath, ['-e', `
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {
        detached: true, stdio: 'ignore'
      }).unref();
    `], { env: { ...process.env, NODE_OPTIONS: tracker.nodeOptions } });
    expect(parent.status, parent.stderr.toString()).toBe(0);
    await tracker.waitForExit();
    expect(fs.readFileSync(output, 'utf8')).toBe('finished');
  } finally {
    await tracker.waitForExit();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
