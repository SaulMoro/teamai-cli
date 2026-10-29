/**
 * Trials on this machine: the one teamai module that runs the commands teamai owns in a trial's clone and completes the
 * driver's report. A driver reaches it through `Trials.next` and `Trials.report`, and never imports another driver.
 *
 * Each baseline step and each trial's `<arm>` step opens a clone place, which the place module prepares, sets up,
 * commits and sweeps as it does for any workflow. Behind `Trials.next`: each command step of the run, a baseline or a
 * check, run in its clone, and one progress line per prompt event. Behind `Trials.report`: what the trial ran as, from
 * what teamai observed of the clone it prepared. `runCheckStep` is `teamai benchmark check`, the command of a baseline
 * and a check: the files check.add writes, the protected paths as the starting commit has them, and the check's verdict.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ReportedAgent } from '../agent-observation.js';
import { loadLocalConfigForScope } from '../config.js';
import { stepEnvironment } from '../env-exec.js';
import { resolveWorkflowEnv, type WorkflowEnv } from '../env-resolution.js';
import { teamRefBlocker } from '../team-ref.js';
import type { LocalConfig } from '../types.js';
import { sameEnvName } from '../resources/env-key.js';
import { log } from '../utils/logger.js';
import { error, leaseNext, locateStep, reportAttempt, type NextOptions, type ReportInput } from '../workflow/engine.js';
import { LeaseWireSchema, type LeaseWire } from '../workflow/lease-wire.js';
import { leaseDeadline } from '../workflow/limits.js';
import { abandonPlace, commitCacheOf, freshClone, placeLeaseOf, preparedClone, preparePlace, runPlaceSetup, scratchCloneRoot } from '../workflow/place/place.js';
import { commandEnd } from '../workflow/protocol.js';
import { findAttemptRun } from '../workflow/run-location.js';
import { runSetup } from '../workflow/place/setup.js';
import { EnvScopeSchema, lacksTool, LeaseSetupSchema, SANDBOX_WITHHELD_ENV, type DriverCan, type EnvScope, type LeaseSetup, type Setup } from '../workflow/requirements.js';
import { attemptEnv } from '../workflow/attempt-marker.js';
import { runShellCommand, type CommandExit } from '../workflow/shell-command.js';
import { readRun, RunIdSchema, type RunLock } from '../workflow/store.js';
import { stepDefinitions } from '../workflow/scope.js';
import { StepModelSchema, type StepModel } from '../workflow/step-model.js';
import { WORKSPACE_MODES, type DriverIdentity, type RunState, type WorkflowEnvelope, type WorkflowFailure } from '../workflow/types.js';
import { cloneBranchOf } from '../workflow/workspace.js';
import { untrustedGit, type Git } from '../workflow/worktree.js';
import { checkVerdict, type CheckResult, type CheckVerdict } from './check.js';
import { BENCHMARK_PLAN_SCHEMA_VERSION, baselineStepOf, stepOf, type BenchmarkPlan } from './plan.js';
import type { CheckFile, Suite } from './suite.js';
import { PromptTermsSchema, type Added, type PreparedTrialLease } from './terms.js';

export interface TrialNextOptions extends NextOptions {
  /** Stops setup or a command this call runs. The step stays leased, so the next call prepares or runs it again. */
  signal?: AbortSignal;
}

