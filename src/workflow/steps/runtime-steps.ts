import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunMode } from '../../launch-context.js';
import { shellArgv, STOPPED_EXIT_CODE, type GroupedCommandExit } from '../shell-command.js';
import { attemptEnv } from '../attempt-marker.js';
import type { LeaseWire } from '../lease-wire.js';
import type { AttemptRun } from '../runtimes/attempt.js';
import { type ExecEvents } from '@teamai/runtime-protocol/step-runtime';
import { withRetry } from '../runtimes/retry-command.js';
import { PROMPT_FAILURE_CODES, type PlaceView, type PromptLease, type RuntimeFailure } from '@teamai/runtime-protocol';
import { MAX_TIMER_MS } from '../../utils/timer.js';
import { AttemptResult } from '../attempt-result.js';
import { attemptResultPath, runScratchDir, type AttemptId, type RunId } from '../store.js';
import type { WorkflowFailure } from '../types.js';
import { git } from '../worktree.js';
import type { LocalConfig } from '../../types.js';
import { stepPrompt, withoutPrompt, type ToolClosed, type ToolLauncher } from '@teamai/tool-launch/run-step-launch';
import type { StepLauncher, StepRun, StepRunResult } from '@teamai/runtime-tools';

// ─── The local loop's steps on a step runtime ────────────
//
//  teamai prepares the place on the host and finishes it there (finishWriter, with hook-safe git). What runs in
//  between goes through the attempt's runtime: a command step as one `exec` of the shell, a prompt step as one `exec`
//  of the argv the local tool adapter builds, or, on a runtime that launches agents its own way, as one `prompt`. Work
//  is collected back before teamai reads the result or commits.
//

/** The most stderr a command step's failure message keeps, as the local loop's own commands do. */
const STDERR_KEPT = 64 * 1024;

/**
 * What attempt `attempt` gives its runtime: the worktree `cwd` read-write at its host path, its git paths read-only
 * (the common git directory, the worktree's admin directory, which holds `config.worktree`, and the `.git` pointer),
 * the result directory read-write, and the tool home under the variable its tool reads.
 */
export async function placeView(config: LocalConfig, run: RunId, attempt: AttemptId, cwd: string, toolHome?: { variable: string; dir: string }): Promise<PlaceView> {
  const listed = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir']);
  const gitDirs = listed.code === 0 ? listed.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '') : [];
  const pointer = path.join(cwd, '.git');
  const readonly = [...new Set([...gitDirs, ...(await fs.lstat(pointer).then(() => [pointer], () => []))])];
  const result = path.dirname(attemptResultPath(config, run, attempt));
  const runDir = runScratchDir(config, run);
  await Promise.all([fs.mkdir(result, { recursive: true }), fs.mkdir(runDir, { recursive: true })]);
  const view: PlaceView = { worktree: cwd, readonly, result, runDir, toolHome: {} };

  if (toolHome) view.toolHome[toolHome.variable] = toolHome.dir;

  return view;
}

/** The names a step's process gets over its runtime's environment, and those it goes without. */
export interface StepEnv {
  env: Record<string, string>;
  /** The names of `env` whose values the team provides, which a runtime that cannot keep env private drops. */
  provided: string[];
  unset: string[];
}

/**
 * The names a step's process gets over the runtime's own environment: each key the lease provides, with its value
 * here, the lease's `env`, and the attempt's marker. Never this process's environment: `unset` lists the names the
 * lease withholds, which the runtime removes from its own.
 */
export function runtimeStepEnv(lease: Pick<LeaseWire, 'envScope' | 'env' | 'attempt'>, scoped: NodeJS.ProcessEnv, { config, run, mode }: { config: LocalConfig; run: RunId; mode: RunMode }): StepEnv {
  const env: Record<string, string> = {};

  for (const key of lease.envScope?.provide ?? []) {
    const value = scoped[key];

    if (value !== undefined) env[key] = value;
  }

  const own = { ...lease.env, ...attemptEnv(config, run, lease.attempt, mode) };
  const provided = Object.keys(env).filter((key) => !(key in own));
  Object.assign(env, own);

  return { env, provided, unset: [...lease.envScope?.withhold ?? []] };
}

/** The credentials a prompt's tool gets: those its runtime declares, less any name the step withholds. */
function toolCredentials(credentials: Record<string, string>, unset: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(credentials).filter(([name]) => !unset.includes(name)));
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])));
}

/** A started command: one here, or one on a step runtime, which may end with a failure instead of an exit. */
export interface StartedCommand {
  exit: Promise<GroupedCommandExit | WorkflowFailure>;
  /** Stops it and what it started, then settles with how it ended once they are gone. */
  stop: () => Promise<GroupedCommandExit | WorkflowFailure>;
  /** Stops it because the run cancelled the step, for a command that runs elsewhere (the fleet) and passes that on. Absent: `stop`. */
  cancel?: () => Promise<GroupedCommandExit | WorkflowFailure>;
}

