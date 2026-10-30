/**
 * `teamai benchmark report`: a `finally` step of a benchmark run. It reads the run it is a step of, classifies the trials
 * of the plan the run measured, and writes the run's benchmark record: always into the run's directory, which the
 * dashboard reads, and into the pending delivery when the member's recording allows publication. The record is keyed
 * by run id and built from the run alone, so a report that runs again writes the same record at the same key.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RunOriginSchema } from '../default-workflows.js';
import { getCurrentVersion } from '../package-info.js';
import { publishPendingRecords, queueBenchmarkRecord } from '../workflow/records.js';
import { findAttemptRun } from '../workflow/run-location.js';
import { runsDir } from '../workflow/store.js';
import type { RunState, WorkflowFailure } from '../workflow/types.js';
import { runComparisons, type ArmComparison } from './history.js';
import { benchmarkRecord, BenchmarkRecordSchema } from './result.js';
import { planOfRun, type RunPlan } from './run-plan.js';
import { benchmarkTable, formatBenchmarkTable, type BenchmarkTable } from './table.js';
import { toolUnavailableNotice } from './trial.js';

/** A benchmark run's record: its plan's trials, classified, with the run they ran in. No prompt, command, URL or path. */
export const BenchmarkRunRecordSchema = BenchmarkRecordSchema.extend({
  schemaVersion: z.literal(1),
  run: z.string().min(1),
  /** How the run's steps ended, before its `finally` steps ran. */
  outcome: z.enum(['succeeded', 'failed', 'cancelled']),
  teamaiVersion: z.string().min(1),
  startedAt: z.string(),
  /** When the run's steps ended. */
  finishedAt: z.string(),
  username: z.string().optional(),
  /** The workflow the run ran: the team's `benchmark`, or teamai's default, by the hash of its bytes. */
  workflow: z.object({ name: z.string(), origin: RunOriginSchema, sourceHash: z.string() }),
});
export type BenchmarkRunRecord = z.infer<typeof BenchmarkRunRecordSchema>;

/** `runs/<run>/benchmark.json`: where a run's benchmark record is kept on this machine. */
export function benchmarkRecordFile(runsRoot: string, run: string): string {
  return path.join(runsRoot, run, 'benchmark.json');
}

/**
 * What `report` prints: the results as text, after a line for each arm whose tool the run's driver could not launch, and
 * ending with `record: pending` while the record waits; and as a table.
 */
export interface BenchmarkReport {
  text: string;
  table: BenchmarkTable & { pairs: ArmComparison[] };
}

/**
 * The report of the run whose attempt `env` marks: its record written, queued and, when it can be, published. Refused
 * when this process runs as no `finally` step of a benchmark run, or the run's plan is of an unknown schemaVersion.
 */
export async function reportBenchmark(env: NodeJS.ProcessEnv, secrets: Record<string, string>): Promise<{ report: BenchmarkReport } | { failure: WorkflowFailure }> {
  const found = await findAttemptRun(env);
  if ('error' in found) return { failure: found.error };
  const { config, run, step } = found;
  const finalizing = run.finalizing;
  if (!finalizing) {
    return { failure: { code: 'invalid_arguments', message: `Step "${step.id}" of run ${run.id} runs before the run's steps ended, so there is nothing to report yet. Run teamai benchmark report as a finally step.` } };
  }
  const planned = planOfRun(run);
  if ('failure' in planned) return planned;
  const record: BenchmarkRunRecord = {
    schemaVersion: 1,
    run: run.id,
    outcome: finalizing.outcome,
    teamaiVersion: getCurrentVersion(),
    startedAt: run.createdAt,
    finishedAt: finalizing.since,
    ...(config.username ? { username: config.username } : {}),
    workflow: { name: run.name, origin: run.origin ?? { source: 'team' }, sourceHash: run.sourceHash },
    ...benchmarkRecord(run, planned.found),
  };
  const file = benchmarkRecordFile(runsDir(config), run.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fs.rename(`${file}.tmp`, file);
  const queued = await queueBenchmarkRecord(config, record, secrets);
  const pending = queued && (await publishPendingRecords(config, { run: run.id }).catch(() => ({ state: 'pending' as const }))).state === 'pending';
  const table = benchmarkTable({ benchmark: record });
  const text = [...unlaunchedArms(run, planned.found), formatBenchmarkTable(table)].join('\n\n');
  return {
    report: {
      text: pending ? `${text}\n\nrecord: pending` : text,
      table: { ...table, pairs: runComparisons({ run: run.id, source: 'local', startedAt: run.createdAt, benchmark: record }) },
    },
  };
}

/** A line for each arm with a prompt that failed `tool_unavailable` before any lease: the driver could not launch its tool. */
function unlaunchedArms(run: RunState, { plan, prefix }: RunPlan): string[] {
  const unlaunched = (step: string): boolean => run.steps.some((state) => state.id === `${prefix}${step}` && state.status === 'failed' && state.failure?.code === 'tool_unavailable' && state.attempt === undefined);
  return plan.arms.filter((arm) => plan.trials.some((trial) => trial.arm === arm.name && unlaunched(trial.step))).map(toolUnavailableNotice);
}
