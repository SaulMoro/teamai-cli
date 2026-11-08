import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { launchEnv, type Launch } from '../../launch-context.js';
import { opencodeMajorVersion } from '../../opencode-version.js';
import { resolveCliPath, resolvePathCommand } from '../../utils/cli-path.js';
import { log } from '../../utils/logger.js';
import type { toolExtrasFor } from '../../resources/agent-format.js';
import { stopProcess } from '../../tool-launch/process-stop.js';
import { tokenMeter, toolStdout, type TokenUsage, type ToolReport } from '../../tool-launch/stdout.js';
import type { LaunchAdapter } from '@teamai/tool-core/launch';
import { spawnCommand } from '@teamai/tool-core/exec';
import { isUsageLimitText } from '@teamai/tool-core/usage-limit';
import { executableOf, launchAdapterIdOf, launchAdapterOf, opencodeModelArgs, type LaunchTool } from '../../tool-launch/tools.js';
import { AttemptResult } from '../attempt-result.js';
import { budgeted } from '../limits.js';
import { expectedOutput } from '../output.js';
import type { Limit } from '../requirements.js';
import { MAX_TIMER_MS } from '../../utils/timer.js';
import type { StepModel } from '../step-model.js';
import type { OutputSchema, WorkflowFailure } from '../types.js';
import { agyGatewayEnv } from '../../models/agy-gateway.js';

export interface LocalToolRun {
  prompt: string;
  cwd: string;
  resultPath: string;
  /** What the run masks: a result kept from the tool's stdout is masked with it before it is written. */
  secrets: Record<string, string>;
  /** The step's declared output, which the result instruction asks the tool to match. */
  output?: OutputSchema;
  /** The definition the step runs as. `settings` are the deployed OpenCode file's other fields, such as `mode` and `variant`. */
  agent?: { name: string; instructions: string; model?: string; settings?: NonNullable<ReturnType<typeof toolExtrasFor>> };
  /** The model and effort the launch passes: the step's, which replaces the definition's, or on Codex and OpenCode the definition's own. */
  model?: StepModel;
  /** The workflow launch the tool's session-start hook reads from its environment (#1176). */
  launch?: Launch;
  /** A session id from the same tool. Claude and Codex resume it; OpenCode has no resume flag here. */
  resume?: string;
  /** The environment the tool runs with, scoped to the env keys its lease provides; the inherited one when unset. */
  env?: NodeJS.ProcessEnv;
  /** The most agent turns headless Claude may take. Other tools have no such flag. */
  maxTurns?: number;
  /** The most tokens the run may bill, counted as a budget counts them: once its stdout states more, it is stopped. */
  budget?: number;
  /** How long the tool may run from its spawn before it is stopped. */
  timeoutMs?: number;
  /**
   * How long the tool may print nothing before it is stopped. Only a launch known to stream its output takes it: headless
   * Claude, whose `stream-json` prints each message as it comes. A launch that prints only once it ends would always reach
   * the limit, so every other launch has none.
   */
  idleTimeoutMs?: number;
  /** Launch the tool in its own mode for editing and running commands without asking (`permissions: unattended`). */
  unattended?: true;
  /** The command that starts the tool, when an instance of it has its own; the tool's own command otherwise. */
  command?: string;
}

/**
 * What a run gave. `started` is whether the tool's process spawned, as its `spawn` event says, so a pass that
 * launched nothing records no observation of a launch (#1176).
 */
export type LocalToolResult =
  | {
    started: true;
    exitCode: number;
    /** How the launch handed over the definition, when it ran one. */
    applied?: 'main' | 'prompt';
    output?: unknown;
    model?: string;
    session?: string;
    tokens?: TokenUsage;
    /** What the tool said the run cost, as it said it. */
    cost?: ToolReport['cost'];
    /**
     * The limit that ended the run: the first one at which the adapter stopped the tool, its timeout or its budget, or
     * the turn cap, at which headless Claude ends itself with `error_max_turns`.
     */
    stoppedBy?: Limit;
    /** The run was asked to resume a session, and its runtime started a new one instead. */
    startedFresh?: true;
    failure?: WorkflowFailure;
  }
  | { started: false; exitCode: number; failure: WorkflowFailure };

