/**
 * Trials on this machine: the one teamai module that makes a trial's workspace, runs the commands teamai owns in it,
 * completes the driver's report, and takes everything away again. A driver reaches it through `Trials.next` and
 * `Trials.report`, and never imports another driver.
 *
 * Behind them: each check task's baseline, tried once on a fresh clone of its starting commit before its trials; a
 * fresh clone of the task's starting commit with its own `.git` and no remotes, the trial's own teamai install at the
 * arm's team revision under a HOME of its own, setup, the check on the protected paths as the starting commit has them
 * and its classification, the prompt's commit and what it ran as, the evidence its judges read, one progress line per
 * event, and a receipt per trial copy and baseline that names the root before anything under it exists, so
 * `Trials.sweep` removes what a crash left. One call at a time holds a copy (`withCopy`).
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { observeCheckout, ReportedAgentSchema, type ReportedAgent } from '../../agent-observation.js';
import { resolveCliEntry } from '../../builtin-hooks.js';
import { loadLocalConfigForScope, saveLocalConfigForScope } from '../../config.js';
import { stepEnvironment } from '../../env-exec.js';
import { resolveWorkflowEnv, type WorkflowEnv } from '../../env-resolution.js';
import { removeGitHook } from '../../git-hook.js';
import { createProjectToolRoots } from '../../project-agent-root.js';
import { teamRefBlocker } from '../../team-ref.js';
import { homeVariables, isToolId, TOOLS } from '../../tools.js';
import { getDataHome, type LocalConfig } from '../../types.js';
import { execCommand } from '../../utils/exec.js';
import { readJson, writeJsonAtomic } from '../../utils/fs.js';
import { scoresDir } from '../../scorers/attempts.js';
import { removeSubjectEvidence, subjectEvidenceDirOf } from '../../scorers/evidence.js';
import { getDefaultBranch, HEAD_STATUS, headStateOf, resolveAnchors } from '../../utils/git.js';
import { log } from '../../utils/logger.js';
import { projectSlug } from '../../utils/partition.js';
import { withFileLock } from '../../update.js';
import { error, leaseNext, locateStep, reportAttempt, type NextOptions, type ReportInput } from '../engine.js';
import { sameDriver } from '../../driver-identity.js';
import { EnvScopeSchema, LeaseSetupSchema, trialGaps, type DriverCan, type EnvScope, type LeaseSetup, type Setup } from '../requirements.js';
import { runSetup } from '../place/setup.js';
import { attemptEnv } from '../attempt-marker.js';
import { leaseDeadline } from '../limits.js';
import { collectEvidence } from '../scoring-evidence.js';
import { runShellCommand } from '../shell-command.js';
import { runPasses, type RunPass } from '../loop.js';
import { settled, type LeasedStep } from '../step-state.js';
import { readRun, runsDir } from '../store.js';
import { WORKSPACE_MODES, type DriverIdentity, type RunState, type WorkflowEnvelope, type WorkflowFailure } from '../types.js';
import { commitWork, git, recordConfigOverlay, restoreUneditedConfig, saveConfig, untrustedGit, type Git } from '../worktree.js';
import { baselineOutput, checkVerdict, type CheckVerdict } from './check.js';
import { trialCopyOf, type BenchmarkPlan } from './plan.js';
import type { CheckFile, Suite } from './suite.js';
import { BaselineTermsSchema, CheckTermsSchema, PromptTermsSchema, TRIAL_WITHHELD_ENV, setsLimit, type Added, type PreparedTrialLease, type PromptTerms, type TrialTerms } from './terms.js';

/**
 * `<runsDir>/<run>/trials/<copy>.json`, one per trial copy, the `<arm>` step whose copy the prompt and the check share,
 * and one per baseline step, which has a clone of its own.
 * Local run state, never published, never on a lease. `root` is chosen and written before anything under it exists, so
 * cleanup after a crash at any point removes exactly what might exist. What the receipt does not say, the run does: the
 * check runs in a `prepared` clone once the engine accepted its prompt's report.
 *
 *   <os.tmpdir()>/teamai-trials/<6 hex>/      root, short on purpose: Windows paths
 *     r/                                      the clone, the lease's `cwd`
 *     h/                                      the HOME of the trial's own `teamai pull`: its partition and team clone
 *     team.git/                               a bare repo that holds only the team revision the trial pins
 *     saved/                                  the starting commit's agent files, put back where the agent left them as delivered
 */
const TrialReceiptSchema = z.object({
  v: z.literal(1),
  copy: z.string().min(1),
  root: z.string().min(1),
  state: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('preparing'), attempt: z.string().min(1) }).strict(),
    /**
     * A prompt lease handed to the driver, and once the engine accepted its report, the clone its check runs in.
     * `branch` is the copy's, which the prompt's `changes` name. `observed` is the clone as the trial's own install
     * delivered it: the team revision it pinned and the starting commit. `withhold` is what the lease withheld from the
     * tool, which git and whatever it starts in the clone never get either.
     */
    z.object({
      kind: z.literal('prepared'), attempt: z.string().min(1), branch: z.string().min(1), observed: ReportedAgentSchema, withhold: z.array(z.string()),
    }).strict(),
  ]),
}).strict();
type TrialReceipt = z.infer<typeof TrialReceiptSchema>;

export interface TrialNextOptions extends NextOptions {
  /** Stops setup or a check this call runs. The step stays leased, so the next call prepares or runs it again. */
  signal?: AbortSignal;
}

