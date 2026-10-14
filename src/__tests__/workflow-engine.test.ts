import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, parseReport, reportAttempt, SETTLED_ATTEMPTS_LIMIT, startRun } from '../workflow/engine.js';
import { runLocalDriver } from '../workflow/local-driver.js';
import { outputMismatch } from '../workflow/output.js';
import { readRun, runLockPath, writeRun } from '../workflow/store.js';
import type { DriverIdentity } from '../workflow/types.js';

const dirs: string[] = [];

function testConfig(): { config: LocalConfig; work: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-engine-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  const work = path.join(root, 'work');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  return {
    work,
    config: {
      repo: { localPath: knowledge, remote: 'local', kind: 'self' },
      username: 'tester',
      scope: 'project',
      additionalRoles: [],
      projectRoot: root,
      dataHome: path.join(root, 'data'),
    },
  };
}

const driverA: DriverIdentity = { kind: 'local', machine: 'a', workspace: '/work' };
const driverB: DriverIdentity = { kind: 'external', machine: 'b', workspace: '/work' };

async function startBuild(body: string): Promise<{ config: LocalConfig; work: string; runId: string }> {
  const fixture = testConfig();
  fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), body);
  await syncWorkflowDefinitions(fixture.config);
  const started = await startRun(fixture.config, 'build');
  if ('error' in started) throw new Error(started.error.message);
  return { ...fixture, runId: String(started.data.run) };
}

const TWO_STEPS = `schemaVersion: v1alpha1
name: build
description: Two commands.
steps:
  - id: one
    command: node one.js
  - id: two
    needs: [one]
    command: node two.js
    output:
      ok: boolean
`;

/** Drives a run with next and report, failing the steps in `failing`. Returns the leased step ids and the done envelope. */
async function drive(config: LocalConfig, runId: string, failing: string[] = []): Promise<{ leased: string[]; done: unknown }> {
  const leased: string[] = [];
  for (;;) {
    const next = await leaseNext(config, runId, driverA);
    if ('error' in next) throw new Error(next.error.message);
    if (next.data.done) return { leased, done: next.data.done };
    const lease = next.data.lease as { step: string; attempt: string; revision: number };
    leased.push(lease.step);
    const reported = await reportAttempt(config, runId, {
      attempt: lease.attempt,
      revision: lease.revision,
      outcome: failing.includes(lease.step) ? 'failed' : 'success',
      driver: driverA,
    });
    if ('error' in reported) throw new Error(reported.error.message);
  }
}

