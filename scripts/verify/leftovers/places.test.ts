import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LeftoverContext } from '../leftovers.js';
import type { World } from '../world.js';
import { places } from './places.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A closed attempt record of run r1, written where teamai keeps it, whose sandbox profile ran on `provider`. */
function closedRecord(provider: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'places-'));
  roots.push(root);
  const file = path.join(root, 'runs', 'r1', 'attempts', 'a1', 'runtime.json');
  const origin = { layer: 'personal', location: 'drivers/box.yaml', revision: 'r' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    runtime: 'sandbox', driver: 'box', phase: 'closed', open: { op: 'op-0123abcd', handle: 'h' },
    sources: [{ runtime: 'teamai-sandbox', ...origin, sandbox: { profile: 'mac', ...origin, location: 'sandboxes/mac.yaml', provider, enforces: {} } }],
  }));

  return file;
}

function contextOf(files: string[]): LeftoverContext {
  return { world: {} as World, self: { runId: 'w', paths: [], journals: [], runs: [] }, others: [], records: { files, runs: ['r1'], runtimeJournals: 0 } };
}

describe('open attempt places', () => {
  it("notes that a closed attempt ran on seatbelt, which no observer reads, and says nothing of another provider's", async () => {
    expect(await places.observe(contextOf([closedRecord('seatbelt')]))).toEqual([
      { kind: 'observed', findings: [], notes: ["run r1 attempt a1 ran on seatbelt, which no observer reads: the env check proves nothing for it"] },
    ]);
    expect(await places.observe(contextOf([closedRecord('docker')]))).toEqual([{ kind: 'observed', findings: [], notes: [] }]);
  });
});