export interface LocalToolAdapter {
  run(tool: LaunchTool, input: LocalToolRun, signal?: AbortSignal): Promise<LocalToolResult>;
  /** Opens a foreground tool for a person, with an optional structured result. */
  runInteractive(tool: LaunchTool, input: LocalToolRun, signal?: AbortSignal): Promise<LocalToolResult>;
}

export type ToolSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type ToolResolve = (command: string) => string | null;

type ResultFile = ToolReport & { failure?: WorkflowFailure };

function resultInstruction(input: LocalToolRun, prompt: string): string {
  return `${prompt}\n\nWrite the workflow result as JSON to ${input.resultPath}. `
    + `Use this shape: {"output":...}, where output is ${expectedOutput(input.output)}. `
    + 'Leave failure out unless the step failed; then add "failure":{"code":"...","message":"..."}.';
}

/** The step's prompt after the agent definition's instructions, for a launch that hands the definition over in the prompt. */
function withInstructions(input: LocalToolRun): string {
  return input.agent?.instructions ? `${input.agent.instructions}\n\n${input.prompt}` : input.prompt;
}

/**
 * The whole prompt a runtime that launches agents its own way gets: the agent definition's instructions, which it has
 * no flag to pass, the step's prompt, and the instruction to write the result file.
 */
export function agentPrompt(input: LocalToolRun): string {
  return resultInstruction(input, withInstructions(input));
}

/** Codex, and OpenCode 1 for a subagent, which `opencode run --agent` does not start, get the definition's instructions in the prompt. */
function promptHandoff(tool: LaunchTool, input: LocalToolRun, opencodeMajor: number): boolean {
  const family = launchAdapterIdOf(tool);

  return family === 'codex' || (family === 'opencode' && opencodeMajor < 2 && input.agent?.settings?.['mode'] === 'subagent');
}

/** The arguments that launch `tool` unattended, or `'none'` when teamai knows no such mode of it. */
function unattendedArgs(tool: LaunchTool): readonly string[] | 'none' {
  const adapter: LaunchAdapter = launchAdapterOf(tool);
  const unattended = adapter.step?.unattended ?? 'none';

  return unattended === 'none' ? 'none' : unattended.args;
}

/**
 * An absolute path as a Claude or CodeBuddy permission rule matches it, after the `/` that marks a rule absolute: as it
 * is, and on Windows in the POSIX form Claude matches, so `C:\a\b` is `/c/a/b`.
 */
function permissionRulePath(file: string): string {
  if (process.platform !== 'win32') return file;

  return file.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll('\\', '/');
}

/** The argv that launches `tool` for one step: the prompt with its result instruction, then the flags the step's lease sets. */
export function invocation(tool: LaunchTool, input: LocalToolRun, opencodeMajor: number, interactive: boolean): string[] {
  const family = launchAdapterIdOf(tool);
  const modeArgs = input.unattended ? unattendedArgs(tool) : [];
  const unattended = modeArgs === 'none' ? [] : modeArgs;
  const viaPrompt = promptHandoff(tool, input, opencodeMajor);

  const prompt = resultInstruction(input, viaPrompt ? withInstructions(input) : input.prompt);
  const agent = input.agent && !viaPrompt ? ['--agent', input.agent.name] : [];
  const model = input.model ? ['--model', input.model.name] : [];
  const effort = input.model?.effort;
  const resume = input.resume ? ['--resume', input.resume] : [];
  const turns = input.maxTurns !== undefined ? ['--max-turns', String(input.maxTurns)] : [];

  // Claude's and CodeBuddy's default mode asks before any write, so the result file's directory, the attempt's out/,
  // and only it, is allowed: the step writes its result there, and the evidence archived with its session. The mode
  // stays as it is. One argument: the flag is variadic, and would take a prompt after it as a rule too.
  const result = `--allowedTools=Edit(/${permissionRulePath(path.dirname(input.resultPath))}/**)`;

  switch (family) {
    case 'claude': {
      if (interactive) return [...unattended, result, ...agent, ...model, ...(effort ? ['--effort', effort] : []), ...resume, prompt];

      // Only partial messages state each message's final usage as it ends, which the budget meter counts.
      return ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...(input.budget !== undefined ? ['--include-partial-messages'] : []), ...unattended, result, ...turns, ...agent, ...model, ...(effort ? ['--effort', effort] : []), ...resume];
    }

    case 'codebuddy':
      // Claude's flags, with no --effort.
      if (interactive) return [...unattended, result, ...agent, ...model, ...resume, prompt];

      return ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...unattended, result, ...turns, ...agent, ...model, ...resume];
    case 'codex': {
      if (interactive) return [...(input.resume ? ['resume', input.resume] : []), ...unattended, ...model, ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), prompt];
      const codexModel = input.model?.name ?? input.agent?.model;
      const codexResume = input.resume ? ['resume', input.resume] : [];

      return ['exec', ...codexResume, '--json', ...unattended, ...(codexModel ? ['--model', codexModel] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), prompt];
    }

    case 'opencode':
      if (interactive) return [...unattended, ...agent, ...model, '--prompt', prompt];

      return ['run', '--format', 'json', ...unattended, prompt, ...agent, ...opencodeModelArgs(input.model, opencodeMajor)];
    case 'agy': {
      const conversation = input.resume ? ['--conversation', input.resume] : [];
      const agyEffort = effort ? ['--effort', effort] : [];

      if (interactive) return [...unattended, ...agent, ...model, ...agyEffort, ...conversation, '--prompt-interactive', prompt];

      // `--print=` keeps the prompt attached: a bare `-p` takes its next argument as the prompt, even a flag.
      return ['--output-format=stream-json', ...unattended, ...agent, ...model, ...agyEffort, ...conversation, `--print=${prompt}`];
    }

    default: {
      const unhandled: never = family;
      throw new Error(`No workflow step profile for adapter ${String(unhandled)}`);
    }
  }
}

