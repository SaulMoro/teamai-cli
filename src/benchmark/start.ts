/**
 * `teamai workflow start <suite> --benchmark`: the shell around plan.ts. Every refusal is an error envelope before a
 * run exists, so a refused start leaves no run and no record. Each refusal says what happened and what to do.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isLabelShaped, isNameShaped, observeCheckout } from '../agent-observation.js';
import { loadLocalConfigForScope } from '../config.js';
import { isModelAlias, loadModelAliases, loadTeamModelAliases, noModelCause, noModelReason, resolveModelValue, type ModelAliases, type ModelResolution, type NoModel } from '../models/aliases.js';
import { pinScorers } from '../scorers/cache.js';
import { resolveTeamRef, TeamRefError } from '../team-ref.js';
import { isAgentToolId } from '../tools.js';
import type { LocalConfig } from '../types.js';
import { loadCachedSuite, readSuiteFiles, withTeamRevision } from '../workflow/cache.js';
import { createRun, error } from '../workflow/engine.js';
import { judgeUnavailable } from '../workflow/scoring.js';
import type { DriverIdentity, RunState, WorkflowEnvelope } from '../workflow/types.js';
import type { DriverCan } from '../workflow/requirements.js';
import { formatDiagnostic } from '../workflow/parse.js';
import { git } from '../workflow/worktree.js';
import { addedOf, compilePlan, freezePlan, runSourceHash, type PlannedArm } from './plan.js';
import { parseSuite, type Arm, type Suite, type TaskJudge } from './suite.js';
import type { TeamSelection } from '../workflow/clone.js';
import type { Added, ArmTeam } from './terms.js';
import { commitCacheOf } from '../workflow/place/place.js';
import { commitCheckFiles, tryCheckAt, type CheckRun } from './trial.js';

export interface BenchmarkStart {
  secrets: Record<string, string>;
  /** The member's checkout: the run's `checkout`, where control commands run, and where trials fetch task commits from. */
  checkout: string;
  base?: RunState['base'];
  driver?: DriverIdentity;
  runMode?: RunState['runMode'];
  /** `--member-aliases`: resolve arm models with this member's ~/.teamai/models/aliases.yaml over the team's. */
  memberAliases: boolean;
  /** What the local driver, the run's only driver, gives strict requirements. */
  alone?: DriverCan;
}

/**
 * Reads the last valid version of suite `name` this member pulled, under the config's selection, and creates a run of
 * its frozen plan. Trials get the team assets of the team revision this checkout last pulled, never the default-branch
 * head, and each arm the model its alias names for its tool at that revision. A suite that needs a judge, for its
 * scorers or a task judged by success criteria, starts only where a judge can run.
 */
