import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { toolExtrasFor, type AgentSpec } from '../../../resources/agent-format.js';
import { observeLaunch, type ToolLaunch, type Used } from '../../../agent-observation.js';
import { detectProjectConfig } from '../../../config.js';
import { driverIdentity } from '../../../driver-identity.js';
import { commandSignalPolicy, exitLike, stepEnvironment, terminalReachesCommand, withRunningCli } from '../../../env-exec.js';
import { knownSecrets, resolveWorkflowEnv, type WorkflowEnv } from '../../../env-resolution.js';
import { resolveRunMode, workflowLaunch, type RunMode } from '../../../launch-context.js';
import type { LocalConfig, TeamaiConfig } from '../../../types.js';
import { writeJsonAtomic } from '../../../utils/fs.js';
import { log, PROGRESS_STREAMS_ENV, streamOfLine, withoutStreamMarks } from '../../../utils/logger.js';
import { redact } from '@teamai/shared/redact';
import { AgentSession, type AgentSessionRef } from '../../../session-flow/agent-session.js';
import { openSessionArchive, type SessionArchive } from '../../../session-flow/archive.js';
import { deliveredTeamSkills, usedSkills } from '../../../skill-use.js';
import { agentEvidence, attemptEnv } from '../../attempt-marker.js';
import { leaseNext, promptTool, type PersonHandoff, type ReportInput, type ToolFor } from '../../engine.js';
import { offeredToPerson, offerToPerson, reconcileTakenCopies } from '../../handoff.js';
import { LeaseWireSchema, type LeaseWire } from '../../lease-wire.js';
import { setsLimit, type DecidedCan, type DriverCan, type Missing } from '../../requirements.js';
import { callerProvenance, respondProvenance, respondToHitl, type ResponseInput } from '../../run-controls.js';
import { isRecord } from '../../expression.js';
import { budgeted } from '../../limits.js';
import {
  createLocalToolAdapter,
  toolAdapter,
  type LocalToolAdapter,
  type LocalToolResult,
  type LocalToolRun,
} from './local-tool-adapter.js';
import { placeView, runtimeCommand, runtimeLauncher, runtimePrompter, runtimeSetup, runtimeStepEnv, type StartedCommand } from './runtime-steps.js';
import { attemptHoldingSession, attemptRun, attemptToolHome, EXEC_RUNTIME_TOOLS, isExecRuntimeTool, readAttemptRuntime, attemptRuntimePath, maskAttemptResults, seedMemberModel, seedToolHome, toolHomeVariable, type AttemptRun } from '../../runtimes/attempt.js';
import { localStepRuntime } from '../../runtimes/local.js';
import { writeHeldSteps, type HeldSteps } from '../../runtimes/held.js';
import { closeAfterSweep, stopOnRecordedDriver } from '../../runtimes/cancelled.js';
import { ensureLogin, holdLogin, loginHolder, loginLockFile, loginWaitFile, releaseLogin, writeLoginBack, type LoginTool } from '../../runtimes/login.js';
import { credentialsForTool, type EngineOptions, type OpenedDriver } from '../../runtimes/sources.js';
import { credentialSecrets, newOpId, withRetry, type StepRuntime } from '../../runtimes/step-runtime.js';
import type { RuntimeOffer, SoleDriver } from '../../engine.js';
import { storeDirOf } from '../../../session-flow/adapters/index.js';
import { attemptDir, AttemptIdSchema, attemptResultPath, readRun, RunIdSchema, runScratchDir, updateRun, withRunLock, type AttemptId, type RunId, type RunLock } from '../../store.js';
import { abandonPlace, cloneDelivery, cloneHead, placeLeaseOf, placeOf, placeRoot, preparedClone, preparePlace, cloneRoleProblem, refuseDirtyAdoptedCommand, roleNotDeliveredFailure, runPlaceSetup, sweepClones, worktreeRoleProblem, type StepEnd } from '../../place/place.js';
import { commandEnd, managedReport, StartedRunSchema, unreadablePlace, type StartedRun } from '../../protocol.js';
import { memberTools, type MemberTool } from '../../../tool-launch/member-tools.js';
import { startGroupedCommand, stopRecordedGroup, type CommandExit } from '../../../tool-launch/process-stop.js';
import { acceptToolCommand, instanceHomeDir } from '../../../tool-instances.js';
import { toolHome as memberToolHome } from '../../../tool-home.js';
import { baseToolOf, instanceNames, isToolId } from '../../../tool-registry.js';
import { launchExecutableOf, LAUNCH_ORDER, LAUNCH_TOOLS, launchAdapterIdOf, launchTargetOf, type LaunchTarget, type LaunchTool } from '../../../tool-launch/tools.js';
import { confinedOffers, type ConfinedOffer } from '../../../tool-launch/confined.js';
import { AttemptResult } from '../../attempt-result.js';
import { runConfinedStep, runConfinedStepOnRuntime } from '../../confined-step.js';
import { runAnswerStep } from './answer-step.js';
import { chooseStepModel, loadDeployedAgent, type StepModel } from '../../step-model.js';
import type { DriveOptions, DriverIdentity, RunState, StepHitl, WorkflowEnvelope, WorkflowFailure, WorkflowStep } from '../../types.js';
import { isWorkflowError, stepWorkflow } from '../../types.js';
import { WORKSPACE_MODES } from '@teamai/runtime-protocol';
import { confinedOf, contractClone, type SessionRef } from '../../workspace.js';
import { git, headCommit } from '../../worktree.js';

/** The signals that stop teamai, which the driver passes on to what it runs before it exits. */
export const STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP'];

/** How long the driver waits for a command or prompt before asking the run again; half that while a question is open. */
let pollMs = 2000;

/** Shorten the driver's poll (for testing only). */
export function _setDriverPollMs(ms: number): void {
  pollMs = ms;
}

/**
 * What a leased command came to: it ran, staging failed or its step runtime failed it, or it was stopped or its lease
 * ended before it could start.
 */
type StagedResult = { kind: 'ran'; result: CommandExit } | { kind: 'unstaged'; failure: WorkflowFailure } | { kind: 'stopped' };


interface StagedCommand {
  exit: Promise<StagedResult>;
  /** Aborts staging and setup, or stops the command once it runs. Settles once the attempt is over; a second call changes nothing. */
  stop(): Promise<StagedResult>;
}

/** Whether a staged lease may start its command or tool: nothing stopped it, and its deadline has not passed. */
function startable(lease: Lease, signal: AbortSignal): boolean {
  return !signal.aborted && (lease.expiresAt === undefined || Date.now() < Date.parse(lease.expiresAt));
}

/**
 * Stages a leased command, then starts it, as one attempt, so the driver keeps asking the run what to do while staging
 * and setup run, and a cancel reaches either phase.
 */
function stageThenStart(lease: Lease, stage: (signal: AbortSignal) => Promise<WorkflowFailure | undefined>, start: () => StartedCommand): StagedCommand {
  const controller = new AbortController();
  let command: StartedCommand | undefined;

  const exit = (async (): Promise<StagedResult> => {
    const failure = await stage(controller.signal);

    if (!startable(lease, controller.signal)) return { kind: 'stopped' };

    if (failure) return { kind: 'unstaged', failure };
    command = start();
    const ended = await command.exit;

    return 'exitCode' in ended ? { kind: 'ran', result: ended } : { kind: 'unstaged', failure: ended };
  })();

  return { exit, stop: async () => {
    controller.abort();
    await command?.stop();

    return exit;
  } };
}

/** A rendered HITL request and the exact pass and response command presented by the engine. */
export interface LocalHitl extends StepHitl {
  /** The run that owns the question. */
  run: string;
  /** The waiting step's full path. */
  step: string;
  /** The pass the answer will apply to. */
  pass: number;
  /** The engine's literal CLI response template. */
  respond: string;
}

/** A HITL request as the engine's `next` sends it. A `default` that is not text counts as none. */
const HitlRequestSchema = z.object({
  run: z.string(), step: z.string(), pass: z.number(), respond: z.string(), kind: z.enum(['approve', 'choose']), message: z.string(), required: z.boolean(),
  options: z.array(z.string()), default: z.string().optional().catch(undefined),
});

/** What the engine's `next` says the driver waits for. */
/** What a step held for strict isolation misses, as `wait.held` names it. */
const ISOLATION = 'isolation' satisfies Missing;
const HITL = 'hitl' satisfies Missing;

const WaitReplySchema = z.object({
  delivering: z.array(z.unknown()).optional().catch(undefined),
  reason: z.string().optional().catch(undefined),
  held: z.array(z.object({ step: z.string(), reason: z.string(), missing: z.array(z.string()) })).optional().catch(undefined),
}).catch({});

/** A step a runtime held back, as a wait names it. */
type WaitHeld = NonNullable<z.infer<typeof WaitReplySchema>['held']>[number];

/** What the driver says once it handed run `runId` to a person at `steps`, and the command that person runs. */
function handedToPerson(runId: string, steps: readonly string[]): WorkflowEnvelope {
  const resume = `teamai workflow resume ${runId} --claim`;
  log.info(offeredToPerson(runId, steps, resume));

  return { data: { handoff: { run: runId, steps: [...steps], resume } } };
}

/**
 * Where a run that relays its gates stops once nothing it started still runs: at gate `hitl`, which the agent session
 * that started the run answers with `respond`, or hands to the person, and then continues with `resume` on `driver`.
 * `isConfirmed`: the person agreed to the run at its start, as an `invoke: ask` workflow needs, so the session's resume
 * carries that yes.
 */
function relayedGate(hitl: LocalHitl, { driver, isConfirmed }: { driver: string; isConfirmed: boolean }): WorkflowEnvelope {
  const { run, step, pass, kind, message, options, required, respond } = hitl;
  const resume = `teamai workflow resume ${run} --driver ${driver}${isConfirmed ? ' --confirmed' : ''}`;
  log.info(`Run ${run} waits at step "${step}" (pass ${pass}): ${message}\nOptions: ${options.join(', ')}. Required: ${required ? 'yes' : 'no'}.\nAnswer: ${respond}\nThen: ${resume}`);

  return { data: { hitl_waiting: { run, step, pass, kind, message, options, required, ...(hitl.default !== undefined && { default: hitl.default }), respond, resume } } };
}

/** Whether every step `next` held from this driver waits for a confined tool here that reaches its level or resolves its model. */
function heldForConfined(held: ReadonlyArray<{ missing: readonly string[] }> | undefined): held is ReadonlyArray<{ reason: string; missing: string[] }> {
  return held !== undefined && held.length > 0 && held.every(({ missing }) => missing.includes('confined') || missing.includes('model'));
}

/** Reads the line typed at the terminal after `prompt`. Aborting `signal` closes it unanswered. */
async function readLine(prompt: string, signal: AbortSignal): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });

  try {
    return await terminal.question(prompt, { signal });
  } finally {
    terminal.close();
  }
}

async function askHitl(hitl: LocalHitl, signal: AbortSignal): Promise<string> {
  process.stderr.write(`Step "${hitl.step}": ${hitl.message}\nOptions: ${hitl.options.join(', ')}\n${hitl.respond}\n`);

  return readLine('Choice, followed by an optional note: ', signal);
}

/** Puts a prompt step's own question to the person at the terminal: their line, or none once `signal` aborts it. */
type AskPerson = (question: string, signal: AbortSignal) => Promise<string | undefined>;

/** Local tool selection and terminal behavior for one driver invocation. */
export interface LocalDriverOptions {
  /** Overrides auto approval for this run without changing member config; the run remembers it on this install. */
  autoApprove?: boolean;
  /** Declares whether a person can answer HITL requests and work in foreground tools. */
  hitl?: boolean;
  /** Declares this host a sandbox for this run, as `workflows.sandbox` does for every process; the run remembers it on this install. */
  sandbox?: boolean;
  /** The terminal question implementation, injectable for callers without readline. */
  question?: (hitl: LocalHitl, signal: AbortSignal) => Promise<string>;
  tools?: Record<string, string>;
  /** The team's `toolPaths`, as teamai.yaml states them. */
  toolPaths?: TeamaiConfig['toolPaths'];
  adapter?: LocalToolAdapter;
  /** Where the tools a step confined to a directory runs on are looked up: PATH unless given. */
  resolveTool?: (executable: string) => string | null;
  /** Called with the runs each report the engine took answers its settled passes started, which the caller drives. */
  started?: (runs: readonly StartedRun[]) => void;
  /**
   * Shown each line a command step writes to stderr as it writes it, masked, with the stream the command meant it for:
   * what a shortcut of the run shows live.
   */
  progress?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** The runtimes of the driver definition `--driver` names, in its order. Without it, the loop has one: `local`. */
  runtimes?: DriverRuntimes;
}