export const Trials = {
  /**
   * What `leaseNext` answers, holding the run's lock, except that no trial lease reaches the caller unprepared:
   *   - a command lease, a baseline's or a check's, is run here in its clone, settled with its exit and the outputs it
   *     printed, and the next lease is asked for;
   *   - a prompt lease comes back with its clone prepared and set up, `{ data: { lease: { ...lease without workspace and
   *     setup, cwd } } }`, or, when preparation or setup fails, is settled failed (the trial's `error`) and the next lease
   *     is asked for;
   *   - `wait`, `hitl`, `done` and errors pass through unchanged.
   * teamai makes the workspace, runs setup and applies the env of everything it runs, so it declares those for the
   * caller. A stop through `signal` leaves the step leased and answers `interrupted`. Where `trialBlocker` says this
   * machine cannot pin the team, no trial is prepared: the run's only driver (`alone`) settles them all `not_run`, and
   * any other driver gets `team_ref_blocked` until the run ends.
   */
  async next(config: LocalConfig, lock: RunLock, driver: DriverIdentity, options: TrialNextOptions): Promise<WorkflowEnvelope> {
    const { signal, ...next } = options;
    const runId = lock.run;
    const run = await readRun(config, runId);
    // The engine's own answer for a run that is missing or unreadable.
    if (typeof run !== 'object') return leaseNext(config, runId, driver, next);
    if (!run.benchmark) {
      return error('invalid_arguments', `Run ${runId} is not a benchmark run, so it has no trials to prepare.`);
    }
    const env = next.env ?? await resolveWorkflowEnv(config);
    const can = { ...next.can, workspace: [...WORKSPACE_MODES], setup: true, env: true };
    const blocked = await trialBlocker(config);
    if (blocked !== undefined) {
      // Unprepared, every trial is held for `prepare`, which `alone` skips. Another driver only reconciles, so the
      // suite's timeout still ends the run through its calls.
      if (next.alone) return leaseNext(config, runId, driver, { ...next, can, env, prepare: false });
      const answer = await leaseNext(config, runId, driver, { ...next, env, canTakeLease: false });
      return 'data' in answer && answer.data.done !== undefined ? answer : error('team_ref_blocked', blocked);
    }
    const trial = { config, lock, driver, env, signal, checkout: run.checkout, total: run.benchmark.trials.length };
    for (;;) {
      const answer = await leaseNext(config, runId, driver, { ...next, can, env, prepare: true });
      const leased = trialLeaseOf(answer, run);
      switch (leased.kind) {
        case 'none':
          return answer;
        case 'unreadable':
          return error('run_unreadable', `Run ${runId} leased step "${leased.step}", which is not a trial step this teamai can prepare. Update teamai.`);
        case 'command': {
          const ran = await runCommand(trial, leased.lease, leased.wire);
          if (ran) return ran;
          continue;
        }
        case 'prompt': {
          const taken = await takePrompt(trial, leased.lease, leased.wire, answer);
          if (taken) return taken;
          continue;
        }
        default: {
          const unhandled: never = leased;
          return unhandled;
        }
      }
    }
  },

  /**
   * The report of a prompt trial `next` prepared, completed for the caller to settle through the place that finishes
   * it, which puts back the agent files the clone's install delivered and commits the clone: the trial's `agent` is
   * what teamai observed of the clone it prepared, plus what the driver observed of its tool, and the report carries
   * the stamp the engine requires on a trial report. A report of an attempt no longer leased is completed as it is, so
   * the engine answers it. A report of a check, one that carries what teamai fills itself, or one of a prompt this
   * machine did not prepare, is refused and leaves the trial leased.
   */
  async report(config: LocalConfig, runId: string, report: ReportInput): Promise<{ report: ReportInput } | WorkflowEnvelope> {
    const run = await readRun(config, runId);
    const leased = typeof run === 'object' ? run.steps.find((step) => step.status === 'leased' && step.attempt === report.attempt) : undefined;
    const defined = leased && typeof run === 'object' ? locateStep(run, leased.id)?.step : undefined;
    const terms = defined?.trial;
    // An attempt that is no longer leased gets the engine's own answer: stale, cancelled, or not this run's.
    if (!leased || typeof run !== 'object' || terms === undefined) return { report: { ...report, trialReport: {} } };
    if (terms.kind !== 'prompt') {
      return error('invalid_report', `Step "${leased.id}" is a benchmark check, which teamai runs itself inside teamai workflow next --prepare. Report only the prompt leases next --prepare gives this driver.`);
    }
    const filled = TEAMAI_FILLS.filter((field) => report[field] !== undefined);
    if (filled.length > 0) {
      return error('invalid_report', `Prepared trial reports fill ${TEAMAI_FILLS.join('/')} automatically; omit ${filled.join('/')}`);
    }
    if (report.tool === undefined) {
      return error('invalid_report', `The report of trial step "${leased.id}" names no tool. Send tool with the tool the driver launched: ${defined?.tool} for this trial.`);
    }
    const branch = cloneBranchOf(run, leased.id);
    const made = branch === undefined ? undefined : await preparedClone(config, RunIdSchema.parse(run.id), branch);
    if (!made) {
      return error('invalid_report', `Attempt ${report.attempt} of step "${leased.id}" has no prepared trial on this machine. Ask for it with teamai workflow next --prepare, and report the lease that answers.`);
    }
    const model = typeof defined?.model === 'object' ? defined.model : undefined;
    return { report: { ...report, agent: trialAgent(made.prepared, model, report), trialReport: {} } };
  },
} as const;

const CommittedSuiteSchema = z.custom<{ suite: Suite; files: ReadonlyMap<string, Added> }>((value) => typeof value === 'object' && value !== null)
  .brand<'CommittedSuite'>();
/**
 * A suite whose check files are each a commit in a commit cache: `files` holds, by task, the check.add entry that writes
 * them. Only `commitCheckFiles` makes one, so a task's check files never reach a plan without their commit.
 */
export type CommittedSuite = z.infer<typeof CommittedSuiteSchema>;

/** Commits the check files of every task of `suite` that has them into `cache`, or names the first task that failed. */
export async function commitCheckFiles(cache: string, suite: Suite): Promise<{ ok: true; suite: CommittedSuite } | { ok: false; task: string; failed: string }> {
  const files = new Map<string, Added>();
  for (const task of suite.tasks) {
    if (task.judge.kind !== 'check' || !task.judge.files) continue;
    const [first, ...rest] = task.judge.files;
    const committed = await commitFiles(cache, task.judge.files);
    if ('failed' in committed) return { ok: false, task: task.id, failed: committed.failed };
    files.set(task.id, { kind: 'suite', commit: committed.commit, paths: [first.path, ...rest.map((file) => file.path)] });
  }
  return { ok: true, suite: CommittedSuiteSchema.parse({ suite, files }) };
}

/**
 * Writes `files` into the bare repo `cache` as a commit of their own, each at its path with its mode, so a trial's check
 * writes them as `check.add` writes a fix's: a pull during the run changes none of them. A fixed author, committer and
 * date make the same files the same commit. A ref keeps it from gc while runs read it.
 */