export async function startBenchmark(config: LocalConfig, name: string, options: BenchmarkStart): Promise<WorkflowEnvelope> {
  const pulled = await pulledTeamRevision(config, options.checkout);
  if ('refused' in pulled) return error('team_revision_unpullable', pulled.refused);
  const { revision } = pulled;
  const found = await loadCachedSuite(config, name);
  if (found === null) {
    return error('benchmark_not_found', `Suite "${name}" has no runnable version for this member. Check benchmarks/${name}/suite.yaml and that your roles or projects receive its namespace, push it, run teamai pull, and start again.`);
  }
  const unreachable = await unreachableTask(config, found, options.checkout);
  if (unreachable) {
    const { task, commit } = unreachable;
    const named = commit === task.startingCommit ? `starts from ${short(commit)}` : `writes check.add from its fix ${short(commit)}`;
    return error('commit_unreachable', `Task "${task.id}" ${named}, which neither this checkout nor ${found.repo} has. Push it, or fix ${commit === task.startingCommit ? 'startingCommit' : 'source.fix'}, and start again.`);
  }
  let aliases: Promise<ModelAliases> | undefined;
  const loadAliases = (): Promise<ModelAliases> => (aliases ??= armAliases(config, revision, options.memberAliases));
  const [firstArm, ...otherArms] = found.arms;
  const first = await plannedArm(config, firstArm, revision, loadAliases);
  if (!first.ok) return first.refused;
  const rest: PlannedArm[] = [];
  for (const arm of otherArms) {
    const resolved = await plannedArm(config, arm, revision, loadAliases);
    if (!resolved.ok) return resolved.refused;
    rest.push(resolved.arm);
  }
  const unpublishable = [first.arm, ...rest].map(unpublishableArm).find((message) => message !== undefined);
  if (unpublishable !== undefined) return error('arm_unpublishable', unpublishable);
  const pinned = await pinScorers(config, found.scorers);
  const unpinned = found.scorers.find((scorer) => !Object.hasOwn(pinned, scorer));
  if (unpinned !== undefined) {
    return error('scorer_not_found', `Suite "${found.name}" lists scorer "${unpinned}", which has no valid scorers/${unpinned}.md for this member. Add the scorer, or remove it from ${found.relativePath}, push it, run teamai pull, and start again.`);
  }
  const committed = await commitCheckFiles(commitCacheOf(config, found.repo), found);
  if (!committed.ok) {
    return error('check_files_unwritable', `Task "${committed.task}" writes files from the suite directory before its check, and they could not be written as a commit into this machine's benchmark cache: ${committed.failed} Fix that, and start again.`);
  }
  const plan = freezePlan({ committed: committed.suite, baselineTeamRevision: revision, selection: selectionOf(config), arms: [first.arm, ...rest], scorers: pinned });
  const { definition, scorers: generated } = compilePlan(plan, committed.suite);
  const scorers = { ...pinned, ...generated };
  const criteria = found.tasks.find((task) => task.judge.kind === 'criteria');
  const needs = found.scorers.length > 0 ? `its scorers ${found.scorers.join(', ')}` : criteria ? `task "${criteria.id}" has successCriteria` : undefined;
  const unjudged = needs === undefined ? undefined : await judgeUnavailable(config, scorers);
  if (unjudged !== undefined) {
    return error('scoring_unavailable', `This suite needs a judge (${needs}), and this machine cannot judge: ${unjudged} Fix it, or start the benchmark where a judge tool is installed.`);
  }
  return createRun(config, {
    name: found.name,
    sourceHash: runSourceHash(plan),
    teamRevision: revision,
    origin: { source: 'team' },
    definition,
    scorers,
    benchmark: plan,
    secrets: options.secrets,
    checkout: options.checkout,
    ...(options.base ? { base: options.base } : {}),
    ...(options.driver ? { driver: options.driver } : {}),
    ...(options.runMode ? { runMode: options.runMode } : {}),
    ...(options.alone ? { alone: options.alone } : {}),
  });
}

type ArmResolution = { ok: true; arm: PlannedArm } | { ok: false; message: string };
type Refused = { ok: false; refused: WorkflowEnvelope };

/** The arm as the plan freezes it, its team assets resolved before its model, or why start refuses it. */
async function plannedArm(config: LocalConfig, arm: Arm, pulled: string, aliases: () => Promise<ModelAliases>): Promise<{ ok: true; arm: PlannedArm } | Refused> {
  const team = await resolveTeam(config, arm, pulled);
  if (!team.ok) return team;
  const resolved = await resolveArm(arm, team.team, aliases);
  return resolved.ok ? resolved : { ok: false, refused: error('arm_model_missing', resolved.message) };
}

/**
 * The team assets of `arm` as the plan freezes them: a ref resolved, as `pull --team-ref` resolves it, to a commit on the
 * team remote; each skill it runs without found at the pulled revision. An arm without team assets is refused on a
 * machine whose user-scope install delivers to its tool, since the tool would read those assets from the home.
 */
