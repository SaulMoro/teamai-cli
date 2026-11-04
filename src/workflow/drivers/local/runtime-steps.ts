import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunMode } from '../../../launch-context.js';
import type { CommandExit } from '../../../tool-launch/process-stop.js';
import { attemptEnv } from '../../attempt-marker.js';
import type { LeaseWire } from '../../lease-wire.js';
import type { AttemptRun } from '../../runtimes/attempt.js';
import { PROMPT_FAILURE_CODES, type PlaceView, type PromptLease, type RuntimeFailure } from '@teamai/runtime-protocol';
import { launchEnv } from '../../../launch-context.js';
import { writeJsonAtomic } from '../../../utils/fs.js';
import { attemptResultPath, type AttemptId, type RunId } from '../../store.js';
import type { WorkflowFailure } from '../../types.js';
import { git } from '../../worktree.js';
import type { LocalConfig } from '../../../types.js';
import { agentPrompt, type LocalToolAdapter, type LocalToolResult, type LocalToolRun, type ToolClosed, type ToolLauncher } from './local-tool-adapter.js';

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
  await fs.mkdir(result, { recursive: true });
  const view: PlaceView = { worktree: cwd, readonly, result, toolHome: {} };

  if (toolHome) view.toolHome[toolHome.variable] = toolHome.dir;

  return view;
}

/** The argv a command step runs as: its command in the shell, as the local loop runs one. */
export function shellArgv(command: string): string[] {
  return process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['/bin/sh', '-c', command];
}

/** The names a step's process gets over its runtime's environment, and those it goes without. */
export interface StepEnv {
  env: Record<string, string>;
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

  Object.assign(env, lease.env, attemptEnv(config, run, lease.attempt, mode));

  return { env, unset: [...lease.envScope?.withhold ?? []] };
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])));
}

/** A started command: one here, or one on a step runtime, which may end with a failure instead of an exit. */
export interface StartedCommand {
  exit: Promise<CommandExit | WorkflowFailure>;
  /** Stops it and what it started, then settles with how it ended once they are gone. */
  stop: () => Promise<CommandExit | WorkflowFailure>;
}

/**
 * A command step on the attempt's runtime, as the loop stages and stops one: open, one exec of the shell, collect.
 * A runtime failure, or an exec a restart found running and stopped, ends it with a failure instead of an exit.
 */
export function runtimeCommand(input: { run: AttemptRun; view: () => Promise<PlaceView>; command: string; env: Record<string, string>; unset: string[] }): StartedCommand {
  const { run, command, env, unset } = input;

  const exit = (async (): Promise<CommandExit | WorkflowFailure> => {
    const view = await input.view();
    const opened = await run.open(view);

    if (!opened.ok) return opened.failure;
    let stderr = '';
    let output = '';

    const end = await run.exec({ argv: shellArgv(command), env, unset, cwd: view.worktree }, {
      onOutput: (stream, data) => {
        output += data;

        if (stream === 'stderr') stderr = `${stderr}${data}`.slice(-STDERR_KEPT);
      },
    });

    const uncollected = await run.collect();

    switch (end.kind) {
      case 'exited':
        return uncollected ?? { exitCode: end.code, stdout: end.stdout, stderr, output: output || end.stdout };
      case 'cancelled':
        return { exitCode: 130, stdout: '', stderr, output };
      case 'interrupted':
        return interrupted();
      case 'failed':
        return { code: 'runtime_failed', message: `The step runtime could not run the command: ${end.failure.message}` };
      default: {
        const unhandled: never = end;

        return unhandled;
      }
    }
  })();

  return { exit, stop: async () => {
    await run.cancel();

    return exit;
  } };
}

function interrupted(): WorkflowFailure {
  return {
    code: 'runtime_interrupted',
    message: 'teamai restarted while the step ran on its runtime, so the step was stopped: its limits cannot be kept across the gap. Its work is kept; retry the step to go on from it.',
  };
}

/**
 * The launcher that runs a prompt's tool through the attempt's runtime: it opens the place with the tool home, execs
 * the tool's argv with `env` (names over the runtime's own) and without `unset`, and collects before the adapter reads
 * the result file. A stop is the runtime's `cancel`.
 */