function graph(steps: string, header = ''): string {
  return `schemaVersion: v1alpha1
name: build
description: A needs graph.
${header}steps:
${steps}`;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow engine', () => {
  it('parses and stores tool report metadata', async () => {
    const parsed = parseReport({
      attempt: 'a00000000',
      revision: 1,
      outcome: 'success',
      driver: driverA,
      tool: 'claude',
      model: 'sonnet',
      session: 'session-1',
      tokens: { input: 2, output: 1, cachedInput: 1 },
      failure: { code: 'tool_failed', message: 'failed' },
    });
    expect(parsed).toMatchObject({ tool: 'claude', model: 'sonnet', session: 'session-1', tokens: { input: 2 } });
    expect(parseReport({
      attempt: 'a00000000',
      revision: 1,
      outcome: 'success',
      driver: driverA,
      tokens: { input: Number.NaN },
    })).toBe('tokens.input must be a finite number');
  });

  it('leases steps in order and stores the outcome', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const first = await leaseNext(config, runId, driverA);
    expect(first).toMatchObject({ data: { lease: { step: 'one', revision: 1 } } });
    if ('error' in first) return;
    const attempt = String((first.data.lease as { attempt: string }).attempt);
    const accepted = await reportAttempt(config, runId, {
      attempt, revision: 1, outcome: 'success', driver: driverA, exitCode: 0,
    });
    expect(accepted).toMatchObject({ data: { accepted: true, revision: 2, step: { status: 'succeeded' } } });

    const second = await leaseNext(config, runId, driverA);
    if ('error' in second) throw new Error(second.error.message);
    const nextAttempt = String((second.data.lease as { attempt: string }).attempt);
    await reportAttempt(config, runId, {
      attempt: nextAttempt,
      revision: 2,
      outcome: 'success',
      driver: driverA,
      outputs: { ok: true },
    });
    const done = await leaseNext(config, runId, driverA);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({ status: 'succeeded', steps: [{ outcome: 'success' }, { outcome: 'success', outputs: { ok: true } }] });
  });

  it('returns a released step to pending without ending the run', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const leased = await leaseNext(config, runId, driverA);
    if ('error' in leased) throw new Error(leased.error.message);
    const attempt = String((leased.data.lease as { attempt: string }).attempt);
    const released = await reportAttempt(config, runId, { attempt, revision: 1, outcome: 'released', driver: driverA });
    expect(released).toMatchObject({ data: { accepted: true, step: { status: 'pending', outcome: 'released' } } });
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({ status: 'running', revision: 2, steps: [{ status: 'pending', outcome: 'released' }, { status: 'pending' }] });

    const again = await leaseNext(config, runId, driverA);
    expect(again).toMatchObject({ data: { lease: { step: 'one', revision: 2 } } });
    if ('error' in again) return;
    expect((again.data.lease as { attempt: string }).attempt).not.toBe(attempt);
  });

  it('skips the steps after a failed step and fails the run', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const leased = await leaseNext(config, runId, driverA);
    if ('error' in leased) throw new Error(leased.error.message);
    await reportAttempt(config, runId, {
      attempt: String((leased.data.lease as { attempt: string }).attempt),
      revision: 1,
      outcome: 'failed',
      driver: driverA,
      exitCode: 2,
    });
    const done = await leaseNext(config, runId, driverA);
    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({ status: 'failed', steps: [{ status: 'failed' }, { status: 'skipped' }] });
  });

  it('stamps updatedAt when next settles the run after a failed report', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const failing = await startBuild(TWO_STEPS);
      const leased = await leaseNext(failing.config, failing.runId, driverA);
      if ('error' in leased) throw new Error(leased.error.message);
      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
      await reportAttempt(failing.config, failing.runId, {
        attempt: String((leased.data.lease as { attempt: string }).attempt),
        revision: 1,
        outcome: 'failed',
        driver: driverA,
      });
      expect(await readRun(failing.config, failing.runId)).toMatchObject({ status: 'running' });
      vi.setSystemTime(new Date('2026-01-01T00:01:30.000Z'));
      await leaseNext(failing.config, failing.runId, driverA);
      expect(await readRun(failing.config, failing.runId)).toMatchObject({
        status: 'failed',
        updatedAt: '2026-01-01T00:01:30.000Z',
      });

      const finishing = await startBuild(TWO_STEPS);
      const stored = await readRun(finishing.config, finishing.runId);
      if (typeof stored !== 'object') throw new Error('run missing');
      stored.steps = stored.steps.map((step) => ({ ...step, status: 'succeeded', outcome: 'success' }));
      await writeRun(finishing.config, stored);
      vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'));
      await leaseNext(finishing.config, finishing.runId, driverA);
      expect(await readRun(finishing.config, finishing.runId)).toMatchObject({
        status: 'succeeded',
        updatedAt: '2026-01-01T00:02:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects stale, repeated, wrong-attempt, and wrong-driver reports', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const leased = await leaseNext(config, runId, driverA);
    if ('error' in leased) throw new Error(leased.error.message);
    const attempt = String((leased.data.lease as { attempt: string }).attempt);

    expect(await reportAttempt(config, runId, { attempt: 'a00000000', revision: 1, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'wrong_attempt' } });
    expect(await reportAttempt(config, runId, { attempt, revision: 1, outcome: 'success', driver: driverB }))
      .toMatchObject({ error: { code: 'wrong_driver' } });

    await reportAttempt(config, runId, { attempt, revision: 1, outcome: 'success', driver: driverA });
    expect(await reportAttempt(config, runId, { attempt, revision: 1, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'repeated_report' } });
    expect(await reportAttempt(config, runId, { attempt, revision: 2, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'repeated_report' } });
    expect(await reportAttempt(config, runId, { attempt: 'a00000001', revision: 1, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'stale_revision' } });
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({ revision: 2, steps: [{ status: 'succeeded' }, { status: 'pending' }] });
  });

  it('accepts extra keys on a shorthand object output', async () => {
    expect(outputMismatch(
      { type: 'object', fields: { ok: { type: 'boolean' }, nested: { type: 'object', fields: { n: { type: 'number' } } } } },
      { ok: true, extra: 'kept', nested: { n: 1, more: true } },
    )).toBeNull();
    expect(outputMismatch({ type: 'object', fields: { ok: { type: 'boolean' } } }, { extra: true }))
      .toBe('output.ok is missing');

    const { config, runId } = await startBuild(TWO_STEPS);
    const leased = await leaseNext(config, runId, driverA);
    if ('error' in leased) throw new Error(leased.error.message);
    await reportAttempt(config, runId, {
      attempt: String((leased.data.lease as { attempt: string }).attempt),
      revision: 1,
      outcome: 'success',
      driver: driverA,
    });
    const second = await leaseNext(config, runId, driverA);
    if ('error' in second) throw new Error(second.error.message);
    const accepted = await reportAttempt(config, runId, {
      attempt: String((second.data.lease as { attempt: string }).attempt),
      revision: 2,
      outcome: 'success',
      driver: driverA,
      outputs: { ok: true, note: 'extra' },
    });
    expect(accepted).toMatchObject({ data: { accepted: true, step: { status: 'succeeded', outcome: 'success' } } });
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({ steps: [{ status: 'succeeded' }, { outputs: { ok: true, note: 'extra' } }] });
  });

  it('settles a running run with no pending steps from the step statuses', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    stored.steps = [
      { id: 'one', status: 'failed', outcome: 'failed' },
      { id: 'two', status: 'succeeded', outcome: 'success' },
    ];
    await writeRun(config, stored);

    const done = await leaseNext(config, runId, driverA);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({ status: 'failed' });
  });

  it('keeps settledAttempts bounded across a release loop', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const attempts: string[] = [];
    for (let i = 0; i < SETTLED_ATTEMPTS_LIMIT + 5; i += 1) {
      const leased = await leaseNext(config, runId, driverA);
      if ('error' in leased) throw new Error(leased.error.message);
      const lease = leased.data.lease as { attempt: string; revision: number };
      attempts.push(lease.attempt);
      const released = await reportAttempt(config, runId, {
        attempt: lease.attempt,
        revision: lease.revision,
        outcome: 'released',
        driver: driverA,
      });
      expect(released).toMatchObject({ data: { accepted: true } });
    }

    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    expect(stored.settledAttempts).toHaveLength(SETTLED_ATTEMPTS_LIMIT);
    expect(stored.settledAttempts).not.toContain(attempts[0]);
    expect(stored.settledAttempts).toContain(attempts.at(-1));
    expect(stored.status).toBe('running');

    const latest = attempts.at(-1) ?? '';
    expect(await reportAttempt(config, runId, { attempt: latest, revision: 1, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'repeated_report' } });
    expect(await reportAttempt(config, runId, { attempt: latest, revision: stored.revision, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'repeated_report' } });
    expect(await reportAttempt(config, runId, { attempt: attempts[0] ?? '', revision: 1, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'stale_revision' } });
    expect(await reportAttempt(config, runId, { attempt: attempts[0] ?? '', revision: stored.revision, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'wrong_attempt' } });

    const after = await readRun(config, runId);
    expect(after).toMatchObject({
      status: 'running',
      revision: stored.revision,
      settledAttempts: stored.settledAttempts,
    });
  });

  it('keeps the lease on disk after next returns', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const leased = await leaseNext(config, runId, driverA);
    if ('error' in leased) throw new Error(leased.error.message);
    const attempt = String((leased.data.lease as { attempt: string }).attempt);
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({
      steps: [
        { status: 'leased', lease: { attempt, revision: 1, driver: driverA } },
        { status: 'pending' },
      ],
    });
    const accepted = await reportAttempt(config, runId, { attempt, revision: 1, outcome: 'success', driver: driverA });
    expect(accepted).toMatchObject({ data: { accepted: true } });
  });

  it('does not lease a step while another process holds the run lock', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const lock = runLockPath(config, runId);
    expect(await acquireLock(lock)).toBe(true);
    try {
      const blocked = await leaseNext(config, runId, driverA);
      expect(blocked).toMatchObject({ error: { code: 'busy' } });
    } finally {
      await releaseLock(lock);
    }
    const leased = await leaseNext(config, runId, driverA);
    expect(leased).toMatchObject({ data: { lease: { step: 'one' } } });
  });

  it('does not let two concurrent callers lease the same step', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const [left, right] = await Promise.all([
      leaseNext(config, runId, driverA),
      leaseNext(config, runId, driverB),
    ]);
    const leases = [left, right].filter((result) => 'data' in result && 'lease' in result.data);
    const waits = [left, right].filter((result) => 'data' in result && 'wait' in result.data);
    expect(leases).toHaveLength(1);
    expect(waits).toHaveLength(1);
    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    expect(stored.steps.filter((step) => step.status === 'leased')).toHaveLength(1);
    expect(new Set(stored.steps.map((step) => step.lease?.attempt).filter(Boolean)).size).toBe(1);
  });

  it('runs one command at a time through the same next and report operations', async () => {
    const { config, work, runId } = await startBuild(TWO_STEPS);
    fs.writeFileSync(path.join(work, 'one.js'), "require('fs').writeFileSync('step-one.txt', '1')\n");
    fs.writeFileSync(path.join(work, 'two.js'), [
      "const fs = require('fs')",
      "if (fs.readFileSync('step-one.txt', 'utf8') !== '1') process.exit(1)",
      "fs.writeFileSync('step-two.txt', '2')",
      "process.stdout.write(JSON.stringify({ ok: true }))",
      '',
    ].join('\n'));

    const done = await runLocalDriver(config, runId, work);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', run: runId } } });
    expect(fs.readFileSync(path.join(work, 'step-two.txt'), 'utf8')).toBe('2');
  });

  // #1083: run records publish at start and end; a publication failure is
  // queued durably and surfaced as `record: pending`, never failing the run.
  it('surfaces record publication state on start and done envelopes', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    // The fixture has no reports remote, so publication cannot succeed —
    // the run must still start, and the record must be queued for the next
    // pull.
    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    const { pendingRecords } = await import('../workflow/records.js');
    const queued = await pendingRecords(config);
    expect(queued).toHaveLength(1);
    expect(queued[0].phase).toBe('start');
    expect(queued[0].run).toBe(runId);
    // A machine that dies after start stays visible as started-but-not-ended:
    // the queued record has no endedAt and status running.
    expect(queued[0].status).toBe('running');
    expect(queued[0]).not.toHaveProperty('endedAt');
    // The driver workspace never crosses into the record.
    expect(JSON.stringify(queued)).not.toContain('/work');
  });

  it('queues an end record on the next that settles a run after a failed report (#1126 P1)', async () => {
    const failing = `schemaVersion: v1alpha1
name: build
description: One command.
steps:
  - id: one
    command: node one.js
`;
    const { config, runId } = await startBuild(failing);
    const { pendingRecords } = await import('../workflow/records.js');
    const leased = await leaseNext(config, runId, driverA);
    if ('error' in leased) throw new Error(leased.error.message);
    const lease = leased.data.lease as { attempt: string; revision: number };
    await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'failed', driver: driverA });
    // A failed report does not settle the run; the next `next` does.
    expect((await pendingRecords(config)).find((record) => record.phase === 'end')).toBeUndefined();

    const done = await leaseNext(config, runId, driverA);
    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const end = (await pendingRecords(config)).find((record) => record.phase === 'end');
    expect(end).toBeDefined();
    expect(end!.status).toBe('failed');
    expect(end!.stepCounts).toEqual({ total: 1, succeeded: 0, failed: 1 });
  });

  it('queues an end record when the run settles', async () => {
    const { config, work, runId } = await startBuild(TWO_STEPS);
    fs.writeFileSync(path.join(work, 'one.js'), "process.stdout.write(JSON.stringify({ ok: true }))\n");
    fs.writeFileSync(path.join(work, 'two.js'), "process.stdout.write(JSON.stringify({ ok: true }))\n");
    const done = await runLocalDriver(config, runId, work);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const { pendingRecords } = await import('../workflow/records.js');
    const queued = await pendingRecords(config);
    const end = queued.find((record) => record.phase === 'end');
    expect(end).toBeDefined();
    expect(end!.status).toBe('succeeded');
    expect(end!.stepCounts).toEqual({ total: 2, succeeded: 2, failed: 0 });
  });

  it('skips a step whose dependency failed and still runs an independent branch', async () => {
    const { config, runId } = await startBuild(graph(`  - id: build
    command: node build.js
  - id: test
    needs: [build]
    command: node test.js
  - id: docs
    needs: []
    command: node docs.js
`));

    const { leased, done } = await drive(config, runId, ['build']);

    expect(leased).toEqual(['build', 'docs']);
    expect(done).toMatchObject({ outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({
      status: 'failed',
      steps: [{ id: 'build', status: 'failed' }, { id: 'test', status: 'skipped' }, { id: 'docs', status: 'succeeded' }],
    });
  });

  it.each([
    ['linear', `  - id: a
    command: node a.js
  - id: b
    needs: [a]
    command: node b.js
  - id: c
    needs: [b]
    command: node c.js
`, ['a', 'b', 'c']],
    ['diamond', `  - id: a
    command: node a.js
  - id: d
    needs: [b, c]
    command: node d.js
  - id: c
    needs: [a]
    command: node c.js
  - id: b
    needs: [a]
    command: node b.js
`, ['a', 'c', 'b', 'd']],
    ['join of two roots', `  - id: a
    command: node a.js
  - id: join
    needs: [a, b]
    command: node join.js
  - id: b
    needs: []
    command: node b.js
`, ['a', 'b', 'join']],
  ])('settles a %s graph in declaration order of ready steps', async (_shape, steps, order) => {
    const { config, runId } = await startBuild(graph(steps));

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(order);
    expect(done).toMatchObject({ outcome: 'succeeded' });
  });

  it('skips a join only when every step it needs was skipped', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    command: node check.js
  - id: fix
    needs: [check]
    command: node fix.js
  - id: docs
    needs: []
    command: node docs.js
  - id: some-skipped
    needs: [fix, docs]
    command: node some.js
  - id: all-skipped
    needs: [fix]
    command: node all.js
`));

    const { leased, done } = await drive(config, runId, ['check']);

    expect(leased).toEqual(['check', 'docs', 'some-skipped']);
    expect(done).toMatchObject({ outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [
        { id: 'check', status: 'failed' },
        { id: 'fix', status: 'skipped' },
        { id: 'docs', status: 'succeeded' },
        { id: 'some-skipped', status: 'succeeded' },
        { id: 'all-skipped', status: 'skipped' },
      ],
    });
  });

  it('accepts the report for a lease handed out after skipping steps', async () => {
    const { config, runId } = await startBuild(graph(`  - id: build
    command: node build.js
  - id: test
    needs: [build]
    command: node test.js
  - id: docs
    needs: []
    command: node docs.js
`));
    const first = await leaseNext(config, runId, driverA);
    if ('error' in first) throw new Error(first.error.message);
    const lease = first.data.lease as { attempt: string; revision: number };
    await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'failed', driver: driverA });

    const docs = await leaseNext(config, runId, driverA);
    expect(docs).toMatchObject({ data: { lease: { step: 'docs', revision: 2 } } });
    if ('error' in docs) return;
    const docsLease = docs.data.lease as { attempt: string; revision: number };
    expect(await readRun(config, runId)).toMatchObject({ revision: 2, steps: [{ status: 'failed' }, { status: 'skipped' }, { status: 'leased' }] });

    const accepted = await reportAttempt(config, runId, {
      attempt: docsLease.attempt, revision: docsLease.revision, outcome: 'success', driver: driverA,
    });
    expect(accepted).toMatchObject({ data: { accepted: true, revision: 3, step: { id: 'docs', status: 'succeeded' } } });
  });

  it('settles an end-only step without a lease and skips what is left', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    command: node check.js
  - id: drop
    needs: [check]
    end: dropped
  - id: build
    needs: [check]
    command: node build.js
`, 'ends:\n  dropped: succeeded\n'));

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(['check']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded', end: 'dropped' });
    expect(await readRun(config, runId)).toMatchObject({
      status: 'succeeded',
      revision: 2,
      steps: [{ id: 'check', status: 'succeeded' }, { id: 'drop', status: 'succeeded' }, { id: 'build', status: 'skipped' }],
    });
  });

  it.each([
    ['a failed end fails the run', 'ends:\n  stuck: failed\n', `  - id: triage
    command: node triage.js
    end: stuck
  - id: build
    needs: []
    command: node build.js
`, [], ['triage'], { outcome: 'failed', end: 'stuck' }],
    ['a succeeded end succeeds the run after another step failed', 'ends:\n  recovered: succeeded\n', `  - id: docs
    command: node docs.js
  - id: check
    needs: []
    command: node check.js
    end: recovered
  - id: later
    needs: [check]
    command: node later.js
`, ['docs'], ['docs', 'check'], { outcome: 'succeeded', end: 'recovered' }],
    ['a step with end that fails reaches no end', 'ends:\n  shipped: succeeded\n', `  - id: ship
    command: node ship.js
    end: shipped
  - id: docs
    needs: []
    command: node docs.js
`, ['ship'], ['ship', 'docs'], { outcome: 'failed' }],
  ])('%s', async (_name, header, steps, failing, order, expected) => {
    const { config, runId } = await startBuild(graph(steps, header));

    const { leased, done } = await drive(config, runId, failing);

    expect(leased).toEqual(order);
    expect(done).toEqual({ run: runId, record: 'pending', ...expected });
    expect(await leaseNext(config, runId, driverA)).toEqual({ data: { done: { run: runId, record: 'pending', ...expected } } });
  });

  it('reaches a ready end before it leases a step declared earlier', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    command: node check.js
  - id: docs
    needs: []
    command: node docs.js
  - id: drop
    needs: [check]
    end: dropped
`, 'ends:\n  dropped: succeeded\n'));

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(['check']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded', end: 'dropped' });
  });
  it('runs a recovery step that reads a failed check, and the run still fails', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    command: node check.js
  - id: label
    needs: [check]
    if: steps.check.outcome == 'failed'
    command: node label.js
  - id: ship
    needs: [check]
    command: node ship.js
`));

    const { leased, done } = await drive(config, runId, ['check']);

    expect(leased).toEqual(['check', 'label']);
    expect(done).toMatchObject({ outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ id: 'check', status: 'failed' }, { id: 'label', status: 'succeeded' }, { id: 'ship', status: 'skipped' }],
    });
  });

  it('skips a step whose if reads only one of two stopped dependencies', async () => {
    const { config, runId } = await startBuild(graph(`  - id: lint
    command: node lint.js
  - id: test
    needs: []
    command: node test.js
  - id: report
    needs: [lint, test]
    if: steps.lint.outcome == 'failed'
    command: node report.js
  - id: both
    needs: [lint, test]
    if: steps.lint.outcome == 'failed' || steps.test.outcome == 'failed'
    command: node both.js
`));

    const { leased, done } = await drive(config, runId, ['lint', 'test']);

    expect(leased).toEqual(['lint', 'test', 'both']);
    expect(done).toMatchObject({ outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{}, {}, { id: 'report', status: 'skipped' }, { id: 'both', status: 'succeeded' }] });
  });

  it('runs the branch whose if is true and skips the other without failing the run', async () => {
    const { config, runId } = await startBuild(graph(`  - id: review
    command: node review.js
    output:
      verdict: pass | fix
  - id: fix
    needs: [review]
    if: steps.review.outputs.verdict == 'fix'
    command: node fix.js
  - id: merge
    needs: [review]
    if: steps.review.outputs.verdict == 'pass'
    command: node merge.js
  - id: after-merge
    needs: [merge]
    command: node after.js
`));
    const first = await leaseNext(config, runId, driverA);
    if ('error' in first) throw new Error(first.error.message);
    const lease = first.data.lease as { attempt: string; revision: number };
    await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', outputs: { verdict: 'fix' }, driver: driverA });

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(['fix']);
    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(await readRun(config, runId)).toMatchObject({
      revision: 3,
      steps: [{}, { id: 'fix', status: 'succeeded' }, { id: 'merge', status: 'skipped' }, { id: 'after-merge', status: 'skipped' }],
    });
  });

  it('evaluates an if only after every step it reads has settled', async () => {
    // gate is skipped as soon as build fails, while late is still pending; deploy reads late through gate.
    const { config, runId } = await startBuild(graph(`  - id: build
    command: node build.js
  - id: docs
    needs: []
    command: node docs.js
  - id: gate
    needs: [build, late]
    command: node gate.js
  - id: deploy
    needs: [gate, docs]
    if: steps.late.outcome == 'success'
    command: node deploy.js
  - id: late
    needs: []
    command: node late.js
`));

    const { leased } = await drive(config, runId, ['build']);

    expect(leased).toEqual(['build', 'docs', 'late', 'deploy']);
  });

  it.each([
    ['fails', ['check'], ['check'], { outcome: 'succeeded', end: 'handled' }],
    ['succeeds', [], ['check', 'ship'], { outcome: 'succeeded' }],
  ])('settles a recovery end-only step only when the check it reads %s', async (_case, failing, order, done) => {
    const { config, runId } = await startBuild(graph(`  - id: check
    command: node check.js
  - id: handle
    needs: [check]
    if: steps.check.outcome == 'failed'
    end: handled
  - id: ship
    needs: [check]
    command: node ship.js
`, 'ends:\n  handled: succeeded\n'));

    const result = await drive(config, runId, failing);

    expect(result.leased).toEqual(order);
    expect(result.done).toEqual({ run: runId, record: 'pending', ...done });
  });

  it('reports a run whose stored if does not parse instead of guessing', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    command: node check.js
  - id: label
    needs: [check]
    if: steps.check.outcome == 'failed'
    command: node label.js
`));
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    run.definition.steps[1]!.if = 'steps.check.outcome = 1';
    await writeRun(config, run);

    expect(await leaseNext(config, runId, driverA)).toMatchObject({
      error: { code: 'run_unreadable', message: expect.stringContaining('step "label" has an if that does not parse') },
    });
  });
});