/** The result file a tool writes: its output, when it wrote one, and a failure with a code and a message. A null failure is none. */
const ResultFileSchema = z.object({
  output: z.unknown().optional(),
  failure: z.object({ code: z.string(), message: z.string() }).nullish().transform((failure) => failure ?? undefined),
});

async function readResultFile(resultPath: string): Promise<ResultFile | null> {
  try {
    const result = ResultFileSchema.safeParse(JSON.parse(await fs.readFile(resultPath, 'utf8')));

    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** A failure message a tool wrote, without the step's prompt or the agent's instructions it may quote. */
export function withoutPrompt(message: string, input: LocalToolRun): string {
  let kept = message;

  for (const secret of [input.prompt, input.agent?.instructions]) {
    if (secret) kept = kept.replaceAll(secret, '[prompt omitted]');
  }

  return kept;
}

/** Whether what the tool printed says it stopped on its usage limit: by the kind of its error, or by its text. */
function isUsageLimit(printed: ToolReport | null): printed is ToolReport & { error: string } {
  return printed?.error !== undefined && (printed.isUsageLimit === true || isUsageLimitText(printed.error));
}

/** A spent usage limit, with the tool's own words, which name the reset when the tool gives it. */
function usageLimited(tool: string, error: string, input: LocalToolRun): WorkflowFailure {
  return { code: 'usage_limited', message: `${tool} hit its usage limit: ${withoutPrompt(error, input)}` };
}

function redactFailure(result: ResultFile, input: LocalToolRun): void {
  if (result.failure) result.failure.message = withoutPrompt(result.failure.message, input);
}

async function persistFallback(input: LocalToolRun, result: ResultFile): Promise<void> {
  const artifact: ResultFile = {};

  if ('output' in result) artifact.output = result.output;

  if (result.failure) artifact.failure = result.failure;
  await AttemptResult.write(input.resultPath, artifact, input.secrets);
}

function combineResults(fileResult: ResultFile | null, reported: ToolReport | null): ResultFile | null {
  if (!fileResult && !reported) return null;
  const result: ResultFile = {};

  if (fileResult && 'output' in fileResult) result.output = fileResult.output;
  else if (reported && 'output' in reported) result.output = reported.output;

  if (fileResult?.failure) result.failure = fileResult.failure;

  if (reported?.model) result.model = reported.model;

  if (reported?.session) result.session = reported.session;

  if (reported?.tokens) result.tokens = reported.tokens;

  if (reported?.cost) result.cost = reported.cost;

  return result;
}

/** What a launched tool process ended with: its exit code and complete stdout, or why it ended without one. */
export type ToolClosed = { exitCode: number; stdout: string; error?: NodeJS.ErrnoException } | { failure: WorkflowFailure };

/** One launched tool process, as the adapter watches it. */
export interface ToolProcess {
  closed: Promise<ToolClosed>;
  /** Whether the process started: it spawned, or its runtime accepted it. */
  started(): boolean;
  /** Stops the process and everything it started; a signal from the person is forwarded to an interactive one. */
  stop(signal?: NodeJS.Signals): Promise<void>;
}

/**
 * Starts a tool process: here with `spawn`, or through a step runtime's `exec`. `onStart` is called once the process
 * started, after any place and setup before it; `onStdout` gets each decoded chunk.
 */
export type ToolLauncher = (launch: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; interactive: boolean; onStart: () => void; onStdout: (text: string) => void }) => ToolProcess;

/** The launcher that spawns the tool on this machine, in a process group of its own unless it is interactive. */
function spawnLauncher(spawnTool: ToolSpawn): ToolLauncher {
  return ({ executable, args, cwd, env, interactive, onStart, onStdout }) => {
    let started = false;
    let childProcess: ChildProcess | undefined;

    const closed = new Promise<ToolClosed>((resolve) => {
      let child: ChildProcess;

      try {
        child = spawnTool(executable, args, {
          cwd,
          env,
          // OpenCode waits for the end of a piped stdin before it starts.
          stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
          detached: !interactive && process.platform !== 'win32',
          windowsHide: true,
        });
      } catch (error) {
        resolve({ exitCode: 1, stdout: '', error: error instanceof Error ? error : new Error(String(error)) });

        return;
      }

      childProcess = child;
      let stdout = '';
      const decoder = new StringDecoder('utf8');
      child.on('spawn', () => {
        started = true;
        onStart();
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        const text = decoder.write(chunk);
        stdout += text;
        onStdout(text);
      });
      child.stderr?.resume();
      child.on('error', (error: NodeJS.ErrnoException) => resolve({ exitCode: 1, stdout, error }));
      child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout: stdout + decoder.end() }));
    });

    const stop = childProcess && stopProcess(childProcess, closed, !interactive && process.platform !== 'win32');

    return { closed, started: () => started, stop: async (signal) => { await stop?.(signal); } };
  };
}