export function runtimeLauncher(run: AttemptRun, { view, toolHome, unset }: { view: PlaceView; toolHome: { tool: string; dir: string }; unset: string[] }): ToolLauncher {
  return ({ executable, args, cwd, env, onStdout }) => {
    let accepted = false;
    let stdout = '';

    const closed = (async (): Promise<ToolClosed> => {
      const opened = await run.open(view, toolHome);

      if (!opened.ok) return { failure: opened.failure };

      const end = await run.exec({ argv: [executable, ...args], env: stringEnv(env), unset, cwd }, {
        onAccepted: () => { accepted = true; },
        onOutput: (stream, data) => {
          if (stream !== 'stdout') return;
          stdout += data;
          onStdout(data);
        },
      });

      const uncollected = await run.collect();

      switch (end.kind) {
        case 'exited':
          return uncollected ? { failure: uncollected } : { exitCode: end.code, stdout: end.stdout };
        case 'cancelled':
          // A stop at a limit reads what the tool printed until then.
          return { exitCode: 143, stdout };
        case 'interrupted':
          return { failure: interrupted() };
        case 'failed':
          return { failure: { code: 'runtime_failed', message: `The step runtime could not run ${executable}: ${end.failure.message}` } };
        default: {
          const unhandled: never = end;

          return unhandled;
        }
      }
    })();

    return { closed, started: () => accepted, stop: () => run.cancel() };
  };
}

/** A failed prompt as the step records it: a code the protocol lets a prompt carry as it is, or `runtime_failed`. */
function promptFailure(failure: RuntimeFailure): WorkflowFailure {
  if (PROMPT_FAILURE_CODES.some((code) => code === failure.code)) return { code: failure.code, message: failure.message };

  return { code: 'runtime_failed', message: `The step runtime could not run the prompt (${failure.code}): ${failure.message}` };
}

/**
 * The adapter for a runtime that launches agents its own way: it opens the place, sends the step as one `prompt` with
 * teamai's whole prompt and the lease's tool, model, session and limits, and collects before it reports. A finished
 * prompt's result is written to the result file, as a tool writes it, and its session and usage are the step's. teamai
 * keeps the step's timeout and a driver abort as a `cancel`; a budget is checked against the usage once it finishes.
 */
export function runtimePrompter(run: AttemptRun, { view, step, unset }: { view: PlaceView; step: string; unset: string[] }): LocalToolAdapter {
  const launch = async (tool: string, input: LocalToolRun, signal: AbortSignal | undefined, interactive: boolean): Promise<LocalToolResult> => {
    const opened = await run.open(view);

    if (!opened.ok) return { started: false, exitCode: 1, failure: opened.failure };
    const lease: PromptLease = { step, tool, prompt: agentPrompt(input), result: input.resultPath, permissions: input.unattended ? 'unattended' : 'approval-required', interactive };

    if (input.model) lease.model = input.model.effort ? { name: input.model.name, effort: input.model.effort } : { name: input.model.name };

    if (input.resume) lease.resume = input.resume;

    if (input.maxTurns !== undefined) lease.maxTurns = input.maxTurns;
    const env = stringEnv({ ...input.env, ...(input.launch ? launchEnv(input.launch) : {}), TEAMAI_WORKFLOW_RESULT: input.resultPath });
    let accepted = false;
    let timedOut = false;
    const stop = (): void => { void run.cancel(); };

    const timer = input.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);

    signal?.addEventListener('abort', stop, { once: true });

    if (signal?.aborted) stop();
    const end = await run.prompt({ lease, env, unset, cwd: input.cwd }, { onAccepted: () => { accepted = true; } });
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    const uncollected = await run.collect();

    switch (end.kind) {
      case 'finished': {
        if (end.session.tool !== tool) {
          return { started: true, exitCode: 1, failure: { code: 'runtime_failed', message: `The step runtime finished the ${tool} prompt with a session of ${end.session.tool}.` } };
        }

        await writeJsonAtomic(input.resultPath, end.result);

        if (uncollected) return { started: true, exitCode: 1, session: end.session.id, failure: uncollected };
        const ran: LocalToolResult = { started: true, exitCode: 0, session: end.session.id };

        if ('output' in end.result) ran.output = end.result.output;

        if (end.result.failure) ran.failure = end.result.failure;

        if (end.usage) ran.tokens = end.usage;

        return ran;
      }

      case 'cancelled': {
        const stopped: LocalToolResult = { started: true, exitCode: 143, failure: { code: 'tool_failed', message: `${tool} was stopped before it wrote a workflow result` } };

        if (timedOut) stopped.stoppedBy = 'timeout';

        return stopped;
      }

      case 'failed':
        return accepted ? { started: true, exitCode: 1, failure: promptFailure(end.failure) } : { started: false, exitCode: 1, failure: promptFailure(end.failure) };
      default: {
        const unhandled: never = end;

        return unhandled;
      }
    }
  };

  return {
    run: (tool, input, signal) => launch(tool, input, signal, false),
    runInteractive: (tool, input, signal) => launch(tool, input, signal, true),
  };
}