/** A driver definition's runtimes, which the loop offers in turn: each step goes to the first that can take it. */
export interface DriverRuntimes {
  /** The definition's canonical name, recorded with each attempt. */
  driver: string;
  runtimes: OpenedDriver['runtimes'];
}

/**
 * One runtime the loop offers: `local`, which launches on this machine as the loop always did, or an external one,
 * whose steps go through an `AttemptRun`. Each is reached through the `StepRuntime` interface for its offer and the
 * lifecycle of its attempts' places.
 */
interface RuntimeSlot {
  kind: 'local' | 'external';
  use: string;
  runtime: StepRuntime;
  can: DriverCan;
  /** Its prompt steps go as `prompt`, never as an exec of the tool's argv. */
  launchesAgents: boolean;
  engine: EngineOptions;
  /** The values of the credentials the runtime declares, which only its prompts' tools get. */
  credentials: Record<string, string>;
  /** The names of `credentials` found in the member's environment, each only for the tool it signs in. */
  found: readonly string[];
  /** The tools it cannot run now, with the runtime's reason. */
  unavailable?: Record<string, string>;
}

/** A lease as this driver runs it: what the engine sent, and what staging it adds. A step staged after `expiresAt` does not start. */
interface Lease extends LeaseWire {
  /** The lease named a workspace this driver cannot read. The step fails instead of running in the active checkout. */
  unreadableWorkspace?: true;
  /** The environment the step's command or tool runs with, built from `envScope` when the lease is staged. */
  processEnv?: NodeJS.ProcessEnv;
  /** Set once the step has a directory to run in. */
  cwd?: string;
}

/**
 * The tool a prompt step runs on: the step's own `tool`, then `--tools`, then `workflows.tools`, the agent's entry before
 * the default (`--tools default=` holds the driver definition's `tool` under the one given), then `runtimeDefault`, the
 * default of the app the runtime that takes the step drives (`can.default_tool`), then the member's own AI tool:
 * TEAMAI_AI_TOOL before `workflows.tools.default`, and `ai.tool`, the project's before the machine's, after it. A
 * member's tool that teamai does not launch fails the step; one that runs no workflow step gives way to the next rung,
 * which `warnings` says.
 */
function stepTool({ agent, tool }: Pick<WorkflowStep, 'agent' | 'tool'>, config: LocalConfig, flags: Record<string, string>, members: MemberTool[], runtimeDefault: string | undefined): { ok: true; tool: string | undefined; warnings: string[] } | { ok: false; failure: WorkflowFailure } {
  const configured = config.workflows?.tools ?? {};
  const member = ({ setting, tool: named }: MemberTool) => ({ source: setting, named, member: true });

  const rungs = [
    { source: 'tool', named: tool, member: false },
    { source: '--tools', named: agent ? flags[agent] : undefined, member: false },
    { source: `workflows.tools.${agent}`, named: agent ? configured[agent] : undefined, member: false },
    { source: '--tools', named: flags.default, member: false },
    { source: 'can.default_tool', named: runtimeDefault, member: false },
    ...members.flatMap((memberTool) => (memberTool.source === 'TEAMAI_AI_TOOL' ? [member(memberTool)] : [])),
    { source: 'workflows.tools.default', named: configured.default, member: false },
    ...members.flatMap((memberTool) => (memberTool.source !== 'TEAMAI_AI_TOOL' ? [member(memberTool)] : [])),
  ];

  const passed: { source: string; named: string }[] = [];

  for (const { source, named, member: isMember } of rungs) {
    if (!named) continue;

    if (isMember && !launchTargetOf(named)) {
      if (!LAUNCH_ORDER.some((launched) => launched === named)) {
        return { ok: false, failure: { code: 'tool_unsupported', message: `${source} is "${named}", which is not a tool teamai launches. Set it to one of: ${LAUNCH_TOOLS.join(', ')}.` } };
      }

      passed.push({ source, named });
      continue;
    }

    return { ok: true, tool: named, warnings: passed.map((skipped) => `${skipped.source} is "${skipped.named}", which cannot run a workflow step. Using ${source} (${named}) instead.`) };
  }

  return { ok: true, tool: undefined, warnings: passed.map((skipped) => `${skipped.source} is "${skipped.named}", which cannot run a workflow step.`) };
}

/** The tool a prompt step launches here, with the warnings its pick logs, or why it launches none. */
type LaunchChoice = { ok: true; tool: LaunchTool; target: LaunchTarget; warnings: string[] } | { ok: false; failure: WorkflowFailure; tool?: string; warnings: string[] };

/**
 * The tool teamai launches for prompt step `step` here, as {@link stepTool} picks it with `--tools` `flags`, or why
 * none: no tool is configured, or the one picked is not one teamai launches, which `tool` then names. `warnings` says
 * which of the member's tools gave way, for the step that launches to log.
 */
export function launchToolFor(step: Pick<WorkflowStep, 'agent' | 'tool'>, config: LocalConfig, flags: Record<string, string>, members: MemberTool[], runtimeDefault?: string): LaunchChoice {
  const choice = stepTool(step, config, flags, members, runtimeDefault);

  if (!choice.ok) return { ...choice, warnings: [] };
  const { tool: selected, warnings } = choice;

  if (!selected) return { ok: false, failure: { code: 'tool_unconfigured', message: 'This prompt step names no tool, and none is set for it. Name one with the step\'s tool:, with --tools default=<tool>, or with ai.tool in your teamai config' }, warnings };

  const target = launchTargetOf(selected);

  if (!target) return { ok: false, failure: { code: 'tool_unsupported', message: `The local workflow tool "${selected}" is not supported` }, tool: selected, warnings };

  return { ok: true, tool: target.tool, target, warnings };
}

function ignoredCodexSettings(agent: AgentSpec): string[] {
  const extras = Object.keys(agent.tool_extras?.codex ?? {});

  return agent.tools?.length ? ['tools', ...extras] : extras;
}

function definitionRun(tool: LaunchTool, name: string, agent: AgentSpec): NonNullable<LocalToolRun['agent']> {
  const settings = launchAdapterIdOf(tool) === 'opencode' ? toolExtrasFor(agent, 'opencode') : undefined;

  const run: NonNullable<LocalToolRun['agent']> = { name, instructions: agent.instructions };

  if (agent.model) run.model = agent.model;

  if (settings) run.settings = settings;

  return run;
}

/** The model a launch passes on argv, and its effort. */
type LaunchModel = { model: string; effort?: string };

/** The fields of a report that say the attempt failed, and why. */
type FailedReport = { outcome: 'failed'; message: string; failure: WorkflowFailure };

function failureReport(failure: WorkflowFailure): FailedReport {
  return { outcome: 'failed', message: failure.message, failure };
}

type ReportBody = ReportInput;

/**
 * A lease as this driver runs it. A lease whose workspace alone it cannot read, which reads as a lease without it, is
 * kept, marked, so its step fails instead of running in the active checkout.
 */
const LocalLeaseSchema = LeaseWireSchema.or(z.preprocess((raw) => (isRecord(raw) ? { ...raw, workspace: undefined } : raw), LeaseWireSchema)
  .transform((lease): Lease => ({ ...lease, unreadableWorkspace: true })));

/**
 * Gets the lease a place to run under `root`, with the team env resolved for it. `signal` stops setup, which
 * then fails, and the workspace it was preparing is removed. A prompt step's place is prepared for `launches`, the tool
 * `promptReport` launches there, when the lease names none.
 */
async function stageLease(lease: Lease, { config, lock, root, env, mode, signal, launches, setUpOn, runsOn }: {
  config: LocalConfig;
  lock: RunLock;
  root: string;
  env: WorkflowEnv;
  mode: RunMode;
  signal?: AbortSignal;
  launches?: string;
  /** The attempt's run on its step runtime, which runs setup once the step opens its place there (`runtimeSetup`). */
  setUpOn?: AttemptRun;
  /** The step runtime this driver gives the attempt, by its definition's name; undefined for this host. */
  runsOn?: string;
}): Promise<WorkflowFailure | undefined> {
  if (lease.unreadableWorkspace) return unreadablePlace(lock.run);
  // A lease is handed back to a driver after one of this run was killed: the setup or command that one left running
  // in the attempt's place is stopped before the attempt is staged again.
  await stopRecordedGroup(attemptDir(config, lock.run, lease.attempt));
  // So is what a killed teamai left on a step runtime, which may write into the place by its path: on another runtime,
  // through the driver recorded for it; on this one, its setup here.
  const moved = await stopLeftElsewhere({ config, run: lock.run, attempt: lease.attempt, runsOn, checkout: root });

  if (moved) return moved;
  const leftSetup = (await setUpOn?.stopLeftSetup())?.failure;

  if (leftSetup) return { code: 'runtime_lost', message: leftSetup.message };

  if (lease.envScope) {
    const scoped = await stepEnvironment(env, lease.envScope);

    if (!scoped.ok) return scoped.failure;
    lease.processEnv = scoped.env;
  } else {
    lease.processEnv = withRunningCli(process.env);
  }

  const placeLease = placeLeaseOf(lease);

  if (lease.tool === undefined && launches !== undefined) placeLease.tool = launches;
  const prepared = await preparePlace({ config, lock, root, lease: placeLease });

  if (prepared.kind !== 'prepared') return prepared.failure;
  lease.cwd = prepared.dir;

  if (prepared.prompt !== undefined) lease.prompt = prepared.prompt;

  return setUpOn ? undefined : runPlaceSetup({ config, run: lock.run, attempt: lease.attempt, mode, env, signal });
}

/**
 * Stops what a killed teamai left of attempt `attempt` open on a step runtime other than `runsOn`, the one this driver
 * gives it (undefined: this host), through the driver recorded for it, as `teamai workflow cancel` does. Once that place
 * is closed, the attempt starts again here: its record of the other runtime goes. Answers why the stop is not confirmed,
 * which keeps the place and the record.
 */
async function stopLeftElsewhere({ config, run, attempt, runsOn, checkout }: { config: LocalConfig; run: RunId; attempt: string; runsOn: string | undefined; checkout: string }): Promise<WorkflowFailure | undefined> {
  const id = AttemptIdSchema.safeParse(attempt);
  const record = id.success ? await readAttemptRuntime(config, run, id.data) : undefined;

  if (!id.success || !record || record.phase === 'closed' || record.runtime === runsOn) return undefined;
  const notStopped = await stopOnRecordedDriver(config, run, id.data, { checkout });

  if (notStopped) return notStopped;
  await fs.rm(attemptRuntimePath(config, run, id.data), { force: true });

  return undefined;
}

/**
 * The session the step's tool resumes, and the lease session it continues: the lease's session, else each earlier one it
 * continued, newest first. Each is tried on this machine, then as a copy in this tool, then as a copy of the one the team
 * session archive holds. OpenCode has no flag to resume one, so its step starts a new session. `held` answers whether
 * an earlier attempt of the run keeps the session where the step's runtime resumes it by id, such as the home a
 * runtime that launches agents its own way reported it in.
 */