export const Trials = {
  /**
   * What `leaseNext` answers, except that no trial lease reaches the caller unprepared:
   *   - a check lease, or a baseline's, is run here, settled with its verdict, and the next lease is asked for;
   *   - a prompt lease comes back prepared, `{ data: { lease: { ...lease without workspace and setup, cwd } } }`, or,
   *     when preparation or setup fails, is settled failed (the trial's `error`) and the next lease is asked for;
   *   - `wait`, `hitl`, `done` and errors pass through unchanged.
   * teamai makes the workspace, runs setup and applies the env of everything it runs, so it declares those for the
   * caller. A stop through `signal` leaves the step leased and answers `interrupted`. Where `trialBlocker` says this
   * machine cannot pin the team, no trial is prepared: the run's only driver (`alone`) settles them all `not_run`, and
   * any other driver gets `team_ref_blocked` until the run ends.
   */
  async next(config: LocalConfig, runId: string, driver: DriverIdentity, options: TrialNextOptions): Promise<WorkflowEnvelope> {
    const { signal, ...next } = options;
    const run = await readRun(config, runId);
    // The engine's own answer for a run that is missing or unreadable.
    if (typeof run !== 'object') return leaseNext(config, runId, driver, next);
    if (!run.benchmark) {
      return error('invalid_arguments', `Run ${runId} is not a benchmark run, so it has no trials to prepare.`);
    }
    await Trials.sweep(config, runId);
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
    const sources = [...(run.checkout !== undefined ? [run.checkout] : []), commitCacheOf(config, run.benchmark.suite.repo)];
    const trial = { config, runId, driver, env, signal, sources, total: run.benchmark.trials.length };
    for (;;) {
      const answer = await leaseNext(config, runId, driver, { ...next, can, env, prepare: true });
      const leased = trialLeaseOf(answer);
      switch (leased.kind) {
        case 'none':
          if ('data' in answer && answer.data.done !== undefined) await Trials.sweep(config, runId);
          return answer;
        case 'unreadable':
          return error('run_unreadable', `Run ${runId} leased step "${leased.step}", which is not a trial step this teamai can prepare. Update teamai.`);
        case 'baseline': {
          const ran = await withCopy(receiptPath(config, runId, leased.lease.step), COPY_WAIT, () => runBaseline(trial, leased.lease));
          if (!ran.held) return copyBusy(leased.lease.step);
          if (ran.value) return ran.value;
          continue;
        }
        case 'check': {
          const ran = await withCopy(receiptPath(config, runId, trialCopyOf(leased.lease.trial)), COPY_WAIT, () => runTrialCheck(trial, leased.lease));
          if (!ran.held) return copyBusy(leased.lease.step);
          if (ran.value) return ran.value;
          continue;
        }
        case 'prompt': {
          const taken = await withCopy(receiptPath(config, runId, trialCopyOf(leased.lease.trial)), COPY_WAIT, () => takePrompt(trial, leased.lease, answer));
          if (!taken.held) return copyBusy(leased.lease.step);
          if (taken.value) return taken.value;
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
   * The report of a prompt trial `next` prepared, completed by teamai: it puts back the agent files the agent left as
   * delivered and commits the clone, so `changes` run from the starting commit and hold only the agent's edits. The
   * trial's `agent` is what teamai observed of the clone it prepared, plus what the driver observed of its tool. Settles
   * through `reportAttempt` with the stamp the engine requires on a trial report, holding the trial's copy
   * (`reportPrompt`). Once accepted, a succeeded prompt of a check task keeps its clone for the check, and every other
   * outcome removes it. A report of a check, or one that carries what teamai fills itself, is refused and leaves the
   * trial leased.
   */
  async report(config: LocalConfig, runId: string, report: ReportInput, secrets: Record<string, string>): Promise<WorkflowEnvelope> {
    const run = await readRun(config, runId);
    const leased = typeof run === 'object' ? run.steps.find((step) => step.status === 'leased' && step.attempt === report.attempt) : undefined;
    const terms = leased && typeof run === 'object' ? locateStep(run, leased.id)?.step.trial : undefined;
    // An attempt that is no longer leased gets the engine's own answer: stale, cancelled, or not this run's.
    if (!leased || typeof run !== 'object' || terms === undefined) return reportAttempt(config, runId, { ...report, trialReport: {} }, secrets);
    if (terms.kind !== 'prompt') {
      return error('invalid_report', `Step "${leased.id}" is a benchmark check, which teamai runs itself inside teamai workflow next --prepare. Report only the prompt leases next --prepare gives this driver.`);
    }
    const filled = TEAMAI_FILLS.filter((field) => report[field] !== undefined);
    if (filled.length > 0) {
      return error('invalid_report', `Prepared trial reports fill ${TEAMAI_FILLS.join('/')} automatically; omit ${filled.join('/')}`);
    }
    if (report.tool === undefined) {
      return error('invalid_report', `The report of trial step "${leased.id}" names no tool. Send tool with the tool the driver launched: ${terms.tool} for this trial.`);
    }
    if (report.limit !== undefined && !setsLimit(terms.limits, report.limit)) {
      return error('invalid_report', `The report of trial step "${leased.id}" names limit ${report.limit}, which its suite's trial does not set. Send limit only for a limit in the lease's trial.limits that stopped the tool.`);
    }
    const file = receiptPath(config, runId, trialCopyOf(terms));
    const reported = await withCopy(file, COPY_WAIT, () => reportPrompt({ config, runId, report, secrets, file, terms }));
    return reported.held ? reported.value : copyBusy(leased.id);
  },

  /**
   * Removes the root and the receipt of every trial copy that no longer needs them: its run is not running, or no step
   * of its copy is still to settle. The evidence a report staged for a pass of its prompt that did not succeed goes too,
   * as no judge reads it. `runId` limits it to one run. A receipt this teamai cannot read is kept.
   */
  async sweep(config: LocalConfig, runId?: string): Promise<void> {
    const runs = runId !== undefined
      ? [runId]
      : (await fs.readdir(runsDir(config), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    for (const id of runs) {
      const dir = path.join(runsDir(config), id, 'trials');
      const files = await fs.readdir(dir).catch((): string[] => []);
      if (files.length === 0) continue;
      for (const name of files.filter((entry) => entry.endsWith('.json'))) {
        const file = path.join(dir, name);
        // A copy another call holds is in use: a later sweep sees it again.
        await withCopy(file, COPY_NOW, async () => {
          const receipt = await readReceipt(file);
          if (!receipt) {
            log.debug(`Kept trial receipt ${file}: this teamai cannot read it.`);
            return;
          }
          const run = await readRun(config, id);
          const open = typeof run === 'object' && run.status === 'running'
            && run.steps.some((step) => (step.id === receipt.copy || step.id.startsWith(`${receipt.copy}.`)) && !settled(step));
          if (open) return;
          await removeRoot({ file, root: receipt.root });
          if (typeof run === 'object') await removeUnjudgedEvidence(config, run, receipt.copy);
        });
      }
    }
  },
} as const;

/**
 * Removes the evidence staged for each pass of `copy`'s prompt that did not succeed. A report removes it itself unless it
 * was stopped between staging the evidence and the engine's answer; then the prompt never settles from that report.
 */
async function removeUnjudgedEvidence(config: LocalConfig, run: RunState, copy: string): Promise<void> {
  const step = run.benchmark?.trials.find((trial) => trialCopyOf(trial) === copy)?.step;
  if (step === undefined) return;
  const passes = runPasses(run).filter((pass) => pass.step === step);
  const succeeded = new Set(passes.filter((pass) => pass.outcome === 'success').map((pass) => pass.pass));
  const staged = new Set([...passes.map((pass) => pass.pass), run.steps.find((state) => state.id === step)?.pass ?? 1]);
  await removeSubjectEvidence(scoresDir(config), [...staged].filter((pass) => !succeeded.has(pass)).map((pass) => ({ runId: run.id, step, pass })));
}

/** What an accepted report answers of the step it settled. */
const AcceptedSchema = z.object({ step: z.object({ outcome: z.string() }) });

/**
 * A prompt trial's report, holding its copy. The engine's refusal of another revision, another driver, or an attempt no
 * longer leased comes before the clone changes. Before the engine accepts the report, all that a reader of the settled
 * prompt reads exists: the commit, and the evidence its judges read. A refusal leaves the clone and the receipt for the
 * report sent again, which finds the agent files put back and the work committed, and commits nothing twice. So a
 * report stopped at any point leaves the prompt leased with its work, or settled with all its check and judges read.
 */
async function reportPrompt({ config, runId, report, secrets, file, terms }: {
  config: LocalConfig; runId: string; report: ReportInput; secrets: Record<string, string>; file: string; terms: PromptTerms;
}): Promise<WorkflowEnvelope> {
  const run = await readRun(config, runId);
  const leased = typeof run === 'object' ? leasedStep(run, report.attempt) : undefined;
  const owned = typeof run === 'object' && leased !== undefined && run.cancelledAttempts?.includes(report.attempt) !== true
    && leased.lease.revision === report.revision && sameDriver(leased.lease.driver, report.driver);
  if (typeof run !== 'object' || !leased || !owned) {
    return reportAttempt(config, runId, { ...report, trialReport: {} }, secrets);
  }
  const receipt = await readReceipt(file);
  if (receipt?.state.kind !== 'prepared' || receipt.state.attempt !== report.attempt) {
    return error('invalid_report', `Attempt ${report.attempt} of step "${leased.id}" has no prepared trial on this machine. Ask for it with teamai workflow next --prepare, and report the lease that answers.`);
  }
  const saved = path.join(receipt.root, 'saved');
  const scoped = await stepEnvironment(new Map(), { provide: [], withhold: receipt.state.withhold });
  if (!scoped.ok) return { error: scoped.failure };
  const clone = trialClone(receipt.root, scoped.env, leaseDeadline(run, leased));
  // Only putting the agent files back removes `saved`, so a report sent again finds them back already.
  const unrestored = report.outcome === 'released' || !await isDirectory(saved) ? undefined : await restoreUneditedConfig(clone.dir, terms.startingCommit, saved, clone.git);
  const committed = report.outcome === 'released' || unrestored !== undefined ? undefined : await commitWork(clone.dir, `teamai: ${leased.id}`, terms.startingCommit, clone.git);
  const failure: WorkflowFailure | undefined = unrestored !== undefined
    ? { code: 'workspace_base', message: `Trial step "${leased.id}" ran, but the team assets delivered into its clone could not be told apart from its edits, so nothing was committed: ${unrestored}` }
    : committed && 'error' in committed
      ? { code: 'workspace_base', message: `Trial step "${leased.id}" ran, but its work could not be committed in its clone: ${committed.error}` }
      : undefined;
  const changes = committed && !('error' in committed) ? { branch: receipt.state.branch, base: terms.startingCommit, ...committed } : undefined;
  const evidence = report.outcome === 'success' && !failure ? await stageJudgeEvidence(config, run, { leased, report, changes, clone, env: scoped.env }) : undefined;
  // A limit goes only with a prompt that succeeded: the failure to keep its work replaces both.
  const { limit, ...unlimited } = report;
  const answer = await reportAttempt(config, runId, {
    ...unlimited,
    ...(failure ? { outcome: 'failed', message: failure.message, failure } : limit !== undefined ? { limit } : {}),
    ...(changes ? { changes } : {}),
    agent: trialAgent(receipt.state.observed, terms, report),
    trialReport: {},
  }, secrets);
  const outcome = AcceptedSchema.safeParse('data' in answer ? answer.data : undefined).data?.step.outcome;
  // No judge reads the evidence of a prompt that did not succeed, and nothing else removes it.
  if (evidence !== undefined && outcome !== 'success') await fs.rm(evidence, { recursive: true, force: true, maxRetries: 3 });
  const hasCheck = run.benchmark?.tasks.find((task) => task.id === terms.task)?.judge === 'check';
  if (outcome !== undefined && (outcome !== 'success' || !hasCheck)) await removeRoot({ file, root: receipt.root });
  return answer;
}

/**
 * The evidence the judges of a succeeded trial prompt read, collected from its clone and the session that ran there
 * before the engine settles the prompt, wherever the driver runs, with git getting only `env` there. A judge never
 * reads the clone itself, which is gone by then. Answers the directory, or undefined when the prompt's step lists no
 * scorer the run pinned. A clone that gave no evidence leaves the directory empty, so its entries close `evidence_empty`.
 */
async function stageJudgeEvidence(config: LocalConfig, run: RunState, { leased, report, changes, clone, env }: {
  leased: LeasedStep; report: ReportInput; changes: RunPass['changes']; clone: TrialClone; env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const pinned = run.scorers ?? {};
  if (!(locateStep(run, leased.id)?.step.scorers?.names ?? []).some((name) => Object.hasOwn(pinned, name))) return undefined;
  const subject = { runId: run.id, step: leased.id, pass: leased.pass ?? 1 };
  const dir = subjectEvidenceDirOf(scoresDir(config), subject);
  // A report of this pass that was refused or stopped filled it, maybe from another commit.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  const settling: RunPass = {
    step: leased.id, pass: subject.pass, attempt: report.attempt, outcome: 'success', tool: report.tool, session: report.session,
    ...(changes ? { changes } : {}), ...(report.outputs !== undefined ? { outputs: report.outputs } : {}),
  };
  const collected = await collectEvidence(config, run, subject, dir, { checkout: clone.dir, sessionCwd: clone.dir, untrustedEnv: env, settling })
    .catch((e: unknown) => {
      log.warn(`The judge evidence of trial step "${leased.id}" could not be collected, so its judges find none: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false } as const;
    });
  if (!collected.ok) await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  return dir;
}

/**
 * Where start keeps the starting commits of `repo` this member's checkout lacks, such as a shallow CI checkout's, for a
 * trial's clone to fetch offline, and the commits it makes of the suite files a check writes, which no repo holds and
 * nothing can fetch again. Safe to delete only while no run of `repo` is open; the next start fills it again.
 */
export function commitCacheOf(config: LocalConfig, repo: string): string {
  return path.join(getDataHome(config), 'benchmarks', 'objects', `${createHash('sha256').update(repo).digest('hex').slice(0, 16)}.git`);
}

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
 * Each arm's reasons are `trialGaps`, the rule that holds its trials, so a printed reason and a held trial agree.
 */
export function benchmarkNotices(plan: BenchmarkPlan, can: Pick<DriverCan, 'trials' | 'isolation'>, blocked: string | undefined): string[] {
  const gaps = plan.arms.map((arm) => ({ arm, missing: trialGaps({ tool: arm.tool }, can, true) }));
  return [
    ...(blocked !== undefined ? [blocked] : []),
    ...(gaps.some(({ missing }) => missing.includes('sandbox'))
      ? ['This machine is not declared a sandbox, so benchmark trials did not run. Run benchmarks in CI or a container, and declare it with --sandbox.']
      : []),
    ...gaps.filter(({ missing }) => missing.includes('trials'))
      .map(({ arm }) => `Arm "${arm.name}" uses ${arm.tool}, which the local driver cannot run, so its trials did not run.`),
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
const PromptLeaseSchema = z.object({ ...LeaseBase, trial: PromptTermsSchema, prompt: z.string() }).passthrough();
const CheckLeaseSchema = z.object({ ...LeaseBase, trial: CheckTermsSchema, command: z.string() }).passthrough();
const BaselineLeaseSchema = z.object({ ...LeaseBase, trial: BaselineTermsSchema, command: z.string() }).passthrough();
type PromptLease = z.infer<typeof PromptLeaseSchema>;
type CheckLease = z.infer<typeof CheckLeaseSchema>;
type BaselineLease = z.infer<typeof BaselineLeaseSchema>;

type TrialLease =
  | { kind: 'prompt'; lease: PromptLease }
  | { kind: 'check'; lease: CheckLease }
  | { kind: 'baseline'; lease: BaselineLease }
  /** The answer holds no lease. */
  | { kind: 'none' }
  /** A lease that is not a trial step: only compilePlan writes a benchmark's steps, so a newer teamai wrote this one. */
  | { kind: 'unreadable'; step: string };

/** `leaseData` builds the lease as a plain record, so it is parsed here, once, into the kind teamai runs. */
function trialLeaseOf(answer: WorkflowEnvelope): TrialLease {
  const raw = 'data' in answer ? answer.data.lease : undefined;
  if (raw === undefined) return { kind: 'none' };
  const prompt = PromptLeaseSchema.safeParse(raw);
  if (prompt.success) return { kind: 'prompt', lease: prompt.data };
  const check = CheckLeaseSchema.safeParse(raw);
  if (check.success) return { kind: 'check', lease: check.data };
  const baseline = BaselineLeaseSchema.safeParse(raw);
  if (baseline.success) return { kind: 'baseline', lease: baseline.data };
  const step = z.object({ step: z.string() }).safeParse(raw);
  return { kind: 'unreadable', step: step.success ? step.data.step : '(unknown)' };
}

/** What one call of `Trials.next` works with. */
interface TrialCall {
  config: LocalConfig;
  runId: string;
  driver: DriverIdentity;
  env: WorkflowEnv;
  signal: AbortSignal | undefined;
  /** Where a clone fetches the task's starting commit from: the run's checkout, then the commit cache. */
  sources: string[];
  /** The plan's trial count, for progress lines. */
  total: number;
}

type Prepared =
  | { ok: true; cwd: string; receipt: ReceiptFile }
  | { ok: false; failure: WorkflowFailure; receipt: ReceiptFile };

/** A receipt's file and the root it names. */
interface ReceiptFile {
  file: string;
  root: string;
}

/**
 * A prompt lease, holding its copy: the driver's lease once prepared, `interrupted`, or the engine's refusal of the
 * failed preparation it settled. Undefined when the next lease is to be asked for: preparation failed and was settled,
 * or the lease ended before this call held the copy.
 */
async function takePrompt(trial: TrialCall, lease: PromptLease, answer: WorkflowEnvelope): Promise<WorkflowEnvelope | undefined> {
  if (!await stillLeased(trial, lease.attempt)) return undefined;
  const prepared = await preparePrompt(trial, lease);
  if (trial.signal?.aborted) {
    await removeRoot(prepared.receipt);
    return interrupted(trial.runId, lease.step);
  }
  if (!prepared.ok) {
    const refused = await settle(trial, lease, { outcome: 'failed', message: prepared.failure.message, failure: prepared.failure, trialReport: {} });
    progress(trial, lease.trial, { kind: 'error', failure: prepared.failure });
    await removeRoot(prepared.receipt);
    return refused;
  }
  progress(trial, lease.trial, { kind: 'ready', tool: lease.trial.tool });
  return { data: { ...('data' in answer ? answer.data : {}), lease: driverLease(lease, prepared.cwd) } };
}

/**
 * receipt (preparing), then any earlier root of this copy removed, then the fresh clone, the trial's own install, setup
 * and what the clone ran as, then receipt (prepared).
 */
async function preparePrompt(trial: TrialCall, lease: PromptLease): Promise<Prepared> {
  const copy = trialCopyOf(lease.trial);
  const file = receiptPath(trial.config, trial.runId, copy);
  const earlier = await readReceipt(file);
  if (earlier) await removeRoot({ file, root: earlier.root });
  const root = newRoot();
  const receipt = { file, root };
  await writeReceipt(file, { v: 1, copy, root, state: { kind: 'preparing', attempt: lease.attempt } });
  progress(trial, lease.trial, { kind: 'preparing' });
  const withhold = (lease.envScope ?? NO_ENV).withhold;
  const scoped = await stepEnvironment(new Map(), { provide: [], withhold });
  if (!scoped.ok) return { ok: false, failure: scoped.failure, receipt };
  const clone = trialClone(root, scoped.env, lease.expiresAt);
  const cloned = await freshClone(root, lease.trial.startingCommit, trial.sources);
  if (cloned) return { ok: false, failure: cloned, receipt };
  const installed = await prepareInstall(trial, root, lease);
  if (!installed.ok) return { ok: false, failure: installed.failure, receipt };
  const setupFailed = lease.setup ? await setupIn(trial, clone.dir, lease.setup, lease.expiresAt) : undefined;
  if (setupFailed) return { ok: false, failure: setupFailed, receipt };
  const status = await clone.git(clone.dir, [...HEAD_STATUS]);
  const head = status.code === 0 ? headStateOf(status.stdout) : null;
  const observed = await observeCheckout({ config: installed.config, tool: lease.trial.tool, cwd: clone.dir, head });
  await writeReceipt(file, { v: 1, copy, root, state: { kind: 'prepared', attempt: lease.attempt, branch: lease.workspace.branch, observed, withhold } });
  return { ok: true, cwd: clone.dir, receipt };
}

const TrialCloneSchema = z.object({ dir: z.string().min(1), git: z.custom<Git>((value) => typeof value === 'function') }).brand<'TrialClone'>();
/**
 * A prompt trial's clone, where setup and then the tool run, with the only git that runs there: `untrustedGit` with the
 * trial's env, so nothing their files or config make git start sees what the trial withholds, stopped at the run's
 * `expiresAt`. Only `trialClone` makes one.
 */
type TrialClone = z.infer<typeof TrialCloneSchema>;

function trialClone(root: string, env: NodeJS.ProcessEnv, expiresAt: string | undefined): TrialClone {
  return TrialCloneSchema.parse({ dir: path.join(root, 'r'), git: untrustedGit(env, expiresAt) });
}

/**
 * A fresh clone with its own `.git`, no remotes and no refs, at a detached HEAD, its hooks pointed at a directory that
 * does not exist. The commit comes from the first of `sources` that has it. Every git call is an argv array: no shell
 * string.
 */
async function freshClone(root: string, startingCommit: string, sources: readonly string[]): Promise<WorkflowFailure | undefined> {
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.mkdir(root);
  const clone = path.join(root, 'r');
  const made = await git(root, ['init', '-q', '--template=', clone]);
  const configured = made.code === 0 ? await git(clone, ['config', 'core.hooksPath', path.join(root, 'no-hooks')]) : made;
  if (configured.code !== 0) {
    return { code: 'trial_prepare_failed', message: `The trial's clone could not be made in ${root}: ${configured.stderr.trim()}` };
  }
  const said: string[] = [];
  for (const source of sources) {
    if (!await isDirectory(source)) continue;
    const fetched = await git(clone, ['fetch', '-q', '--no-tags', source, startingCommit]);
    if (fetched.code === 0) {
      const checkedOut = await git(clone, ['checkout', '-q', '--detach', startingCommit]);
      return checkedOut.code === 0
        ? undefined
        : { code: 'trial_prepare_failed', message: `The trial's clone could not check out ${startingCommit}: ${checkedOut.stderr.trim()}` };
    }
    said.push(`${source}: ${fetched.stderr.trim()}`);
  }
  return { code: 'trial_prepare_failed', message: `Commit ${startingCommit} could not be fetched into the trial's clone (${said.join('; ') || 'no checkout to fetch it from'}). Fetch it into the checkout the benchmark started in, or fix the task's startingCommit, and start the benchmark again.` };
}

/** The env variables that move a tool's home away from HOME, which the trial's own pull must not follow. */
const TOOL_HOME_VARIABLES = [...new Set(Object.keys(TOOLS).filter(isToolId).flatMap(homeVariables))];

/** How long the trial's own `teamai pull` may take: it fetches only from the trial's root. */
const TRIAL_PULL_TIMEOUT_MS = 10 * 60_000;

/**
 * The trial's own teamai install at the arm's team revision, offline, with nothing written outside `root`: a bare repo
 * holding only that revision, fetched from the member's team clone; the trial's team clone of it; the trial's partition
 * config, written from the frozen selection with every per-machine knob off; then `teamai pull --team-ref` as a child
 * whose HOME is `<root>/h`, so the hooks, shell profiles and env registry a workspace pull writes under HOME land there.
 * The git hooks that pull writes into the clone go again, so neither teamai nor the agent's git runs teamai during the
 * trial, and the delivered files are recorded as the overlay, so they are never the agent's edits.
 */
async function prepareInstall(trial: TrialCall, root: string, lease: PromptLease): Promise<{ ok: true; config: LocalConfig } | { ok: false; failure: WorkflowFailure }> {
  const failed = (message: string): { ok: false; failure: WorkflowFailure } => ({ ok: false, failure: { code: 'trial_prepare_failed', message } });
  const { teamRevision, tool, selection } = lease.trial;
  const clone = path.join(root, 'r');
  const saved = path.join(root, 'saved');
  await fs.mkdir(saved);
  await saveConfig(clone, saved);
  const anchors = await resolveAnchors(clone);
  if (!anchors) return failed(`The trial's clone ${clone} is not a git repository teamai can install into.`);
  const home = path.join(root, 'h');
  const partition = path.join(home, '.teamai', 'projects', projectSlug(anchors.projectAnchor));
  const member = trial.config.repo.localPath;
  const bare = path.join(root, 'team.git');
  const team = path.join(partition, 'team-repo');
  const branch = await getDefaultBranch(member);
  const steps: Array<{ cwd: string; args: string[] }> = [
    { cwd: root, args: ['init', '-q', '--bare', bare] },
    { cwd: bare, args: ['fetch', '-q', '--no-tags', member, `${teamRevision}:refs/heads/${branch}`] },
    { cwd: bare, args: ['symbolic-ref', 'HEAD', `refs/heads/${branch}`] },
    { cwd: root, args: ['clone', '-q', '--no-local', bare, team] },
  ];
  for (const { cwd, args } of steps) {
    const ran = await git(cwd, args);
    if (ran.code !== 0) return failed(`Team revision ${teamRevision} could not be copied from ${member} for the trial (git ${args[0]}): ${ran.stderr.trim()}`);
  }
  const config: LocalConfig = {
    repo: { localPath: team, remote: trial.config.repo.remote, kind: 'git' },
    username: trial.config.username, provider: 'git', scope: 'project', projectRoot: anchors.workspaceRoot, dataHome: partition,
    ...(selection.primaryRole ? { primaryRole: selection.primaryRole } : {}),
    additionalRoles: selection.additionalRoles, projects: selection.projects, excludedSkills: selection.excludedSkills,
    ...(selection.subscribedTags ? { subscribedTags: selection.subscribedTags } : {}),
    enabledAgents: [tool],
    recallEnabled: false, contributeHintEnabled: false, mrHintEnabled: false, usageReportEnabled: false, coAuthorEnabled: false, codexTrustEnabled: false,
  };
  await saveLocalConfigForScope(config);
  await createProjectToolRoots({ config, tools: [tool] });
  const entry = resolveCliEntry();
  if (!entry) return failed('The teamai CLI that runs this benchmark could not be found, so the trial\'s own teamai pull could not run.');
  const scoped = await stepEnvironment(trial.env.values, { provide: [], withhold: lease.envScope?.withhold ?? [] });
  if (!scoped.ok) return { ok: false, failure: scoped.failure };
  const env: NodeJS.ProcessEnv = { ...scoped.env, HOME: home, USERPROFILE: home };
  for (const name of TOOL_HOME_VARIABLES) delete env[name];
  // The run's deadline bounds the pull too, so a slow one does not hold the run past its timeout.
  const timeoutMs = lease.expiresAt === undefined ? TRIAL_PULL_TIMEOUT_MS : Math.max(0, Math.min(TRIAL_PULL_TIMEOUT_MS, Date.parse(lease.expiresAt) - Date.now()));
  const pulled = await execCommand(process.execPath, [entry, 'pull', '--team-ref', teamRevision], { cwd: clone, env, timeoutMs })
    .catch((error: unknown) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
  if (pulled.code !== 0) {
    const tail = (pulled.stderr.trim() || pulled.stdout.trim()).slice(-500);
    return failed(`teamai pull --team-ref ${teamRevision.slice(0, 7)} exited ${pulled.code}: ${tail}`);
  }
  try {
    await removeGitHook(clone);
  } catch (error) {
    return failed(`The git hooks the trial's own teamai pull installed in ${clone} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await recordConfigOverlay(clone, saved);
  return { ok: true, config };
}

/** Setup with only its own keys, as the lease scopes them. */
async function setupIn(trial: Runner, dir: string, setup: LeaseSetup, expiresAt: string | undefined): Promise<WorkflowFailure | undefined> {
  const scope = setup.envScope ?? NO_ENV;
  const scoped = await stepEnvironment(trial.env.values, scope);
  if (!scoped.ok) return scoped.failure;
  return runSetup({ command: setup.command, dir, env: scoped.env, keys: scope.provide, ...(trial.signal ? { signal: trial.signal } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) });
}

/**
 * The trial's check, holding its copy, in the clone its prompt's accepted report left, on the protected paths as the
 * starting commit has them, settled with its verdict. Then the root goes, unless the engine refused the settlement, so
 * the check stays leased and runs again there. Answers an envelope only when the call must stop: the stop signal, or a
 * report the engine refused.
 */
async function runTrialCheck(trial: TrialCall, lease: CheckLease): Promise<WorkflowEnvelope | undefined> {
  if (!await stillLeased(trial, lease.attempt)) return undefined;
  const file = receiptPath(trial.config, trial.runId, trialCopyOf(lease.trial));
  const receipt = await readReceipt(file);
  // Only an accepted report of the prompt lets the engine lease its check, so a prepared clone here is that report's.
  const clone = receipt?.state.kind === 'prepared' ? path.join(receipt.root, 'r') : undefined;
  const ran = clone && await isDirectory(clone)
    ? await checkIn(trial, lease, clone, async (env) => await restoreProtected({ clone, startingCommit: lease.trial.startingCommit, protect: lease.trial.protect, sources: trial.sources, env })
      ?? (lease.trial.add ? await writeAdded({ clone, add: lease.trial.add, sources: trial.sources, env }) : undefined))
    : { kind: 'error' as const, failure: { code: 'trial_prepare_failed', message: `The clone of trial ${trialCopyOf(lease.trial)} is gone, so its check could not run.` } };
  if (trial.signal?.aborted) return interrupted(trial.runId, lease.step);
  const settled = await settle(trial, lease, ran.kind === 'check'
    ? { ...checkSettlement(ran.verdict), trialReport: { verdict: ran.verdict } }
    : { outcome: 'failed', message: ran.failure.message, failure: ran.failure, trialReport: {} });
  progress(trial, lease.trial, ran);
  if (receipt && !settled) await removeRoot({ file, root: receipt.root });
  return settled;
}

/**
 * A check task's baseline: the files check.add writes, setup, then its check, once, in a fresh clone of the starting
 * commit with no team assets, as no agent runs there. A check that ran to the end outputs whether it passes or fails,
 * which the task's trials read; one that could not run, or whose clone or setup failed, fails the step with no output.
 * Then the root goes.
 */
async function runBaseline(trial: TrialCall, lease: BaselineLease): Promise<WorkflowEnvelope | undefined> {
  if (!await stillLeased(trial, lease.attempt)) return undefined;
  const file = receiptPath(trial.config, trial.runId, lease.step);
  const earlier = await readReceipt(file);
  if (earlier) await removeRoot({ file, root: earlier.root });
  const root = newRoot();
  await writeReceipt(file, { v: 1, copy: lease.step, root, state: { kind: 'preparing', attempt: lease.attempt } });
  const clone = path.join(root, 'r');
  const ran = await checkIn(trial, lease, clone, async (env) => await freshClone(root, lease.trial.startingCommit, trial.sources)
    ?? (lease.trial.add ? await writeAdded({ clone, add: lease.trial.add, sources: trial.sources, env }) : undefined)
    ?? (lease.setup ? await setupIn(trial, clone, lease.setup, lease.expiresAt) : undefined));
  if (trial.signal?.aborted) return interrupted(trial.runId, lease.step);
  const settled = await settle(trial, lease, ran.kind === 'check'
    ? { ...baselineSettlement(ran.verdict), trialReport: { verdict: ran.verdict } }
    : { outcome: 'failed', message: ran.failure.message, failure: ran.failure, trialReport: {} });
  baselineProgress(lease.trial.task, ran);
  await removeRoot({ file, root });
  return settled;
}

/** How a check went: its verdict, or why it never ran. */
export type CheckRun = Extract<ProgressEvent, { kind: 'check' | 'error' }>;

/** What running setup or a check reads of a call: the env values it gives and the signal that stops it. */
type Runner = { env: Pick<WorkflowEnv, 'values'>; signal: AbortSignal | undefined };

/**
 * `prepare`, then the check command in `clone` with the lease's env, bounded by the run's deadline. `prepare` gets that
 * env too, which is all the agent's code gets once the check runs it. A caller tells a stopped call from its verdict by
 * its signal.
 */
async function checkIn(trial: Runner, lease: Pick<CheckLease, 'command' | 'envScope' | 'expiresAt'>, clone: string, prepare: (env: NodeJS.ProcessEnv) => Promise<WorkflowFailure | undefined>): Promise<CheckRun> {
  const scoped = await stepEnvironment(trial.env.values, lease.envScope ?? NO_ENV);
  if (!scoped.ok) return { kind: 'error', failure: scoped.failure };
  const failure = await prepare(scoped.env);
  if (failure) return { kind: 'error', failure };
  const { exit } = await runShellCommand({
    command: lease.command, cwd: clone, env: scoped.env,
    ...(trial.signal ? { signal: trial.signal } : {}), ...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}),
  });
  return { kind: 'check', verdict: checkVerdict(exit, process.platform) };
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
  const runner: Runner = { env: { values: new Map(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) }, signal: input.signal };
  const withhold = [...TRIAL_WITHHELD_ENV];
  const leaseSetup = setup ? { command: setup.command, envScope: { provide: setup.requires?.env ?? [], withhold } } : undefined;
  const root = newRoot();
  const clone = path.join(root, 'r');
  try {
    const written = async (env: NodeJS.ProcessEnv): Promise<WorkflowFailure | undefined> => (add ? await writeAdded({ clone, add, sources, env }) : undefined);
    return await checkIn(runner, { command: input.command, envScope: { provide: [], withhold }, expiresAt }, clone, async (env) => await freshClone(root, commit, sources)
      ?? (protect ? undefined : await written(env))
      ?? (leaseSetup ? await setupIn(runner, clone, leaseSetup, expiresAt) : undefined)
      ?? (protect ? await restoreProtected({ clone, startingCommit, protect, sources, env }) ?? await written(env) : undefined));
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
 * back. Git gets `env` and starts nothing the clone configures. Undefined once restored.
 */
export async function restoreProtected({ clone, startingCommit, protect, sources, env }: {
  clone: string; startingCommit: string; protect: readonly string[]; sources: readonly string[]; env: NodeJS.ProcessEnv;
}): Promise<WorkflowFailure | undefined> {
  const specs = protect.map((entry) => `:(glob)${entry}`);
  const failed = (step: string, stderr: string): WorkflowFailure => ({ code: 'trial_prepare_failed', message: `The protected paths of the clone in ${clone} could not be put back as ${startingCommit} has them (git ${step}): ${stderr.trim()}` });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-protect-'));
  // A source's own hooks stay off too: writing an index starts its post-index-change hook.
  const starting = untrustedGit({ ...env, GIT_INDEX_FILE: path.join(dir, 'index') });
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
    const cloneGit = untrustedGit(env);
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
 * `restoreProtected` checks its own. Undefined once every entry is written.
 */
async function writeAdded({ clone, add, sources, env }: {
  clone: string; add: readonly Added[]; sources: readonly string[]; env: NodeJS.ProcessEnv;
}): Promise<WorkflowFailure | undefined> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-add-'));
  const fixed = untrustedGit({ ...env, GIT_INDEX_FILE: path.join(dir, 'index') });
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

/** The settlement teamai reports for a check it ran: one mapping from the verdict, never derived again later. */
function checkSettlement(verdict: CheckVerdict): Pick<ReportInput, 'outcome' | 'exitCode' | 'failure' | 'message'> {
  switch (verdict.verdict) {
    case 'passed':
      return { outcome: 'success', exitCode: 0 };
    case 'failed':
      return { outcome: 'failed', exitCode: verdict.exitCode, message: `check exited with code ${verdict.exitCode}` };
    case 'could_not_run': {
      if (verdict.cause !== 'timeout') return { outcome: 'failed', message: `The check could not run (${verdict.cause}${verdict.detail ? `: ${verdict.detail}` : ''}).` };
      const message = 'The check did not finish before the run timeout.';
      return { outcome: 'failed', message, failure: { code: 'timeout', message } };
    }
    default: {
      const unhandled: never = verdict;
      return unhandled;
    }
  }
}

/** Reports what teamai did with a lease. Answers the engine's refusal, except a cancel: the next lease call shows it. */
async function settle(trial: TrialCall, lease: Pick<PromptLease, 'attempt' | 'revision'>, body: Omit<ReportInput, 'attempt' | 'revision' | 'driver'>): Promise<WorkflowEnvelope | undefined> {
  const answer = await reportAttempt(trial.config, trial.runId, { attempt: lease.attempt, revision: lease.revision, driver: trial.driver, ...body }, trial.env.secrets);
  return 'error' in answer && answer.error.code !== 'lease_cancelled' ? answer : undefined;
}

function interrupted(runId: string, step: string): WorkflowEnvelope {
  return error('interrupted', `Stopped while step "${step}" was prepared or checked. It stays leased to this driver: call teamai workflow next ${runId} --prepare again, and teamai prepares it from the start.`);
}

/**
 * The trial's `agent`: the team revision and project commit teamai observed of the clone it prepared, whatever the
 * member's checkout pulled since and whatever the driver says; of what the driver sent, only what it observed of its
 * tool. The model and effort it was asked to run are the plan's.
 */
function trialAgent(observed: ReportedAgent, terms: PromptTerms, report: ReportInput): ReportedAgent {
  const sent = report.agent;
  return {
    ...(observed.team ? { team: observed.team } : {}),
    ...(observed.project ? { project: observed.project } : {}),
    ...(sent?.tool?.version ? { tool: { version: sent.tool.version } } : {}),
    model: { ...(terms.model ? { requested: terms.model } : {}), ...(sent?.model?.reported ? { reported: sent.model.reported } : {}) },
    effort: { ...(terms.effort ? { requested: terms.effort } : {}), ...(sent?.effort?.reported ? { reported: sent.effort.reported } : {}) },
  };
}

/** A baseline's settlement: success with its output when the check ran to the end, as a trial check's otherwise. */
function baselineSettlement(verdict: CheckVerdict): Pick<ReportInput, 'outcome' | 'exitCode' | 'failure' | 'message' | 'outputs'> {
  const outputs = baselineOutput(verdict);
  return outputs ? { outcome: 'success', outputs } : checkSettlement(verdict);
}

/** The lease a driver sees: no `workspace`, `setup` or `command`, with `cwd`. */
function driverLease(lease: PromptLease, cwd: string): PreparedTrialLease {
  const { workspace: _workspace, setup: _setup, ...rest } = lease;
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

function progress({ total }: TrialCall, { order, task, arm }: Extract<TrialTerms, { kind: 'prompt' | 'check' }>, event: ProgressEvent): void {
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

/** A root no receipt names yet, short on purpose: Windows paths. */
function newRoot(): string {
  return path.join(os.tmpdir(), 'teamai-trials', randomBytes(3).toString('hex'));
}

/** How long a call waits for another to let go of a trial copy before it answers busy. */
const COPY_WAIT = { attempts: 40, delayMs: 25 };
/** The sweep does not wait: a copy another call holds is in use. */
const COPY_NOW = { attempts: 1, delayMs: 0 };

/**
 * Runs `body` as the one call, of any process, on the trial copy or baseline whose receipt is `file`. Preparing,
 * reporting, checking and sweeping each hold it, and each checks under it that the attempt it acts for is still leased,
 * so none removes or replaces a root another call made or still uses. Never the run lock: preparation takes minutes.
 */
function withCopy<T>(file: string, wait: { attempts: number; delayMs: number }, body: () => Promise<T>): Promise<{ held: true; value: T } | { held: false }> {
  return withFileLock(`${file}.lock`, wait, body);
}

function copyBusy(step: string): WorkflowEnvelope {
  return error('busy', `Another teamai call is preparing, reporting or checking trial step "${step}" on this machine. Ask again once it answers.`);
}

function leasedStep(run: RunState, attempt: string): LeasedStep | undefined {
  return run.steps.find((step): step is LeasedStep => step.status === 'leased' && step.attempt === attempt);
}

/** Whether `attempt` is still leased, read once this call holds its copy. */
async function stillLeased(trial: TrialCall, attempt: string): Promise<boolean> {
  const run = await readRun(trial.config, trial.runId);
  return typeof run === 'object' && leasedStep(run, attempt) !== undefined;
}

function receiptPath(config: LocalConfig, runId: string, copy: string): string {
  return path.join(runsDir(config), runId, 'trials', `${copy}.json`);
}

/** The receipt in `file`; undefined when there is none, or one this teamai cannot read. */
async function readReceipt(file: string): Promise<TrialReceipt | undefined> {
  const parsed = TrialReceiptSchema.safeParse(await readJson(file));
  return parsed.success ? parsed.data : undefined;
}

async function writeReceipt(file: string, receipt: TrialReceipt): Promise<void> {
  await writeJsonAtomic(file, receipt);
}

/** The root, then the receipt that names it. rm retries a busy file, as Windows reports one still being closed. */
async function removeRoot({ file, root }: ReceiptFile): Promise<void> {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  await fs.rm(file, { force: true });
}

async function isDirectory(dir: string): Promise<boolean> {
  return (await fs.stat(dir).catch(() => undefined))?.isDirectory() === true;
}