export function createLocalToolAdapter(
  // A global npm .cmd shim on Windows gets its arguments escaped for cmd.exe twice, which cross-spawn does not do.
  spawnTool: ToolSpawn = spawnCommand,
  resolveTool: ToolResolve = resolveCliPath,
  // A tool instance's command comes from a config file, so only the PATH directories may hold it.
  resolveInstanceCommand: ToolResolve = resolvePathCommand,
): LocalToolAdapter {
  return toolAdapter(spawnLauncher(spawnTool), resolveTool, resolveInstanceCommand);
}

/**
 * The adapter over `launcher`: everything teamai does around a tool's launch, whatever starts its process. It builds
 * the argv with `invocation()`, meters the budget from stdout and stops the tool at its limits, reads the result file,
 * and parses stdout for the session, tokens and cost. `resolveTool` finds the executable, and `resolveInstanceCommand` a tool instance's command, or says it is missing.
 */
export function toolAdapter(launcher: ToolLauncher, resolveTool: ToolResolve, resolveInstanceCommand: ToolResolve): LocalToolAdapter {
  const launch =
    async (tool: LaunchTool, input: LocalToolRun, signal: AbortSignal | undefined, interactive: boolean): Promise<LocalToolResult> => {
      await fs.mkdir(path.dirname(input.resultPath), { recursive: true });
      const command = input.command ?? executableOf(tool);
      const executable = input.command === undefined ? resolveTool(command) : resolveInstanceCommand(command);

      if (!executable) {
        return {
          started: false,
          exitCode: 1,
          failure: { code: 'tool_unavailable', message: `The ${command === executableOf(tool) ? tool : command} executable is not available on PATH` },
        };
      }

      if (input.unattended && unattendedArgs(tool) === 'none') {
        return {
          started: false,
          exitCode: 1,
          failure: { code: 'tool_unavailable', message: `The step sets permissions: unattended, and ${tool} has no unattended mode teamai knows. Run the step on a tool that has one, or remove permissions from the step.` },
        };
      }

      const opencode = launchAdapterIdOf(tool) === 'opencode';
      const opencodeMajor = opencode && (input.agent || input.model?.effort) ? await opencodeMajorVersion(executable) : 1;

      if (opencode && input.agent) {
        const { name, model, settings = {} } = input.agent;
        const viaPrompt = promptHandoff(tool, input, opencodeMajor);

        // OpenCode 1 applies an agent's variant to a launch on the agent's own model that passes none.
        if (opencodeMajor < 2 && !viaPrompt && settings['variant'] !== undefined && input.model && input.model.name === model && input.model.effort === undefined) {
          return {
            started: false,
            exitCode: 1,
            failure: {
              code: 'model_unavailable',
              message: `Agent "${name}" runs on its own model "${model}" with no effort, and ${tool} 1 applies the agent's variant "${String(settings['variant'])}" `
                + `to that model. Remove model from the step to run at that variant, or set it to an alias with an effort for ${tool}.`,
            },
          };
        }

        // The variant goes on argv with a model, the definition's or the step's.
        const dropped = Object.keys(settings).filter((key) => key !== 'mode' && (key !== 'variant' || !input.model));

        if (viaPrompt && dropped.length > 0) {
          log.warn(`Agent "${name}" runs on ${tool} 1 from the prompt, since opencode run does not start a subagent there, so it does not apply `
            + `${dropped.join(', ')} from the deployed agent file. The step is not blocked.`);
        } else if (opencodeMajor >= 2 && settings['variant'] !== undefined && !input.model) {
          log.warn(`Agent "${name}" sets a variant with no model, and ${tool} 2 takes a variant only with a model, so it does not apply variant `
            + 'from the deployed agent file. The step is not blocked.');
        }
      }

      const args = invocation(tool, input, opencodeMajor, interactive);
      const applied = input.agent ? { applied: promptHandoff(tool, input, opencodeMajor) ? 'prompt' as const : 'main' as const } : {};
      const meter = input.budget !== undefined ? tokenMeter(launchAdapterIdOf(tool)) : undefined;
      let metered: TokenUsage | undefined;
      // The first reason a stop was sent, so a limit crossed while the tool shuts down does not replace it.
      let stopCause: 'timeout' | 'budget' | 'idle' | 'aborted' | undefined;
      let partial = '';
      const env: NodeJS.ProcessEnv = { ...input.env ?? process.env };

      // A model switch hands agy its gateway through a shell function, and this launch runs no shell.
      if (launchAdapterIdOf(tool) === 'agy') Object.assign(env, agyGatewayEnv(input.env ?? process.env));

      if (input.launch) Object.assign(env, launchEnv(input.launch));
      env.TEAMAI_WORKFLOW_RESULT = input.resultPath;

      // The idle limit starts with the tool, and each chunk it prints restarts it, so a tool that streams lives and a
      // silent one is stopped.
      const idleMs = !interactive && launchAdapterIdOf(tool) === 'claude' && input.idleTimeoutMs !== undefined && input.idleTimeoutMs <= MAX_TIMER_MS ? input.idleTimeoutMs : undefined;
      let idleTimer: NodeJS.Timeout | undefined;

      const active = (): void => {
        if (idleMs === undefined) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => stopAt('idle'), idleMs);
      };

      const onStdout = (text: string): void => {
        active();

        if (!meter || input.budget === undefined) return;
        // A long line arrives over many chunks: only the chunk that ends it is split.
        const end = text.lastIndexOf('\n');

        if (end === -1) {
          partial += text;

          return;
        }

        const lines = `${partial}${text.slice(0, end)}`.split('\n');
        partial = text.slice(end + 1);

        for (const line of lines) metered = meter(line);

        if (budgeted(metered) > input.budget) stopAt('budget');
      };

      // The timeout counts from the tool's spawn, as the idle limit does: a place and setup a runtime makes first take none of it.
      let timer: NodeJS.Timeout | undefined;

      const started = (): void => {
        if (input.timeoutMs !== undefined && input.timeoutMs <= MAX_TIMER_MS) timer ??= setTimeout(() => stopAt('timeout'), input.timeoutMs);
        active();
      };

      const processRun = launcher({ executable, args, cwd: input.cwd, env, interactive, onStart: started, onStdout });

      function stopAt(limit: 'timeout' | 'budget' | 'idle'): void {
        stopCause ??= limit;
        void processRun.stop();
      }

      const abort = (): void => {
        const reason: unknown = signal?.reason;
        const forwarded = reason === 'SIGINT' || reason === 'SIGQUIT' || reason === 'SIGTERM' || reason === 'SIGHUP' ? reason : undefined;
        stopCause ??= 'aborted';
        void processRun.stop(interactive ? forwarded : undefined);
      };

      signal?.addEventListener('abort', abort, { once: true });

      if (signal?.aborted) abort();
      const completed = await processRun.closed;
      clearTimeout(timer);
      clearTimeout(idleTimer);

      if (stopCause !== undefined) await processRun.stop();
      signal?.removeEventListener('abort', abort);

      if (stopCause === 'idle' && idleMs !== undefined) {
        return {
          started: processRun.started(), exitCode: 'exitCode' in completed ? completed.exitCode : 1, ...applied,
          failure: { code: 'tool_failed', message: `${tool} printed nothing for ${idleMs / 1000}s, longer than its idle limit (workflows.idle_timeout). Raise the limit if this tool works silently for longer.` },
        };
      }

      const stopped = stopCause === 'aborted' || stopCause === 'idle' ? undefined : stopCause;

      if ('failure' in completed) return { started: processRun.started(), exitCode: 1, ...applied, failure: completed.failure };

      if (!processRun.started() || completed.error?.code === 'ENOENT') {
        return {
          started: false,
          exitCode: completed.exitCode,
          failure: completed.error?.code === 'ENOENT'
            ? { code: 'tool_unavailable', message: `The ${tool} executable is not available on PATH` }
            : { code: 'tool_failed', message: `${tool} could not be started` },
        };
      }

      if (completed.error) {
        const failed: LocalToolResult = { started: true, exitCode: completed.exitCode, ...applied };

        if (stopped) failed.stoppedBy = stopped;
        failed.failure = { code: 'tool_failed', message: `${tool} could not be started` };

        return failed;
      }

      const fileResult = await readResultFile(input.resultPath);
      const printed = toolStdout(launchAdapterIdOf(tool), completed.stdout);
      // Only a tool stopped at a limit may end before its result: one that ended there on its own wrote none.
      const stated = printed?.unfinished && !stopped ? null : printed;
      // A tool stopped mid-run, such as Claude before its final result, states no total: what the meter counted stands in.
      const reported = metered && !stated?.tokens ? { ...stated, tokens: metered } : stated;
      const result = combineResults(fileResult, reported) ?? (interactive ? {} : null);
      const stoppedBy: Limit | undefined = stopped ?? (stated?.reachedMaxTurns ? 'max_turns' : undefined);
      const ended = stoppedBy ? { stoppedBy } : {};

      // OpenCode 1.x exits 0 on a provider's error, a spent limit among them, and writes no result.
      if (!fileResult && isUsageLimit(printed)) return { started: true, exitCode: completed.exitCode, ...applied, ...ended, failure: usageLimited(tool, printed.error, input) };

      if (!result) {
        return {
          started: true,
          exitCode: completed.exitCode,
          ...applied,
          ...ended,
          failure: { code: 'tool_failed', message: `${tool} did not write a valid workflow result` },
        };
      }

      redactFailure(result, input);

      // The tool's own reason, such as a provider's 401, says what the status cannot. It may echo a credential, so it is
      // never written here: only the result the driver reports carries it, which the driver masks before keeping it.
      let told: WorkflowFailure | undefined;

      if (completed.exitCode !== 0 && !result.failure) {
        result.failure = { code: 'tool_failed', message: `${tool} exited with status ${completed.exitCode}` };

        if (isUsageLimit(printed)) {
          result.failure = { code: 'usage_limited', message: `${tool} hit its usage limit` };
          told = usageLimited(tool, printed.error, input);
        } else if (printed?.error !== undefined) {
          told = { ...result.failure, message: `${result.failure.message}: ${withoutPrompt(printed.error, input)}` };
        }
      }

      if (!fileResult) await persistFallback(input, result);

      return { started: true, exitCode: completed.exitCode, ...applied, ...ended, ...result, ...(told && { failure: told }) };
    };

  return {
    run(tool, input, signal) {
      return launch(tool, input, signal, false);
    },
    runInteractive(tool, input, signal) {
      return launch(tool, input, signal, true);
    },
  };
}
