import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupPlan, type LeftoverContext } from '../leftovers.js';
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

const RUN = '20261112T120000-aaaaaa';

/** A world whose HOME and member bob's HOME are under `root`, and a T3 attempt record of run r1 in `home`, at `phase`. */
function openT3Record(root: string, home: string, phase: string): string {
  const file = path.join(home, '.teamai', 'runs', 'r1', 'attempts', 'a1', 'runtime.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, phase === 'garbled' ? '{' : JSON.stringify({ runtime: 't3', driver: 'teamai-t3', phase, open: { op: 'op-0123abcd', handle: 'thread-1' } }));

  return file;
}

function worldWithBob(): { root: string; context: (files: string[]) => LeftoverContext } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'places-'));
  roots.push(root);
  const world = { runId: RUN, home: path.join(root, 'home'), members: [{ name: 'bob', home: path.join(root, 'members', 'bob', 'home') }] } as World;

  return { root, context: (files) => ({ world, self: { runId: RUN, paths: [], journals: [], runs: [] }, others: [], records: { files, runs: ['r1'], runtimeJournals: 0 } }) };
}

describe('cleanup while an attempt place is still open', () => {
  it('refuses, naming the place and the command that closes it from the install whose record it is', async () => {
    const { root, context } = worldWithBob();
    const mine = openT3Record(root, path.join(root, 'home'), 'running');
    const bobs = openT3Record(root, path.join(root, 'members', 'bob', 'home'), 'running');

    expect(cleanupPlan([{ onCleanup: places.onCleanup, observed: await places.observe(context([mine, bobs])) }])).toEqual({
      kind: 'refuse',
      refusals: [{
        why: 'an attempt place of the world is still open, and its record, which cleanup would remove, is what closes it. Close each one as its line says, then run cleanup again',
        items: [
          `run r1 attempt a1's place on teamai-t3/t3 (thread-1), running: close it with \`npm run -s verify -- teamai ${RUN} workflow cancel r1\``,
          `run r1 attempt a1's place on teamai-t3/t3 (thread-1), running: close it with \`npm run -s verify -- teamai ${RUN}@bob workflow cancel r1\``,
        ],
      }],
    });
  });

  it('refuses while a record cannot be read, since its place may be open, as uninstall does', async () => {
    const { root, context } = worldWithBob();
    const file = openT3Record(root, path.join(root, 'home'), 'garbled');
    const plan = cleanupPlan([{ onCleanup: places.onCleanup, observed: await places.observe(context([file])) }]);

    expect(plan.kind).toBe('refuse');
    expect(JSON.stringify(plan)).toContain(`close what it can with \`npm run -s verify -- teamai ${RUN} workflow cancel r1\`, or fix that record`);
  });

  it('goes on once every place is closed', async () => {
    const { root, context } = worldWithBob();

    expect(cleanupPlan([{ onCleanup: places.onCleanup, observed: await places.observe(context([openT3Record(root, path.join(root, 'home'), 'closed')])) }]).kind).toBe('remove');
  });
});

describe('open attempt places', () => {
  it("notes that a closed attempt ran on seatbelt, which no observer reads, and says nothing of another provider's", async () => {
    expect(await places.observe(contextOf([closedRecord('seatbelt')]))).toEqual([
      { kind: 'observed', findings: [], notes: ["run r1 attempt a1 ran on seatbelt, which no observer reads: the env check proves nothing for it"] },
    ]);
    expect(await places.observe(contextOf([closedRecord('docker')]))).toEqual([{ kind: 'observed', findings: [], notes: [] }]);
  });
});