async function resumeSession(archive: SessionArchive, lease: Lease, target: LaunchTarget, cwd: string, held?: (session: SessionRef) => Promise<boolean>): Promise<{ id: string; resumed: SessionRef } | undefined> {
  const to = AgentSession.platformForTool(target.name);

  if (!lease.session || !to) return undefined;
  const resumes = launchAdapterIdOf(target.tool) !== 'opencode';
  const misses: string[] = [];

  for (const session of [lease.session, ...(lease.session.earlier ?? [])]) {
    const from = AgentSession.platformForTool(session.tool);

    if (!from) continue;
    const resumed = { tool: session.tool, id: session.id };

    // One platform is one store: a tool that shares the format but keeps its own home, as an instance does, gets a copy.
    if (from === to && resumes) {
      if (await held?.(resumed)) return { id: session.id, resumed };
      const found = await AgentSession.find({ platform: from, sessionId: session.id }, { scrub: false });

      if (found.status === 'done') return { id: session.id, resumed };
      misses.push(found.failure.message);
    } else {
      const copied = await AgentSession.copy({ from: { platform: from, sessionId: session.id }, to: { platform: to, cwd } });

      if (copied.status === 'done') return resumes ? { id: copied.sessionId, resumed } : undefined;
      misses.push(copied.failure.message);
    }

    const restored = await archive.restore({ platform: from, sessionId: session.id }, { platform: to, cwd });

    if (restored.status !== 'fresh') return resumes ? { id: restored.sessionId, resumed } : undefined;
    misses.push(restored.reason);
  }

  if (misses.length > 0) log.warn(`Step "${lease.step}" starts a new ${target.name} session: ${misses.join(' ')}`);

  return undefined;
}

async function commandReport(config: LocalConfig, lock: RunLock, driver: DriverIdentity, lease: Lease, exited: CommandExit, secrets: Record<string, string>): Promise<ReportBody> {
  const result = { ...exited, stderr: withoutStreamMarks(exited.stderr) };
  const end = commandEnd(result);
  await AttemptResult.write(attemptResultPath(config, lock.run, lease.attempt), end.outputs !== undefined ? { output: end.outputs } : {}, secrets);
  // What a command says as it runs goes to its stderr, so its stdout stays the step's outputs.
  const progress = result.stderr.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => masked(line, secrets));
  const body: ReportBody = { attempt: lease.attempt, revision: lease.revision, driver, ...end };

  if (progress.length > 0) body.progress = progress;

  return body;
}

function masked(line: string, secrets: Record<string, string>): string {
  return redact(line, { envSecrets: secrets, patterns: false });
}

/** Writes that call `show` with each whole line of the chunks given, and with what is left once `end` is called. */
function lineSplitter(show: (line: string) => void) {
  let rest = '';
  const each = (line: string): void => { if (line.trim() !== '') show(line); };

  return {
    write: (chunk: string): void => {
      const lines = `${rest}${chunk}`.split(/\r?\n/);
      rest = lines.pop() ?? '';
      lines.forEach(each);
    },
    end: (): void => { each(rest); rest = ''; },
  };
}

/**
 * The team skills the pass's session and its subagents loaded since `launchedAt`, credited by `teamSkills`, what its
 * checkout held as delivered at launch. A load before it, by a pass whose session this one resumes, is that pass's.
 * Undefined when the session cannot be read.
 */
async function usedInSession(tool: string, sessionId: string, cwd: string, teamSkills: Record<string, string[]>, launchedAt: number, storeDir?: string): Promise<Used | undefined> {
  const platform = AgentSession.platformForTool(tool);

  if (!platform) return undefined;
  const ref: AgentSessionRef = { platform, sessionId, cwd };

  if (storeDir !== undefined) ref.storeDir = storeDir;
  const found = await AgentSession.find(ref, { subagents: true }).catch(() => undefined);
  const atOrAfterLaunch = (timestamp: string | undefined): boolean => timestamp === undefined || !(Date.parse(timestamp) < launchedAt);

  return found?.status === 'done'
    ? { skills: usedSkills(AgentSession.toolForPlatform(platform), found, (timestamp) => atOrAfterLaunch(timestamp) ? teamSkills : {}) }
    : undefined;
}

async function promptReport(
  config: LocalConfig,
  lock: RunLock,
  driver: DriverIdentity,
  lease: Lease,
  adapter: LocalToolAdapter,
  options: LocalDriverOptions,
  archive: SessionArchive,
  signal: AbortSignal,
  mode: RunMode,
  staged: LaunchChoice | undefined,
  secrets: Record<string, string>,
  askPerson: AskPerson | undefined,
  onRuntime: { run: AttemptRun; logins: readonly LoginTool[]; launchesAgents: boolean; credentials: Record<string, string>; found: readonly string[]; defaultTool?: string; teamEnv: WorkflowEnv } | undefined,
): Promise<ReportBody> {
  const giveUp = async (failure: WorkflowFailure, tool?: string): Promise<ReportBody> => {
    const unrestored = await abandonPlace({ config, lock, attempt: lease.attempt });
    const reported = unrestored ? { ...failure, message: `${failure.message.replace(/\.?$/, '.')} ${unrestored}` } : failure;

    const body: ReportBody = { attempt: lease.attempt, revision: lease.revision, driver, ...failureReport(reported) };

    if (tool) body.tool = tool;

    return body;
  };

  // A role lease's place was staged for its launch tool, which launches it; others pick theirs now.
  const choice = staged ?? launchToolFor({ agent: lease.agent, tool: lease.tool }, config, options.tools ?? {}, await memberTools(config), onRuntime?.defaultTool);

  for (const warning of choice.warnings) log.warn(warning);

  if (!choice.ok) return giveUp(choice.failure, choice.tool);
  const selected = choice.tool;
  // The name the step runs its tool by, an instance's own: its report, delivery and sessions are credited to it.
  const { target } = choice;
  const launched = target.name;

  // A team instance's own command runs only once a person accepted it here.
  if (target.instance) {
    const accepted = await acceptToolCommand(target.instance, { ask: askPerson && ((question) => askPerson(question, signal)) });

    if (!accepted.ok) return giveUp({ code: accepted.code, message: accepted.message }, launched);
  }

  // A worktree has its own pull record, so the tool launched there is observed and bound as that checkout. A clone has
  // its own install, never the member's config, and none when its place installs no team.
  const contract = lease.workspace;
  const clone = contractClone(contract) ? contract?.branch : undefined;
  const prepared = clone !== undefined ? await preparedClone(config, lock.run, clone) : undefined;

  // The copy was checked as it was prepared; it is checked again right before launch, as something may have pulled since.
  if (lease.role !== undefined) {
    const { role, step } = lease;

    const refused = clone !== undefined
      ? prepared?.install
        ? await cloneRoleProblem({ install: prepared.install, step, role, tools: [launched] })
        : roleNotDeliveredFailure({ role, step, notDelivered: { copy: 'clone', gap: { kind: 'no_install' } } })
      : lease.cwd !== undefined
        ? await worktreeRoleProblem({ dir: lease.cwd, step, role, tools: [launched] })
        : roleNotDeliveredFailure({ role, step, notDelivered: { copy: 'none' } });

    if (refused !== undefined) return giveUp(refused, launched);
  }

  const teamConfig = clone !== undefined
    ? prepared?.install
    : contract && lease.cwd ? await detectProjectConfig(lease.cwd) ?? config : config;

  const stepConfig = teamConfig ?? config;
  const loaded = lease.agent && teamConfig ? await loadDeployedAgent({ tool: selected, name: lease.agent, config: teamConfig, toolPaths: options.toolPaths }) : undefined;
  const agent = loaded?.spec;

  if (lease.agent && !agent) {
    return giveUp({
      code: 'agent_unavailable',
      message: `Agent "${lease.agent}" is not available for ${launched}. Run teamai pull and try again.`,
    }, launched);
  }

  const chosen = await chooseStepModel({
    step: lease.step, tool: selected, model: lease.model, defaultModel: lease.defaultModel, agent: agent ?? undefined, config: stepConfig,
    passesAgentFile: !onRuntime?.launchesAgents,
  });

  if (!chosen.ok) return giveUp(chosen.failure, launched);

  if (agent && launchAdapterIdOf(selected) === 'codex') {
    const ignored = ignoredCodexSettings(agent);

    if (ignored.length > 0) {
      log.warn(`Agent "${agent.name}" on ${selected} does not apply ${ignored.join(', ')} from the deployed agent file. codex exec still has a shell. The step is not blocked.`);
    }
  }

  const cwd = lease.cwd ?? driver.workspace;
  const resultFile = attemptResultPath(config, lock.run, lease.attempt);
  // On a step runtime that execs the tool, it keeps its session in a home of the attempt's, under the variable it reads:
  // an instance's own `home.env`, else the one of the tool it extends. A runtime that launches agents its own way gives
  // the tool its own home, where the member's sessions are found.
  const execs = onRuntime && !onRuntime.launchesAgents ? onRuntime : undefined;
  const variable = execs ? target.instance?.home?.env ?? toolHomeVariable(selected) : undefined;

  if (execs && (variable === undefined || !isExecRuntimeTool(selected))) {
    return giveUp({
      code: 'tool_unsupported',
      message: `A step runtime runs prompt steps on ${EXEC_RUNTIME_TOOLS.join(', ')}, and step "${lease.step}" runs on ${selected}. Name one of them with the step's tool or --tools, or run the step with --driver local.`,
    }, selected);
  }

  if (execs && lease.interactive) {
    return giveUp({ code: 'tool_unsupported', message: `Step "${lease.step}" is interactive, and a step runtime runs only headless prompts. Run the step with --driver local.` }, selected);
  }

  // An instance reaches a runtime that execs its tool only when the runtime lists it, so its command is there. Its
  // home, and the sessions there, are its own.
  const toolHome = execs && variable !== undefined ? { tool: selected, variable, dir: attemptToolHome(config, lock.run, lease.attempt, launched) } : undefined;
  const storeDir = toolHome ? storeDirOf(AgentSession.platformForTool(launched) ?? '', { kind: 'tool-home', dir: toolHome.dir }) : undefined;
  let resume: { id: string; resumed: SessionRef } | undefined;

  if (toolHome) {
    await fs.mkdir(toolHome.dir, { recursive: true });
    const seeded = lease.session ? await seedToolHome({ config, run: lock.run, attempt: lease.attempt, tool: launched, sessions: [lease.session, ...lease.session.earlier ?? []] }) : undefined;

    // The tool starts on the member's own model choices, from their home of it, or of the instance.
    if (isExecRuntimeTool(selected)) await seedMemberModel({ tool: selected, dir: toolHome.dir, memberHome: target.instance?.home ? instanceHomeDir(target.instance.home, target.instance.extends) : memberToolHome(selected) });

    if (seeded) resume = { id: seeded.id, resumed: { tool: seeded.tool, id: seeded.id } };
  } else {
    // A runtime that launches agents resumes a session by id in the home it reported it in.
    const held = onRuntime?.launchesAgents ? async (session: SessionRef) => (await attemptHoldingSession(config, lock.run, session)) !== undefined : undefined;
    resume = await resumeSession(archive, lease, target, cwd, held);
  }

  // A login the runtime brings is held by this attempt alone, on the whole machine, from before the place opens until
  // it is written back: another attempt waits for it here, naming the attempt that holds it.
  // An instance keeps its own sign-in in its own home, so a login of the tool it extends is not copied there.
  const login = toolHome ? execs?.logins.find((tool) => tool === launched) : undefined;

  if (login && toolHome) {
    // The first attended step that needs the login creates it for the member; an unattended one says how.
    const missing = await ensureLogin(login, { step: { run: lock.run, id: lease.step }, canAsk: mode === 'attended' && process.stdin.isTTY && process.stderr.isTTY });

    if (missing) return giveUp(missing, selected);
    const waitFile = loginWaitFile(attemptDir(config, lock.run, lease.attempt));

    const held = await holdLogin({
      tool: login, run: lock.run, attempt: lease.attempt, toolHome: toolHome.dir, signal,
      onWait: async (wait) => {
        if (!wait) return fs.rm(waitFile, { force: true });
        log.info(`Step "${lease.step}" waits for the ${wait.tool} login teamai keeps, which attempt ${wait.holder.attempt} of run ${wait.holder.run} holds. It goes on once that attempt ends; teamai workflow cancel ${wait.holder.run} releases it.`);
        await writeJsonAtomic(waitFile, wait);
      },
    });

    await fs.rm(waitFile, { force: true });

    if (!held.ok) return giveUp(held.failure, selected);
  }

  const launchModel = (model: StepModel): LaunchModel => {
    const named: LaunchModel = { model: model.name };

    if (model.effort) named.effort = model.effort;

    return named;
  };

  const definitionModel = chosen.model && chosen.by === 'definition' ? launchModel(chosen.model) : {};

  const { teamDelivery } = await import('../../../pull.js');

  const delivery = prepared?.install
    ? await cloneDelivery({ install: prepared.install, without: prepared.without }, launched)
    : teamConfig ? await teamDelivery(teamConfig, launched).catch(() => undefined) : undefined;

  const observing: ToolLaunch = { config: stepConfig, tool: launched, cwd, delivery: delivery ?? null };

  // In a clone, git reads its head without the names the place withholds, which setup could have handed a hook.
  if (clone !== undefined) observing.head = await cloneHead(config, lock.run, clone, { withhold: lease.envScope?.withhold ?? [], expiresAt: lease.expiresAt });

  if (lease.agent && loaded) observing.definition = { stem: lease.agent, file: loaded.file, ...definitionModel };

  if (chosen.model && chosen.by !== 'definition') observing.chosen = { ...launchModel(chosen.model), alias: chosen.alias || undefined };

  const [observed, launch, teamSkills] = await Promise.all([
    observeLaunch(observing),
    teamConfig ? workflowLaunch(teamConfig, launched) : undefined,
    delivery?.record?.delivered ? deliveredTeamSkills(stepConfig, cwd, delivery.record.delivered, delivery.record.rev).then((found) => found.teamSkills, () => undefined) : undefined,
  ]);

  // Only headless Claude and CodeBuddy have a turn limit, and a runtime that launches agents its own way keeps the cap it
  // offered; any other launch reports the cap as not enforced.
  const family = launchAdapterIdOf(selected);
  const capsTurns = lease.maxTurns !== undefined && !lease.interactive && (onRuntime?.launchesAgents === true || family === 'claude' || family === 'codebuddy');
  // A turn is ended only at the limits its tool is known to keep and report: Codex states its usage only as it ends, and
  // CodeBuddy's turn cap and per-message usage are untried, so the rest list as unenforced.
  const { limits } = lease;
  const endsAtTurns = limits?.maxTurns !== undefined && !lease.interactive && family === 'claude' ? limits.maxTurns : undefined;
  // A runtime that launches agents its own way states usage only once the prompt ends, so the budget is checked then.
  const budget = limits?.budget !== undefined && !onRuntime?.launchesAgents && (family === 'claude' || family === 'opencode') ? limits.budget.tokens : undefined;
  const launchedAt = Date.now();

  if (lease.interactive && !onRuntime) log.info(`Step "${lease.step}" opens ${launched} here for interactive work.`);

  const input: LocalToolRun = {
    prompt: lease.prompt!,
    cwd,
    resultPath: resultFile,
    secrets,
    // The lease `env` is set over the step's environment, as a command's is.
    env: { ...lease.processEnv ?? process.env, ...lease.env, ...attemptEnv(config, lock.run, lease.attempt, mode) },
  };

  if (lease.output) input.output = lease.output;

  let launcher = adapter;

  // Setup runs on the step's runtime once the place is open there, before the tool.
  const setUp = async (): Promise<WorkflowFailure | undefined> => (onRuntime ? runPlaceSetup({ config, run: lock.run, attempt: lease.attempt, mode, env: onRuntime.teamEnv, signal, on: runtimeSetup(onRuntime.run) }) : undefined);

  // On a step runtime the tool gets only the names its lease provides, over the runtime's own, and its home.
  if (onRuntime?.launchesAgents) {
    const scoped = runtimeStepEnv(lease, lease.processEnv ?? {}, { config, run: lock.run, mode });
    input.env = scoped.env;
    launcher = runtimePrompter(onRuntime.run, { view: await placeView(config, lock.run, lease.attempt, cwd), runId: lock.run, step: lease.step, provided: scoped.provided, unset: scoped.unset, credentials: credentialsForTool(onRuntime.credentials, onRuntime.found, launched), setUp, tool: launched });
  } else if (onRuntime && toolHome) {
    const scoped = runtimeStepEnv(lease, lease.processEnv ?? {}, { config, run: lock.run, mode });
    input.env = { ...scoped.env, [toolHome.variable]: toolHome.dir };
    const view = await placeView(config, lock.run, lease.attempt, cwd, toolHome);
    launcher = toolAdapter(runtimeLauncher(onRuntime.run, { view, tool: launched, toolHome: { tool: toolHome.tool, dir: toolHome.dir }, unset: scoped.unset, credentials: credentialsForTool(onRuntime.credentials, onRuntime.found, toolHome.tool), setUp }), (command) => command, (command) => command);
  }

  if (launch) input.launch = launch;

  if (resume) input.resume = resume.id;

  if (agent) input.agent = definitionRun(selected, lease.agent!, agent);

  if (chosen.model) input.model = chosen.model;

  if (capsTurns) input.maxTurns = lease.maxTurns;
  else if (endsAtTurns !== undefined) input.maxTurns = endsAtTurns;

  if (budget !== undefined) input.budget = budget;

  if (limits?.timeoutMs !== undefined) input.timeoutMs = limits.timeoutMs;

  if (lease.permissions === 'unattended') input.unattended = true;

  if (target.instance?.command) input.command = target.instance.command;

  const { result, durationMs } = await timedLaunch({
    launch: lease.interactive ? launcher.runInteractive.bind(launcher) : launcher.run.bind(launcher),
    tool: selected,
    input,
    signal,
    unfinished: `${launched} could not complete the workflow step`,
  });

  const end: StepEnd = { outcome: result.exitCode === 0 && !result.failure ? 'success' : 'failed' };

  if (end.outcome === 'failed' && result.failure) {
    // A runtime that launches agents its own way ended its prompt's failure with the retry already (runtimePrompter).
    const failure = onRuntime?.launchesAgents ? result.failure : { ...result.failure, message: withRetry(result.failure, { run: lock.run, step: lease.step }) };
    end.message = failure.message;
    end.failure = failure;
  }

  // A runtime lost while the tool ran may still run it, refreshing the login: the attempt keeps it, and closing its
  // place says how to free it.
  if (login && toolHome && result.failure?.code !== 'runtime_lost') {
    // A runtime that failed may not have brought the tool home back, so what is there says nothing of the login.
    const collected = !(result.failure?.code.startsWith('runtime_') === true && result.failure.code !== 'runtime_interrupted');
    const notBack = await writeLoginBack({ tool: login, run: lock.run, attempt: lease.attempt, toolHome: toolHome.dir, collected });
    await releaseLogin(login, { run: lock.run, attempt: lease.attempt });

    if (notBack && end.outcome === 'success') {
      end.outcome = 'failed';
      end.message = notBack.message;
      end.failure = notBack;
    } else if (notBack) {
      log.warn(notBack.message);
    }
  }

  const ran = result.started ? result : undefined;
  const used = ran?.session && teamSkills ? await usedInSession(launched, ran.session, cwd, teamSkills, launchedAt, storeDir || undefined) : undefined;
  // A tool held to no budget that stated it spent more still ended its turn there: the budget names it.
  const passedBudget = limits?.budget !== undefined && budget === undefined && budgeted(ran?.tokens) > limits.budget.tokens;
  const stoppedBy = ran?.stoppedBy ?? (passedBudget ? 'budget' : undefined);
  const limit = limits && stoppedBy && setsLimit(limits, stoppedBy) ? stoppedBy : undefined;

  const unenforced = [
    ...((lease.maxTurns !== undefined && !capsTurns) || (limits?.maxTurns !== undefined && endsAtTurns === undefined) ? ['max_turns' as const] : []),
    ...(limits?.budget !== undefined && budget === undefined ? ['budget' as const] : []),
  ];

  const body: ReportBody = { attempt: lease.attempt, revision: lease.revision, driver, tool: launched, outcome: end.outcome };

  if (ran?.model) body.model = ran.model;

  if (ran?.session) body.session = ran.session;

  // A runtime that launches agents its own way says whether it continued the session; one that says nothing did not.
  if (ran && resume && !ran.startedFresh) body.resumed = resume.resumed;

  if (ran) body.durationMs = durationMs;

  if (ran?.tokens) body.tokens = ran.tokens;

  if (ran?.cost) body.cost = ran.cost;

  if (ran?.output !== undefined) body.outputs = ran.output;

  // How the definition was handed over is known only once the launch resolved its tool: OpenCode's depends on its major.
  if (ran) body.agent = ran.applied ? { ...observed, definition: { applied: ran.applied } } : observed;

  if (used) body.used = used;

  if (unenforced.length > 0) body.unenforced = unenforced;
  body.exitCode = result.exitCode;

  if (limit) {
    body.outcome = 'success';
    body.limit = limit;
  } else if (end.failure) {
    Object.assign(body, failureReport(end.failure));
  } else if (end.message) {
    body.message = end.message;
  }

  return body;
}