async function commitFiles(cache: string, files: readonly CheckFile[]): Promise<{ commit: string } | { failed: string }> {
  await fs.mkdir(cache, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-check-files-'));
  // untrustedGit is the git that takes an env with stdin, which the index of its own needs.
  const written = untrustedGit({
    ...process.env, GIT_INDEX_FILE: path.join(dir, 'index'),
    GIT_AUTHOR_NAME: 'teamai', GIT_AUTHOR_EMAIL: 'teamai@localhost', GIT_AUTHOR_DATE: '946684800 +0000',
    GIT_COMMITTER_NAME: 'teamai', GIT_COMMITTER_EMAIL: 'teamai@localhost', GIT_COMMITTER_DATE: '946684800 +0000',
  });
  const failed = (step: string, stderr: string): { failed: string } => ({ failed: `git ${step} failed: ${stderr.trim()}.` });
  try {
    const made = await written(cache, ['init', '-q', '--bare']);
    if (made.code !== 0) return failed('init', made.stderr);
    const blobs = files.map((file, index) => ({ at: path.join(dir, `${index}.blob`), file }));
    for (const { at, file } of blobs) await fs.writeFile(at, Buffer.from(file.base64, 'base64'));
    const hashed = await written(cache, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: blobs.map(({ at }) => at).join('\n') });
    const objects = hashed.stdout.trim().split('\n');
    if (hashed.code !== 0 || objects.length !== files.length) return failed('hash-object', hashed.stderr);
    const staged = await written(cache, ['update-index', '--add', '-z', '--index-info'], { input: files.map((file, index) => `${file.mode} ${objects[index]}\t${file.path}\0`).join('') });
    if (staged.code !== 0) return failed('update-index', staged.stderr);
    const tree = await written(cache, ['write-tree']);
    if (tree.code !== 0) return failed('write-tree', tree.stderr);
    const commit = await written(cache, ['commit-tree', tree.stdout.trim(), '-m', 'teamai: check files']);
    if (commit.code !== 0) return failed('commit-tree', commit.stderr);
    const sha = commit.stdout.trim();
    const kept = await written(cache, ['update-ref', `refs/benchmark/${sha}`, sha]);
    return kept.code === 0 ? { commit: sha } : failed('update-ref', kept.stderr);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Why this machine cannot pin the team a trial runs, or undefined: the team also reaches the trial through user scope,
 * or it is single-repo or served over HTTP. The check `teamai pull --team-ref` makes, with its message.
 */
export async function trialBlocker(config: LocalConfig): Promise<string | undefined> {
  return teamRefBlocker(config, await loadLocalConfigForScope('user', undefined, { dryRun: true }))?.message;
}

/**
 * The lines the local driver prints once before its first `next`, one per reason a trial of `plan` does not run on it.
 * The reason is `lacksTool`, the rule that holds its trials, so a printed reason and a held trial agree.
 */
export function benchmarkNotices(plan: BenchmarkPlan, can: Pick<DriverCan, 'tools'>, blocked: string | undefined): string[] {
  return [
    ...(blocked !== undefined ? [blocked] : []),
    ...plan.arms.filter((arm) => lacksTool(arm.tool, can))
      .map((arm) => `Arm "${arm.name}" uses ${arm.tool}, which the local driver cannot run, so its trials did not run.`),
  ];
}

/** What a trial report never carries: teamai commits the clone and fills them. */
const TEAMAI_FILLS = ['changes', 'read', 'exitCode'] as const satisfies readonly (keyof ReportInput)[];

const LeaseBase = {
  run: z.string(),
  step: z.string(),
  attempt: z.string(),
  revision: z.number().int(),
  pass: z.number().int().positive(),
  setup: LeaseSetupSchema.optional(),
  envScope: EnvScopeSchema.optional(),
  workspace: z.object({ branch: z.string().min(1) }).passthrough(),
  expiresAt: z.string().optional(),
};
const PromptLeaseSchema = z.object({ ...LeaseBase, trial: PromptTermsSchema, prompt: z.string(), tool: z.string().min(1), model: StepModelSchema.optional() }).passthrough();
const CommandLeaseSchema = z.object({ ...LeaseBase, command: z.string() }).passthrough();
type PromptLease = z.infer<typeof PromptLeaseSchema>;
type CommandLease = z.infer<typeof CommandLeaseSchema>;

/** `wire` is the lease as every driver reads it, which the place reads. */
type TrialLease =
  | { kind: 'prompt'; lease: PromptLease; wire: LeaseWire }
  | { kind: 'command'; lease: CommandLease; wire: LeaseWire }
  /** The answer holds no lease. */
  | { kind: 'none' }
  /** A lease that is not a trial step: only compilePlan writes a benchmark's steps, so a newer teamai wrote this one. */
  | { kind: 'unreadable'; step: string };

/**
 * `leaseData` builds the lease as a plain record, so it is parsed here, once, into the kind teamai runs, with the trial
 * terms its step in `run` carries.
 */
function trialLeaseOf(answer: WorkflowEnvelope, run: RunState): TrialLease {
  const leased = 'data' in answer ? answer.data.lease : undefined;
  if (leased === undefined) return { kind: 'none' };
  const named = z.object({ step: z.string() }).passthrough().safeParse(leased);
  if (!named.success) return { kind: 'unreadable', step: '(unknown)' };
  const raw = { ...named.data, trial: stepDefinitions(run)(named.data.step)?.trial };
  const wire = LeaseWireSchema.safeParse(raw);
  const prompt = PromptLeaseSchema.safeParse(raw);
  if (wire.success && prompt.success) return { kind: 'prompt', lease: prompt.data, wire: wire.data };
  const command = CommandLeaseSchema.safeParse(raw);
  if (wire.success && command.success) return { kind: 'command', lease: command.data, wire: wire.data };
  return { kind: 'unreadable', step: named.data.step };
}

/** What one call of `Trials.next` works with. */
interface TrialCall {
  config: LocalConfig;
  lock: RunLock;
  driver: DriverIdentity;
  env: WorkflowEnv;
  signal: AbortSignal | undefined;
  /** The checkout the run started in, which a clone is made from. */
  checkout: string | undefined;
  /** The plan's trial count, for progress lines. */
  total: number;
}

/**
 * A prompt lease: the driver's lease once its clone is prepared and set up, `interrupted`, or the engine's refusal of
 * the failed preparation it settled. Undefined when the next lease is to be asked for: preparation failed and was
 * settled.
 */
async function takePrompt(trial: TrialCall, lease: PromptLease, wire: LeaseWire, answer: WorkflowEnvelope): Promise<WorkflowEnvelope | undefined> {
  const at = { ...lease.trial, total: trial.total };
  progress(at, { kind: 'preparing' });
  const placed = await placeTrial(trial, wire);
  if (trial.signal?.aborted) {
    await abandonPlace({ config: trial.config, lock: trial.lock, attempt: wire.attempt });
    return interrupted(trial.lock.run, lease.step);
  }
  if ('failure' in placed) {
    const refused = await settle(trial, lease, { outcome: 'failed', message: placed.failure.message, failure: placed.failure, trialReport: {} });
    progress(at, { kind: 'error', failure: placed.failure });
    return refused;
  }
  progress(at, { kind: 'ready', tool: lease.tool });
  return { data: { ...('data' in answer ? answer.data : {}), lease: driverLease(lease, placed.dir) } };
}

/** The clone place of the trial lease `wire`, prepared and set up as any place is. A place that could not be made or set up is given up. */
async function placeTrial(trial: TrialCall, wire: LeaseWire): Promise<{ dir: string } | { failure: WorkflowFailure }> {
  const { config, lock } = trial;
  if (trial.checkout === undefined) {
    return { failure: { code: 'workspace_base', message: `Run ${lock.run} has no checkout recorded, so the clone of step "${wire.step}" has nothing to be made from.` } };
  }
  const prepared = await preparePlace({ config, lock, root: trial.checkout, lease: placeLeaseOf(wire) });
  if (prepared.kind !== 'prepared') return { failure: prepared.failure };
  const failure = await runPlaceSetup({ config, run: lock.run, attempt: wire.attempt, mode: 'unattended', env: trial.env, ...(trial.signal ? { signal: trial.signal } : {}) });
  if (failure) {
    await abandonPlace({ config, lock, attempt: wire.attempt });
    return { failure };
  }
  return { dir: prepared.dir };
}

/** Setup with only its own keys, as the lease scopes them. */
async function setupIn(trial: Runner, dir: string, setup: LeaseSetup, expiresAt: string | undefined): Promise<WorkflowFailure | undefined> {
  const scope = setup.envScope ?? NO_ENV;
  const scoped = await stepEnvironment(trial.env, scope);
  if (!scoped.ok) return scoped.failure;
  return runSetup({ command: setup.command, dir, env: scoped.env, keys: scope.provide, ...(trial.signal ? { signal: trial.signal } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) });
}

/**
 * A command step of the run, a baseline or a check, in the clone its lease prepares, with the lease's env and the
 * attempt marker, bounded by the run's deadline, settled with its exit and the outputs its stdout states. Its stderr
 * goes to this process's too, so the lines it prints reach the driver's log. Answers an envelope only when the call must stop: the
 * stop signal, or a report the engine refused.
 */
async function runCommand(trial: TrialCall, lease: CommandLease, wire: LeaseWire): Promise<WorkflowEnvelope | undefined> {
  const ran = await commandIn(trial, lease, wire);
  await abandonPlace({ config: trial.config, lock: trial.lock, attempt: wire.attempt });
  if (trial.signal?.aborted) return interrupted(trial.lock.run, lease.step);
  if ('failure' in ran) {
    log.info(`Step ${lease.step}: could not run (${ran.failure.code}: ${ran.failure.message})`);
    return settle(trial, lease, { outcome: 'failed', message: ran.failure.message, failure: ran.failure, trialReport: {} });
  }
  return settle(trial, lease, { ...commandSettlement(ran), trialReport: {} });
}

/** The command of `lease` in its prepared clone, or why it never started. */
async function commandIn(trial: TrialCall, lease: CommandLease, wire: LeaseWire): Promise<{ exit: CommandExit; output: string; errors: string } | { failure: WorkflowFailure }> {
  const scoped = await stepEnvironment(trial.env, lease.envScope ?? NO_ENV);
  if (!scoped.ok) return { failure: scoped.failure };
  const placed = await placeTrial(trial, wire);
  if ('failure' in placed) return placed;
  return runShellCommand({
    command: lease.command, cwd: placed.dir, env: { ...scoped.env, ...attemptEnv(lease.run, lease.attempt, 'unattended') }, stderr: 'forward',
    ...(trial.signal ? { signal: trial.signal } : {}), ...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}),
  });
}

