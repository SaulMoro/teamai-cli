/**
 * A driver that knows only the CLI JSON protocol and the trial contract: it asks `workflow next --prepare`, launches the
 * lease's tool in the lease's cwd with the lease's model and effort, without the names the lease withholds, and reports tool, model, session, tokens,
 * durationMs, and cost when the tool stated one. It stops a tool at the lease's `trial.limits` timeout and reports `limit: timeout`, and lists the
 * budget and max_turns it does not enforce as unenforced. It runs no git, setup, check or cleanup, never runs teamai in a lease's cwd, and imports
 * no other driver: only the lease schema a TypeScript driver parses at its boundary.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PreparedTrialLeaseSchema } from '../../benchmark/terms.js';

const run = promisify(execFile);

const HeldSchema = z.array(z.object({ step: z.string(), missing: z.array(z.string()) }));
const NextAnswerSchema = z.object({
  data: z.union([
    z.object({ lease: PreparedTrialLeaseSchema }),
    z.object({ wait: z.object({ held: HeldSchema.optional() }) }),
    z.object({ done: z.object({ outcome: z.string(), failure: z.object({ code: z.string() }).optional(), benchmark: z.object({ text: z.string() }).optional() }) }),
  ]),
});
const ReportAnswerSchema = z.object({ data: z.object({ accepted: z.literal(true) }) });
/** What execFile rejects with once its `timeout` killed the tool. */
const TimedOutSchema = z.object({ killed: z.literal(true) });
const StreamLineSchema = z.object({
  model: z.string().optional(), session_id: z.string().optional(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(), total_cost_usd: z.number().optional(),
});

export interface DriveResult {
  /** Each step this driver was leased, in order. */
  leased: string[];
  /** What the last `wait` held. */
  held: z.infer<typeof HeldSchema>;
  done?: { outcome: string; failure?: { code: string }; text?: string };
}

/** A driver the trial contract runs. Another driver joins the contract as one more entry with its own `drive`. */
export interface DriverUnderTest {
  drive(input: { runId: string; can: Record<string, unknown>; prepare: boolean; maxPolls: number }): Promise<DriveResult>;
}

export interface FakeTrialDriverOptions {
  /** The built CLI, run from the member's checkout. */
  teamai: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** The executable of each tool it launches, by tool name. */
  tools: Record<string, string>;
  /** The environment it launches a tool with, before it removes what the lease withholds. */
  env: NodeJS.ProcessEnv;
  pauseMs: number;
}

const identity = { kind: 'external', machine: 'fake-trial-driver', workspace: '/fake' };

/** The model and session a tool printed, from the first stream line that names each, and the tokens and cost it stated last. */
function sessionOf(stdout: string): { model?: string; session?: string; tokens?: { input: number; output: number }; cost?: { amount: number; unit: string } } {
  const lines = stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => StreamLineSchema.safeParse(JSON.parse(line)));
  const model = lines.find((line) => line.success && line.data.model)?.data?.model;
  const session = lines.find((line) => line.success && line.data.session_id)?.data?.session_id;
  const usage = lines.findLast((line) => line.success && line.data.usage !== undefined)?.data?.usage;
  const cost = lines.findLast((line) => line.success && line.data.total_cost_usd !== undefined)?.data?.total_cost_usd;
  return {
    ...(model ? { model } : {}), ...(session ? { session } : {}),
    ...(usage ? { tokens: { input: usage.input_tokens, output: usage.output_tokens } } : {}),
    ...(cost !== undefined ? { cost: { amount: cost, unit: 'USD' } } : {}),
  };
}

function lastJson(stdout: string, stderr: string): unknown {
  const line = stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
  if (!line) throw new Error(`no JSON envelope:\n${stdout}\n${stderr}`);
  return JSON.parse(line);
}

export function fakeTrialDriver(options: FakeTrialDriverOptions): DriverUnderTest {
  return {
    async drive({ runId, can, prepare, maxPolls }) {
      const leased: string[] = [];
      let held: DriveResult['held'] = [];
      for (let polls = 0; polls < maxPolls; polls += 1) {
        const next = await options.teamai(['workflow', 'next', runId, ...(prepare ? ['--prepare'] : []), '--json', JSON.stringify({ driver: { ...identity, can }, running: [] })]);
        const answer = NextAnswerSchema.parse(lastJson(next.stdout, next.stderr)).data;
        if ('done' in answer) {
          const { outcome, failure, benchmark } = answer.done;
          return { leased, held, done: { outcome, ...(failure ? { failure } : {}), ...(benchmark ? { text: benchmark.text } : {}) } };
        }
        if ('wait' in answer) {
          held = answer.wait.held ?? [];
          await new Promise((resolve) => { setTimeout(resolve, options.pauseMs); });
          continue;
        }
        const { lease } = answer;
        leased.push(lease.step);
        const tool = options.tools[lease.trial.tool];
        if (tool === undefined) throw new Error(`leased a trial of ${lease.trial.tool}, which this driver does not list`);
        const env = { ...Object.fromEntries(Object.entries(options.env).filter(([key]) => !lease.envScope.withhold.includes(key))), ...lease.env };
        const started = Date.now();
        const { limits } = lease.trial;
        const launched = await run(tool, ['-p', lease.prompt, ...(lease.trial.model ? ['--model', lease.trial.model] : []), ...(lease.trial.effort ? ['--effort', lease.trial.effort] : [])], {
          cwd: lease.cwd, env, ...(limits?.timeoutMs !== undefined ? { timeout: limits.timeoutMs } : {}),
        }).then((result) => ({ outcome: 'success' as const, ...sessionOf(result.stdout) }), (error: unknown) => (
          TimedOutSchema.safeParse(error).success ? { outcome: 'success' as const, limit: 'timeout' } : { outcome: 'failed' as const }
        ));
        const unenforced = [...(limits?.tokens !== undefined ? ['budget'] : []), ...(limits?.maxTurns !== undefined ? ['max_turns'] : [])];
        const report = await options.teamai(['workflow', 'report', runId, '--json', JSON.stringify({
          attempt: lease.attempt, revision: lease.revision, driver: identity, tool: lease.trial.tool, durationMs: Date.now() - started, ...launched,
          ...(unenforced.length > 0 ? { unenforced } : {}),
        })]);
        ReportAnswerSchema.parse(lastJson(report.stdout, report.stderr));
      }
      return { leased, held };
    },
  };
}