async function resolveTeam(config: LocalConfig, { name, tool, team }: Arm, pulled: string): Promise<{ ok: true; team: ArmTeam } | Refused> {
  switch (team.kind) {
    case 'pulled':
      return { ok: true, team: { kind: 'pulled', revision: pulled } };
    case 'none': {
      const user = await loadLocalConfigForScope('user');
      if (user && (user.enabledAgents === undefined || user.enabledAgents.includes(tool))) {
        return { ok: false, refused: error('arm_team_unclean', `Arm "${name}" runs without team assets, and this machine's user-scope teamai install delivers team assets to ${tool} in your home, where its trials would read them. Start the benchmark on a machine where teamai is installed only in workspace scope.`) };
      }
      return { ok: true, team: { kind: 'none' } };
    }
    case 'ref': {
      const resolved = await resolveTeamRef(config.repo.localPath, team.ref).then((ref) => ({ ok: true as const, commit: ref.commit }), (cause: unknown) => ({ ok: false as const, cause }));
      if (resolved.ok) return { ok: true, team: { kind: 'ref', ref: team.ref, revision: resolved.commit } };
      if (resolved.cause instanceof TeamRefError) {
        return { ok: false, refused: error('arm_team_unresolved', `Arm "${name}" runs on team ref "${team.ref}", which is no branch, tag or commit of this checkout's team repo that holds teamai.yaml. Its branches: ${resolved.cause.branches.join(', ') || 'none'}. Fetch it, or fix the arm's team, push it, run teamai pull, and start again.`) };
      }
      const cause = resolved.cause instanceof Error ? resolved.cause.message : String(resolved.cause);
      return { ok: false, refused: error('arm_team_unreadable', `Arm "${name}" runs on team ref "${team.ref}", and git could not read this checkout's team repo at ${config.repo.localPath}: ${cause}. Repair the team repo, or run teamai pull, and start again.`) };
    }
    case 'without': {
      const listed = await git(config.repo.localPath, ['ls-tree', '-r', '--name-only', pulled]);
      const skills = new Set(listed.stdout.split('\n').flatMap((file) => /(?:^|\/)skills\/(?:[^/]+\/)*?([^/]+)\/SKILL\.md$/.exec(file)?.[1] ?? []));
      const missing = team.skills.find((skill) => !skills.has(skill));
      if (listed.code !== 0) {
        return { ok: false, refused: error('arm_team_unreadable', `Arm "${name}" runs without skill "${team.skills[0]}", and git could not list the skills of the team revision this checkout pulled at ${config.repo.localPath}: ${listed.stderr.trim()}. Repair the team repo, or run teamai pull, and start again.`) };
      }
      if (missing !== undefined) {
        return { ok: false, refused: error('arm_team_unresolved', `Arm "${name}" runs without skill "${missing}", and the team revision this checkout pulled has no skill of that name. Fix the arm's team, push it, run teamai pull, and start again.`) };
      }
      return { ok: true, team: { kind: 'without', skills: team.skills, revision: pulled } };
    }
    default: {
      const unhandled: never = team;
      return unhandled;
    }
  }
}

/** What a member can do about an arm whose model gives its tool none. */
const NO_MODEL_FIX = {
  unmapped: 'Add one and start again.',
  local: 'Remove that entry, or start again without --member-aliases.',
  switched: 'Run teamai models restore, or start again without --member-aliases.',
  unresolved: 'Fix that and start again.',
} as const satisfies Record<NoModel, string>;

/**
 * The arm as the plan freezes it: its model alias resolved for its tool to a model name and effort, or its model name as
 * written. An alias that gives the tool no model refuses the start. `source` is `member` when the member's own entry,
 * or their model switch, decided the model.
 */
async function resolveArm({ name, tool, model }: Arm, team: ArmTeam, aliases: () => Promise<ModelAliases>): Promise<ArmResolution> {
  if (model === undefined) return { ok: true, arm: { name, tool, source: 'team', team } };
  const loaded = await aliases();
  const alias = isModelAlias(loaded, model);
  // An alias maps only the tools teamai knows, so it gives any other tool no model; a model name passes as written.
  const resolution: ModelResolution = isAgentToolId(tool) ? resolveModelValue(loaded, model, tool) : alias ? { ok: true, step: 'default' } : { ok: true, step: 'literal', model };
  if (!resolution.ok || resolution.model === undefined) {
    return { ok: false, message: `Arm "${name}" uses ${alias ? `model alias "${model}"` : `model "${model}"`}, which ${noModelCause(resolution, tool)}. ${NO_MODEL_FIX[noModelReason(resolution)]}` };
  }
  const source = resolution.step === 'local' || resolution.step === 'switched' ? 'member' : 'team';
  return { ok: true, arm: { name, tool, model: resolution.model, ...(alias ? { alias: model } : {}), ...(resolution.effort !== undefined ? { effort: resolution.effort } : {}), source, team } };
}

