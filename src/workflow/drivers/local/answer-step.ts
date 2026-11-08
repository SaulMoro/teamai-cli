/**
 * An answer step on the local driver: the member's AI tool answers the lease's prompt on the one-shot launch every AI
 * call takes, in the managed read-only checkout, and the step reports the reply as text or as the JSON its output declares.
 */
import { CallError, type CallErrorKind } from '../../../tool-launch/member-tools.js';
import { createToolCaller, type CallOptions, type ToolCallerDeps } from '../../../tool-launch/call.js';
import { JsonValueSchema, type JsonValue, type LocalConfig } from '../../../types.js';
import type { ReportInput } from '../../engine.js';
import { expectedOutput, outputMismatch } from '../../output.js';
import type { z } from 'zod';
import type { OutputSchema, WorkflowFailure } from '../../types.js';

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

/** The values the step's output takes, so a reply holding some other JSON is asked for again. */
function replySchema(output: OutputSchema | undefined): z.ZodType<JsonValue> {
  return output === undefined ? JsonValueSchema : JsonValueSchema.refine((value) => outputMismatch(output, value) === null);
}

const FAILURE_OF = {
  no_tool: 'tool_unavailable',
  override_invalid: 'tool_unconfigured',
  call_failed: 'tool_failed',
} as const satisfies Record<CallErrorKind, WorkflowFailure['code']>;

function failed(failure: WorkflowFailure): AnswerReport {
  return { outcome: 'failed', message: failure.message, failure };
}

/**
 * Answers `prompt` on the member's AI tool, the one `TEAMAI_AI_TOOL`, then `ai.tool`, names, else the first installed,
 * in `cwd`. It ends by `expiresAt` or when `signal` aborts, which a cancelled lease does.
 */
export async function runAnswerStep({ config, prompt, output, cwd, expiresAt, signal, resolveTool }: {
  config: LocalConfig;
  prompt: string;
  output: OutputSchema | undefined;
  cwd: string;
  expiresAt: string | undefined;
  signal: AbortSignal;
  resolveTool?: ToolCallerDeps['resolveTool'];
}): Promise<AnswerReport> {
  const caller = createToolCaller(resolveTool ? { resolveTool } : {});
  const options: CallOptions = { launchedBy: 'answer', scope: config, cwd, signal };

  // The lease expires at the step's timeout, which the call then keeps.
  if (expiresAt !== undefined) options.timeout = Math.max(1, Date.parse(expiresAt) - Date.now());
  const started = performance.now();

  try {
    if (takesText(output)) {
      const { text, tool, tokens } = await caller.callTool(promptOf(prompt, output), options);

      return { outcome: 'success', tool, durationMs: Math.round(performance.now() - started), ...(tokens && { tokens }), outputs: { text: text.trim() } };
    }

    // A reply that holds no value the output takes is asked for once more, in the same session, within the timeout.
    const { text, tool, tokens, reply } = await caller.callForReply(promptOf(prompt, output), replySchema(output), { ...options, retries: 1 });
    const ran: AnswerReport = { outcome: 'success', tool, durationMs: Math.round(performance.now() - started), ...(tokens && { tokens }) };

    if (reply === undefined) {
      return { ...ran, ...failed({ code: 'invalid_output', message: `${tool} replied with no JSON value this step's output takes, even when asked again: ${text.trim().slice(0, 200)}` }) };
    }

    return { ...ran, outputs: reply };
  } catch (cause) {
    if (cause instanceof CallError) return failed({ code: FAILURE_OF[cause.kind], message: cause.message });
    throw cause;
  }
}
