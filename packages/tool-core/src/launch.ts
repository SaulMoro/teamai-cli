import { z } from 'zod';
import type { Evidence } from './definition.js';
import { JsonValueSchema, type JsonValue } from './json.js';
import type { TokenUsage } from './stdout.js';

/** What a tool run confined can do beyond answering: nothing, read its directory, or whatever its tool allows. */
export const ACCESS_LEVELS = ['answer', 'read', 'full'] as const;

export type ConfinedAccess = (typeof ACCESS_LEVELS)[number];

/** The level a confined run reaches. `verified`: the tool's confined profile is known to keep it to its directory on this machine. */
export const CONFINED_LEVELS = ['best-effort', 'verified'] as const;

export type ConfinedLevel = (typeof CONFINED_LEVELS)[number];

/** What a headless call printed: its answer and the session it ran in, or the error the tool reported, when it reported one. */
export type CallReading = { ok: true; text: string; tokens?: TokenUsage; session?: string } | { ok: false; message?: string };

/** What a finished call left: its stdout, and the last message it wrote to the file `args` named, if it wrote one. */
export interface CallOutput {
  stdout: string;
  lastMessage: string | undefined;
}

/** What a call's arguments may name: the prompt, and fresh paths in a scratch directory for its prompt and last message. */
export interface CallInput {
  prompt: string;
  /** Holds the prompt when the profile takes it from a file. */
  promptFile: string;
  /** For a tool that writes its last message to a file. */
  lastMessageFile: string;
}

/** How an adapter runs a prompt headless and reads the answer back. */
export interface CallLaunch {
  readonly evidence: Evidence;
  /** How the prompt reaches the tool: on stdin, in `promptFile`, or as an argument `args` places. */
  readonly prompt: 'stdin' | 'file' | 'argv';
  /** What goes on stdin for a `stdin` prompt, when the tool takes it wrapped rather than as is. */
  stdinOf?(prompt: string): string;
  args(input: CallInput): string[];
  read(output: CallOutput): CallReading;
  /** The arguments, after `args`, that continue the session a call ran in, for a tool that keeps it and reports its id. */
  readonly resume?: { readonly evidence: Evidence; args(session: string): string[] };
  /**
   * That the call prints as it works, which an idle limit needs: `args` stream already, or `streams.args` run a call
   * that does, whose output `read` reads too. Absent: it prints only once it ends, so an idle limit would stop it while
   * it works, and none applies.
   */
  readonly streams?: { readonly evidence: Evidence; args?(input: CallInput): string[] };
}

/**
 * The tool's own mode for editing and running commands without asking, which a step with `permissions: unattended`
 * runs in: its arguments, and what they were checked against. `'none'`: teamai knows no such mode, so it launches no
 * such step on the tool.
 */
export type UnattendedLaunch = { readonly args: readonly string[]; readonly evidence: Evidence } | 'none';

/** A workflow step: a session the adapter starts and resumes, in `local-tool-adapter.ts`. */
export interface StepLaunch {
  readonly evidence: Evidence;
  readonly unattended: UnattendedLaunch;
}

/** A run confined to one directory, in `src/tool-launch/confined.ts`: what judges a scorer. */
export interface ConfinedLaunch {
  readonly evidence: Evidence;
  /** The member's variables the run keeps, beyond the common ones. */
  readonly env: readonly string[];
  /** The variable the tool reads its home from. A run started outside the member's shell, as background scoring is, gets the recorded one. */
  readonly homeEnv?: string;
  /** The versions whose confinement has been checked; any other version runs at best-effort. */
  readonly verified?: RegExp;
  /** What the run can do beyond answering. */
  readonly access: ConfinedAccess;
}

/** A tool's gateway variables: `url`, its base URL, and `token`, what signs the tool in to it. */
export interface GatewayVariables {
  readonly url: string;
  readonly token: string;
}

/**
 * The environment variables a tool signs in with (`variables`), and those that go with a sign-in (`alongside`). teamai
 * finds them by name in the member's environment and gives each tool only its own; a step runtime that checks whether
 * a tool can sign in reads the same names.
 */
export interface SignInVariables {
  readonly variables: readonly string[];
  readonly alongside?: readonly string[];
  /** The variable that points the tool at a model gateway, and the one that holds the token it signs in to it with. */
  readonly gateway?: GatewayVariables;
}

export interface LaunchAdapter {
  /** The command that starts the tool, when it is not the tool's id. */
  readonly executable?: string;
  /** The variables the tool signs in with, for a tool a step runtime launches with the member's sign-in. */
  readonly signIn?: SignInVariables;
  readonly call: CallLaunch;
  readonly step?: StepLaunch;
  readonly confined?: ConfinedLaunch;
}

export function jsonLines(stdout: string): JsonValue[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();

    if (!trimmed.startsWith('{')) return [];

    try {
      const value = JsonValueSchema.safeParse(JSON.parse(trimmed));

      return value.success ? [value.data] : [];
    } catch { return []; }
  });
}

/** A call that gave no answer, with the reason the tool reported when it reported one. */
export function failed(message: string | undefined): CallReading {
  return message === undefined ? { ok: false } : { ok: false, message };
}

/** A call's answer, with the tokens it billed and the session it ran in when the tool reported them. */
export function answered(text: string, tokens: TokenUsage | undefined, session?: string): CallReading {
  const reading: CallReading = { ok: true, text };

  if (tokens !== undefined) reading.tokens = tokens;

  if (session !== undefined) reading.session = session;

  return reading;
}

/** The counts a tool reported, or undefined when it reported none. */
export function reportedTokens(counts: TokenUsage): TokenUsage | undefined {
  const tokens: TokenUsage = {};

  if (counts.input !== undefined) tokens.input = counts.input;

  if (counts.output !== undefined) tokens.output = counts.output;

  if (counts.cachedInput !== undefined) tokens.cachedInput = counts.cachedInput;

  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

const ClaudeResult = z.object({
  type: z.literal('result'),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  session_id: z.string().optional(),
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_input_tokens: z.number().optional() }).partial().optional(),
});

/** Claude's `--output-format json` result record, which CodeBuddy prints too. */
export function readClaudeResult({ stdout }: CallOutput): CallReading {
  const record = jsonLines(stdout).flatMap((line) => {
    const parsed = ClaudeResult.safeParse(line);

    return parsed.success ? [parsed.data] : [];
  }).at(-1);

  if (!record) return { ok: false };

  // An error exits 1 with the reason in `result`; stderr carries only a tag such as `[claude-code:unrecognized_model]`.
  // An end with no reason, as on the turn limit, is named by its subtype.
  if (record.is_error || record.result === undefined) return failed(record.result || (record.subtype === undefined ? undefined : `it ended with ${record.subtype}`));
  const usage = record.usage;

  return answered(record.result.trim(), reportedTokens({ input: usage?.input_tokens, output: usage?.output_tokens, cachedInput: usage?.cache_read_input_tokens }), record.session_id);
}

/** A tool that prints only its reply, as plain text. */
export function readPlainReply({ stdout }: CallOutput): CallReading {
  const text = stdout.trim();

  return text ? { ok: true, text } : { ok: false };
}