/**
 * Why the record cannot publish `arm` as planned, or undefined when it can: its tool, model and effort meet the name
 * rules an observed agent meets (agent-observation.ts), so no URL, credential or local path reaches a record. Says
 * nothing of the value, which may be a secret.
 */
function unpublishableArm(arm: PlannedArm): string | undefined {
  const field = !isLabelShaped(arm.tool) ? 'tool'
    : arm.model !== undefined && !isNameShaped(arm.model) ? 'model'
      : arm.effort !== undefined && !isLabelShaped(arm.effort) ? 'effort' : undefined;
  if (field === undefined) return undefined;
  const fix = arm.source === 'member' && field !== 'tool'
    ? 'Fix your entry in ~/.teamai/models/aliases.yaml, or start again without --member-aliases.'
    : 'Fix the suite or the team\'s models/aliases.yaml, push it, run teamai pull, and start again.';
  return `Arm "${arm.name}" has a ${field} that is not a plain name, such as a URL or a local path, and a benchmark record publishes it. ${fix}`;
}

/** The model aliases the team files hold at `revision`, under the config's selection, and the member's over them when asked. */
async function armAliases(config: LocalConfig, revision: string, member: boolean): Promise<ModelAliases> {
  const read = await withTeamRevision(config, revision, (at) => (member ? loadModelAliases(at) : loadTeamModelAliases(at)));
  return 'failed' in read ? { ok: false, reason: `the team's model aliases at ${revision.slice(0, 7)} could not be read: ${read.failed}` } : read;
}

/**
 * The team revision this checkout last pulled, as a launch of a tool that pull delivered to observes it. Refused when
 * pull delivered to no tool, when the delivered assets were edited since, or when the revision is on no branch of the
 * team remote, so another machine could not pull it.
 */
async function pulledTeamRevision(config: LocalConfig, checkout: string): Promise<{ revision: string } | { refused: string }> {
  const { teamDelivery } = await import('../pull.js');
  const tool = (await teamDelivery(config, '')).record?.targets[0];
  if (tool === undefined) {
    return { refused: 'teamai pull set up no AI tool in this checkout, so the team revision it delivered cannot be read. Run teamai init with --agent <tool>, run teamai pull, and start again.' };
  }
  const team = (await observeCheckout({ config, tool, cwd: checkout })).team;
  const pushed = team !== undefined && !team.localChanges && await resolveTeamRef(config.repo.localPath, team.revision).then(() => true, () => false);
  return pushed ? { revision: team.revision } : { refused: 'Benchmarks start from the team revision this checkout last pulled, and it has none that another machine can pull. Push any team changes, run teamai pull, and start again.' };
}

/**
 * The first task, and its commit, whose starting commit or check.add fix neither the checkout nor the commit cache has,
 * after a fetch by SHA from the suite repo into the cache: a shallow CI checkout lacks older commits, and a trial's clone
 * fetches offline.
 */
async function unreachableTask(config: LocalConfig, suite: Suite, checkout: string): Promise<{ task: Suite['tasks'][number]; commit: string } | undefined> {
  const cache = commitCacheOf(config, suite.repo);
  for (const task of suite.tasks) {
    // A check's added files come from the task's fix, so its trials need that commit too.
    const commit = await firstUnreachable(checkout, cache, suite.repo, [task.startingCommit, ...(task.judge.kind === 'check' && task.judge.add ? [task.judge.add.commit] : [])]);
    if (commit !== undefined) return { task, commit };
  }
  return undefined;
}

/**
 * The first of `commits` neither `checkout` nor the bare repo `cache` has, after a fetch by SHA from `repo` into the
 * cache, with the member's own credentials.
 */
