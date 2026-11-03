import { z } from 'zod';
import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import { answered, failed, jsonLines, readClaudeResult, readPlainReply, reportedTokens, type CallOutput, type CallReading, type LaunchAdapter } from '@teamai/tool-core/launch';
import { agyRun, readToolMetadata } from '@teamai/tool-core/stdout';

const OpenCodeEvent = z.union([
  z.object({ type: z.literal('text'), part: z.object({ text: z.string() }) }),
  z.object({ type: z.literal('error'), error: z.object({ message: z.string() }) }),
]);

/** OpenCode prints the answer as `text` parts and an error as an `error` event; `step_finish` carries the tokens. */
function readOpenCodeRun({ stdout }: CallOutput): CallReading {
  const events = jsonLines(stdout).flatMap((line) => {
    const parsed = OpenCodeEvent.safeParse(line);

    return parsed.success ? [parsed.data] : [];
  });

  const error = events.flatMap((event) => event.type === 'error' ? [event.error.message] : []).at(-1);
  const text = events.flatMap((event) => event.type === 'text' ? [event.part.text] : []).join('\n').trim();

  if (error !== undefined || !text) return failed(error);

  return answered(text, readToolMetadata(stdout)?.tokens);
}

const OpenClawEnvelope = z.object({
  ok: z.boolean(),
  final: z.string().optional(),
  usage: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
  error: z.object({ message: z.string() }).optional(),
});

/** `openclaw agent exec --json` prints one envelope: `final` is the answer, `usage` the tokens, `error` the failure. */
function readOpenClawExec({ stdout }: CallOutput): CallReading {
  let candidate: unknown;

  try { candidate = JSON.parse(stdout.trim()); } catch { candidate = jsonLines(stdout).at(-1); }

  const parsed = OpenClawEnvelope.safeParse(candidate);

  if (!parsed.success) return { ok: false };
  const { ok, final, usage, error } = parsed.data;

  if (!ok || !final?.trim()) return failed(error?.message);

  return answered(final.trim(), reportedTokens({ input: usage?.input, output: usage?.output }));
}

const PiReply = z.object({
  type: z.literal('message_end'),
  message: z.object({
    role: z.literal('assistant'),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    usage: z.object({ input: z.number(), output: z.number(), cacheRead: z.number() }).partial().optional(),
    stopReason: z.string().optional(),
    errorMessage: z.string().optional(),
  }),
});

/** pi and omp print the turn's events; the assistant's `message_end` carries the reply, its usage and any error. */
function readPiJson({ stdout }: CallOutput): CallReading {
  const reply = jsonLines(stdout).flatMap((line) => {
    const parsed = PiReply.safeParse(line);

    return parsed.success ? [parsed.data.message] : [];
  }).at(-1);

  if (!reply) return { ok: false };

  // pi exits 0 on a provider error; the reply's stop reason says it failed.
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') return failed(reply.errorMessage || undefined);
  const text = reply.content.flatMap((part) => part.type === 'text' && part.text !== undefined ? [part.text] : []).join('\n').trim();

  if (!text) return { ok: false };
  const { usage } = reply;

  return answered(text, reportedTokens({ input: usage?.input, output: usage?.output, cachedInput: usage?.cacheRead }));
}

const MuseRecord = z.object({ payload_type: z.string(), payload: z.record(z.string(), z.unknown()) });
const MuseTerminal = z.object({ terminal: z.string(), text: z.string().nullable().optional(), reason: z.string().nullable().optional() });
const MuseUsage = z.object({ models: z.array(z.object({ input_tokens: z.number(), cached_tokens: z.number(), output_tokens: z.number() }).partial()) });

/** `muse exec --json` prints one record per event: the run's terminal record carries the answer, `run.usage` the tokens. */
function readMuseExec({ stdout }: CallOutput): CallReading {
  const records = jsonLines(stdout).flatMap((line) => {
    const parsed = MuseRecord.safeParse(line);

    return parsed.success ? [parsed.data] : [];
  });

  const terminal = records.flatMap((record) => {
    const parsed = record.payload_type.startsWith('run.terminal.') ? MuseTerminal.safeParse(record.payload) : undefined;

    return parsed?.success ? [parsed.data] : [];
  }).at(-1);

  if (!terminal) return { ok: false };
  const text = terminal.text?.trim();

  if (terminal.terminal !== 'completed' || !text) return failed(terminal.reason || undefined);

  const models = records.flatMap((record) => {
    const parsed = record.payload_type === 'run.usage' ? MuseUsage.safeParse(record.payload) : undefined;

    return parsed?.success ? parsed.data.models : [];
  });

  const sum = (key: 'input_tokens' | 'cached_tokens' | 'output_tokens') => models.some((model) => model[key] !== undefined) ? models.reduce((total, model) => total + (model[key] ?? 0), 0) : undefined;

  return answered(text, reportedTokens({ input: sum('input_tokens'), output: sum('output_tokens'), cachedInput: sum('cached_tokens') }));
}

