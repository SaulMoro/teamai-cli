import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards helpers/isolate-e2e-env.ts: a skill runner a test leaves working in
// this file's own temporary directory fails that test (teardown-writers.ts),
// which holds only when no other file shares the directory.
describe('E2E temporary directory isolation', () => {
  it('runs each test file with a temporary directory of its own, not the one the worker started with', () => {
    // teardown-writers.ts makes its tracker in the worker's first temporary directory, before any isolation.
    const workerTmp = path.dirname(process.env.TEAMAI_TEST_DETACHED_ROOT ?? '');

    expect(os.tmpdir()).not.toBe(workerTmp);
    expect(fs.statSync(os.tmpdir()).isDirectory()).toBe(true);
    expect(process.env.TMP).toBe(os.tmpdir());
    expect(process.env.TEMP).toBe(os.tmpdir());
  });
});