async function firstUnreachable(checkout: string, cache: string, repo: string, commits: readonly string[]): Promise<string | undefined> {
  const has = async (dir: string, commit: string): Promise<boolean> => (await git(dir, ['cat-file', '-e', `${commit}^{commit}`])).code === 0;
  for (const commit of commits) {
    if (await has(checkout, commit) || await has(cache, commit)) continue;
    await fs.mkdir(cache, { recursive: true });
    const made = await git(cache, ['init', '-q', '--bare']);
    const fetched = made.code === 0 && (await git(cache, ['fetch', '-q', '--no-tags', repo, `${commit}:refs/benchmark/${commit}`])).code === 0;
    if (!fetched || !await has(cache, commit)) return commit;
  }
  return undefined;
}

function selectionOf(config: LocalConfig): TeamSelection {
  return {
    ...(config.primaryRole ? { primaryRole: config.primaryRole } : {}),
    additionalRoles: config.additionalRoles,
    projects: config.projects ?? [],
    ...(config.subscribedTags ? { subscribedTags: config.subscribedTags } : {}),
    excludedSkills: config.excludedSkills ?? [],
  };
}

/**
 * `teamai workflow start <suite> --benchmark --try <task file>`: whether a task's check tells its fix from no change,
 * before the task reaches a suite. Reads the task file and the suite.yaml two directories up from it as written, with no
 * install, and validates both as pull does. A check task's check must fail by its own exit at `startingCommit`, as its
 * baseline must, and with `source.fix`, pass at the fix with the protected paths as `startingCommit` has them, as a
 * trial's check would read a correct change. Each runs in a fresh clone from `checkout`, or from a cache that fetched the
 * commit by SHA from the suite repo as start does, under the suite's setup and timeout. No run, arm, trial, judge or
 * record.
 */