/**
 * Run leased commands, up to `workflows.max_parallel` at once, or with none set one at a time but for the items of a
 * `for_each` that declares `max_parallel`. Each lease and report goes through the same engine operations an external
 * driver calls.
 */
export async function runLocalDriver(
  config: LocalConfig,
  runId: string,
  cwd: string,
  options: LocalDriverOptions = {},
): Promise<WorkflowEnvelope> {
  return withDriverLock(config, runId, (driveLocked) => driveLocked(cwd, options));
}

/**
 * Runs `body` holding this machine's driver lock of run `runId`, or answers `driver_running` without running it. `body`
 * drives the run through `drive`, so whatever it changes first, such as a claim, no other local driver of the run sees.
 */
export async function withDriverLock(
  config: LocalConfig,
  runId: string,
  body: (drive: (cwd: string, options: LocalDriverOptions) => Promise<WorkflowEnvelope>) => Promise<WorkflowEnvelope>,
): Promise<WorkflowEnvelope> {
  const run = RunIdSchema.safeParse(runId);

  if (!run.success) return { error: { code: 'invalid_run', message: 'Run id must look like r followed by 8 or 16 hex digits' } };

  return withRunLock(config, run.data, (lock) => body((cwd, options) => driveRun(config, lock, cwd, options)), { waitMs: 0 });
}

/** Adds to `seen` each value of `secrets` it lacks, under a label of its own when its name already holds another value. */
function rememberSecrets(seen: Record<string, string>, secrets: Record<string, string>) {
  const known = new Set(Object.values(seen));

  for (const [key, value] of Object.entries(secrets)) {
    if (known.has(value)) continue;
    let label = key;

    for (let count = 2; label in seen; count += 1) label = `${key} (value ${count})`;
    seen[label] = value;
    known.add(value);
  }

  return { ...seen };
}

/**
 * What this driver declares on every `next`. Every key is set, so a new capability does not compile until it is decided.
 * It runs setup in each workspace it creates. `tools` are the tools it launches a prompt step on, named or picked. It
 * ends a prompt's turn at the limits its lease carries. It runs an unattended prompt in its tool's unattended mode, and
 * fails one whose tool has none.
 */
function localCan({ strict, hitl, tools, confined }: { strict: StrictCan; hitl: boolean; tools: string[]; confined: ConfinedOffer[] }): DecidedCan {
  return { hitl, exec: true, workspace: [...WORKSPACE_MODES], ...strict, tokens: true, max_turns: true, setup: true, tools, end_turn: true, unattended: true, role: true, confined };
}

type StrictCan = Required<Pick<DriverCan, 'network' | 'isolation' | 'env'>>;

/**
 * What this driver gives the strict requirements of a run on this machine, which a local start checks before the run
 * exists. It cannot deny a step the network, keeps it from the member's machine only on a host the member marks
 * `sandbox`, in config or with `--sandbox`, and gives each command and tool only the env keys its lease provides.
 */
export function localStrictCan(config: LocalConfig, options: Pick<LocalDriverOptions, 'sandbox'>): StrictCan {
  return { network: false, isolation: isSandbox(config, options) ? 'sandbox' : 'none', env: true };
}

/** Whether the command that starts the tool `name` names is on PATH here. */
function onPath(name: string): boolean {
  const target = launchTargetOf(name);

  return target !== undefined && launchExecutableOf(target) !== null;
}

/**
 * The tools the run's steps launch on: `named`, those its steps name, undefined when a `from` step may bring a workflow
 * that names any; and `picked`, those `toolFor` picks for its prompt steps that name none, with the pick for a step that
 * names no agent when a `from` step may bring one. Looking a tool up can start login shells, so the driver looks up only
 * the named ones.
 */
