import { spawn } from 'node:child_process';
import { z } from 'zod';
import { stopProcess } from '@teamai/shared/process-group';
import type { DriverCan } from '../requirements.js';
import { boundedStdout, type OpId, type OpState } from '@teamai/runtime-protocol';
import type { ExecEnd, Lost, StepRuntime } from '@teamai/runtime-protocol/step-runtime';
import { CallError, type CallErrorKind } from '../member-tools.js';
import { JsonValueSchema, type JsonValue, type LocalConfig } from '../../types.js';
import type { ReportInput } from '../engine.js';
import { idleLimit } from '../limits.js';
import { expectedOutput, outputMismatch } from '../output.js';
import type { OutputSchema, WorkflowFailure } from '../types.js';
import { createToolCaller, type CallOptions, type ToolCallerDeps } from './tool-caller.js';

export type AnswerReport = Pick<ReportInput, 'outcome' | 'outputs' | 'tool' | 'tokens' | 'durationMs' | 'message' | 'failure'>;

/** Whether the step takes its reply as text: its output is `{ text: string }`. */
function takesText(output: OutputSchema | undefined): boolean {
  if (output?.type !== 'object') return false;
  const fields = Object.entries(output.fields);

  return fields.length === 1 && fields[0][0] === 'text' && fields[0][1].type === 'string';
}

/** The prompt the tool answers: the step's, and for a JSON output, what the reply must be. */
function promptOf(prompt: string, output: OutputSchema | undefined): string {
  return takesText(output) ? prompt : `${prompt}\n\nReply with only a JSON value, with no other text: ${expectedOutput(output)}`;
}

/**
 * The values the step's output takes, so a reply holding some other JSON is asked for again. A list where the output
 * takes none is kept whole, for the step's output check to refuse: its items are choices, not the answer.
 */
function replySchema(output: OutputSchema | undefined): z.ZodType<JsonValue> {
  return output === undefined ? JsonValueSchema : JsonValueSchema.refine((value) => (Array.isArray(value) && output.type !== 'array') || outputMismatch(output, value) === null);
}

const FAILURE_OF = {
  no_tool: 'tool_unavailable',
  override_invalid: 'tool_unconfigured',
  usage_limited: 'usage_limited',
  call_failed: 'tool_failed',
} as const satisfies Record<CallErrorKind, WorkflowFailure['code']>;

function failed(failure: WorkflowFailure): AnswerReport {
  return { outcome: 'failed', message: failure.message, failure };
}

/**
 * The tool an answer step's call runs on now, picked as the call picks it, so a usage limit on that tool holds the step.
 * Undefined when no tool can be picked: the step's call then fails on its own.
 */
export async function answerCallTool({ config, resolveTool }: { config: LocalConfig; resolveTool?: ToolCallerDeps['resolveTool'] }): Promise<string | undefined> {
  try {
    return await createToolCaller(resolveTool ? { resolveTool } : {}).toolFor(config);
  } catch (cause) {
    if (cause instanceof CallError) return undefined;
    throw cause;
  }
}

/** An answer step's lease as the host answers it: the step's question, its output, where and until when it runs. */
export interface AnswerInput {
  config: LocalConfig;
  prompt: string;
  output: OutputSchema | undefined;
  cwd: string;
  expiresAt: string | undefined;
  signal: AbortSignal;
  resolveTool?: ToolCallerDeps['resolveTool'];
}

/**
 * Answers `prompt` on the member's AI tool, the one `TEAMAI_AI_TOOL`, then `ai.tool`, names, else the first installed,
 * in `cwd`, through the tools runtime's answer launch. It ends by `expiresAt` or when `signal` aborts, which a cancelled
 * lease does.
 */
async function answer({ config, prompt, output, cwd, expiresAt, signal, resolveTool }: AnswerInput): Promise<AnswerReport> {
  const caller = createToolCaller(resolveTool ? { resolveTool } : {});
  const options: CallOptions = { launchedBy: 'answer', scope: config, cwd, signal };

  const idle = idleLimit(config);

  if ('failure' in idle) return failed(idle.failure);

  if (idle.ms !== undefined) options.idleTimeout = idle.ms;

  // The lease expires at the step's timeout, which the call then keeps.
  if (expiresAt !== undefined) options.timeout = Math.max(1, Date.parse(expiresAt) - Date.now());
  const started = performance.now();

  try {
    if (takesText(output)) {
      const { text, tool, tokens } = await caller.callTool(promptOf(prompt, output), options);

      return { outcome: 'success', tool, durationMs: Math.round(performance.now() - started), ...(tokens && { tokens }), outputs: { text: text.trim() } };
    }

    // A reply that holds no value the output takes is asked for once more, in the same session, within the timeout.
    const { text, tool, tokens, reply, asked } = await caller.callForReply(promptOf(prompt, output), replySchema(output), { ...options, retries: 1 });
    const ran: AnswerReport = { outcome: 'success', tool, durationMs: Math.round(performance.now() - started), ...(tokens && { tokens }) };

    if (reply === undefined) {
      return { ...ran, ...failed({ code: 'invalid_output', message: `${tool} replied with no JSON value this step's output takes${asked > 1 ? ', even when asked again' : ''}: ${text.trim().slice(0, 200)}` }) };
    }

    return { ...ran, outputs: reply };
  } catch (cause) {
    if (cause instanceof CallError) return { ...failed({ code: FAILURE_OF[cause.kind], message: cause.message }), ...(cause.tool !== undefined && { tool: cause.tool }) };
    throw cause;
  }
}