export async function tryBenchmarkTask(name: string, file: string, options: { checkout: string; signal?: AbortSignal; progress: (line: string) => void }): Promise<WorkflowEnvelope> {
  const suiteFile = path.join(path.dirname(path.dirname(file)), 'suite.yaml');
  const read = (at: string): Promise<string | undefined> => fs.readFile(at, 'utf8').catch(() => undefined);
  const [suiteText, taskText] = [await read(suiteFile), await read(file)];
  if (taskText === undefined) return error('benchmark_not_found', `The task file ${file} could not be read. Pass the path of a task file, such as benchmarks/<suite>/tasks/<task>.yaml in a checkout of the team repo.`);
  if (suiteText === undefined) return error('benchmark_not_found', `${suiteFile} could not be read: --try reads the suite two directories up from the task file, as in benchmarks/<suite>/tasks/<task>.yaml.`);
  const posix = (at: string): string => at.split(path.sep).join('/');
  const taskSource = { relativePath: posix(file), content: taskText };
  const files = await readSuiteFiles(path.dirname(suiteFile), posix(path.dirname(suiteFile)), [taskSource]);
  const parsed = parseSuite({ suite: { relativePath: posix(suiteFile), content: suiteText }, tasks: [taskSource], files });
  if (!parsed.ok) return error('benchmark_invalid', parsed.diagnostics.map(formatDiagnostic).join('\n'));
  const { suite } = parsed;
  const [task] = suite.tasks;
  if (suite.name !== name) {
    return error('invalid_arguments', `${posix(suiteFile)} is suite "${suite.name}", and the command names "${name}". Name the suite the task belongs to: teamai workflow start ${suite.name} --benchmark --try ${file}.`);
  }
  const { judge, startingCommit } = task;
  if (judge.kind === 'criteria') return tried(task.id, `Task "${task.id}" is judged by successCriteria, so there is no check to try. Its files are valid.`);
  const fix = task.source?.fix;
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-try-commits-'));
  try {
    const unreachable = await firstUnreachable(options.checkout, cache, suite.repo, [startingCommit, ...(fix ? [fix] : [])]);
    if (unreachable !== undefined) {
      const named = unreachable === startingCommit ? `starts from ${short(unreachable)}` : `names the fix ${short(unreachable)}`;
      return error('commit_unreachable', `Task "${task.id}" ${named}, which neither this checkout nor ${suite.repo} has. Push it, or fix ${unreachable === startingCommit ? 'startingCommit' : 'source.fix'}, and try again.`);
    }
    const committed = await commitCheckFiles(cache, suite);
    if (!committed.ok) {
      return error('check_files_unwritable', `Task "${committed.task}" writes files from the suite directory before its check, and they could not be written as a commit into a temporary cache: ${committed.failed} Fix that, and try again.`);
    }
    return await tryCheck(suite, task, judge, addedOf(judge, committed.suite.files.get(task.id)), [options.checkout, cache], options);
  } finally {
    await fs.rm(cache, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * --try once the task's commits are reachable from `sources`: its check at the starting commit, then at the fix, each
 * with the files `add` writes.
 */
async function tryCheck(suite: Suite, task: Suite['tasks'][number], judge: Extract<TaskJudge, { kind: 'check' }>, add: readonly Added[], sources: readonly string[], options: { checkout: string; signal?: AbortSignal; progress: (line: string) => void }): Promise<WorkflowEnvelope> {
  const { startingCommit } = task;
  const expiresAt = new Date(Date.now() + suite.timeoutMs).toISOString();
  const at = (commit: string, protect?: readonly string[]): Promise<CheckRun> => tryCheckAt({
    commit, startingCommit, command: judge.run, ...(protect ? { protect } : {}), add, ...(suite.setup ? { setup: suite.setup } : {}),
    sources, expiresAt, ...(options.signal ? { signal: options.signal } : {}),
  });
  options.progress(`Task ${task.id}: trying the check at ${short(startingCommit)}`);
  const start = await at(startingCommit);
  const unusable = unusableRun(task.id, judge.run, startingCommit, start);
  if (unusable !== undefined) return error('task_try_failed', unusable);
  if (start.kind === 'check' && start.verdict.verdict === 'passed') {
    return error('task_try_failed', `Task "${task.id}": the check passes without changes at ${short(startingCommit)}, so it cannot tell a fix from no change. Pick a startingCommit where the check fails, or fix the check.`);
  }
  const fix = task.source?.fix;
  if (fix === undefined) return tried(task.id, `Task "${task.id}": the check fails at ${short(startingCommit)}, as the task expects. The task has no source.fix, so the check was not tried on a fix.`);
  options.progress(`Task ${task.id}: trying the check at the fix ${short(fix)}, with the protected paths as ${short(startingCommit)} has them`);
  const fixed = await at(fix, judge.protect);
  const unusableFix = unusableRun(task.id, judge.run, fix, fixed);
  if (unusableFix !== undefined) return error('task_try_failed', unusableFix);
  if (fixed.kind === 'check' && fixed.verdict.verdict === 'failed') {
    const changed = await git(options.checkout, ['diff', '--name-only', startingCommit, fix, '--', ...judge.protect.map((entry) => `:(glob)${entry}`)]);
    const added = new Set(add.flatMap((entry) => entry.paths));
    const paths = changed.code === 0 ? changed.stdout.split('\n').filter((line) => line !== '' && !added.has(line)) : [];
    const hint = paths.length > 0 ? ` The fix changes ${paths.join(', ')}, which protect puts back as ${short(startingCommit)} has them: list a test the fix brought in check.add.` : '';
    return error('task_try_failed', `Task "${task.id}": the check fails at the fix ${short(fix)} (exit ${fixed.verdict.exitCode}), with the protected paths as ${short(startingCommit)} has them.${hint}`);
  }
  return tried(task.id, `Task "${task.id}": the check fails at ${short(startingCommit)} and passes at the fix ${short(fix)}, with the protected paths as ${short(startingCommit)} has them.`);
}

function tried(task: string, message: string): WorkflowEnvelope {
  return { data: { try: { task, message } } };
}

function short(commit: string): string {
  return commit.slice(0, 7);
}

/** Why `ran` at `commit` says nothing of the check, or undefined when the check ran to its own exit. */
function unusableRun(task: string, command: string, commit: string, ran: CheckRun): string | undefined {
  if (ran.kind === 'error') return `Task "${task}" could not be tried at ${short(commit)}: ${ran.failure.message}`;
  const { verdict } = ran;
  if (verdict.verdict !== 'could_not_run') return undefined;
  return `Task "${task}": the check "${command}" could not run at ${short(commit)} (${verdict.cause}${verdict.detail ? `: ${verdict.detail}` : ''}). Make the command runnable after setup there, or fix check.run.`;
}