function runTools(run: Pick<RunState, 'definition' | 'workflows'>, toolFor: ToolFor) {
  const named = new Set<string>();
  const picked = new Set<string>();
  let bringsSteps = false;

  const visit = (steps: readonly WorkflowStep[]): void => {
    for (const step of steps) {
      const tool = promptTool(step, toolFor);

      if (step.tool !== undefined) named.add(step.tool);
      else if (tool !== undefined) picked.add(tool);
      const child = stepWorkflow(step);

      if (child?.kind === 'from') bringsSteps = true;

      if (child?.kind === 'inline') visit(child.workflow.steps);
    }
  };

  for (const definition of [run.definition, ...Object.values(run.workflows ?? {})]) visit(definition.steps);
  const unnamed = bringsSteps ? toolFor({}) : undefined;

  if (unnamed !== undefined) picked.add(unnamed);

  return { named: bringsSteps ? undefined : named, picked };
}

/**
 * Whether a step of `run` may be confined to a directory: one is, or a `from` step may bring a workflow with one. Probing
 * the confined tools runs each, so the driver probes them only then.
 */
function mayConfine(run: Pick<RunState, 'definition' | 'workflows'>): boolean {
  const confines = (steps: readonly WorkflowStep[]): boolean => steps.some((step) => {
    const child = stepWorkflow(step);

    return confinedOf(step) !== undefined || child?.kind === 'from' || (child?.kind === 'inline' && confines(child.workflow.steps));
  });

  return [run.definition, ...Object.values(run.workflows ?? {})].some((definition) => confines(definition.steps));
}

/**
 * Whether two items of `run` may run at once with no `workflows.max_parallel`: a `for_each` it has now declares
 * `max_parallel` above 1, or a template of it. A workflow a `from` step admits later is read when the run is driven
 * again, so such a run keeps the terminal, one step at a time, until then.
 */
function mayRunItemsBeside(run: Pick<RunState, 'definition' | 'workflows' | 'admitted'>): boolean {
  const beside = (steps: readonly WorkflowStep[]): boolean => steps.some((step) => {
    const max = step.forEach?.maxParallel;
    const child = stepWorkflow(step);

    return (max !== undefined && (max instanceof Object || max > 1)) || (child?.kind === 'inline' && beside(child.workflow.steps));
  });

  const definitions = [run.definition, ...Object.values(run.workflows ?? {}), ...Object.values(run.admitted ?? {}).map(({ definition }) => definition)];

  return definitions.some((definition) => beside(definition.steps));
}

function isSandbox(config: LocalConfig, options: Pick<LocalDriverOptions, 'sandbox'>): boolean {
  return options.sandbox === true || config.workflows?.sandbox === true;
}

/**
 * Whether a person answers the HITL requests the local driver puts to them in run mode `mode`: an attended run at a
 * terminal. A terminal alone is not a person: an unattended run under a pseudo-terminal asks nobody.
 */
export function personAnswers(mode: RunMode): boolean {
  return mode === 'attended' && Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY);
}

/**
 * Runs a prompt's tool, timed around the tool's run alone. A launch that throws fails `tool_failed` with `unfinished`.
 * The adapter returns once the tool's process group is gone, so when its timeout or budget stopped it, no lock git left
 * in the checkout is held any more, and they are removed.
 */
async function timedLaunch({ launch, tool, input, signal, unfinished }: {
  launch: LocalToolAdapter['run'];
  tool: LaunchTool;
  input: LocalToolRun;
  signal: AbortSignal;
  unfinished: string;
}): Promise<{ result: LocalToolResult; durationMs: number }> {
  const started = performance.now();
  let result: LocalToolResult;

  try {
    result = await launch(tool, input, signal);
  } catch {
    result = { started: false, exitCode: 1, failure: { code: 'tool_failed', message: unfinished } };
  }

  const durationMs = Math.round(performance.now() - started);

  if (result.started && (result.stoppedBy === 'timeout' || result.stoppedBy === 'budget')) await removeGitLocks(path.join(input.cwd, '.git'));

  return { result, durationMs };
}

/**
 * Removes the locks a git process leaves when it is killed mid-write, on which the report's commit of the clone would
 * fail: those directly under `gitDir`, such as `index.lock` and `HEAD.lock`, and those of its refs. None under
 * `objects/` blocks the commit. The agent shaped the clone, so a `gitDir` or `refs` that is not a real directory, such
 * as a link out of the clone, is left alone.
 */
async function removeGitLocks(gitDir: string): Promise<void> {
  const isDirectory = async (at: string): Promise<boolean> => (await fs.lstat(at).catch(() => undefined))?.isDirectory() === true;

  if (!await isDirectory(gitDir)) return;
  const top = await fs.readdir(gitDir).catch((): string[] => []);
  const refs = await isDirectory(path.join(gitDir, 'refs')) ? await fs.readdir(path.join(gitDir, 'refs'), { recursive: true }).catch((): string[] => []) : [];
  const locks = [...top.map((name) => path.join(gitDir, name)), ...refs.map((name) => path.join(gitDir, 'refs', name))].filter((at) => at.endsWith('.lock'));
  await Promise.all(locks.map((lock) => fs.rm(lock, { force: true })));
}

/**
 * The flags a drive runs with: those `given`, over the ones the run `remembered` from this install's last drive, a
 * `--tools` name at a time. A flag left out keeps what the run remembers. The driver definition is the one this drive
 * runs on, which `workflow resume` reopens when it names none; plain `local` records none.
 */
function drivenWith(given: Pick<LocalDriverOptions, 'tools' | 'autoApprove' | 'sandbox' | 'runtimes'>, remembered: DriveOptions | undefined): DriveOptions {
  const driven: DriveOptions = {};
  const tools = { ...remembered?.tools, ...given.tools };

  if (Object.keys(tools).length > 0) driven.tools = tools;
  // Kept off as well as on: an off overrides the member's workflows.auto_approve, as the flag does.
  const autoApprove = given.autoApprove ?? remembered?.autoApprove;

  if (autoApprove !== undefined) driven.autoApprove = autoApprove;

  if (given.sandbox ?? remembered?.sandbox) driven.sandbox = true;

  if (given.runtimes) driven.driver = given.runtimes.driver;

  return driven;
}

/**
 * `given` over what run `run` remembers, which the run then remembers for the next drive, so a resume without flags
 * drives the run as this one does. Answers the error when the run file could not be written.
 */
async function rememberDrive(config: LocalConfig, run: RunState, given: LocalDriverOptions): Promise<LocalDriverOptions | { error: WorkflowFailure }> {
  const driven = drivenWith(given, run.driveOptions);
  // Neither given nor remembered, auto-approve stays unset, so the member's workflows.auto_approve decides.
  const options = { ...given, tools: driven.tools ?? {}, autoApprove: driven.autoApprove, sandbox: driven.sandbox === true };

  if (JSON.stringify(driven) === JSON.stringify(run.driveOptions ?? {})) return options;

  const written = await updateRun(config, run.id, await knownSecrets(config), async (stored) => ({
    value: undefined,
    write: stored === 'missing' ? undefined : { ...stored, driveOptions: driven },
  }));

  if (written.status === 'busy') return { error: { code: 'busy', message: `Run ${run.id} is locked by another process, so it was not driven. Resume it again: teamai workflow resume ${run.id}` } };

  if (written.status === 'corrupt') return { error: { code: 'run_unreadable', message: `Run ${run.id} could not be read` } };

  return options;
}

