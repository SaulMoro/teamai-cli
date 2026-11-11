import type { ChildProcess, SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stopProcess } from '@teamai/shared/process-group';
import { resolveCliPath, resolvePathCommand } from '@teamai/shared/cli-path';
import { spawnCommand } from '@teamai/shared/exec';
import { runStepLaunch, type StepLaunchHost, type StepLaunchInput, type StepLaunchResult, type StepLimits, type StepTool, type ToolClosed, type ToolLauncher } from '@teamai/tool-launch/run-step-launch';

/** A step's launch as the engine asks for it: what the launch takes, and its limits. */
export interface StepRun extends StepLaunchInput, StepLimits {
  /** The command that starts the tool, when an instance of it has its own; the tool's own command otherwise. */
  command?: string;
}

/** What a run gave: the launch's result, which `started` says whether the tool's process started (#1176). */
export type StepRunResult = StepLaunchResult;

/** Runs a workflow step's tool, headless or handed the terminal. */
export interface StepLauncher {
  run(tool: string, input: StepRun, signal?: AbortSignal): Promise<StepRunResult>;
  /** Opens a foreground tool for a person, with an optional structured result. */
  runInteractive(tool: string, input: StepRun, signal?: AbortSignal): Promise<StepRunResult>;
}

export type ToolSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type ToolResolve = (command: string) => string | null;

/**
 * What a step's launch reads from teamai, which a runtime package cannot import: the machine's facts the launch takes
 * (`host`), and each tool's step profile with the command that starts it, or undefined for a tool that runs no step.
 */
export interface StepLaunchDeps {
  host: StepLaunchHost;
  stepTool(tool: string): (Omit<StepTool, 'executable' | 'name'> & { command: string }) | undefined;
}

/**
 * The launcher that spawns the tool on this machine, in a process group of its own unless it is interactive, which gets
 * the terminal. It never calls `onStdout` before it returns, so the launch holds the process before a limit stops it.
 */
export function hostProcess(spawnTool: ToolSpawn = spawnCommand): ToolLauncher {
  return ({ executable, args, cwd, env, interactive, onStart, onStdout }) => {
    let started = false;
    let childProcess: ChildProcess | undefined;

    const closed = new Promise<ToolClosed>((resolve) => {
      let child: ChildProcess;

      try {
        child = spawnTool(executable, args, {
          cwd,
          // A shell sets PWD to the directory it starts in; OpenCode works in PWD, not in its cwd.
          env: { ...env, PWD: cwd },
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

/**
 * The launcher over `start`, whatever starts the tool's process: it finds the tool's executable, then runs the step's
 * launch through `start`. `resolveTool` finds the executable, and `resolveInstanceCommand` a tool instance's command,
 * which comes from a config file, so only the PATH directories may hold it; each says when it is missing.
 */
export function stepLauncher(deps: StepLaunchDeps, {
  start = hostProcess(),
  resolveTool = resolveCliPath,
  resolveInstanceCommand = resolvePathCommand,
}: { start?: ToolLauncher; resolveTool?: ToolResolve; resolveInstanceCommand?: ToolResolve } = {}): StepLauncher {
  const launch = async (tool: string, input: StepRun, signal: AbortSignal | undefined, interactive: boolean): Promise<StepRunResult> => {
    const profile = deps.stepTool(tool);

    if (!profile) return { started: false, exitCode: 1, failure: { code: 'tool_unsupported', message: `The local workflow tool "${tool}" is not supported` } };
    await fs.mkdir(path.dirname(input.resultPath), { recursive: true });
    // The launch reads only what this tool writes there: a file an earlier process of the attempt left, such as the
    // tool of a killed driver that wrote one as it was stopped, is never taken for this tool's result.
    await fs.rm(input.resultPath, { force: true });
    const command = input.command ?? profile.command;
    const executable = input.command === undefined ? resolveTool(command) : resolveInstanceCommand(command);

    if (!executable) {
      return {
        started: false,
        exitCode: 1,
        failure: { code: 'tool_unavailable', message: `The ${command === profile.command ? tool : command} executable is not available on PATH` },
      };
    }

    // `command` is resolved above; the launch ignores it.
    const { budget, timeoutMs, idleTimeoutMs, command: _command, ...run } = input;

    return runStepLaunch({
      tool: { name: tool, family: profile.family, step: profile.step, executable },
      input: run,
      start,
      limits: { budget, timeoutMs, idleTimeoutMs },
      signal,
      interactive,
      host: deps.host,
    });
  };

  return {
    run: (tool, input, signal) => launch(tool, input, signal, false),
    runInteractive: (tool, input, signal) => launch(tool, input, signal, true),
  };
}