/** The host runtime: a step runtime, and the answer of an answer step, which only the host slot is leased. */
export interface HostStepRuntime extends StepRuntime<DriverCan> {
  answer(input: AnswerInput): Promise<AnswerReport>;
}

/** How an exec of this runtime ended: never lost, since it runs in teamai's own process. */
type LocalEnd = Exclude<ExecEnd, Lost>;

/** What `reattach` says of an exec this runtime ended. */
function endedState(op: OpId, end: LocalEnd): OpState {
  switch (end.kind) {
    case 'exited':
      return { op, state: 'exited', code: end.code, stdout: end.stdout };
    case 'cancelled':
      return { op, state: 'cancelled', ...(end.stdout !== undefined && { stdout: end.stdout }) };
    case 'failed':
      return { op, state: 'failed', failure: end.failure };
    default: {
      const unhandled: never = end;

      return unhandled;
    }
  }
}

/**
 * The `host` step runtime, in teamai's process: the place is the worktree as it is on the host, and each `exec` runs
 * there in a process group of its own. It retains outcomes for as long as this process lives, so a teamai started
 * again finds every handle `gone`. It takes no options; `can` is what the caller decided this machine offers. An answer
 * step's lease it answers in teamai's process with `answer`, which the wire's prompt lease cannot carry: the step's output.
 */
export function hostStepRuntime(can: DriverCan = {}): HostStepRuntime {
  const handles = new Map<string, string>();
  const ended = new Map<OpId, { handle: string; end: LocalEnd }>();
  const running = new Map<OpId, { handle: string; end: Promise<ExecEnd>; stop: () => Promise<void>; cancelled: boolean }>();
  const detached = process.platform !== 'win32';

  const exec: StepRuntime<DriverCan>['exec'] = async (request, events) => {
    const retained = ended.get(request.op);

    if (retained) {
      events.onAccepted?.({});

      return retained.end;
    }

    const live = running.get(request.op);

    if (live) {
      events.onAccepted?.({});

      return live.end;
    }

    const env: NodeJS.ProcessEnv = { ...process.env, ...request.env, ...request.credentials };

    for (const name of request.unset) delete env[name];
    const [command = '', ...args] = request.argv;
    const child = spawn(command, args, { cwd: request.cwd, env, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';

    const closed = new Promise<{ code: number; error?: Error }>((resolve) => {
      child.on('error', (error) => resolve({ code: 127, error }));
      child.on('close', (code) => resolve({ code: code ?? 1 }));
    });

    child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; events.onOutput?.('stdout', data); });
    child.stderr.setEncoding('utf8').on('data', (data: string) => { events.onOutput?.('stderr', data); });

    const stopGroup = stopProcess(child, closed, detached);

    const entry = {
      handle: request.handle,
      stop: async (): Promise<void> => { await stopGroup(); },
      cancelled: false,
      end: closed.then(({ code, error }): ExecEnd => {
        running.delete(request.op);

        const end: LocalEnd = entry.cancelled ? { kind: 'cancelled' }
          : error ? { kind: 'failed', failure: { code: 'exec_failed', message: `${command} could not be started: ${error.message}` } }
            : { kind: 'exited', code, stdout };

        // Kept within protocol 1's bound for as long as this process lives; the exec's caller gets the whole stdout.
        ended.set(request.op, { handle: request.handle, end: end.kind === 'exited' ? { ...end, stdout: boundedStdout(end.stdout) } : end });

        return end;
      }),
    };

    running.set(request.op, entry);
    events.onAccepted?.({});

    return entry.end;
  };

  const opsOf = (handle: string): OpState[] => [
    ...[...running].flatMap(([op, live]): OpState[] => (live.handle === handle ? [{ op, state: 'running' }] : [])),
    ...[...ended].flatMap(([op, { handle: of, end }]): OpState[] => (of === handle ? [endedState(op, end)] : [])),
  ];

  return {
    name: 'host',

    async init({ options }) {
      const [key] = Object.keys(options);

      return key === undefined ? { ok: true, can, launchesAgents: false } : { ok: false, failure: { code: 'bad_option', key, message: `The host runtime takes no options, and was given "${key}".` } };
    },

    async open(request, onAccepted) {
      const key = `${request.run}/${request.attempt}`;
      const handle = handles.get(key) ?? `host-${request.run}-${request.attempt}`;
      handles.set(key, handle);
      await onAccepted(handle);

      return { kind: 'ready', handle };
    },

    exec,
    answer,

    async prompt() {
      return { kind: 'failed', failure: { code: 'runtime_protocol', message: 'The host runtime runs commands and answers answer steps in teamai\'s process, and launches no prompt\'s tool: the tools runtime does.' } };
    },

    async cancel(op) {
      const live = running.get(op);

      if (!live) return;
      live.cancelled = true;
      await live.stop();
    },

    async collect() {
      return { ok: true };
    },

    async reattach(handle) {
      return [...handles.values()].includes(handle) ? { kind: 'alive', ops: opsOf(handle) } : { kind: 'gone' };
    },

    async close(handle) {
      for (const [key, open] of handles) if (open === handle) handles.delete(key);

      for (const [op, done] of ended) if (done.handle === handle) ended.delete(op);

      return { ok: true };
    },

    async dispose() {},
  };
}