/** agy's stream-json output ends with a `result` event: the response on SUCCESS, else the error, and the turn's usage. */
function readAgyStream({ stdout }: CallOutput): CallReading {
  const { result, tokens } = agyRun(stdout);

  if (!result) return { ok: false };
  const text = result.response?.trim();

  if (result.status !== 'SUCCESS' || !text) return failed(result.error || undefined);

  return answered(text, tokens);
}

/** How teamai launches each family of tools headless. A tool picks its adapter with the `launch` facet in `TOOLS`. */
// oxlint-disable-next-line teamai/tool-facts -- keyed by launch adapter id, which this table defines; a tool picks one with TOOLS.launch
export const LAUNCH_ADAPTERS = {
  claude: BUILT_IN_TOOLS.claude.launch.claude,
  codex: BUILT_IN_TOOLS.codex.launch.codex,
  opencode: {
    call: { evidence: 'verified', prompt: 'stdin', args: () => ['run', '--format', 'json'], read: readOpenCodeRun },
    // `opencode run --help` of 2.1.2 and opencode.ai/docs/permissions: approves every request a rule does not deny.
    step: { evidence: 'verified', unattended: { args: ['--auto'], evidence: 'docs' } },
    confined: { evidence: 'verified', env: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OPENCODE_API_KEY'], verified: /^opencode v2\.1\.2$/, access: 'read' },
  },
  codebuddy: {
    call: { evidence: 'docs', prompt: 'stdin', args: () => ['-p', '--output-format', 'json'], read: readClaudeResult },
    // Claude's flags and stream, without --effort. Its unattended mode is codebuddy.ai/docs/cli/permission-modes.
    step: { evidence: 'docs', unattended: { args: ['--permission-mode', 'bypassPermissions'], evidence: 'docs' } },
    // CodeBuddy lists about 70 tools whatever `--tools` says.
    confined: { evidence: 'docs', env: ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_CONFIG_DIR'], homeEnv: 'CODEBUDDY_CONFIG_DIR', access: 'full' },
  },
  // One embedded turn with ephemeral state, so no call leaves a session in the member's conversations (#1308):
  // after calls on OpenClaw 2026.8.1 (the first with `agent exec`) and 2026.10.9, `openclaw sessions --all-agents --json` counts 0.
  openclaw: {
    call: { evidence: 'verified', prompt: 'stdin', args: () => ['agent', 'exec', '--json', '--message-file', '-'], read: readOpenClawExec },
  },
  cursor: {
    executable: 'cursor-agent',
    // Ask mode answers without editing.
    call: { evidence: 'docs', prompt: 'stdin', args: () => ['-p', '--output-format', 'json', '--mode', 'ask', '--trust'], read: readClaudeResult },
    confined: { evidence: 'docs', env: ['CURSOR_API_KEY', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR'], access: 'full' },
  },
  // `-s` prints only the reply. Copilot 0.0.x has no JSON output to read tokens from.
  copilot: {
    call: { evidence: 'docs', prompt: 'argv', args: ({ prompt }) => ['-p', prompt, '-s'], read: readPlainReply },
  },
  pi: {
    call: { evidence: 'source', prompt: 'stdin', args: () => ['-p', '--mode', 'json', '--no-session'], read: readPiJson },
    confined: {
      evidence: 'docs',
      env: ['PI_CODING_AGENT_DIR', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY'],
      homeEnv: 'PI_CODING_AGENT_DIR',
      access: 'full',
    },
  },
  // pi's fork: the same call and events, with flags of its own elsewhere.
  omp: {
    call: { evidence: 'docs', prompt: 'stdin', args: () => ['-p', '--mode', 'json', '--no-session'], read: readPiJson },
  },
  // muse reads no prompt from stdin: `--prompt-file` takes a regular file only.
  muse: {
    call: { evidence: 'verified', prompt: 'file', args: ({ promptFile }) => ['exec', '--json', '--no-session-log', '--prompt-file', promptFile], read: readMuseExec },
  },
  qoder: BUILT_IN_TOOLS.qoder.launch.qoder,
  kiro: {
    executable: 'kiro-cli',
    call: { evidence: 'docs', prompt: 'argv', args: ({ prompt }) => ['chat', '--no-interactive', prompt], read: readPlainReply },
  },
  hermes: {
    call: { evidence: 'source', prompt: 'argv', args: ({ prompt }) => ['-z', prompt], read: readPlainReply },
  },
  // agy reads stdin only as stream-json user events. `--print=` is print mode with the prompt left to them; a bare
  // `-p` would take the next flag as its prompt.
  agy: {
    // `agy --help` of 1.4.10.
    step: { evidence: 'verified', unattended: { args: ['--dangerously-skip-permissions'], evidence: 'docs' } },
    // Plan mode with the sandbox reads files but runs no shell and writes nothing in the workspace (agy 1.4.10).
    confined: { evidence: 'verified', env: ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL'], access: 'read' },
    call: {
      evidence: 'verified',
      prompt: 'stdin',
      stdinOf: (prompt) => `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`,
      args: () => ['--input-format=stream-json', '--output-format=stream-json', '--print='],
      read: readAgyStream,
    },
  },
} as const satisfies Record<string, LaunchAdapter>;

export type LaunchAdapterId = keyof typeof LAUNCH_ADAPTERS;