async function driveRun(config: LocalConfig, lock: RunLock, cwd: string, given: LocalDriverOptions): Promise<WorkflowEnvelope> {
  const runId = lock.run;
  const started = await readRun(config, runId);
  // Places go under the checkout the run started from, wherever in it the driver runs.
  const isStarted = started !== 'missing' && started !== 'corrupt';
  const drive = isStarted ? await rememberDrive(config, started, given) : given;

  if ('error' in drive) return drive;
  const options = drive;
  const root = await placeRoot({ cwd, checkout: isStarted ? started.checkout : undefined });
  const unreconciled = await reconcileTakenCopies(config, runId, root);

  if (unreconciled) return { error: unreconciled };
  // Resolved once per drive, so a resume where a person attends runs attended whatever mode the run started in.
  const mode = resolveRunMode(process.env);
  const canHitl = options.hitl ?? personAnswers(mode);
  const members = await memberTools(config);

  // The tool a prompt step that names none launches on, which a runtime must offer as it must a named one: an
  // instance by its own name, since a runtime that offers the tool it extends does not run it. Offered to a runtime
  // that reports the default of the app it drives, that default comes before the member's own.
  const toolForOn = (runtimeDefault: string | undefined): ToolFor => (step) => {
    const choice = launchToolFor(step, config, options.tools ?? {}, members, runtimeDefault);

    return choice.ok ? choice.target.name : undefined;
  };

  const toolFor = toolForOn(undefined);

  // It launches a step that names its tool on the tools this machine has: those the run's steps name, or every one when a
  // step's output may bring a workflow later. It is the run's only driver, so a step whose tool it cannot launch fails
  // rather than waits. A tool it picks for a step that names none, and that no step names, it offers without looking it
  // up, as it always launched it: launching it says if it is missing.
  const { named, picked } = isStarted ? runTools(started, toolFor) : { named: undefined, picked: new Set<string>() };
  const found = [...LAUNCH_TOOLS, ...instanceNames().filter((name) => !isToolId(name))].filter((tool) => (named === undefined || named.has(tool)) && onPath(tool));
  const pickedUnlooked = [...picked].filter((tool) => !found.some((launched) => launched === tool) && !(named?.has(tool) ?? false));
  const tools = [...found, ...pickedUnlooked];
  const defined: DriverRuntimes = options.runtimes ?? { driver: 'local', runtimes: [{ kind: 'local', use: 'local', engine: { logins: [] } }] };
  const lookup = options.resolveTool ? { resolveTool: options.resolveTool } : {};
  const confined = isStarted && mayConfine(started) ? await confinedOffers(lookup) : [];
  const local = localStepRuntime(localCan({ strict: localStrictCan(config, options), hitl: canHitl, tools, confined }));
  const localReady = await local.init({ options: {}, mode });

  if (!localReady.ok) return { error: { code: 'runtime_failed', message: localReady.failure.message } };

  // An external runtime is offered with what it said it can. One that execs the tool launches only the tools it can give
  // a home, and the instances of them it lists; one that launches agents its own way gives each its own. It keeps
  // `can.confined` only when its init said it answers confined prompts (the stdio reader drops it otherwise).
  // A runtime that runs a tool without permission prompts outside a sandbox proves no isolation: its steps' is none.
  const unproven = (can: DriverCan): boolean => (can.fullAccess?.length ?? 0) > 0 && can.isolation !== 'sandbox';

  const toSlot = (entry: OpenedDriver['runtimes'][number]): RuntimeSlot => (entry.kind === 'local'
    ? { kind: 'local', use: 'local', runtime: local, can: localReady.can, launchesAgents: false, engine: entry.engine, credentials: {}, found: [] }
    : {
      kind: 'external', use: entry.use, runtime: entry.runtime, launchesAgents: entry.launchesAgents, engine: entry.engine, credentials: entry.credentials, found: entry.found,
      ...(entry.unavailable && { unavailable: entry.unavailable }),
      can: {
        ...entry.can, tools: entry.launchesAgents ? entry.can.tools : (entry.can.tools ?? []).filter((tool) => isExecRuntimeTool(baseToolOf(tool))), remote: true,
        ...(unproven(entry.can) && { isolation: 'none' as const }),
      },
    });

  for (const entry of defined.runtimes) {
    if (entry.kind === 'external' && unproven(entry.can)) {
      log.warn(`Runtime ${entry.use} of driver ${defined.driver} runs steps in full access on this machine, as ${entry.optionsFrom} sets: they run without asking for permission, an unattended run approves the runtime's own full-access sign-in where it asks for one, and teamai cannot prove any isolation. Their isolation is recorded as none.`);
    }
  }

  // Every definition has a host command slot: its `local`, or else one here that takes no prompt step but answer steps, last. While another
  // runtime runs commands, it takes only the command steps of teamai's own workflows, so a team's command never runs
  // here in place of that runtime.
  const definedSlots = defined.runtimes.map(toSlot);
  const listedHost = definedSlots.find((slot) => slot.kind === 'local');

  const hostSlot: RuntimeSlot = listedHost ?? {
    kind: 'local', use: 'host', runtime: local, can: { ...localReady.can, prompt: false, tools: [], confined: [] }, launchesAgents: false, engine: { logins: [] }, credentials: {}, found: [],
  };

  const runsCommands = definedSlots.some((slot) => slot.kind === 'external' && slot.can.exec !== false);
  const host: RuntimeSlot = runsCommands ? { ...hostSlot, can: { ...hostSlot.can, commands: 'pinned' } } : hostSlot;
  const [firstSlot = host, ...otherSlots] = listedHost ? definedSlots.map((slot) => (slot === listedHost ? host : slot)) : [...definedSlots, host];
  const slots: [RuntimeSlot, ...RuntimeSlot[]] = [firstSlot, ...otherSlots];
  const offerOf = (slot: RuntimeSlot): RuntimeOffer => ({ runtime: slot.use, can: slot.can, ...(slot.unavailable && { unavailable: slot.unavailable }) });
  const sole: SoleDriver = { driver: defined.driver, offers: [offerOf(slots[0]), ...otherSlots.map(offerOf)] };
  // Started or resumed from an agent session, with no terminal here, on a runtime a person reaches through its app: a
  // gate is relayed to that session rather than decided, and the loop stops at it once nothing it started still runs.
  const relay = !canHitl && mode === 'attended' && agentEvidence(process.env).kind !== 'none' && slots.some((slot) => slot.can.hitl === true);
  const driver = driverIdentity('local', cwd);
  // The runtime each open attempt runs on, and the handle of its place, until its report is recorded or its place abandoned.
  const slotOf = new Map<string, RuntimeSlot>();
  const attemptRuns = new Map<string, AttemptRun>();
  const localHandles = new Map<string, string>();

  const runOf = (lease: Lease): AttemptRun | undefined => {
    const slot = slotOf.get(lease.attempt);

    if (slot?.kind !== 'external') return undefined;
    const known = attemptRuns.get(lease.attempt);

    if (known) return known;
    // The lease's expiry is the latest the attempt may run on its runtime. A turn limit ends the turn instead, and the
    // driver keeps it itself, so it gives no deadline.
    const created = attemptRun({ config, run: runId, attempt: lease.attempt, runtime: slot.runtime, driver: defined.driver, ...(lease.expiresAt !== undefined && { deadline: lease.expiresAt }) });
    attemptRuns.set(lease.attempt, created);

    return created;
  };

  /** The external step runtime the lease's attempt is bound to, by its definition's name; undefined on this host. */
  const externalOf = (lease: Lease): string | undefined => {
    const slot = slotOf.get(lease.attempt);

    return slot?.kind === 'external' ? slot.use : undefined;
  };

  // Each runtime before the one a step lands on that cannot run its tool now, once per drive, by runtime and tool.
  const fellPast = new Set<string>();

  /** Says once, with that runtime's reason, that a prompt step passed a runtime that lists its tool as unavailable. */
  const sayFellPast = (lease: Lease, slot: RuntimeSlot): void => {
    if (lease.prompt === undefined || lease.answer || lease.confined) return;
    const choice = launchToolFor({ agent: lease.agent, tool: lease.tool }, config, options.tools ?? {}, members, slot.can.default_tool);
    const tool = choice.ok ? choice.target.name : undefined;

    for (const earlier of slots.slice(0, slots.indexOf(slot))) {
      const reason = tool === undefined ? undefined : earlier.unavailable?.[tool];
      const key = `${earlier.use}\u0000${tool ?? ''}`;

      if (reason === undefined || fellPast.has(key)) continue;
      fellPast.add(key);
      log.warn(`Runtime ${earlier.use} of driver ${defined.driver} cannot run ${tool} now, so steps on ${tool} run on runtime ${slot.use}: ${earlier.use}: ${reason}`);
    }
  };

  /** Binds a lease to the runtime it was offered on. A `local` attempt's place is opened at once: it is the host's. */
  const bind = async (lease: Lease, slot: RuntimeSlot): Promise<void> => {
    slotOf.set(lease.attempt, slot);
    sayFellPast(lease, slot);

    if (slot.kind !== 'local') return;
    const view = { worktree: lease.cwd ?? root, readonly: [], result: path.dirname(attemptResultPath(config, runId, lease.attempt)), runDir: runScratchDir(config, runId), toolHome: {} };
    const opened = await slot.runtime.open({ op: newOpId(), run: runId, attempt: lease.attempt, view, credentials: {} }, async () => {});

    if (opened.kind === 'ready') localHandles.set(lease.attempt, opened.handle);
  };

  // The handle of the last place each external runtime closed for this run, which it is sent again once teamai removed
  // a clone or a team folder, so it sees the folder gone at a close, the verb it cleans up at.
  const lastClosed = new Map<RuntimeSlot, string>();

  const closeRun = async (attempt: AttemptId): Promise<void> => {
    const closing = attemptRuns.get(attempt);
    const handle = localHandles.get(attempt);
    const slot = slotOf.get(attempt);
    const logins = slot?.engine.logins ?? [];
    const closingHandle = slot?.kind === 'external' ? (await readAttemptRuntime(config, runId, attempt))?.open.handle : undefined;
    attemptRuns.delete(attempt);
    localHandles.delete(attempt);
    slotOf.delete(attempt);
    const notClosed = await closing?.close();

    if (slot && closingHandle !== undefined && !notClosed) lastClosed.set(slot, closingHandle);

    if (handle !== undefined) await local.close(handle);

    // A closed attempt holds no login, whatever stopped it before its write-back. One whose place stays open may
    // still run its tool, so it keeps the login until a person stops that tool.
    if (notClosed) log.warn(notClosed.message);

    for (const tool of logins) {
      if (!notClosed) {
        await releaseLogin(tool, { run: runId, attempt });
        continue;
      }

      const holder = await loginHolder(tool);

      if (holder?.run === runId && holder.attempt === attempt) {
        log.warn(`The ${tool} login teamai keeps stays held by attempt ${attempt} of run ${runId}, whose tool may still run. Stop that tool on its step runtime, then delete ${loginLockFile(tool)}.`);
      }
    }
  };

  /** Whether `slot` may open another attempt under its own `max_parallel`. */
  const slotHasRoom = (slot: RuntimeSlot): boolean => slot.engine.maxParallel === undefined
    || [...slotOf.values()].filter((bound) => bound === slot).length < slot.engine.maxParallel;

  // A restarted loop hands each attempt it left open back to the runtime it ran on, one at a time: an external one by
  // the runtime its record names, any other to local, or, without a local runtime, to the definition's first.
  const reconnecting: Array<{ attempt: string; slot: RuntimeSlot }> = [];

  if (isStarted) {
    for (const step of started.steps) {
      if (step.status !== 'leased') continue;
      const attempt = AttemptIdSchema.safeParse(step.lease.attempt);
      const record = attempt.success ? await readAttemptRuntime(config, runId, attempt.data) : undefined;

      const slot = (record && slots.find((candidate) => candidate.kind === 'external' && candidate.use === record.runtime))
        ?? (record ? slots.find((candidate) => candidate.kind === 'external') : undefined)
        ?? slots.find((candidate) => candidate.kind === 'local') ?? slots[0];

      reconnecting.push({ attempt: step.lease.attempt, slot });
    }
  }

  const abandon = async (attempt: AttemptId): Promise<void> => {
    await abandonPlace({ config, lock, attempt });
    await closeRun(attempt);
  };

  // A driver killed before cleanup, of this run or any other, left clones behind. The runtimes that ran in them, which
  // that driver can no longer tell, hear of it at a close.
  await closeAfterSweep(config, await sweepClones(config));
  const adapter = options.adapter ?? createLocalToolAdapter();
  const archive = openSessionArchive(config);
  // With no workflows.max_parallel the driver runs one step at a time, except the items of a for_each that declares
  // max_parallel, which `next` leases beside each other (`isOneAtATime`); a run that may have them runs in parallel.
  const isOneAtATime = config.workflows?.max_parallel === undefined;
  const maxParallel = config.workflows?.max_parallel ?? (isStarted && mayRunItemsBeside(started) ? Number.POSITIVE_INFINITY : 1);
  const isParallel = maxParallel > 1;
  // One command at a time keeps the terminal: Ctrl-C reaches it, and it can prompt on /dev/tty. Parallel commands get
  // process groups of their own, which `stop` and the signal handlers below can end as a whole.
  const detached = isParallel && process.platform !== 'win32';
  const reported = new Set<string>();
  const inFlight = new Map<string, { lease: Lease; command: StagedCommand }>();
  // Leases not started yet, in lease order. Steps that share a checkout run one at a time. Distinct worktrees overlap.
  const held: Lease[] = [];
  // Cancelled commands whose process group is not gone yet. They are not sent as running, so `next` does not cancel
  // them again. They still take a slot, and a new attempt of their step waits until they are gone, so a retried step
  // never runs beside its cancelled attempt.
  const dying = new Map<string, { step: string; lease: Lease; command: StagedCommand }>();
  const base = await headCommit(root);
  // Outside a git work tree no snapshot can check an answer, so an answer there holds no place and waits for nothing.
  const checked = (await git(root, ['rev-parse', '--is-inside-work-tree'])).code === 0;
  const placeOfLease = (lease: Lease): string => (lease.answer && !checked ? lease.attempt : placeOf(lease, root));
  // The prompts that run, by attempt. A prompt that was stopped before its tool started has nothing to report.
  const prompts = new Map<string, { lease: Lease; controller: AbortController; exit: Promise<ReportBody | undefined> }>();
  let question: { hitl: LocalHitl; controller: AbortController; exit: Promise<{ kind: 'question'; hitl: LocalHitl; line?: string }> } | undefined;
  // A headless prompt takes a slot as a command does, so a step in another checkout starts beside it. An interactive one has the terminal.
  const busy = (): number => inFlight.size + dying.size + prompts.size;
  const interactiveRuns = (): boolean => [...prompts.values()].some(({ lease }) => lease.interactive);
  const room = (): boolean => !interactiveRuns() && busy() + held.length < maxParallel && !held.some((lease) => lease.prompt !== undefined);

  const cancel = (attempt: string): void => {
    prompts.get(attempt)?.controller.abort();
    const index = held.findIndex((lease) => lease.attempt === attempt);

    if (index !== -1) held.splice(index, 1);
    const running = inFlight.get(attempt);

    if (!running) return;
    inFlight.delete(attempt);
    dying.set(attempt, { step: running.lease.step, lease: running.lease, command: running.command });
    void running.command.stop();
  };

  let wake = (): void => {};

  // A line typed at the terminal reaches every reader open on it, so one question is open at a time. A prompt step's
  // question closes the HITL question, which stays closed until no step asks and is then asked again, and steps ask
  // one after another. A step stopped while it waits for its turn asks nothing.
  let stepAsks = 0;
  let stepTurns: Promise<unknown> = Promise.resolve();
  // Ctrl-C or Ctrl-D closed a step's question: the person stops the run, as at the HITL question, and resume goes on.
  let isStoppedByPerson = false;

  const stopByPerson = (): void => {
    isStoppedByPerson = true;

    for (const { controller } of prompts.values()) controller.abort();
    wake();
  };

  const askPerson: AskPerson | undefined = personAnswers(mode) ? async (text, signal) => {
    stepAsks += 1;
    const before = stepTurns;

    // A listener added to an aborted signal never fires, and a step may be stopped before it asks.
    const stopped = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });

    const turn = (async () => {
      await Promise.race([before, stopped]);

      if (signal.aborted) return undefined;

      if (question) {
        const open = question;
        question = undefined;
        open.controller.abort();
        await open.exit;
      }

      return readLine(text, signal).catch(() => {
        if (!signal.aborted) stopByPerson();

        return undefined;
      });
    })();

    stepTurns = Promise.allSettled([before, turn]);

    try {
      return await turn;
    } finally {
      stepAsks -= 1;
      wake();
    }
  } : undefined;

  let interactiveIgnores: readonly NodeJS.Signals[] = [];
  let signalled: NodeJS.Signals | undefined;
  let handled: readonly NodeJS.Signals[] = [];

  const handle = (signals: readonly NodeJS.Signals[]): void => {
    for (const name of handled) process.off(name, onSignal);
    handled = signals;

    for (const name of handled) process.on(name, onSignal);
  };

  const exitOn = (signal: NodeJS.Signals): void => {
    handle([]);
    exitLike({ kind: 'signaled', signal });
  };

  // Parallel commands and detached prompt tools do not get the terminal's Ctrl-C, and no command gets a signal sent to
  // teamai alone, so the driver stops them before it exits the way the signal would. An interactive tool that the
  // terminal's signals reach handles them itself. With nothing running, the signal ends teamai at once, as it would
  // without a handler.
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interactiveRuns() && interactiveIgnores.includes(signal)) return;

    if (busy() === 0) return exitOn(signal);
    signalled ??= signal;

    for (const { controller } of prompts.values()) controller.abort(signal);
    wake();
  };

  if (isParallel) handle(STOP_SIGNALS);
  // The team env, resolved once per turn of the loop: the leases it hands out, their env, and what it masks agree. It
  // masks every value the drive has seen, so a value that changed while an attempt ran stays masked in what it reports.
  let env: WorkflowEnv | undefined;
  const seen: Record<string, string> = {};
  // Nobody answers here, so the driver offers the run to a person; once it could not, the steps only a person can take fail.
  // A run goes to a person only when no runtime of the driver asks one.
  let handoff: PersonHandoff | undefined = slots.some((slot) => slot.can.hitl === true) ? undefined : { kind: 'offers' };

  // A runtime's credential values are masked like the team's secrets, whatever their names look like, each entry's own
  // even when two entries of one runtime give a credential the same name.
  const maskedCredentials: Record<string, string> = {};

  for (const slot of slots) rememberSecrets(maskedCredentials, credentialSecrets(slot.use, slot.credentials));
  const maskedValues = async (): Promise<Record<string, string>> => ({ ...env?.secrets ?? await knownSecrets(config), ...maskedCredentials });

  const report = async (body: ReportBody, lease: Lease, changed?: readonly string[]): Promise<WorkflowEnvelope | undefined> => {
    const secrets = await maskedValues();
    await AttemptResult.mask(attemptResultPath(config, runId, lease.attempt), secrets);

    // The leases still waiting to start keep their whole timeout through this report too.
    const sent: ReportBody = { ...body, queued: held.map((waiting) => waiting.attempt) };

    const answer = changed === undefined
      ? await managedReport({ config, runId, report: sent, secrets, lock })
      : await managedReport({ config, runId, report: sent, secrets, lock, changed });

    // Cancelled while it ran: the next `next` lists it in `cancelled`, and the run goes on without it.
    if (isWorkflowError(answer) && answer.error.code !== 'lease_cancelled') return answer;
    // Its handle is closed only once the report is recorded, so a teamai killed before then reattaches to it.
    await closeRun(lease.attempt);

    if (isWorkflowError(answer)) return undefined;
    reported.add(body.attempt);
    options.started?.(StartedRunSchema.array().catch([]).parse(answer.data.started));

    return undefined;
  };

  const unstaged = (lease: Lease, failure: WorkflowFailure): ReportBody => ({ attempt: lease.attempt, revision: lease.revision, driver, ...failureReport(failure) });
  // Why a confined step this driver was leased has no tool here that resolves its model. It hands that lease back and
  // takes no other, so it does not lease the step again in this process.
  let handedBack: string | undefined;

  try {
    for (;;) {
      if (signalled) return { error: { code: 'interrupted', message: `Stopped by ${signalled} after every command it started exited` } };

      if (isStoppedByPerson) return { error: { code: 'interrupted', message: 'A step\'s question closed without an answer. Continue with teamai workflow resume.' } };
      const running = [...inFlight.keys(), ...held.map((lease) => lease.attempt), ...prompts.keys()];
      const canTakeLease = room() && handedBack === undefined;
      const resolved = await resolveWorkflowEnv(config);
      const turn = { ...resolved, secrets: rememberSecrets(seen, resolved.secrets) };
      env = turn;

      // A runtime's notice is masked as the step's output is, with the team's secrets too.
      for (const entry of defined.runtimes) if (entry.kind === 'external') rememberSecrets(entry.masks, turn.secrets);

      const ask = (slot: RuntimeSlot, take: boolean, listed: string[]): Promise<WorkflowEnvelope> => leaseNext(config, runId, driver, {
        running: listed, queued: held.map((lease) => lease.attempt), canTakeLease: take, can: slot.can, autoApprove: options.autoApprove, runMode: mode, handoff, relay, base, env: turn, alone: { ...sole, offering: slot.use }, prepare: true, isOneAtATime, toolFor: toolForOn(slot.can.default_tool),
      });

      // Each runtime with room is offered in turn, in definition order, until one takes a lease: a wait is final only
      // once every one was offered. An attempt left open by a loop before this one goes back to its own runtime first.
      // `heldByAll`: what every runtime offered held back, so a step one of them holds for a person is seen whichever answered last.
      const offered = await (async (): Promise<{ next: WorkflowEnvelope; slot: RuntimeSlot; held?: true; heldByAll?: WaitHeld[] }> => {
        for (let reconnect = reconnecting.shift(); reconnect; reconnect = reconnecting.shift()) {
          const next = await ask(reconnect.slot, false, [...running, ...reconnecting.map((other) => other.attempt)]);

          if (isWorkflowError(next) || !('wait' in next.data)) return { next, slot: reconnect.slot };
        }

        const withRoom = canTakeLease ? slots.filter(slotHasRoom) : [];
        let last: { next: WorkflowEnvelope; slot: RuntimeSlot } | undefined;
        const holds: HeldSteps['runtimes'] = [];
        const heldByAll: WaitHeld[] = [];

        for (const slot of withRoom) {
          last = { next: await ask(slot, true, running), slot };

          if (isWorkflowError(last.next) || !('wait' in last.next.data)) return last;
          const heldBySlot = WaitReplySchema.parse(last.next.data.wait).held ?? [];
          heldByAll.push(...heldBySlot);
          holds.push({ runtime: slot.use, held: heldBySlot.map(({ step, reason }) => ({ step, reason })) });
        }

        // Every runtime with room was offered and held its steps back: the run's details say why.
        if (last) {
          await writeHeldSteps(config, runId, { driver: sole.driver, runtimes: holds });
          // A wait that holds a step says nothing of a gate, which only a `next` that takes no lease answers.
          const asker = holds.some((hold) => hold.held.length > 0) ? slots.find((slot) => slot.can.hitl === true) : undefined;

          if (asker) {
            const gate = await ask(asker, false, running);

            if (isWorkflowError(gate) || 'hitl' in gate.data) return { next: gate, slot: asker, held: true };
          }
        }

        return last ? { ...last, heldByAll } : { next: await ask(slots[0], false, running), slot: slots[0] };
      })();

      const { next } = offered;

      if (signalled || isStoppedByPerson) continue;

      // A clone whose steps all settled is not needed any more.
      if ((await sweepClones(config, runId)).length > 0) {
        for (const [slot, closedHandle] of lastClosed) {
          if (slot.kind !== 'external') continue;
          const again = await slot.runtime.close(closedHandle);

          if (!again.ok) log.debug(`Runtime ${slot.use} did not close ${closedHandle} again after teamai removed a clone: ${masked(again.failure.message, await maskedValues())}`);
        }

        lastClosed.clear();
      }

      if (isWorkflowError(next)) return next;

      const cancelled = z.array(z.string()).safeParse(next.data.cancelled);
      const deadlines = z.record(z.string(), z.string()).safeParse(next.data.deadlines);

      // A lease waiting to start keeps the deadline its restarted clock gives it.
      for (const [index, lease] of held.entries()) {
        const deadline = deadlines.success ? deadlines.data[lease.attempt] : undefined;

        if (deadline !== undefined) held[index] = { ...lease, expiresAt: deadline };
      }

      for (const attempt of cancelled.success ? cancelled.data : []) cancel(attempt);

      // A step taken, or the run ended: nothing is held back any more. A gate asked beside a held step leaves it held.
      if (!('wait' in next.data) && !offered.held) await writeHeldSteps(config, runId, { driver: sole.driver, runtimes: [] });

      if ('done' in next.data) {
        question?.controller.abort();

        for (const { controller } of prompts.values()) controller.abort();

        for (const [attempt, { lease, exit }] of prompts) {
          const body = await exit;
          const failed = body && await report(body, lease);
          prompts.delete(attempt);

          if (failed) return failed;
        }

        return next;
      }

      const hitlRequest = HitlRequestSchema.safeParse(next.data.hitl);
      const hitl: LocalHitl | undefined = hitlRequest.success ? hitlRequest.data : undefined;
      const leased = LocalLeaseSchema.safeParse(next.data.lease);
      const nextLease = 'lease' in next.data && leased.success ? leased.data : undefined;

      if (question && (nextLease?.step === question.hitl.step
        || (!nextLease && (hitl?.step !== question.hitl.step || hitl?.pass !== question.hitl.pass)))) {
        question.controller.abort();
        await question.exit;
        question = undefined;
      }

      if ('lease' in next.data) {
        if (!nextLease) return { error: { code: 'run_unreadable', message: `Run ${runId} returned a lease the local driver cannot run` } };

        if (reported.has(nextLease.attempt)) {
          return { error: { code: 'driver_stuck', message: `Attempt ${nextLease.attempt} was leased again before it could be reported` } };
        }

        // A confined step runs in its directory, never in a checkout another attempt holds.
        const taken = nextLease.confined ? { ...nextLease, cwd: nextLease.confined.dir } : nextLease;
        await bind(taken, offered.slot);
        held.push(taken);
      }

      const placesBusy = (): Set<string> => new Set([
        ...[...inFlight.values()].map(({ lease }) => placeOfLease(lease)),
        ...[...dying.values()].map(({ lease }) => placeOfLease(lease)),
        ...[...prompts.values()].map(({ lease }) => placeOfLease(lease)),
      ]);

      for (let index = 0; !interactiveRuns() && busy() < maxParallel;) {
        const lease = held[index];
        const command = lease?.command;

        if (lease === undefined || command === undefined) break;

        if ([...dying.values()].some((stopping) => stopping.step === lease.step)
          || placesBusy().has(placeOfLease(lease))
          || held.slice(0, index).some((earlier) => earlier.prompt !== undefined && placeOfLease(earlier) === placeOfLease(lease))) {
          index += 1;
          continue;
        }

        held.splice(index, 1);
        // Setup runs in its own process group, out of the terminal's reach, so the driver handles every stop signal until
        // the command starts. An attached command already has the signals its terminal sends to the whole group; a second
        // would force-quit some tools.
        const forwarded = !isParallel ? commandSignalPolicy(await terminalReachesCommand()).forwarded : undefined;

        if (forwarded) handle(STOP_SIGNALS);
        inFlight.set(lease.attempt, { lease, command: stageThenStart(
          lease,
          async (signal) => {
            const staged = await stageLease(lease, { config, lock, root, env: turn, mode, signal, setUpOn: runOf(lease), runsOn: externalOf(lease) });

            return staged ?? refuseDirtyAdoptedCommand({ config, run: lock.run, attempt: lease.attempt });
          },
          () => {
            if (forwarded) handle(forwarded);

            const stepRun = runOf(lease);

            if (stepRun) {
              // An adopted place is checked again once setup ran there.
              const setUp = async (signal: AbortSignal | undefined): Promise<WorkflowFailure | undefined> => (await runPlaceSetup({ config, run: runId, attempt: lease.attempt, mode, env: turn, signal, on: runtimeSetup(stepRun) }))
                ?? refuseDirtyAdoptedCommand({ config, run: runId, attempt: lease.attempt });

              return runtimeCommand({
                run: stepRun, command, view: () => placeView(config, runId, lease.attempt, lease.cwd ?? root), setUp,
                ...runtimeStepEnv(lease, lease.processEnv ?? {}, { config, run: runId, mode }),
              });
            }

            // The lease `env` is set over the step's environment, so its values reach the shell only as variables.
            const input: Parameters<typeof startGroupedCommand>[0] = {
              command, cwd: lease.cwd ?? root, env: { ...lease.processEnv ?? process.env, ...lease.env, ...attemptEnv(config, runId, lease.attempt, mode), [PROGRESS_STREAMS_ENV]: '1' }, detached, group: attemptDir(config, runId, lease.attempt),
            };

            const { progress } = options;

            if (!progress) return startGroupedCommand(input);

            const shown = lineSplitter((line) => {
              const { stream, text } = streamOfLine(line);
              progress(masked(text, turn.secrets), stream);
            });

            const grouped = startGroupedCommand({ ...input, onStderr: shown.write });

            return { ...grouped, exit: grouped.exit.finally(shown.end) };
          },
        ) });
      }

      // Prompts in places no other attempt holds start beside each other, in lease order, while a slot is free. An
      // interactive one starts only once nothing else runs.
      while (!interactiveRuns() && busy() < maxParallel) {
        const promptAt = held.findIndex((lease) => lease.prompt !== undefined
          && !placesBusy().has(placeOfLease(lease))
          && ![...dying.values()].some((stopping) => stopping.step === lease.step)
          && (!lease.interactive || busy() === 0));

        const [lease] = promptAt === -1 ? [] : held.splice(promptAt, 1);

        if (lease === undefined) break;

        if (lease.interactive && question) {
          question.controller.abort();
          await question.exit;
          question = undefined;
        }

        // Setup runs out of the terminal's reach, so the tool's signals are left to it only once it starts.
        interactiveIgnores = [];
        // An interactive step on a runtime that launches agents its own way is not in this terminal.
        const ignored = lease.interactive && slotOf.get(lease.attempt)?.launchesAgents !== true ? commandSignalPolicy(await terminalReachesCommand()).ignored : [];
        const controller = new AbortController();

        if (!isParallel) handle(STOP_SIGNALS);
        prompts.set(lease.attempt, { lease, controller, exit: (async () => {
          const { confined: place, prompt } = lease;

          if (lease.answer && prompt !== undefined) {
            const failure = await stageLease(lease, { config, lock, root, env: turn, mode, signal: controller.signal, runsOn: externalOf(lease) });

            if (!startable(lease, controller.signal)) {
              await abandonPlace({ config, lock, attempt: lease.attempt });

              return undefined;
            }

            if (failure) return unstaged(lease, failure);

            const answered = await runAnswerStep({ config, prompt, output: lease.output, cwd: lease.cwd ?? root, expiresAt: lease.expiresAt, signal: controller.signal, ...lookup });

            // Cancelled while it answered: the engine settles the step, and the reply is not wanted.
            return controller.signal.aborted ? undefined : { attempt: lease.attempt, revision: lease.revision, driver, ...answered };
          }

          if (place) {
            const slot = slotOf.get(lease.attempt);
            const onRuntime = runOf(lease);

            if (!onRuntime) await stopRecordedGroup(attemptDir(config, runId, lease.attempt));
            const moved = await stopLeftElsewhere({ config, run: runId, attempt: lease.attempt, runsOn: externalOf(lease), checkout: root });

            if (!startable(lease, controller.signal)) return undefined;

            if (moved) return unstaged(lease, moved);
            const confinedLease = { ...lease, confined: place };

            const ended = onRuntime && slot
              ? await runConfinedStepOnRuntime({ config, run: runId, lease: confinedLease, signal: controller.signal, runtime: slot.use, attemptRun: onRuntime, offers: slot.can.confined ?? [], credentials: slot.credentials, secrets: await maskedValues() })
              : await runConfinedStep({ config, run: runId, lease: confinedLease, signal: controller.signal, secrets: await maskedValues(), ...lookup });

            const id = { attempt: lease.attempt, revision: lease.revision, driver };

            if (ended.kind === 'ran') return { ...id, ...ended.report };
            handedBack = ended.reason;

            return { ...id, outcome: 'released' };
          }

          // A role copy is checked and delivered for the tool the step launches, so another tool the member enables does not refuse it.
          const slot = slotOf.get(lease.attempt);
          const launch = lease.role !== undefined ? launchToolFor({ agent: lease.agent, tool: lease.tool }, config, options.tools ?? {}, await memberTools(config), slot?.can.default_tool) : undefined;
          const failure = await stageLease(lease, { config, lock, root, env: turn, mode, signal: controller.signal, launches: launch?.ok ? launch.target.name : undefined, setUpOn: runOf(lease), runsOn: externalOf(lease) });

          if (!startable(lease, controller.signal)) {
            await abandon(lease.attempt);

            return undefined;
          }

          if (failure) return unstaged(lease, failure);
          interactiveIgnores = ignored;

          const stepRun = runOf(lease);

          return promptReport(config, lock, driver, lease, adapter, options, archive, controller.signal, mode, launch, { ...turn.secrets, ...maskedCredentials }, askPerson, stepRun && { run: stepRun, logins: slot?.engine.logins ?? [], launchesAgents: slot?.launchesAgents === true, credentials: slot?.credentials ?? {}, found: slot?.found ?? [], teamEnv: turn, ...(slot?.can.default_tool !== undefined && { defaultTool: slot.can.default_tool }) });
        })() });
      }

      if (canHitl && hitl && !question && !interactiveRuns() && stepAsks === 0) {
        const controller = new AbortController();
        question = { hitl, controller, exit: (options.question ?? askHitl)(hitl, controller.signal)
          .then((line) => ({ kind: 'question' as const, hitl, line }), () => ({ kind: 'question' as const, hitl })) };
      }

      if ('lease' in next.data && room()) continue;

      if (relay && hitl && busy() === 0 && held.length === 0) return relayedGate(hitl, { driver: defined.driver, isConfirmed: isStarted && started.definition.invoke === 'ask' });

      if (busy() === 0 && !question) {
        const wait = WaitReplySchema.parse(next.data.wait);

        // Another process of this machine delivers a step this run waits for; it settles without this driver.
        if (Array.isArray(wait.delivering) && wait.delivering.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
        }

        // A wait for a call that could not take a lease says nothing about what is left; ask again with room. A driver
        // that handed back a confined lease never has room again, so it stops on that.
        if (!canTakeLease && handedBack === undefined) continue;

        const confinedWait = handedBack ?? (heldForConfined(wait.held) ? wait.held.map((item) => item.reason.replace(/\.$/u, '')).join('; ') : undefined);

        if (confinedWait !== undefined) {
          return { error: { code: 'confined_pending', message: `Run ${runId} waits for a confined tool: ${confinedWait.replace(/\.$/u, '')}. Make one available here, then run teamai workflow resume ${runId}, or drive the run with a driver that offers one.` } };
        }

        // Nobody answers here, so the run goes to a person: offered on teamai-reports, its local state kept.
        // A step any runtime holds back only a person can take goes to one, when no runtime of the driver asks.
        const people = handoff?.kind === 'offers' ? [...new Set((offered.heldByAll ?? wait.held ?? []).filter(({ missing }) => missing.includes(HITL)).map(({ step }) => step))] : [];

        if (people.length > 0) {
          const unoffered = await offerToPerson(config, runId, cwd);

          if (unoffered === undefined) return handedToPerson(runId, people);
          handoff = { kind: 'unoffered', reason: unoffered };
          continue;
        }

        // What the member can change comes first: a step the policy holds on one runtime is held on every runtime that
        // has its workspace, so the policy is named whichever runtime was offered last. Only a negotiated policy hold
        // puts policy first in `missing`; a runtime that defers the step on its workspace puts that first.
        const policy = (offered.heldByAll ?? []).find(({ missing }) => missing[0]?.startsWith('policy.'));
        const reason = policy?.reason ?? wait.reason ?? 'the next step is not available';
        // A run claimed from another machine does not bring its --sandbox along: say which flag declares it here.
        const needsSandbox = !isSandbox(config, options) && wait.held?.some(({ missing }) => missing.includes(ISOLATION)) === true;

        return { error: { code: 'busy', message: needsSandbox
          ? `${reason}. If this machine is a disposable host, such as a CI runner or a container, declare it a sandbox: teamai workflow resume ${runId} --sandbox, or workflows.sandbox: true in config`
          : reason } };
      }

      let timer: NodeJS.Timeout | undefined;

      const exited = await Promise.race([
        ...[...inFlight.values()].map(({ lease, command }) => command.exit.then((result) => ({ kind: 'command' as const, attempt: lease.attempt, lease, result }))),
        ...[...dying].map(([attempt, { command }]) => command.stop().then(() => ({ kind: 'stopped' as const, attempt }))),
        ...[...prompts].map(([attempt, { exit }]) => exit.then((body) => ({ kind: 'prompt' as const, attempt, body }))),
        ...(question ? [question.exit] : []),
        new Promise<undefined>((resolve) => {
          wake = () => resolve(undefined);
          timer = setTimeout(wake, question ? pollMs / 2 : pollMs);
        }),
      ]);

      clearTimeout(timer);

      // What ended after the person stopped the run is not reported: the cleanup below stops the rest, and resume reruns it.
      if (!exited || isStoppedByPerson) continue;

      if (exited.kind === 'question') {
        // A step's question closed it, and took it from the driver: it is asked again once no step asks.
        const closedByStep = question === undefined;
        const questionHitl = exited.hitl;
        question = undefined;

        if (exited.line === undefined) {
          if (closedByStep) continue;

          return { error: { code: 'interrupted', message: 'The HITL question closed without an answer. Continue with teamai workflow resume.' } };
        }

        const [choice = '', ...words] = exited.line.trim().split(/\s+/);
        const provenance = respondProvenance({ kind: 'terminal', caller: callerProvenance(process.env, { isTTY: true }) });
        const response: ResponseInput = { step: questionHitl.step, pass: questionHitl.pass, choice, provenance, queued: { driver, attempts: held.map((lease) => lease.attempt) } };

        if (words.length > 0) response.note = words.join(' ');
        const answer = await respondToHitl(config, runId, turn.secrets, response);

        if (isWorkflowError(answer)) {
          // agent_in_path: the driver runs inside an agent session; it keeps waiting for the person's answer from elsewhere.
          if (!['repeated_response', 'stale_response', 'invalid_choice', 'not_waiting', 'run_settled', 'agent_in_path'].includes(answer.error.code)) return answer;
          log.warn(answer.error.message);
        }

        continue;
      }

      if (exited.kind === 'prompt') {
        const ended = prompts.get(exited.attempt);
        prompts.delete(exited.attempt);

        if (!isParallel) handle([]);
        const failed = exited.body && ended && await report(exited.body, ended.lease);

        if (failed) return failed;
        continue;
      }

      if (exited.kind === 'stopped') {
        const stopping = dying.get(exited.attempt);
        dying.delete(exited.attempt);

        if (!isParallel) handle([]);

        if (stopping) await abandon(stopping.lease.attempt);
        continue;
      }

      inFlight.delete(exited.attempt);

      if (!isParallel) handle([]);
      const staged = exited.result;

      if (staged.kind === 'stopped') {
        // Its lease ended while it was staged: the engine stops it, and the driver leaves the copy as it found it.
        await abandon(exited.lease.attempt);
        continue;
      }

      const body = staged.kind === 'unstaged'
        ? unstaged(exited.lease, staged.failure)
        : await commandReport(config, lock, driver, exited.lease, staged.result, turn.secrets);

      // The command did not start. An empty list keeps a host file written after adopt out of the commit.
      const failed = await report(body, exited.lease, staged.kind === 'unstaged' ? [] : undefined);

      if (failed) return failed;
    }
  } finally {
    // The sweep runs even when stopping what still runs throws, so no attempt's result file keeps a secret.
    try {
      question?.controller.abort();

      for (const { controller } of prompts.values()) controller.abort(signalled);
      await Promise.all([...prompts.values()].map(({ exit }) => exit));

      for (const attempt of inFlight.keys()) cancel(attempt);
      await Promise.all([...dying.values()].map(async ({ lease, command }) => {
        await command.stop();
        await abandon(lease.attempt);
      }));
    } finally {
      await maskAttemptResults(config, runId, await maskedValues());
    }

    await archive.close();

    if (signalled) exitOn(signalled);
    handle([]);
  }
}
