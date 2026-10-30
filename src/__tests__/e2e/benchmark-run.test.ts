/**
 * Real CLI: `teamai benchmark run` starts the workflow `benchmark`, teamai's default or the team's file of that name,
 * which plans the suite, runs its trials in fresh clones from the plan, and reports them in a finally step.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

const DoneSchema = z.object({ run: z.string(), outcome: z.string(), outputs: z.object({ text: z.string(), table: z.unknown() }) }).passthrough();
const RecordSchema = z.object({ run: z.string(), outcome: z.string(), workflow: z.object({ name: z.string(), origin: z.object({ source: z.string() }) }).passthrough(), trials: z.array(z.unknown()) }).passthrough();

describe('teamai benchmark run', () => {
  it('runs the shipped benchmark workflow: plan, trials from the plan, and a report with the record', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true });
    fixtures.push(fixture);

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
    const done = DoneSchema.parse(envelope(ran).data?.done);
    const kept = RecordSchema.parse(fixture.benchmarkRecord(done.run));

    expect(ran.code, said(ran)).toBe(0);
    expect(done.outcome).toBe('succeeded');
    expect(done.outputs.text).toContain('100% (1/1)');
    expect(ran.stderr).toContain(done.outputs.text);
    expect(kept).toMatchObject({
      run: done.run, outcome: 'succeeded', workflow: { name: 'benchmark', origin: { source: 'default' } },
      trials: [{ task: 'fix', arm: 'claude', step: 'trials.r1.fix.claude.prompt', result: 'passed' }],
    });
    expect(fixture.reportedBenchmark(done.run)).toEqual(fixture.benchmarkRecord(done.run));
  }, 180_000);
});
