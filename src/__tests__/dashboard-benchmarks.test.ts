import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The team's reports checkout is refreshed from origin before it is read; these fixtures have no origin.
vi.mock('../utils/reports-branch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/reports-branch.js')>();
  const { getReportsDir } = await import('../types.js');
  return { ...actual, readableReportsWorktree: async (config: Parameters<typeof getReportsDir>[0]) => getReportsDir(config) };
});

import { benchmarkHistory, parseBenchmarkQuery } from '../dashboard/benchmarks.js';
import { HttpError } from '../dashboard/http.js';
import { getReportsDir, type LocalConfig } from '../types.js';
import { cancelRun } from '../workflow/run-controls.js';
import { benchmarkRunConfig, FIX_SUITE, fixTask, startBenchmarkRun } from './helpers/benchmark-fixture.js';

// A run this machine starts is dated by the clock, so the window ends just after it.
const NOW = new Date(Date.now() + 60_000);
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
let root = '';
let config: LocalConfig;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dashboard-benchmarks-')));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  config = benchmarkRunConfig(root);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function recordFile(run: string): string {
  return path.join(getReportsDir(config), 'workflows', 'runs', `${run}.json`);
}

/** A record the team published for a run of suite `fix` by `username`, whose one trial on arm claude got `result`. */
function publish(run: string, { username = 'bob', startedAt = YESTERDAY, result = 'passed', benchmark = true } = {}): void {
  fs.mkdirSync(path.dirname(recordFile(run)), { recursive: true });
  fs.writeFileSync(recordFile(run), JSON.stringify({
    schemaVersion: 'v1alpha1', run, workflow: 'fix', sourceHash: 'f'.repeat(64), phase: 'end', status: 'succeeded', startedAt, username,
    ...(benchmark ? {
      benchmark: {
        suite: { name: 'fix', sourceHash: 's1' }, repetitions: 1, baselineTeamRevision: 'b'.repeat(40), scorers: [],
        tasks: [{ id: 'fix', startingCommit: 'a'.repeat(40), sourceHash: 't1', baseline: 'valid' }],
        arms: [{ name: 'claude', tool: 'claude', source: 'team', teamRevision: 'b'.repeat(40) }],
        trials: [{ task: 'fix', arm: 'claude', repetition: 1, order: 0, step: 'trials.r1.fix.claude.prompt', result }],
      },
    } : {}),
  }));
}

/** A benchmark run this machine started and cancelled, so it ended with its one trial not run. */
async function endedLocalRun(): Promise<string> {
  const started = await startBenchmarkRun(config, { name: 'fix', suite: FIX_SUITE, tasks: { fix: fixTask('{{startingCommit}}') } });
  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  await cancelRun(config, runId, {});
  return runId;
}

describe('benchmarkHistory', () => {
  it("reads this machine's ended benchmark runs and the team's benchmark records, this machine's copy of a run first", async () => {
    const local = await endedLocalRun();
    publish(local, { username: 'tester', result: 'passed' });
    publish('r-bob', { username: 'bob' });
    publish('r-review', { benchmark: false });
    fs.writeFileSync(recordFile('r-broken'), '{"benchmark": ');

    const view = await benchmarkHistory({ config, query: { windowDays: 365 }, now: NOW, refresh: false });

    expect(view.suites.map(({ suite, runs }) => ({ suite, runs }))).toEqual([{ suite: 'fix', runs: 2 }]);
    expect(view.selected?.runs.map(({ run, source, username, passed, planned }) => ({ run, source, username, passed, planned }))).toEqual([
      { run: local, source: 'local', username: 'tester', passed: 0, planned: 1 },
      { run: 'r-bob', source: 'reported', username: 'bob', passed: 1, planned: 1 },
    ]);
  });

  it('reads a record again once it changed on disk', async () => {
    publish('r-bob', { result: 'failed' });
    expect((await benchmarkHistory({ config, query: { windowDays: 365 }, now: NOW, refresh: false })).selected?.runs[0]).toMatchObject({ passed: 0 });

    publish('r-bob', { result: 'passed' });
    fs.utimesSync(recordFile('r-bob'), new Date(), new Date(Date.now() + 5000));

    expect((await benchmarkHistory({ config, query: { windowDays: 365 }, now: NOW, refresh: false })).selected?.runs[0]).toMatchObject({ passed: 1 });
    fs.rmSync(recordFile('r-bob'));
    expect((await benchmarkHistory({ config, query: { windowDays: 365 }, now: NOW, refresh: false })).suites).toEqual([]);
  });
});

describe('parseBenchmarkQuery', () => {
  it('takes a window the page offers and a suite name, and 90 days by default', () => {
    expect(parseBenchmarkQuery(new URLSearchParams('suite=fix-auth&window=30'))).toEqual({ windowDays: 30, suite: 'fix-auth' });
    expect(parseBenchmarkQuery(new URLSearchParams(''))).toEqual({ windowDays: 90 });
    expect(() => parseBenchmarkQuery(new URLSearchParams('window=7'))).toThrow(HttpError);
  });
});