/**
 * A command step on the attempt's runtime, as the loop stages and stops one: open, one exec of the shell, collect.
 * A runtime failure, or an exec a restart found running and stopped, ends it with a failure instead of an exit.
 */
export function runtimeCommand(input: {
  run: AttemptRun; view: () => Promise<PlaceView>; command: string; kind?: 'command' | 'workflow'; env: Record<string, string>; unset: string[]; setUp: SetUp; ask?: ExecEvents['ask'];
}): StartedCommand {
  const { run, command, kind = 'command', env, unset, setUp, ask } = input;
  // A stop between setup and the exec finds no operation running there to cancel, so the exec is not sent. Setup gets
  // the stop as its signal, so a stop before it runs sends nothing and one while it runs ends it stopped.
  let isStopRequested = false;
  const stopping = new AbortController();

  const exit = (async (): Promise<GroupedCommandExit | WorkflowFailure> => {
    const view = await input.view();
    const opened = await run.open(view);

    if (!opened.ok) return opened.failure;
    const unready = await setUp(stopping.signal);

    if (unready) return unready;

    if (isStopRequested) return { exitCode: STOPPED_EXIT_CODE, stdout: '', stderr: '', output: '' };
    let stderr = '';
    let output = '';

    // A command runs no tool, so it gets none of the runtime's credentials.
    const end = await run.exec({ argv: shellArgv(command), env, unset, credentials: {}, cwd: view.worktree }, {
      ...(ask && { ask }),
      onOutput: (stream, data) => {
        output += data;

        if (stream === 'stderr') stderr = `${stderr}${data}`.slice(-STDERR_KEPT);
      },
    }, kind);

    const uncollected = await run.collect();

    switch (end.kind) {
      case 'exited':
        return uncollected ?? { exitCode: end.code, stdout: end.stdout, stderr, output: output || end.stdout };
      case 'cancelled':
        return { exitCode: STOPPED_EXIT_CODE, stdout: end.stdout ?? '', stderr, output };
      case 'interrupted':
        return interrupted();
      case 'left':
        return left();
      case 'failed':
        if (end.isStepOutcome) return { code: end.failure.code, message: end.failure.message };

        return { code: 'runtime_failed', message: `The step runtime could not run the command (${end.failure.code}): ${end.failure.message}` };
      case 'lost':
        return lost('the command', end.failure);
      default: {
        const unhandled: never = end;

        return unhandled;
      }
    }
  })();

  const halt = (how: 'stop' | 'cancel') => async (): Promise<GroupedCommandExit | WorkflowFailure> => {
    isStopRequested = true;
    stopping.abort();
    await (how === 'cancel' ? run.cancel() : run.stop());

    return exit;
  };

  return { exit, stop: halt('stop'), cancel: halt('cancel') };
}

/** A command that never starts and ends with `failure`. */
export function failedCommand(failure: WorkflowFailure): StartedCommand {
  const exit = Promise.resolve(failure);

  return { exit, stop: async () => exit };
}

/**
 * What runs once the attempt's place is open, before the step's own exec or prompt: the workflow's setup, through
 * `runtimeSetup`, with the checks teamai keeps, stopped when `signal` aborts. A failure ends the step before it starts.
 */
export type SetUp = (signal: AbortSignal | undefined) => Promise<WorkflowFailure | undefined>;

/**
 * `runPlaceSetup`'s `on` for the attempt's runtime: setup's command as an exec of the attempt's open place, with setup's keys and none of the tool's credentials, then a
 * collect, so the checks that follow read setup's work on the host. A stop is the runtime's `cancel`.
 */
