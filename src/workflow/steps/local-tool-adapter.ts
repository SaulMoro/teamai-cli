import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launchEnv, type Launch } from '../../launch-context.js';
import { opencodeMajorVersion } from '../../opencode-version.js';
import { resolveCliPath, resolvePathCommand } from '../../utils/cli-path.js';
import type { toolExtrasFor } from '../../resources/agent-format.js';
import { stopProcess } from '@teamai/shared/process-group';
import { spawnCommand } from '@teamai/tool-core/exec';
import { runStepLaunch, stepPrompt, type StepLaunchHost, type StepLaunchInput, type StepLaunchResult, type StepLimits, type ToolClosed, type ToolLauncher } from '@teamai/tool-launch/run-step-launch';
import { executableOf, launchAdapterIdOf, launchAdapterOf, type LaunchTool } from '../../tool-launch/tools.js';
import { AttemptResult } from '../attempt-result.js';
import { expectedOutput } from '../output.js';
import type { StepModel } from '../step-model.js';
import type { OutputSchema } from '../types.js';
import { agyGatewayEnv } from '../../models/agy-gateway.js';

/** A step's launch as the engine asks for it: what the launch takes, its limits, and what this machine resolves. */
export interface LocalToolRun extends Omit<StepLaunchInput, 'expected' | 'launchEnv' | 'agent' | 'model'>, StepLimits {
  /** The step's declared output, which the result instruction asks the tool to match. */
  output?: OutputSchema;
  /** The definition the step runs as. `settings` are the deployed OpenCode file's other fields, such as `mode` and `variant`. */
  agent?: { name: string; instructions: string; model?: string; settings?: NonNullable<ReturnType<typeof toolExtrasFor>> };
  /** The model and effort the launch passes: the step's, which replaces the definition's, or on Codex and OpenCode the definition's own. */
  model?: StepModel;
  /** The workflow launch the tool's session-start hook reads from its environment (#1176). */
  launch?: Launch;
  /** The command that starts the tool, when an instance of it has its own; the tool's own command otherwise. */
  command?: string;
}

/** What a run gave: the launch's result, which `started` says whether the tool's process started (#1176). */
export type LocalToolResult = StepLaunchResult;

export interface LocalToolAdapter {
  run(tool: LaunchTool, input: LocalToolRun, signal?: AbortSignal): Promise<LocalToolResult>;
  /** Opens a foreground tool for a person, with an optional structured result. */
  runInteractive(tool: LaunchTool, input: LocalToolRun, signal?: AbortSignal): Promise<LocalToolResult>;
}

export type ToolSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type ToolResolve = (command: string) => string | null;

/**
 * The whole prompt a runtime that launches agents its own way gets: the agent definition's instructions, which it has
 * no flag to pass, the step's prompt, and the instruction to write the result file.
 */
export function agentPrompt(input: LocalToolRun): string {
  return stepPrompt({ ...input, expected: expectedOutput(input.output) }, { inPrompt: true });
}

/** What the launch reads from this machine. */
const HOST: StepLaunchHost = { opencodeMajor: opencodeMajorVersion, agyGatewayEnv, writeResult: AttemptResult.write };

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
 * The adapter over `launcher`: it finds the tool's executable, then runs the step's launch through `launcher`, whatever
 * starts its process. `resolveTool` finds the executable, and `resolveInstanceCommand` a tool instance's command, or says it is missing.
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

      // `command` is resolved above; the launch ignores it.
      const { budget, timeoutMs, idleTimeoutMs, output, launch: launched, ...run } = input;

      return runStepLaunch({
        tool: { name: tool, family: launchAdapterIdOf(tool), step: launchAdapterOf(tool).step, executable },
        input: { ...run, expected: expectedOutput(output), ...(launched && { launchEnv: launchEnv(launched) }) },
        start: launcher,
        limits: { budget, timeoutMs, idleTimeoutMs },
        signal,
        interactive,
        host: HOST,
      });
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
