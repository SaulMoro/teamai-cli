import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { storeDirOf } from '../../session-flow/adapters/index.js';
import { sessionPlatformFacts } from '../../session-flow/adapters/platform-facts.js';
import { AgentSession } from '../../session-flow/agent-session.js';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { defaultToolHome, homeEnvOf, realHost } from '../../tool-home.js';
import { baseToolOf, isToolId } from '../../tool-registry.js';
import { isRecord } from '../expression.js';
import { log } from '../../utils/logger.js';
import type { LaunchTool } from '../../tool-launch/tools.js';
import type { LocalConfig } from '../../types.js';
import { writeJsonAtomic } from '../../utils/fs.js';
import { attemptDir, AttemptIdSchema, attemptResultPath, attemptsDir, RunIdSchema, type AttemptId, type RunId } from '../store.js';
import type { WorkflowFailure } from '../types.js';
import type { SessionRef } from '../workspace.js';
import { redact } from '@teamai/shared/redact';
import { AttemptResult } from '../attempt-result.js';
import { loginFileOf } from './login.js';
import { CANCEL_FAILED, OpIdSchema, RuntimeDisplaySchema, RuntimeFailureSchema, type OpId, type OpState, type PlaceView, type RuntimeDisplay, type RuntimeFailure } from '@teamai/runtime-protocol';
import { credentialSecrets, isUnansweredFailure, newOpId, type Accepted, type ExecEnd, type ExecEvents, type ExecRequest, type Lost, type PromptEnd, type PromptRequest, type StepRuntime } from './step-runtime.js';

// ─── An attempt on a step runtime ────────────────────────
//
//  attempts/<attempt>/runtime.json records which runtime an attempt runs on, the operation ids teamai sent it, and,
//  once accepted, the runtime's handle. Each id is written before its request is sent, so a teamai killed between a
//  runtime's reply and its own write sends the same id again (a repeated open returns the same handle) or reattaches
//  and reads the outcome the runtime retained. The attempt's tool home sits beside it, never in the member's home.
//

/** The tools a step runtime that execs can launch: their session store moves with one variable, into the attempt's tool home. */
// oxlint-disable-next-line teamai/tool-facts -- a fixed-id table of what step runtimes decided to run, kept apart from TOOLS on purpose; tools without one home variable (OpenCode, Pi) stay out
export const EXEC_RUNTIME_TOOLS = ['claude', 'codex', 'codebuddy'] as const satisfies readonly LaunchTool[];

export type ExecRuntimeTool = (typeof EXEC_RUNTIME_TOOLS)[number];

export function isExecRuntimeTool(tool: string): tool is ExecRuntimeTool {
  return EXEC_RUNTIME_TOOLS.some((known) => known === tool);
}

/**
 * Whether `tool`, or the tool an instance extends, keeps its sessions in XDG data (OpenCode): the session home a runtime
 * reports for it is then the directory the tool uses as `XDG_DATA_HOME`, not a tool home.
 */
function keepsSessionsInXdgData(tool: string): boolean {
  const platform = AgentSession.platformForTool(baseToolOf(tool));

  return platform !== undefined && sessionPlatformFacts(platform)?.store.in === 'xdg-data';
}


const PHASES = ['opening', 'ready', 'running', 'collected', 'closed'] as const;

/** A tool's home: the tool, and the directory its sessions are kept under. */
const ToolHomeSchema = z.object({ tool: z.string(), dir: z.string() });

export const AttemptRuntimeRecordSchema = z.object({
  /** The runtime the attempt runs on, as the definition's `use` names it. */
  runtime: z.string(),
  /** The driver definition that chose it. */
  driver: z.string(),
  phase: z.enum(PHASES),
  open: z.object({ op: OpIdSchema, handle: z.string().optional() }),
  exec: z.object({ op: OpIdSchema }).optional(),
  /** The workflow's setup, run as an exec of the place before the step's own. */
  setup: z.object({ op: OpIdSchema }).optional(),
  /** The prompt sent to a runtime that launches agents its own way. */
  prompt: z.object({ op: OpIdSchema }).optional(),
  /** The attempt's tool home, for a prompt: the tool and its directory. */
  toolHome: ToolHomeSchema.optional(),
  /**
   * The tool home outside the attempt that a runtime launching agents its own way reported its prompt's session in
   * (`finished.session.home`), such as a T3 provider instance's. teamai reads the session there and never copies it.
   */
  sessionHome: ToolHomeSchema.optional(),
  /** What the runtime last showed of the place, at `ready` or at a reattach, for the run's details. */
  display: RuntimeDisplaySchema.optional(),
  /**
   * Why the runtime could not close the place, which may still hold what ran there, for the run's details. Kept on a
   * `closed` place only when the person released it without the runtime's close.
   */
  closeFailed: RuntimeFailureSchema.optional(),
  /**
   * Why the open failed after the runtime accepted the place. A restarted teamai answers it instead of sending the open
   * again, which a runtime through another could answer with less of the place than the first open made.
   */
  openFailed: RuntimeFailureSchema.optional(),
});