export function runtimeSetup(run: AttemptRun) {
  return async ({ command, dir, env, unset, signal }: { command: string; dir: string; env: Record<string, string>; unset: string[]; signal: AbortSignal | undefined }): Promise<{ code: number; output: string } | { failure: WorkflowFailure }> => {
    const stop = (): void => { void run.cancel(); };

    signal?.addEventListener('abort', stop, { once: true });
    let output = '';

    try {
      const end = await run.setup({ argv: shellArgv(command), env, unset, credentials: {}, cwd: dir }, { onOutput: (_stream, data) => { output = `${output}${data}`.slice(-STDERR_KEPT); } });
      const uncollected = end.kind === 'exited' ? await run.collect() : undefined;

      switch (end.kind) {
        case 'exited':
          return uncollected ? { failure: uncollected } : { code: end.code, output: output || end.stdout };
        case 'cancelled':
          return { code: STOPPED_EXIT_CODE, output };
        case 'interrupted':
          return { failure: interrupted() };
        case 'left':
          return { failure: left() };
        case 'failed':
          return { failure: { code: 'runtime_failed', message: `The step runtime could not run setup "${command}" (${end.failure.code}): ${end.failure.message}` } };
        case 'lost':
          return { failure: lost(`setup "${command}"`, end.failure) };
        default: {
          const unhandled: never = end;

          return unhandled;
        }
      }
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  };
}

/** A step whose runtime stopped answering while it ran, or could not stop it: what it started may still run there. */
function lost(what: string, failure: RuntimeFailure): WorkflowFailure {
  return { code: 'runtime_lost', message: `The step runtime did not confirm that ${what} stopped, so it may still run there (${failure.code}): ${failure.message}` };
}

/** A step this teamai stopped waiting on, which goes on where it runs, such as on a fleet member. */
function left(): WorkflowFailure {
  return {
    code: 'runtime_interrupted',
    message: 'teamai stopped while the step ran on its runtime, where it goes on: its work stays there, and teamai workflow resume takes it.',
  };
}

function interrupted(): WorkflowFailure {
  return {
    code: 'runtime_interrupted',
    message: 'teamai restarted while the step ran on its runtime, so the step was stopped: its limits cannot be kept across the gap. Its work is kept; retry the step to go on from it.',
  };
}

/**
 * The launcher that runs a prompt's tool through the attempt's runtime: it opens the place with the tool home, execs
 * the tool's argv with `env` (names over the runtime's own), the runtime's `credentials`, and without `unset`, and
 * collects before the adapter reads the result file. A stop is the runtime's `cancel`.
 */
export function runtimeLauncher(run: AttemptRun, { view, tool, toolHome, unset, credentials, setUp }: { view: PlaceView; tool: string; toolHome: { tool: string; dir: string }; unset: string[]; credentials: Record<string, string>; setUp: SetUp }): ToolLauncher {
  const given = toolCredentials(credentials, unset);

  return ({ executable, args, cwd, env, onStart, onStdout }) => {
    let accepted = false;
    let stdout = '';
    // A stop between setup and the exec finds no operation running there to cancel, so the exec is not sent.
    let isStopRequested = false;

    const closed = (async (): Promise<ToolClosed> => {
      const opened = await run.open(view, { tool, toolHome, credentials: given });

      if (!opened.ok) return { failure: opened.failure };
      const unready = await setUp(undefined);

      if (unready) return { failure: unready };

      if (isStopRequested) return { exitCode: 143, stdout };

      const end = await run.exec({ argv: [executable, ...args], env: stringEnv(env), unset, credentials: given, cwd }, {
        onAccepted: () => {
          accepted = true;
          onStart();
        },
        onOutput: (stream, data) => {
          if (stream !== 'stdout') return;
          stdout += data;
          onStdout(data);
        },
      }, 'tool');

      const uncollected = await run.collect();

      switch (end.kind) {
        case 'exited':
          return uncollected ? { failure: uncollected } : { exitCode: end.code, stdout: end.stdout };
        case 'cancelled':
          // A stop at a limit reads what the tool printed until then.
          return { exitCode: 143, stdout };
        case 'interrupted':
          return { failure: interrupted() };
        case 'left':
          return { failure: left() };
        case 'failed':
          return { failure: { code: 'runtime_failed', message: `The step runtime could not run ${executable} (${end.failure.code}): ${end.failure.message}` } };
        case 'lost':
          return { failure: lost(executable, end.failure) };
        default: {
          const unhandled: never = end;

          return unhandled;
        }
      }
    })();

    return {
      closed,
      started: () => accepted,
      stop: () => {
        isStopRequested = true;

        return run.cancel();
      },
    };
  };
}

/**
 * A failed prompt as the step records it: a code the protocol lets a prompt carry as it is, or `runtime_failed`. A
 * code a retry fixes ends with the command that runs `retry` again.
 */
function promptFailure(failure: RuntimeFailure, retry: { run: string; step: string }): WorkflowFailure {
  const recorded = PROMPT_FAILURE_CODES.some((code) => code === failure.code)
    ? { code: failure.code, message: failure.message }
    : { code: 'runtime_failed', message: `The step runtime could not run the prompt (${failure.code}): ${failure.message}` };

  return { ...recorded, message: withRetry({ code: failure.code, message: recorded.message }, retry) };
}

/**
 * The adapter for a runtime that launches agents its own way: it opens the place, sends the step as one `prompt` with
 * teamai's whole prompt and the lease's tool, model, session and limits, and collects before it reports. A finished
 * prompt's result is written to the result file, as a tool writes it, and its session and usage are the step's. teamai
 * keeps the step's timeout and a driver abort as a `cancel`; a budget is checked against the usage once it finishes.
 */
export function runtimePrompter(run: AttemptRun, { view, runId, step, tool, provided, unset, credentials, setUp, isThroughOuter, continues }: {
  view: PlaceView;
  runId: RunId;
  step: string;
  /** The tool the step runs on, or its instance by the name `init.instances` gives it, as the runtime lists it. */
  tool: string;
  provided: string[];
  unset: string[];
  credentials: Record<string, string>;
  setUp: SetUp;
  /** The runtime runs through another, whose open is told what the prompt goes without, since the tool runs in its place. */
  isThroughOuter?: boolean;
  /** The conversation of an earlier attempt's prompt the step continues, in the place teamai held open for it. */
  continues?: NonNullable<PromptLease['continue']>;
}): StepLauncher {
  const given = toolCredentials(credentials, unset);

  // `extended` is the shipped tool `tool` is, or extends; a runtime may report the session under either name.
  const launch = async (extended: string, input: StepRun, signal: AbortSignal | undefined, interactive: boolean): Promise<StepRunResult> => {
    const opened = await run.open(view, { tool, credentials: given, ...(isThroughOuter && { unset }) });

    if (!opened.ok) return { started: false, exitCode: 1, failure: opened.failure };
    const unready = await setUp(undefined);

    if (unready) return { started: false, exitCode: 1, failure: unready };
    const lease: PromptLease = { step, tool, prompt: stepPrompt(input, { inPrompt: true }), result: input.resultPath, permissions: input.unattended ? 'unattended' : 'approval-required', interactive };

    if (input.model) lease.model = input.model.effort ? { name: input.model.name, effort: input.model.effort } : { name: input.model.name };

    if (input.resume) lease.resume = input.resume;

    if (continues) lease.continue = continues;

    if (input.maxTurns !== undefined) lease.maxTurns = input.maxTurns;
    const env = stringEnv(input.env ?? {});

    if (input.launchEnv) Object.assign(env, input.launchEnv);
    env.TEAMAI_WORKFLOW_RESULT = input.resultPath;
    let accepted = false;
    let timedOut = false;
    // A stop before the prompt is sent, or while a restart reattaches, is kept and sent once the runtime accepts it.
    let stopped = false;

    const stop = (): void => {
      stopped = true;
      void run.cancel();
    };

    const timer = input.timeoutMs === undefined || input.timeoutMs > MAX_TIMER_MS ? undefined : setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);

    signal?.addEventListener('abort', stop, { once: true });

    if (signal?.aborted) stop();

    const end = await run.prompt({ lease, env, provided, unset, credentials: given, cwd: input.cwd }, {
      onAccepted: () => {
        accepted = true;

        if (stopped) void run.cancel();
      },
    });

    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    const uncollected = await run.collect();

    switch (end.kind) {
      case 'finished': {
        if (end.session.tool !== tool && end.session.tool !== extended) {
          return { started: true, exitCode: 1, failure: { code: 'runtime_failed', message: `The step runtime finished the ${tool} prompt with a session of ${end.session.tool}.` } };
        }

        // A runtime's answer may echo a credential, so teamai's own write of it is masked: `input.secrets` holds the run's
        // team secrets and runtime credentials. An agent that writes the result file itself, in a result directory on this
        // machine, writes it unmasked before this, and `report` masks it again.
        await AttemptResult.write(input.resultPath, end.result, input.secrets);

        // A session the step asked to resume that the runtime did not continue is a new one, whatever came after it.
        const fresh = input.resume !== undefined && end.resumed !== true ? { startedFresh: true as const } : {};

        if (uncollected) return { started: true, exitCode: 1, session: end.session.id, failure: uncollected, ...fresh };
        const ran: StepRunResult = { started: true, exitCode: 0, session: end.session.id, ...fresh };

        if ('output' in end.result) ran.output = end.result.output;

        if (end.result.failure) ran.failure = { code: end.result.failure.code, message: withoutPrompt(end.result.failure.message, input) };

        if (end.usage) ran.tokens = end.usage;

        return ran;
      }

      case 'cancelled': {
        const cancelled: StepRunResult = { started: true, exitCode: 143, failure: { code: 'tool_failed', message: `${tool} was stopped before it wrote a workflow result` } };

        if (timedOut) cancelled.stoppedBy = 'timeout';

        return cancelled;
      }

      case 'failed':
        return { started: accepted, exitCode: 1, failure: promptFailure(end.failure, { run: runId, step }) };
      case 'lost':
        return { started: accepted, exitCode: 1, failure: lost(`the ${tool} prompt`, end.failure) };
      default: {
        const unhandled: never = end;

        return unhandled;
      }
    }
  };

  return {
    run: (extended, input, signal) => launch(extended, input, signal, false),
    runInteractive: (extended, input, signal) => launch(extended, input, signal, true),
  };
}