/** The settlement teamai reports for a command it ran: as any driver reports an exit, and a stop or timeout failed. */
function commandSettlement({ exit, output, errors }: { exit: CommandExit; output: string; errors: string }): Pick<ReportInput, 'outcome' | 'exitCode' | 'failure' | 'message' | 'outputs'> {
  switch (exit.kind) {
    case 'exited':
      return commandEnd({ exitCode: exit.code, stdout: output, stderr: errors });
    case 'signal':
      return { outcome: 'failed', message: `The command was stopped by ${exit.signal}.` };
    case 'spawn_failed':
      return { outcome: 'failed', message: `The command could not start: ${exit.message}` };
    case 'timeout': {
      const message = 'The command did not finish before the run timeout.';
      return { outcome: 'failed', message, failure: { code: 'timeout', message } };
    }
    default: {
      const unhandled: never = exit;
      return unhandled;
    }
  }
}

/** How a check went: its verdict, or why it never ran. */
export type CheckRun = Extract<ProgressEvent, { kind: 'check' | 'error' }>;

/** What running setup or a check reads of a call: the env values it gives and the signal that stops it. */
type Runner = { env: Pick<WorkflowEnv, 'values' | 'facts'>; signal: AbortSignal | undefined };

/**
 * `prepare`, then the check command in the clone it answers, with the lease's env, bounded by the run's deadline.
 * `prepare` gets that env too, which is all the agent's code gets once the check runs it. A caller tells a stopped call from its verdict by
 * its signal.
 */