export type AttemptRuntimeRecord = z.infer<typeof AttemptRuntimeRecordSchema>;

/** Where attempt `attempt` of run `run` records its runtime (`AttemptRuntimeRecord`). */
export function attemptRuntimePath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'runtime.json');
}

export async function readAttemptRuntime(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<AttemptRuntimeRecord | undefined> {
  try {
    return AttemptRuntimeRecordSchema.parse(JSON.parse(await fs.readFile(attemptRuntimePath(config, run, attempt), 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Whether `record` holds a setup that may still run: sent, its work not brought back yet (a setup that ended is
 * collected before the place is ready), and no step exec or prompt sent after it.
 */
function isSetupLeftRunning(record: AttemptRuntimeRecord): boolean {
  return record.setup !== undefined && record.phase === 'running' && record.exec === undefined && record.prompt === undefined;
}

/**
 * Records the place of attempt `attempt` as no longer teamai's to close, without its runtime's close, once the person
 * checked that nothing of it still runs. Why the runtime could not close it stays in the record.
 */
export async function releaseAttemptRuntime(config: LocalConfig, run: RunId, attempt: AttemptId, record: AttemptRuntimeRecord): Promise<void> {
  await writeJsonAtomic(attemptRuntimePath(config, run, attempt), { ...record, phase: 'closed' });
}

/** Masks the result file of every attempt of `run` with `secrets`, so one that ended without a report, on a signal or a killed driver too, keeps no secret. */
export async function maskAttemptResults(config: LocalConfig, run: RunId, secrets: Record<string, string>): Promise<void> {
  const names = await fs.readdir(attemptsDir(config, run)).catch((): string[] => []);

  const attempts = names.flatMap((name) => {
    const attempt = AttemptIdSchema.safeParse(name);

    return attempt.success ? [attempt.data] : [];
  });

  await Promise.all(attempts.map((attempt) => AttemptResult.mask(attemptResultPath(config, run, attempt), secrets)));
}

/** The tool home of `tool` for attempt `attempt`: under the attempt directory, beside its record. */
export function attemptToolHome(config: LocalConfig, run: RunId, attempt: AttemptId, tool: string): string {
  return path.join(attemptDir(config, run, attempt), 'tool-home', tool);
}

/**
 * Where the sessions of attempt `attempt` of run `run` are: the store in the tool home its record names, or undefined
 * when it ran in the member's own home. Every lookup of a run step's session passes it on (`AgentSessionRef.storeDir`).
 */
export async function attemptSessionStore(config: LocalConfig, run: string, attempt: string | undefined): Promise<string | undefined> {
  const runId = RunIdSchema.safeParse(run);
  const attemptId = AttemptIdSchema.safeParse(attempt);

  if (!runId.success || !attemptId.success) return undefined;
  const record = await readAttemptRuntime(config, runId.data, attemptId.data);
  const home = record?.toolHome ?? record?.sessionHome;
  // An instance, as a runtime that launches agents its own way records it, is read as the tool it extends.
  const platform = home && (isExecRuntimeTool(baseToolOf(home.tool)) || keepsSessionsInXdgData(home.tool)) ? AgentSession.platformForTool(home.tool) : undefined;
  const store = home && platform ? storeDirOf(platform, { kind: 'tool-home', dir: home.dir }) : '';

  return store === '' ? undefined : store;
}

/**
 * The attempt of run `run` whose tool home holds session `session` of its tool, with that home's store, or undefined
 * when no attempt that ran on a step runtime holds it (the session is then in the member's own store, if anywhere).
 * `isOwn` says the home is the attempt's own, under its directory, rather than one a runtime reported outside it.
 */
export async function attemptHoldingSession(config: LocalConfig, run: string, session: { tool: string; id: string }): Promise<{ attempt: AttemptId; home: string; isOwn: boolean; storeDir: string } | undefined> {
  const runId = RunIdSchema.safeParse(run);
  const platform = AgentSession.platformForTool(session.tool);

  if (!runId.success || !platform) return undefined;
  const names = await fs.readdir(attemptsDir(config, runId.data)).catch(() => []);

  for (const name of names.sort()) {
    const attempt = AttemptIdSchema.safeParse(name);
    const record = attempt.success ? await readAttemptRuntime(config, runId.data, attempt.data) : undefined;
    const home = record?.toolHome ?? record?.sessionHome;

    // A runtime that execs the tool records the home under the tool an instance extends; its session names the instance.
    if (!attempt.success || home === undefined || baseToolOf(home.tool) !== baseToolOf(session.tool)) continue;
    const storeDir = storeDirOf(platform, { kind: 'tool-home', dir: home.dir });

    if (storeDir === '') continue;
    const found = await AgentSession.find({ platform, sessionId: session.id, storeDir }, { scrub: false });

    if (found.status === 'done') return { attempt: attempt.data, home: home.dir, isOwn: record?.toolHome !== undefined, storeDir };
  }

  return undefined;
}

/**
 * The session a prompt on a step runtime resumes: the first of `sessions` (the lease's, then each earlier one it
 * continued) that an earlier attempt of run `run` kept in its tool home for `tool`. That home is copied into the home of
 * `attempt`, where the tool resumes it. Undefined when no earlier attempt holds one, and the tool starts a new session.
 */
export async function seedToolHome({ config, run, attempt, tool, sessions }: { config: LocalConfig; run: RunId; attempt: AttemptId; tool: string; sessions: SessionRef[] }): Promise<SessionRef | undefined> {
  for (const session of sessions.filter((candidate) => candidate.tool === tool)) {
    const holding = await attemptHoldingSession(config, run, session);

    // A home outside the attempt is the runtime's, such as the member's own instance home: it is never copied whole.
    if (holding === undefined || !holding.isOwn) continue;

    // A home this attempt already has, from before a restart, keeps what its tool wrote there. The login stays behind:
    // only the lock that holds it may copy it, so a step on a runtime that holds no login never gets one.
    const login = loginFileOf(tool);
    const kept = login === undefined ? undefined : path.join(holding.home, login);

    if (holding.attempt !== attempt) await fs.cp(holding.home, attemptToolHome(config, run, attempt, tool), { recursive: true, force: false, filter: (source) => source !== kept });

    return session;
  }

  return undefined;
}

/**
 * The member's own model choices for each tool, which an attempt's tool home starts with: the settings file under the
 * tool's home, and the keys of it that choose the model. No other key is copied: never an `env`, a credential, a hook,
 * a permission rule or an MCP server.
 */
const MODEL_CHOICES: Record<ExecRuntimeTool, { file: string; format: 'json' | 'toml'; keys: readonly string[] } | undefined> = {
  claude: { file: 'settings.json', format: 'json', keys: ['model', 'effortLevel', 'modelSettings'] },
  codex: { file: 'config.toml', format: 'toml', keys: ['model', 'model_reasoning_effort'] },
  // Not decided yet: a CodeBuddy attempt home starts with none of the member's settings.
  codebuddy: undefined,
};

/**
 * Starts the tool home `dir` of an attempt on `tool` with the member's model choices, read from `memberHome`, the
 * member's own home of that tool. A home that already has the settings file, from a predecessor or a restart, keeps it.
 * A step's own `model` still wins, as the launch names it.
 */
export async function seedMemberModel({ tool, dir, memberHome }: { tool: ExecRuntimeTool; dir: string; memberHome: string }): Promise<void> {
  const choices = MODEL_CHOICES[tool];

  if (choices === undefined) return;
  const target = path.join(dir, choices.file);

  if (await fs.access(target).then(() => true, () => false)) return;
  const text = await fs.readFile(path.join(memberHome, choices.file), 'utf8').catch(() => undefined);

  if (text === undefined) return;
  let parsed: unknown;

  try {
    parsed = choices.format === 'json' ? JSON.parse(text) : parseToml(text);
  } catch (error) {
    log.warn(`Could not read your ${tool} model choices from ${path.join(memberHome, choices.file)} (${error instanceof Error ? error.message : String(error)}), so the step's ${tool} starts with its own defaults.`);

    return;
  }

  if (!isRecord(parsed)) return;
  const picked = Object.fromEntries(choices.keys.flatMap((key) => (parsed[key] === undefined ? [] : [[key, parsed[key]]])));

  if (Object.keys(picked).length === 0) return;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(target, choices.format === 'json' ? `${JSON.stringify(picked, null, 2)}\n` : stringifyToml(picked), { flag: 'wx' });
}

/** The variable `tool`'s session store follows, set to its home in the attempt, or undefined for a tool no exec runtime runs. */
export function toolHomeVariable(tool: string): string | undefined {
  return isExecRuntimeTool(tool) ? homeEnvOf(tool) : undefined;
}

/**
 * What a restart found of an exec it had sent: the outcome, or that it was still running and is now stopped; or, on a
 * runtime whose execs go on without teamai, that this teamai stopped and left the exec running there.
 */
export type AttemptExecEnd = ExecEnd | { kind: 'interrupted' } | { kind: 'left' };

/**
 * One attempt on a step runtime: it opens the place, runs one exec, and finishes with collect and close, each under an
 * id persisted in the attempt's record before it is sent. Built again after a restart, it reopens on the same handle and
 * reads the outcome of the exec it had sent instead of running it again.
 */
export interface AttemptRun {
  /**
   * Opens the place, with what of the host it gets, or with nothing for a confined prompt's place. `toolHome` is the
   * tool home a prompt's tool keeps its session in, recorded for every later lookup; `credentials` are the values its
   * tool gets, sent and never recorded; `tool` is the tool its prompt runs, which the runtime is told; `unset`, for an
   * entry through another runtime, the names its prompt goes without, which the outer keeps from the tool.
   */
  open(view: PlaceView | undefined, place?: { tool?: string; toolHome?: z.infer<typeof ToolHomeSchema>; credentials?: Record<string, string>; unset?: string[] }): Promise<{ ok: true; handle: string } | { ok: false; failure: WorkflowFailure }>;
  exec(request: Omit<ExecRequest, 'op' | 'handle'>, events: ExecEvents): Promise<AttemptExecEnd>;
  /**
   * Runs the workflow's setup as an exec of the open place, recorded apart from the step's exec, under a new id. A setup
   * a teamai before this one left is stopped before its place is prepared again (`stopLeftSetup`), and here again for a
   * caller that did not.
   */
  setup(request: Omit<ExecRequest, 'op' | 'handle'>, events: ExecEvents): Promise<AttemptExecEnd>;
  /**
   * Stops the setup a killed teamai left running, before the place it ran in is prepared again: on a runtime that
   * mounts the host's folders, it would go on writing into the new one. Ends `lost` when the stop is not confirmed, so
   * the place is kept; undefined once it is, or when no setup was left.
   */
  stopLeftSetup(): Promise<Lost | undefined>;
  /**
   * Sends the prompt step to a runtime that launches agents its own way. Built again after a restart, it reads the
   * outcome the runtime kept, or reconnects to the prompt still running by sending the same id again.
   */
  prompt(request: Omit<PromptRequest, 'op' | 'handle'>, events: { onAccepted?: (accepted: Accepted) => void }): Promise<PromptEnd>;
  /** Stops the exec or prompt running now, with every process it started. */
  cancel(): Promise<void>;
  /**
   * This teamai stops: an exec on a runtime whose execs go on without it (`StepRuntime.isExecReconnected`) is left
   * running there and ends `left`, for a later teamai to reconnect to; any other is cancelled.
   */
  stop(): Promise<void>;
  /**
   * Brings the place's work back to the host, after success and after failure, before teamai reads the result or commits.
   * After an exec or prompt that ended `lost` it brings nothing back, since what ran there may still write the place.
   */
  collect(): Promise<WorkflowFailure | undefined>;
  /**
   * Closes the handle once the attempt's report is recorded, so a teamai killed before that still reattaches. A runtime
   * that cannot, or no longer answers, leaves the place open: its failure is recorded on the attempt and returned. So
   * does an exec or prompt that ended `lost`, whose work may still run there: the place is not closed under it.
   * `release` tells the runtime the person let the attempt go (`StepRuntime.close`).
   */
  close(how?: { release: true }): Promise<WorkflowFailure | undefined>;
  /**
   * Stops the exec or prompt a killed teamai left running, for a run cancelled without a live driver, and waits until
   * the runtime no longer reports it running. Answers why the stop is not confirmed, in the runtime's own words when it
   * gave them, or undefined once it is.
   */
  stopLeftOperation(): Promise<RuntimeFailure | undefined>;
}

/** How long a restarted teamai waits for an exec it found running to stop. */
const STOP_WAIT_MS = 15_000;

function runtimeFailure(runtime: string, message: string): WorkflowFailure {
  return { code: 'runtime_failed', message: `Step runtime "${runtime}" ${message}` };
}

/**
 * Whether `state` may still run: `running`, or `failed` with `cancel_failed`, a stop the runtime could not confirm,
 * which a later cancel tries again. Any other `failed` is the operation's end, whatever cancel came before it.
 */
function isUnstopped(state: OpState | undefined): boolean {
  return state?.state === 'running' || (state?.state === 'failed' && isStopRefused(state.failure));
}

/** Whether an operation that ended `failed` with `failure` may still run: the runtime could not confirm its stop. */
function isStopRefused(failure: RuntimeFailure): boolean {
  return failure.code === CANCEL_FAILED;
}

/**
 * `deadline` is the lease's expiry, the latest time the attempt's limits allow, which its `open` tells the runtime and
 * which bounds what runs in the place; undefined when the attempt has no such limit, or only stops what a teamai before
 * it left.
 */
export function attemptRun({ config, run, attempt, runtime, driver, deadline }: { config: LocalConfig; run: RunId; attempt: AttemptId; runtime: StepRuntime; driver: string; deadline?: string }): AttemptRun {
  const file = attemptRuntimePath(config, run, attempt);
  let record: AttemptRuntimeRecord | undefined;
  let running: { op: OpId } | undefined;
  // Ends the exec running now as `left`, while one runs.
  let leave: (() => void) | undefined;
  // An exec ended `left` goes on on its runtime: its place stays open, for a later teamai to reconnect to or cancel.
  let isLeft = false;
  // Why an exec or prompt of this attempt may still run, once one ended `lost`: its place is not closed under it.
  let mayRun: RuntimeFailure | undefined;
  // The credentials the place was opened with, in memory only, so what the runtime says of the place is kept masked.
  let openedWith: Record<string, string> = {};

  const save = async (next: AttemptRuntimeRecord): Promise<void> => {
    record = next;
    await writeJsonAtomic(file, next);
  };

  const current = async (): Promise<AttemptRuntimeRecord | undefined> => (record ??= await readAttemptRuntime(config, run, attempt));

  /** Keeps what the runtime showed now; one that showed nothing keeps what it showed before. */
  const shown = async (display: RuntimeDisplay | undefined): Promise<void> => {
    const now = await current();

    if (now && display) await save({ ...now, display });
  };

  /**
   * Tells `events` of an operation's acceptance and of each display the runtime gives apart from it, and keeps each
   * display, with the acceptance or apart from it, for the run's details. `kept` settles once those are written, and the
   * operation's end waits for it.
   */
  const accepting = ({ onAccepted, onDisplay }: Pick<ExecEvents, 'onAccepted' | 'onDisplay'>) => {
    let kept: Promise<void> = Promise.resolve();

    return {
      onAccepted: (accepted: Accepted): void => {
        if (accepted.display) kept = kept.then(() => shown(accepted.display));
        onAccepted?.(accepted);
      },
      onDisplay: (display: RuntimeDisplay): void => {
        kept = kept.then(() => shown(display));
        onDisplay?.(display);
      },
      kept: () => kept,
    };
  };

  /**
   * Stops an operation a teamai before this one left running, and waits until the runtime no longer reports it running.
   * Answers why the stop is not confirmed, or undefined once it is: the runtime could not be asked, it reports the
   * operation `cancel_failed` (its failure says what to do), or it still reports it running after the wait.
   */
  const stopLeftRunning = async (handle: string, op: OpId): Promise<RuntimeFailure | undefined> => {
    await runtime.cancel(op);
    const waitUntil = Date.now() + STOP_WAIT_MS;

    for (let left = STOP_WAIT_MS; left > 0; left = waitUntil - Date.now()) {
      // A reattach sent just before the wait ends does not extend it.
      let timer: NodeJS.Timeout | undefined;
      const seen = await Promise.race([runtime.reattach(handle), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), left); })]);
      clearTimeout(timer);

      if (seen === undefined) break;

      if (seen.kind === 'failed') return seen.failure;

      if (seen.kind === 'gone') return undefined;
      const state = seen.ops.find((retained) => retained.op === op);

      if (!isUnstopped(state)) return undefined;

      if (state?.state === 'failed') return state.failure;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, waitUntil - Date.now())));
    }

    return { code: 'runtime_unanswered', message: `Step runtime "${runtime.name}" still reported operation ${op} of attempt ${attempt} running ${STOP_WAIT_MS / 1000} s after teamai asked it to cancel it.` };
  };

  /**
   * Records the home outside the attempt a finished prompt's session lives in: the one its runtime reported, else, as
   * protocol 1 reads an omitted home, the tool's default home under $HOME (for a tool that keeps its sessions in XDG
   * data, `~/.local/share`), whatever moved the member's own.
   */
  const keptIn = async (end: PromptEnd): Promise<PromptEnd> => {
    const now = await current();

    if (end.kind !== 'finished' || !now) return end;
    const { tool } = end.session;
    const host = realHost();

    const home = end.session.home
      ?? (keepsSessionsInXdgData(tool) ? host.path.join(host.home, '.local', 'share') : isToolId(tool) ? defaultToolHome(tool, host) : undefined);

    if (home !== undefined) await save({ ...now, sessionHome: { tool, dir: home } });

    return end;
  };

  /** Ends an exec or prompt as `lost`, which keeps its place open: what it started may still run there. */
  const lostFor = (failure: RuntimeFailure): Lost => {
    mayRun = failure;

    return { kind: 'lost', failure };
  };

  /**
   * Why this runtime leaves alone the place `left` names on another runtime: what ran there was not stopped
   * (`stopOnRecordedDriver`), so neither its work nor its place is this runtime's to bring back or close.
   */
  const placeElsewhere = (left: AttemptRuntimeRecord): WorkflowFailure | undefined => (left.runtime === runtime.name ? undefined
    : runtimeFailure(runtime.name, `left the place of attempt ${attempt} on step runtime "${left.runtime}" of driver "${left.driver}" open, since what ran there may still run. Resume the run with --driver ${left.driver}.`));

  /** The setup a teamai before this one left, which the runtime could not stop, may still run in its place. */
  const leftSetupNotStopped = (notStopped: RuntimeFailure): Lost => lostFor({ code: notStopped.code, message: `Step runtime "${runtime.name}" could not stop the setup of attempt ${attempt} that a teamai before this one left running, so it may still run there: ${notStopped.message}` });

  /** `failure` with the values of the credentials the place was opened with masked, for what teamai records or prints. */
  const masked = (failure: RuntimeFailure): RuntimeFailure => ({ ...failure, message: redact(failure.message, { envSecrets: credentialSecrets(runtime.name, openedWith), patterns: false }) });

  /** How an exec or prompt sent now ended, as the attempt takes it: one whose stop the runtime refused may still run. */
  const ended = <TEnd extends ExecEnd | PromptEnd>(end: TEnd): TEnd | Lost => {
    if (end.kind === 'lost' || (end.kind === 'failed' && isStopRefused(end.failure))) return lostFor(end.failure);

    return end;
  };

  return {
    async open(view, { tool, toolHome: home, credentials = {}, unset } = {}) {
      openedWith = credentials;
      const found = await current();
      // A place closed on another runtime, or an open the runtime refused before it made a place, holds nothing of this
      // one: the attempt starts again here.
      const before = found && !(found.phase === 'closed' && (found.runtime !== runtime.name || found.open.handle === undefined)) ? found : undefined;

      // A record of another runtime is one whose place there is still open: what ran there was not stopped
      // (`stopOnRecordedDriver`), so the attempt does not move while it may still run.
      if (before && before.runtime !== runtime.name && before.phase !== 'closed') {
        return { ok: false, failure: runtimeFailure(runtime.name, `cannot continue attempt ${attempt}, whose place on step runtime "${before.runtime}" of driver "${before.driver}" is still open, so what ran there may still run. Resume the run with --driver ${before.driver}.`) };
      }

      if (before?.openFailed && before.phase !== 'closed') return { ok: false, failure: runtimeFailure(runtime.name, `could not open attempt ${attempt} (${before.openFailed.code}): ${before.openFailed.message}`) };
      const op = before?.open.op ?? newOpId();
      const toolHome = home ?? before?.toolHome;
      const opening: AttemptRuntimeRecord = { runtime: runtime.name, driver, phase: before?.phase ?? 'opening', open: { op } };

      if (before?.open.handle) opening.open.handle = before.open.handle;

      if (before?.exec) opening.exec = before.exec;

      if (before?.setup) opening.setup = before.setup;

      if (before?.prompt) opening.prompt = before.prompt;

      if (toolHome) opening.toolHome = toolHome;

      if (before?.sessionHome) opening.sessionHome = before.sessionHome;

      if (before?.display) opening.display = before.display;

      if (before?.closeFailed) opening.closeFailed = before.closeFailed;
      await save(opening);

      // A place opened again keeps the handle it recorded until it is ready: one made in steps (a runtime through
      // another) is accepted first with part of its handle, which must not replace the whole one if the rest fails.
      const opened = await runtime.open({ op, run, attempt, credentials, ...(tool !== undefined && { tool }), ...(deadline !== undefined && { deadline }), ...(view && { view }), ...(unset && { unset }) }, async (handle) => {
        const now = await current();

        if (now) await save({ ...now, open: { op, handle: before?.open.handle ?? handle }, phase: now.phase === 'opening' ? 'ready' : now.phase });
      });

      if (opened.kind !== 'ready') {
        const now = await current();

        if (now?.open.handle !== undefined) await save({ ...now, openFailed: opened.failure });
        // The runtime answered the first open of this op with a failure before it accepted a place, so it holds none.
        // One that did not answer, or an op a killed teamai sent before, may hold a place no handle names: the record
        // stays open, so a close says so.
        else if (now && !before && !isUnansweredFailure(opened.failure)) await save({ ...now, phase: 'closed' });

        return { ok: false, failure: runtimeFailure(runtime.name, `could not open attempt ${attempt} (${opened.failure.code}): ${opened.failure.message}`) };
      }

      const ready = await current();

      if (ready && ready.open.handle !== opened.handle) await save({ ...ready, open: { op, handle: opened.handle } });
      await shown(opened.display);

      return { ok: true, handle: opened.handle };
    },

    async exec(request, events) {
      const before = await current();
      const handle = before?.open.handle;

      if (!before || handle === undefined) return { kind: 'failed', failure: { code: 'runtime_protocol', message: `Attempt ${attempt} has no open place to exec in.` } };

      // A runtime whose execs go on without teamai is sent the same id again, which reconnects to the exec.
      if (before.exec && !runtime.isExecReconnected) {
        const sent = before.exec;
        const found = await runtime.reattach(handle);

        // The exec may still run: the runtime that could tell is not answering.
        if (found.kind === 'failed') return lostFor(found.failure);

        if (found.kind === 'gone') return { kind: 'failed', failure: { code: 'runtime_gone', message: `The runtime no longer knows the place of attempt ${attempt}.` } };
        await shown(found.display);
        const state = found.ops.find((retained) => retained.op === sent.op);

        // The runtime accepted it before the restart.
        if (state !== undefined) events.onAccepted?.({});

        if (isUnstopped(state)) {
          const notStopped = await stopLeftRunning(handle, sent.op);

          if (!notStopped) return { kind: 'interrupted' };

          return lostFor({ code: notStopped.code, message: `Step runtime "${runtime.name}" could not stop the exec of attempt ${attempt} that a teamai before this one left running, so it may still run there: ${notStopped.message}` });
        }

        if (state?.state === 'exited') return { kind: 'exited', code: state.code, stdout: state.stdout };

        if (state?.state === 'cancelled') return { kind: 'cancelled' };

        if (state?.state === 'failed') return { kind: 'failed', failure: state.failure };

        // The request never reached the runtime: it is sent now, under the id that was persisted for it.
      }

      const exec = before.exec ?? { op: newOpId() };
      await save({ ...before, exec, phase: 'running' });
      running = exec;
      const acceptance = accepting(events);
      const leaving = new Promise<{ kind: 'left' }>((resolve) => { leave = () => resolve({ kind: 'left' }); });
      const end = await Promise.race([runtime.exec({ op: exec.op, handle, ...request }, { ...events, onAccepted: acceptance.onAccepted, onDisplay: acceptance.onDisplay }), leaving]);
      leave = undefined;
      await acceptance.kept();
      running = undefined;
      isLeft = end.kind === 'left';

      return end.kind === 'left' ? end : ended(end);
    },

    async setup(request, events) {
      const before = await current();
      const handle = before?.open.handle;

      if (!before || handle === undefined) return { kind: 'failed', failure: { code: 'runtime_protocol', message: `Attempt ${attempt} has no open place to run setup in.` } };

      // Stopped before its place was prepared again (`stopLeftSetup`); stopped here too for a caller that did not, late as that is.
      if (before.setup) {
        const notStopped = await stopLeftRunning(handle, before.setup.op);

        if (notStopped) return leftSetupNotStopped(notStopped);
      }

      const setup = { op: newOpId() };
      await save({ ...before, setup, phase: 'running' });
      running = setup;
      const acceptance = accepting(events);
      const end = await runtime.exec({ op: setup.op, handle, ...request }, { ...events, onAccepted: acceptance.onAccepted, onDisplay: acceptance.onDisplay });
      await acceptance.kept();
      running = undefined;

      return ended(end);
    },

    async prompt(request, events) {
      const before = await current();
      const handle = before?.open.handle;

      if (!before || handle === undefined) return { kind: 'failed', failure: { code: 'runtime_protocol', message: `Attempt ${attempt} has no open place to prompt in.` } };

      if (before.prompt) {
        const found = await runtime.reattach(handle);

        // The prompt may still run: the runtime that could tell is not answering.
        if (found.kind === 'failed') return lostFor(found.failure);

        if (found.kind === 'gone') return { kind: 'failed', failure: { code: 'runtime_gone', message: `The runtime no longer knows the place of attempt ${attempt}.` } };
        await shown(found.display);
        const sent = before.prompt;
        const state = found.ops.find((retained) => retained.op === sent.op);

        // The runtime accepted it before the restart; one still running is accepted again when it is resent.
        if (state !== undefined && state.state !== 'running') events.onAccepted?.({});

        // A stop that a cancel before the restart could not confirm is tried again: it is not how the prompt ended.
        if (state?.state === 'failed' && isUnstopped(state)) {
          const notStopped = await stopLeftRunning(handle, sent.op);

          if (!notStopped) return { kind: 'cancelled' };

          return lostFor({ code: notStopped.code, message: `Step runtime "${runtime.name}" could not stop the prompt of attempt ${attempt} that a teamai before this one asked it to cancel, so it may still run there: ${notStopped.message}` });
        }

        if (state?.state === 'finished') {
          const end: PromptEnd = { kind: 'finished', session: state.session, result: state.result };

          if (state.usage) end.usage = state.usage;

          if (state.confined) end.confined = state.confined;

          if (state.resumed === true) end.resumed = true;

          return keptIn(end);
        }

        if (state?.state === 'cancelled') return { kind: 'cancelled' };

        if (state?.state === 'failed') return { kind: 'failed', failure: state.failure };

        if (state?.state === 'exited') return { kind: 'failed', failure: { code: 'runtime_protocol', message: `Step runtime "${runtime.name}" reported the prompt of attempt ${attempt} as an exec that exited.` } };

        // Still running, or never received: the same id reconnects to it, or sends it now.
      }

      const sent = before.prompt ?? { op: newOpId() };

      if (before.prompt === undefined) await save({ ...before, prompt: sent, phase: 'running' });
      running = sent;
      const acceptance = accepting(events);
      const end = await runtime.prompt({ op: sent.op, handle, ...request }, { onAccepted: acceptance.onAccepted, onDisplay: acceptance.onDisplay });
      await acceptance.kept();
      running = undefined;

      return ended(await keptIn(end));
    },

    async stop() {
      if (leave && runtime.isExecReconnected) {
        leave();

        return;
      }

      if (running) await runtime.cancel(running.op);
    },

    async cancel() {
      if (running) await runtime.cancel(running.op);
    },

    async collect() {
      const before = await current();
      const handle = before?.open.handle;

      if (!before || handle === undefined) return undefined;
      const elsewhere = placeElsewhere(before);

      if (elsewhere) return elsewhere;

      // Nothing is brought back while what ran there may still write the place.
      if (mayRun) return runtimeFailure(runtime.name, `left the work of attempt ${attempt} in its place, since what ran there may still run (${mayRun.code}): ${masked(mayRun).message}`);
      const collected = await runtime.collect(handle);

      if (!collected.ok) return runtimeFailure(runtime.name, `could not bring the work of attempt ${attempt} back (${collected.failure.code}): ${collected.failure.message}. Nothing it changed in the place was committed.`);
      await save({ ...before, phase: 'collected' });

      return undefined;
    },

    async close(how) {
      const before = await current();

      if (!before || before.phase === 'closed' || isLeft) return undefined;
      const handle = before.open.handle;

      // An open sent whose handle teamai never recorded, as when teamai or the runtime stopped in between: the runtime
      // may have made a place that no request teamai can send names, so it is not said to be closed.
      if (handle === undefined) {
        return runtimeFailure(runtime.name, `may hold a place for attempt ${attempt} that teamai cannot close: teamai asked for the place (${before.open.op}) and never recorded its handle, since teamai or the runtime stopped in between. Close it in ${runtime.name} yourself if it is there.`);
      }

      const elsewhere = placeElsewhere(before);

      if (elsewhere) return elsewhere;

      if (mayRun) {
        const failure = masked(mayRun);
        await save({ ...before, closeFailed: failure });

        return runtimeFailure(runtime.name, `kept the place of attempt ${attempt} open, since what ran there may still run (${failure.code}): ${failure.message}`);
      }

      const closed = await runtime.close(handle, how);

      if (!closed.ok) {
        const failure = masked(closed.failure);
        await save({ ...before, closeFailed: failure });

        return runtimeFailure(runtime.name, `could not close the place of attempt ${attempt}, so what ran there may still run (${failure.code}): ${failure.message}`);
      }

      const { closeFailed: _earlier, ...kept } = before;
      await save({ ...kept, phase: 'closed' });

      return undefined;
    },

    async stopLeftSetup() {
      const before = await current();
      const handle = before?.open.handle;

      // One left on another runtime was stopped through the driver recorded for it before this attempt reached here.
      if (!before?.setup || !isSetupLeftRunning(before) || before.runtime !== runtime.name || handle === undefined) return undefined;
      const notStopped = await stopLeftRunning(handle, before.setup.op);

      return notStopped && leftSetupNotStopped(notStopped);
    },

    async stopLeftOperation() {
      const before = await current();
      const handle = before?.open.handle;
      const left = before?.exec ?? before?.prompt ?? before?.setup;

      if (!left || handle === undefined) return undefined;
      const seen = await runtime.reattach(handle);

      if (seen.kind === 'failed') return seen.failure;

      // An operation that ended before this cancel needs no stop; closing its place confirms nothing of it still runs.
      if (seen.kind === 'gone' || !isUnstopped(seen.ops.find((retained) => retained.op === left.op))) return undefined;

      return stopLeftRunning(handle, left.op);
    },
  };
}
