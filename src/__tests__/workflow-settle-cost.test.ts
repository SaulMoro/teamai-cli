import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, startRun } from '../workflow/engine.js';
import type { DriverIdentity } from '../workflow/types.js';

// Settling reads a step instance's scope from its path, so the number of paths parsed counts settle work without a clock.
const counter = vi.hoisted(() => ({ parsed: 0 }));
vi.mock('../workflow/step-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflow/step-path.js')>();
  return {
    ...actual,
    parseStepPath: (value: string) => {
      counter.parsed += 1;
      return actual.parseStepPath(value);
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const driver: DriverIdentity = { kind: 'local', machine: 'a', workspace: '/work' };

const FAN = `schemaVersion: v1alpha1
name: fan
description: An uncapped for_each over an inline workflow.
inputs:
  xs: [number]
steps:
  - id: build
    for_each: inputs.xs
    workflow:
      steps:
        - id: compile
          command: node compile.js
        - id: test
          needs: [compile]
          command: node test.js
  - id: after
    needs: [build]
    command: node after.js
`;

/** The paths parsed by the first `next` of a run over `items` items, which starts every item. */
async function firstNextWork(items: number): Promise<number> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-settle-cost-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'workflows', 'fan.yaml'), FAN);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project',
    additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data'),
  };
  await syncWorkflowDefinitions(config);
  const started = await startRun(config, 'fan', { xs: Array.from({ length: items }, (_, index) => index) });
  if ('error' in started) throw new Error(started.error.message);
  counter.parsed = 0;
  const next = await leaseNext(config, String(started.data.run), driver);
  expect(next).toMatchObject({ data: { lease: { step: 'build[0].compile' } } });
  return counter.parsed;
}

describe('settle cost', () => {
  it('starts every item of an uncapped for_each with work linear in the item count', async () => {
    const small = await firstNextWork(100);
    const large = await firstNextWork(200);
    expect(small).toBeGreaterThan(100);
    // Linear work doubles with the items; quadratic work grows about four times.
    expect(large / small).toBeLessThan(3);
  });
});