async function checkIn(trial: Runner, lease: { command: string; envScope: EnvScope; expiresAt: string | undefined }, prepare: (env: NodeJS.ProcessEnv) => Promise<{ dir: string } | { failure: WorkflowFailure }>): Promise<CheckRun> {
  const scoped = await stepEnvironment(trial.env, lease.envScope);
  if (!scoped.ok) return { kind: 'error', failure: scoped.failure };
  const prepared = await prepare(scoped.env);
  if ('failure' in prepared) return { kind: 'error', failure: prepared.failure };
  const { exit } = await runShellCommand({
    command: lease.command, cwd: prepared.dir, env: scoped.env,
    ...(trial.signal ? { signal: trial.signal } : {}), ...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}),
  });
  return { kind: 'check', verdict: checkVerdict(exit, process.platform) };
}

/** Which check `teamai benchmark check` runs: a check task's baseline, or a trial's check. */
export type CheckStepMode = 'baseline' | 'trial';

/**
 * `teamai benchmark check --baseline|--trial`: the check of the step whose attempt `env` marks, in `cwd`, the clone that
 * step's place prepared and set up. It reads what it checks from the run's plan, by the step's id: a trial's check first
 * puts the protected paths back as the starting commit has them; both then write the files check.add names, from the
 * run's checkout or the commit cache. Git and the check run with `env` without the names a strict sandbox withholds, which this
 * process may have set itself, until `signal` or the lease's deadline stops them, and the verdict is classified here, once. Answers its result, or why the check did not run, with one progress line either way.
 */
export async function runCheckStep({ mode, env: given, cwd, signal }: { mode: CheckStepMode; env: NodeJS.ProcessEnv; cwd: string; signal?: AbortSignal }): Promise<{ result: CheckResult } | { failure: WorkflowFailure }> {
  const found = await findAttemptRun(given);
  if ('error' in found) {
    if (found.error.code !== 'run_unreadable') return { failure: found.error };
    return { failure: { ...found.error, message: `${found.error.message}: its file, or the benchmark plan in it, is not in a form this teamai reads, whose plans are schemaVersion ${BENCHMARK_PLAN_SCHEMA_VERSION}. Run the benchmark with the teamai that started it, or start it again.` } };
  }
  const { config, run, step } = found;
  const plan = run.benchmark;
  const checked = plan && checkedBy(plan, mode, step.id);
  if (!plan || !checked) {
    return { failure: { code: 'invalid_arguments', message: `Step "${step.id}" of run ${run.id} is not ${mode === 'baseline' ? 'the baseline of a check task' : 'the check of a trial'} of a benchmark run, so teamai benchmark check --${mode} has nothing to check there.` } };
  }
  const { task, judge, at } = checked;
  const env = Object.fromEntries(Object.entries(given).filter(([key]) => sameEnvName(SANDBOX_WITHHELD_ENV, key) === undefined));
  const sources = [...(run.checkout !== undefined ? [run.checkout] : []), commitCacheOf(config, plan.suite.repo)];
  const expiresAt = leaseDeadline(run, step);
  const prepared = (mode === 'trial' ? await restoreProtected({ clone: cwd, startingCommit: task.startingCommit, protect: judge.protect, sources, env, expiresAt }) : undefined)
    ?? (judge.add ? await writeAdded({ clone: cwd, add: judge.add, sources, env, expiresAt }) : undefined);
  const ran: CheckRun = prepared
    ? { kind: 'error', failure: prepared }
    : { kind: 'check', verdict: checkVerdict((await runShellCommand({ command: judge.run, cwd, env, ...(signal ? { signal } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) })).exit, process.platform) };
  if (at) progress(at, ran);
  else baselineProgress(task.id, ran);
  return ran.kind === 'check' ? { result: ran.verdict.verdict } : { failure: ran.failure };
}

/** The check task `step` checks in `mode`, its check, and for a trial's check, the trial as its lines name it. */
function checkedBy(plan: BenchmarkPlan, mode: CheckStepMode, step: string): { task: BenchmarkPlan['tasks'][number]; judge: Extract<BenchmarkPlan['tasks'][number]['judge'], { kind: 'check' }>; at?: TrialAt } | undefined {
  const trial = mode === 'trial' ? plan.trials.find((planned) => stepOf({ ...planned, kind: 'check' }) === step) : undefined;
  const task = plan.tasks.find((planned) => (mode === 'trial' ? planned.id === trial?.task : baselineStepOf(planned.id) === step));
  if (task?.judge.kind !== 'check') return undefined;
  return { task, judge: task.judge, ...(trial ? { at: { ...trial, total: plan.trials.length } } : {}) };
}

/**
 * One check of a task at `commit`, as its steps run it but with no run: a fresh clone of `commit` from the first of
 * `sources` that has it, setup, then the check. Without `protect`, a baseline's: the files `add` names are written
 * before setup. With `protect`, a trial check's: after setup, `restoreProtected` puts those paths back as
 * `startingCommit` has them, then the files `add` names are written. Setup, the tool's strip list and `expiresAt`
 * apply as they do to a trial. The clone is removed.
 */
