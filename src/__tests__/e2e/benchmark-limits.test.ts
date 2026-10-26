/**
 * Real CLI: the limits a suite's `trial` sets on every trial's prompt, enforced by the local driver in a declared
 * sandbox. A limit ends the agent's turn, and the trial's check still decides it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, FIX_SUITE, said, type BenchmarkFixture, type FakeTool } from '../helpers/benchmark-fixture.js';

const DoneSchema = z.object({ run: z.string(), outcome: z.string(), end: z.string().optional() }).passthrough();
const TrialSchema = z.object({ order: z.number(), result: z.string(), limit: z.string().optional(), unenforced: z.array(z.string()).optional() }).passthrough();
const EndRecordSchema = z.object({ benchmark: z.object({ limits: z.record(z.number()).optional(), trials: z.array(TrialSchema) }).passthrough() }).passthrough();

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

/** The one-task fix suite, run `repetitions` times under the suite's `trial` value. */
function limitedSuite(trial: string, repetitions = 1): string {
  return FIX_SUITE.replace('repetitions: 1\n', `repetitions: ${repetitions}\ntrial: ${trial}\n`);
}

async function runLocally(tool: FakeTool, suite: string): Promise<{ fixture: BenchmarkFixture; done: z.infer<typeof DoneSchema>; record: z.infer<typeof EndRecordSchema>; stderr: string }> {
  const fixture = await benchmarkFixture({ tool, sandbox: true, suite });
  fixtures.push(fixture);
  const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);
  const done = DoneSchema.safeParse(envelope(started).data?.done);
  if (!done.success) throw new Error(said(started));
  return { fixture, done: done.data, record: EndRecordSchema.parse(fixture.endRecord(done.data.run)), stderr: started.stderr };
}

describe('trial limits on the local driver', () => {
  it('stops a tool that hangs at its trial timeout, checks what it left, and runs the next trial', async () => {
    const { fixture, done, record } = await runLocally('hangs', limitedSuite('{ timeout: 3s }', 2));

    expect(done).toMatchObject({ outcome: 'succeeded', end: 'settled' });
    expect(record.benchmark.limits).toEqual({ timeoutMs: 3000 });
    expect(record.benchmark.trials).toEqual([
      expect.objectContaining({ order: 1, result: 'failed', limit: 'timeout' }),
      expect.objectContaining({ order: 2, result: 'failed', limit: 'timeout' }),
    ]);
    expect(fixture.toolLaunches()).toHaveLength(2);
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);

  it('stops a tool that wrote the fix and hangs holding the git index lock, and its check passes what it left', async () => {
    const { done, record } = await runLocally('fixes-and-hangs', limitedSuite('{ timeout: 3s }'));

    expect(done).toMatchObject({ outcome: 'succeeded', end: 'settled' });
    expect(record.benchmark.trials).toEqual([expect.objectContaining({ result: 'passed', limit: 'timeout' })]);
  }, 120_000);

  it('ends the run at its timeout when that comes before the trial timeout, with no limit on the trial', async () => {
    const fixture = await benchmarkFixture({ tool: 'hangs', sandbox: true, suite: limitedSuite('{ timeout: 19900ms }').replace('timeout: 10m', 'timeout: 20s') });
    fixtures.push(fixture);

    const started = await fixture.teamai(['workflow', 'start', 'fix', '--benchmark', '--driver', 'local']);
    const done = DoneSchema.parse(envelope(started).data?.done);
    const record = EndRecordSchema.parse(fixture.endRecord(done.run));

    expect(started.code, said(started)).toBe(1);
    expect(done).toMatchObject({ outcome: 'failed', failure: { code: 'timeout' } });
    expect(record.benchmark.trials).toEqual([expect.objectContaining({ result: 'error' })]);
    expect(record.benchmark.trials[0]).not.toHaveProperty('limit');
  }, 120_000);
});