export async function tryCheckAt(input: {
  commit: string; startingCommit: string; command: string; protect?: readonly string[]; add?: readonly Added[]; setup?: Setup;
  sources: readonly string[]; expiresAt: string; signal?: AbortSignal;
}): Promise<CheckRun> {
  const { commit, startingCommit, protect, add, setup, sources, expiresAt } = input;
  const values = new Map(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const runner: Runner = { env: { values, facts: { declared: new Set(), secrets: new Set(), present: new Set(values.keys()) } }, signal: input.signal };
  const withhold = [...SANDBOX_WITHHELD_ENV];
  const leaseSetup = setup ? { command: setup.command, envScope: { provide: setup.requires?.env ?? [], withhold } } : undefined;
  const root = scratchCloneRoot();
  const clone = path.join(root, 'r');
  try {
    const written = async (env: NodeJS.ProcessEnv): Promise<WorkflowFailure | undefined> => (add ? await writeAdded({ clone, add, sources, env, expiresAt }) : undefined);
    return await checkIn(runner, { command: input.command, envScope: { provide: [], withhold }, expiresAt }, async (env) => {
      const failure = await freshClone(root, commit, sources, expiresAt)
        ?? (protect ? undefined : await written(env))
        ?? (leaseSetup ? await setupIn(runner, clone, leaseSetup, expiresAt) : undefined)
        ?? (protect ? await restoreProtected({ clone, startingCommit, protect, sources, env, expiresAt }) ?? await written(env) : undefined);
      return failure ? { failure } : { dir: clone };
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Puts every protected path back as `startingCommit` has it, so the check reads only the agent's product code: tracked
 * files the agent edited, deleted or added, commits included, then untracked and ignored files it left there, and git
 * repositories it made there. Each path in `protect` is a glob pathspec, one argv element each: no shell string. A file
 * setup wrote under a protected path goes too. The commit is read from the first of `sources` that has it, where the
 * agent never ran, into an index of its own, so no index flag, filter, replacement or object the agent left in the clone
 * decides what is put back. Then every protected file on disk must be that commit's, byte for byte, of the same kind and
 * executable bit, with nothing else there. A path that reaches into a submodule is refused: git puts none of its files
 * back. Git gets `env`, starts nothing the clone configures, and is stopped at `expiresAt`. Undefined once restored.
 */
export async function restoreProtected({ clone, startingCommit, protect, sources, env, expiresAt }: {
  clone: string; startingCommit: string; protect: readonly string[]; sources: readonly string[]; env: NodeJS.ProcessEnv; expiresAt?: string | undefined;
}): Promise<WorkflowFailure | undefined> {
  const specs = protect.map((entry) => `:(glob)${entry}`);
  const failed = (step: string, stderr: string): WorkflowFailure => ({ code: 'trial_prepare_failed', message: `The protected paths of the clone in ${clone} could not be put back as ${startingCommit} has them (git ${step}): ${stderr.trim()}` });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-protect-'));
  // A source's own hooks stay off too: writing an index starts its post-index-change hook.
  const starting = untrustedGit({ ...env, GIT_INDEX_FILE: path.join(dir, 'index') }, expiresAt);
  try {
    const read = await readStarting(starting, sources, startingCommit);
    if ('stderr' in read) return failed('read-tree', read.stderr);
    // Git puts back none of the files inside a submodule, so a protected path that reaches into one is refused.
    const all = await starting(read.source, ['ls-files', '-s', '-z']);
    if (all.code !== 0) return failed('ls-files', all.stderr);
    const gitlinks = all.stdout.split('\0').filter((line) => line.startsWith('160000 ')).map((line) => line.slice(line.indexOf('\t') + 1));
    for (const entry of protect) {
      const gitlink = gitlinks.find((link) => reachesInto(entry, link));
      if (gitlink !== undefined) return { code: 'trial_prepare_failed', message: `Protected path "${entry}" reaches into submodule ${gitlink}, whose files teamai cannot put back as ${startingCommit} has them. List paths outside submodules in protect, or judge the task by successCriteria.` };
    }
    const listed = await stagedEntries(starting, read.source, specs);
    if ('stderr' in listed) return failed('ls-files', listed.stderr);
    const { entries } = listed;
    // The second -f also removes a git repository the agent made there, which git clean otherwise keeps.
    const cleaned = await starting(clone, ['clean', '-f', '-f', '-d', '-x', '-q', '--', ...specs]);
    if (cleaned.code !== 0) return failed('clean', cleaned.stderr);
    if (entries.length > 0) {
      // Bytes as the commit stores them, whatever this machine's line-ending settings would write.
      const restored = await starting(clone, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'checkout-index', '-f', '-z', '--stdin'], { input: entries.map((entry) => `${entry.path}\0`).join('') });
      if (restored.code !== 0) return failed('checkout-index', restored.stderr);
    }
    // The clone's own index agrees, for a check that runs git.
    const cloneGit = untrustedGit(env, expiresAt);
    const dropped = await cloneGit(clone, ['rm', '--cached', '-r', '-f', '-q', '--ignore-unmatch', '--', ...specs]);
    if (dropped.code !== 0) return failed('rm', dropped.stderr);
    if (entries.length > 0) {
      const staged = await cloneGit(clone, ['update-index', '-z', '--index-info'], { input: entries.map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join('') });
      if (staged.code !== 0) return failed('update-index', staged.stderr);
    }
    // A filter the agent configured ran while the files were written, and could have changed the index they came from.
    const reread = await readStarting(starting, sources, startingCommit);
    if ('stderr' in reread) return failed('read-tree', reread.stderr);
    const added = await starting(clone, ['ls-files', '--others', '-z', '--', ...specs]);
    if (added.code !== 0) return failed('ls-files', added.stderr);
    const differing: string[] = [];
    for (const entry of entries) if (!await holds(clone, entry)) differing.push(entry.path);
    const left = [...differing, ...added.stdout.split('\0').filter((entry) => entry !== '')];
    return left.length === 0
      ? undefined
      : { code: 'trial_prepare_failed', message: `The protected paths of the clone in ${clone} still differ from ${startingCommit} after they were put back: ${left.join(', ')}` };
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Whether glob pathspec `spec` can name submodule `gitlink` or a path inside it. A segment with a character class
 * counts as matching, so a doubtful spec is refused rather than missed.
 */
function reachesInto(spec: string, gitlink: string): boolean {
  const names = gitlink.split('/');
  for (const [at, part] of spec.split('/').entries()) {
    const name = names[at];
    if (name === undefined || part === '**') return true;
    if (part.includes('[')) continue;
    const pattern = part.replace(/[.+^${}()|\\\]]/g, (char) => `\\${char}`).replace(/\*/g, '[^/]*').replace(/\?/g, '.');
    if (!new RegExp(`^${pattern}$`).test(name)) return false;
  }
  return true;
}

/** A protected path of the starting commit: the mode and object git checks out there. */
interface StartingEntry {
  mode: string;
  oid: string;
  path: string;
}

/** `<mode> <object> <stage>\t<path>`, one entry of `git ls-files -s -z`. */
const STAGED_ENTRY = /^(\d{6}) ([0-9a-f]+) \d\t([\s\S]+)$/;

/** The entries of the index `git` writes that `specs` name, read in `cwd`. */
async function stagedEntries(git: Git, cwd: string, specs: readonly string[]): Promise<{ entries: StartingEntry[] } | { stderr: string }> {
  const listed = await git(cwd, ['ls-files', '-s', '-z', '--', ...specs]);
  if (listed.code !== 0) return { stderr: listed.stderr };
  const entries: StartingEntry[] = [];
  for (const line of listed.stdout.split('\0').filter((entry) => entry !== '')) {
    const [, mode, oid, file] = STAGED_ENTRY.exec(line) ?? [];
    if (mode === undefined || oid === undefined || file === undefined) return { stderr: `unreadable entry ${line}` };
    entries.push({ mode, oid, path: file });
  }
  return { entries };
}

/**
 * Writes the files each entry of `add` names into `clone` as its commit has them, whether or not the clone has them, so
 * the check reads the fix's test, or the suite's, and the agent never did. Each must be a file at that commit. The
 * commit is read from the first of `sources` that has it into an index of its own, and its files are written from that
 * source's objects, so nothing the clone holds decides what is written. Then each must hold that commit's bytes, as
 * `restoreProtected` checks its own, git stopped at `expiresAt` as there. Undefined once every entry is written.
 */
async function writeAdded({ clone, add, sources, env, expiresAt }: {
  clone: string; add: readonly Added[]; sources: readonly string[]; env: NodeJS.ProcessEnv; expiresAt?: string | undefined;
}): Promise<WorkflowFailure | undefined> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-add-'));
  const fixed = untrustedGit({ ...env, GIT_INDEX_FILE: path.join(dir, 'index') }, expiresAt);
  try {
    for (const { kind, commit, paths } of add) {
      const failed = (message: string): WorkflowFailure => ({ code: 'trial_prepare_failed', message: `The files check.add names could not be written into the clone in ${clone} as ${commit} has them: ${message}` });
      const read = await readStarting(fixed, sources, commit);
      if ('stderr' in read) return failed(`git read-tree: ${read.stderr.trim()}`);
      const listed = await stagedEntries(fixed, read.source, paths.map((entry) => `:(literal)${entry}`));
      if ('stderr' in listed) return failed(`git ls-files: ${listed.stderr.trim()}`);
      // A literal pathspec also names what is under a directory, and a submodule has no bytes to write: only files count.
      const entries = listed.entries.filter((entry) => entry.mode !== '160000' && paths.includes(entry.path));
      const missing = paths.find((entry) => !entries.some((staged) => staged.path === entry));
      if (missing !== undefined) {
        return {
          code: 'trial_prepare_failed',
          message: kind === 'fix'
            ? `check.add path ${missing} is not a file at the fix ${commit}. List files the fix has in check.add, or fix source.fix.`
            : `check.add path ${missing} is not a file at ${commit}, the commit start made of the suite directory's files. Start a new run, which commits them again.`,
        };
      }
      // Bytes as the commit stores them, whatever this machine's line-ending settings would write.
      const written = await fixed(read.source, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', `--work-tree=${clone}`, 'checkout-index', '-f', '-z', '--stdin'], { input: entries.map((entry) => `${entry.path}\0`).join('') });
      if (written.code !== 0) return failed(`git checkout-index: ${written.stderr.trim()}`);
      const differing: string[] = [];
      for (const entry of entries) if (!await holds(clone, entry)) differing.push(entry.path);
      if (differing.length > 0) return failed(`${differing.join(', ')} still differ from it after they were written.`);
    }
    return undefined;
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Reads `commit` into the index `git` writes, from the first of `sources` that has it, and answers that source. */
async function readStarting(git: Git, sources: readonly string[], commit: string): Promise<{ source: string } | { stderr: string }> {
  const said: string[] = [];
  for (const source of sources) {
    const read = await git(source, ['read-tree', commit]);
    if (read.code === 0) return { source };
    said.push(`${source}: ${read.stderr.trim()}`);
  }
  return { stderr: said.join('; ') || 'no checkout to read it from' };
}

/**
 * Whether what is at `entry.path` in `clone` is what git checks out for it, below directories only, so no link shows
 * the check another directory: a link or a file whose bytes hash to its object, a file of the same executable bit.
 */
async function holds(clone: string, entry: StartingEntry): Promise<boolean> {
  const parts = entry.path.split('/');
  for (let depth = 1; depth < parts.length; depth += 1) {
    if ((await fs.lstat(path.join(clone, ...parts.slice(0, depth))).catch(() => undefined))?.isDirectory() !== true) return false;
  }
  const at = path.join(clone, ...parts);
  const stats = await fs.lstat(at).catch(() => undefined);
  if (stats === undefined) return false;
  // Windows keeps no executable bit, and git writes a link it cannot make there as a file that holds its target.
  const kind = stats.isSymbolicLink() ? '120000' : !stats.isFile() ? undefined : process.platform === 'win32' ? entry.mode : (stats.mode & 0o100) !== 0 ? '100755' : '100644';
  if (kind !== entry.mode) return false;
  const bytes = stats.isSymbolicLink() ? await fs.readlink(at, { encoding: 'buffer' }) : await fs.readFile(at);
  return createHash(entry.oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === entry.oid;
}

/** Reports what teamai did with a lease. Answers the engine's refusal, except a cancel: the next lease call shows it. */
async function settle(trial: TrialCall, lease: Pick<PromptLease, 'attempt' | 'revision'>, body: Omit<ReportInput, 'attempt' | 'revision' | 'driver'>): Promise<WorkflowEnvelope | undefined> {
  const answer = await reportAttempt(trial.config, trial.lock.run, { attempt: lease.attempt, revision: lease.revision, driver: trial.driver, ...body }, trial.env.secrets);
  return 'error' in answer && answer.error.code !== 'lease_cancelled' ? answer : undefined;
}

function interrupted(runId: string, step: string): WorkflowEnvelope {
  return error('interrupted', `Stopped while step "${step}" was prepared or checked. It stays leased to this driver: call teamai workflow next ${runId} --prepare again, and teamai prepares it from the start.`);
}

/**
 * The trial's `agent`: the team revision and project commit teamai observed of the clone it prepared, whatever the
 * member's checkout pulled since and whatever the driver says; of what the driver sent, only what it observed of its
 * tool. The model and effort it was asked to run are the arm's exact model.
 */
function trialAgent(observed: ReportedAgent, model: StepModel | undefined, report: ReportInput): ReportedAgent {
  const sent = report.agent;
  return {
    ...(observed.team ? { team: observed.team } : {}),
    ...(observed.project ? { project: observed.project } : {}),
    ...(sent?.tool?.version ? { tool: { version: sent.tool.version } } : {}),
    model: { ...(model ? { requested: model.name } : {}), ...(sent?.model?.reported ? { reported: sent.model.reported } : {}) },
    effort: { ...(model?.effort ? { requested: model.effort } : {}), ...(sent?.effort?.reported ? { reported: sent.effort.reported } : {}) },
  };
}

/** The lease a driver sees: no `workspace`, `setup`, `command` or trial terms, with `cwd`. */
function driverLease(lease: PromptLease, cwd: string): PreparedTrialLease {
  const { workspace: _workspace, setup: _setup, trial: _trial, ...rest } = lease;
  return { ...rest, envScope: lease.envScope ?? NO_ENV, env: attemptEnv(lease.run, lease.attempt, 'unattended'), cwd };
}

const NO_ENV: EnvScope = { provide: [], withhold: [] };

/**
 * One line on stderr per event, from this module, so every driver's log shows the same lines. Each is one whole
 * literal, so an operator can search for it.
 */
type ProgressEvent =
  | { kind: 'preparing' }
  | { kind: 'ready'; tool: string }
  | { kind: 'check'; verdict: CheckVerdict }
  | { kind: 'error'; failure: WorkflowFailure };

/** A trial, as its progress lines name it: its place in the plan's trial list of `total`. */
interface TrialAt {
  order: number;
  total: number;
  task: string;
  arm: string;
}

function progress({ order, total, task, arm }: TrialAt, event: ProgressEvent): void {
  switch (event.kind) {
    case 'preparing':
      log.info(`Trial ${order}/${total} ${task} ${arm}: preparing`);
      return;
    case 'ready':
      log.info(`Trial ${order}/${total} ${task} ${arm}: running ${event.tool}`);
      return;
    case 'check':
      switch (event.verdict.verdict) {
        case 'passed':
          log.info(`Trial ${order}/${total} ${task} ${arm}: check passed`);
          return;
        case 'failed':
          log.info(`Trial ${order}/${total} ${task} ${arm}: check failed (exit ${event.verdict.exitCode})`);
          return;
        case 'could_not_run':
          log.info(`Trial ${order}/${total} ${task} ${arm}: check could not run (${event.verdict.cause})`);
          return;
        default: {
          const unhandled: never = event.verdict;
          return unhandled;
        }
      }
    case 'error':
      log.info(`Trial ${order}/${total} ${task} ${arm}: error (${event.failure.code}: ${event.failure.message})`);
      return;
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}

/** One line on stderr per baseline, each one whole literal, like the trials' lines. */
function baselineProgress(task: string, event: CheckRun): void {
  switch (event.kind) {
    case 'check':
      switch (event.verdict.verdict) {
        case 'passed':
          log.info(`Baseline ${task}: check passes without changes, so the task is invalid`);
          return;
        case 'failed':
          log.info(`Baseline ${task}: check fails on the starting commit, as the task expects`);
          return;
        case 'could_not_run':
          log.info(`Baseline ${task}: check could not run (${event.verdict.cause})`);
          return;
        default: {
          const unhandled: never = event.verdict;
          return unhandled;
        }
      }
    case 'error':
      log.info(`Baseline ${task}: check could not run (${event.failure.code}: ${event.failure.message})`);
      return;
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}
