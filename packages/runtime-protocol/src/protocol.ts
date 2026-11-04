import { getUserHome } from '@teamai/tool-core/home';
import type { TokenUsage } from '@teamai/tool-core/stdout';
import { z } from 'zod';

// ─── Runtime protocol 1 ──────────────────────────────────
//
//  JSON lines over stdio between teamai and a step runtime. teamai writes one request per line to the runtime's stdin;
//  the runtime writes replies and events to its stdout. Every operation is accepted first and ends later, under an id
//  teamai persists before it sends the request, and a runtime answers a repeated id with the same acceptance and the
//  same terminal outcome until `close`. Both sides parse with the schemas below.
//
//    > {"type":"init","protocol":1,"mode":"unattended","options":{...}}
//    < {"type":"init","ok":true,"can":{...},"prompt":true}           prompt: it launches agents its own way
//    > {"type":"open","op":"op-7f2a…","run":"r…","attempt":"a…","view":{...},"credentials":{}}
//    < {"op":"op-7f2a…","event":"accepted","handle":"toy-r…-a…"}
//    < {"op":"op-7f2a…","event":"ready","display":{"label":"…","url":"…","fields":{…}}}       display optional
//    > {"type":"exec","op":"op-8b10…","handle":"…","argv":[...],"env":{...},"unset":[...],"credentials":{...},"cwd":"…"}
//    < {"op":"op-8b10…","event":"accepted"}
//    < {"op":"op-8b10…","event":"output","stream":"stdout","data":"…"}
//    < {"op":"op-8b10…","event":"exited","code":0,"stdout":"…complete stdout…"}
//    > {"type":"prompt","op":"op-91c4…","handle":"…","lease":{...},"env":{...},"unset":[...],"credentials":{...},"cwd":"…"}
//    < {"op":"op-91c4…","event":"accepted","display":{"label":"…","url":"…"}}      display optional: once the agent exists
//    < {"op":"op-91c4…","event":"finished","session":{"tool":"claude","id":"…"},"result":{"output":{…}},"usage":{…}}
//    > {"type":"collect","handle":"…"}              < {"event":"collected","handle":"…"}
//    > {"type":"reattach","handle":"…"}             < {"event":"alive","handle":"…","ops":[...]} or {"event":"gone",…}
//    > {"type":"close","handle":"…"}                < {"event":"closed","handle":"…"} or {"event":"close_failed","handle":"…","failure":{…}}
//    > {"type":"cancel","op":"op-8b10…"}            the operation then ends {"op":"op-8b10…","event":"cancelled"}
//
//  `max_parallel` and `credentials` in a driver definition's options are teamai's: it strips them before `init`, so a
//  runtime never sees or validates them. The credential values travel only in requests, in memory: on `open` for the
//  attempt, and on each `exec` and `prompt` that gets them, so a runtime that restarted holds none and needs none.
//

export const RUNTIME_PROTOCOL = 1;

/** Whether a person is there for the run: `attended` where one launched it, `unattended` in CI or a cloud agent. */
export const RUNTIME_MODES = ['attended', 'unattended'] as const;

/** An operation id: what teamai persists before it sends an `open`, an `exec` or a `prompt`. */
export const OpIdSchema = z.string().regex(/^op-[0-9a-f]{8,32}$/, 'An operation id looks like op- followed by hex digits').brand<'OpId'>();

export type OpId = z.infer<typeof OpIdSchema>;

/** A runtime's id for one opened place, which teamai persists to reconnect after a restart. */
export const RuntimeHandleSchema = z.string().min(1).max(256);

const EnvSchema = z.record(z.string(), z.string());

/**
 * The credentials an operation gets, by name, with their values: what the definition declares for the runtime, sent
 * only to the processes that need them (a prompt's tool, never a command step), less any name the step withholds. A
 * runtime sets them over the process's environment, and never writes their values to disk or to a log. Absent from a
 * teamai before protocol 1 carried them, which a runtime reads as none.
 */
const CredentialsSchema = EnvSchema.default({});

/** A runtime's options, as a driver definition gives them; the runtime validates them at `init`. */
export const RuntimeOptionsSchema = z.record(z.string(), z.json());

export type RuntimeOptions = z.infer<typeof RuntimeOptionsSchema>;

/**
 * What a runtime may touch for one attempt: the worktree read-write at its host path, the git paths read-only, the
 * attempt's result directory read-write, and the attempt's tool home under the variable its tool reads.
 */
export const PlaceViewSchema = z.object({
  worktree: z.string(),
  readonly: z.array(z.string()),
  result: z.string(),
  toolHome: z.record(z.string(), z.string()),
});

export type PlaceView = z.infer<typeof PlaceViewSchema>;

/** Why a runtime could not do what it was asked. `key` names a bad option. */
export const RuntimeFailureSchema = z.object({ code: z.string().min(1), message: z.string(), key: z.string().optional() });

export type RuntimeFailure = z.infer<typeof RuntimeFailureSchema>;

/** A scheme a display link may use: the web, or an app's own (`t3:`, `vscode:`), never one that runs or reads in the page. */
const DISPLAY_LINK = /^(?!(?:javascript|data|file|vbscript|blob):)[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/** Whether a text of a display names a path in the member's home. */
function inHome(text: string): boolean {
  const home = getUserHome();

  return home !== '/' && text.includes(home);
}

/**
 * What a runtime shows of an attempt's place in the run's details: a label, a link to open it, and up to 8 facts. A
 * runtime never puts a secret or a path in the member's home in it; one that names such a path is not shown.
 */
export const RuntimeDisplaySchema = z.object({
  label: z.string().min(1).max(80),
  url: z.string().max(2048).regex(DISPLAY_LINK, 'A display url is http(s) or an app scheme').optional(),
  fields: z.record(z.string().min(1).max(40), z.string().max(200))
    .refine((fields) => Object.keys(fields).length <= 8, 'A display holds at most 8 fields').optional(),
}).strict().refine((display) => ![display.label, display.url ?? '', ...Object.entries(display.fields ?? {}).flat()].some(inHome), 'A display names no path in the member\'s home');

export type RuntimeDisplay = z.infer<typeof RuntimeDisplaySchema>;

/** A tool's session: the tool that keeps it, and its id there, which a later pass resumes and scoring reads. */
export const PromptSessionSchema = z.object({ tool: z.string().min(1), id: z.string().min(1) });

/** The tokens a prompt billed, as far as the runtime knows them. */
export const PromptUsageSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cachedInput: z.number().nonnegative().optional(),
}).strict() satisfies z.ZodType<TokenUsage>;

/** The workflow result the agent wrote to the lease's `result` file: its output, or a failure with a code and a message. */
export const PromptResultSchema = z.object({ output: z.unknown().optional(), failure: z.object({ code: z.string(), message: z.string() }).optional() });

export type PromptResult = z.infer<typeof PromptResultSchema>;

/**
 * One prompt step as a runtime that launches agents its own way runs it. `prompt` is teamai's whole prompt, the
 * instruction to write `result` included, and the agent definition's instructions when the step names one.
 */
export const PromptLeaseSchema = z.object({
  step: z.string().min(1),
  tool: z.string().min(1),
  /** The exact model and effort to launch on; the tool's own default when absent. */
  model: z.object({ name: z.string().min(1), effort: z.string().min(1).optional() }).optional(),
  prompt: z.string(),
  /** The file the agent writes the workflow result to, in the place's result directory. */
  result: z.string().min(1),
  /** A session of the same tool to continue. */
  resume: z.string().min(1).optional(),
  /** `unattended`: the tool's mode for editing and running commands without asking; never granted otherwise. */
  permissions: z.enum(['approval-required', 'unattended']),
  /** A person works in the step: the runtime gives them the agent, and the step ends once they are done. */
  interactive: z.boolean(),
  /** The most agent turns the tool may take, when the runtime's offer says it caps them (`can.max_turns`). */
  maxTurns: z.number().int().positive().optional(),
});

export type PromptLease = z.infer<typeof PromptLeaseSchema>;

const InitRequestSchema = z.object({ type: z.literal('init'), protocol: z.literal(RUNTIME_PROTOCOL), mode: z.enum(RUNTIME_MODES), options: RuntimeOptionsSchema });

export const OpenRequestSchema = z.object({
  type: z.literal('open'),
  op: OpIdSchema,
  run: z.string(),
  attempt: z.string(),
  view: PlaceViewSchema,
  /**
   * The credentials of this attempt's tool, as each of its execs and prompts also carries them: never set when the
   * place is created, only per operation. A command step's place gets none.
   */
  credentials: EnvSchema,
});

export const ExecRequestSchema = z.object({
  type: z.literal('exec'),
  op: OpIdSchema,
  handle: RuntimeHandleSchema,
  argv: z.array(z.string()).min(1),
  /** The names the process gets set over the runtime's own environment. */
  env: EnvSchema,
  /** The names the process must not inherit from the runtime's own environment, such as the forge variables a strict step withholds. */
  unset: z.array(z.string()),
  /** The credentials this process gets over its environment: a prompt's tool gets the attempt's, a command none. */
  credentials: CredentialsSchema,
  cwd: z.string(),
});

/** A prompt for a runtime that launches agents its own way; `env` and `unset` scope the agent's environment as an exec's. */
export const PromptRequestSchema = z.object({
  type: z.literal('prompt'),
  op: OpIdSchema,
  handle: RuntimeHandleSchema,
  lease: PromptLeaseSchema,
  env: EnvSchema,
  unset: z.array(z.string()),
  /** The credentials the agent gets over its environment. */
  credentials: CredentialsSchema,
  cwd: z.string(),
});

/** A request teamai writes to a runtime's stdin. */
export const RuntimeRequestSchema = z.discriminatedUnion('type', [
  InitRequestSchema,
  OpenRequestSchema,
  ExecRequestSchema,
  PromptRequestSchema,
  z.object({ type: z.literal('cancel'), op: OpIdSchema }),
  z.object({ type: z.enum(['collect', 'reattach', 'close']), handle: RuntimeHandleSchema }),
]);

export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;

/**
 * The codes a failed prompt may carry that teamai records on the step as they are: the tool or model the lease names
 * is not there, or the tool failed. teamai records any other code as `runtime_failed`, naming it in the message.
 */
export const PROMPT_FAILURE_CODES = ['model_unavailable', 'tool_unavailable', 'agent_unavailable', 'tool_failed'] as const;

/** The fields of a finished prompt: the tool's session, the result the agent wrote, and the tokens it billed. */
const finishedPrompt = { session: PromptSessionSchema, result: PromptResultSchema, usage: PromptUsageSchema.optional() };

/** What a runtime retains of one operation of a handle, which `reattach` reports. */
export const OpStateSchema = z.discriminatedUnion('state', [
  z.object({ op: OpIdSchema, state: z.literal('running') }),
  z.object({ op: OpIdSchema, state: z.literal('exited'), code: z.number().int(), stdout: z.string() }),
  z.object({ op: OpIdSchema, state: z.literal('finished'), ...finishedPrompt }),
  z.object({ op: OpIdSchema, state: z.literal('cancelled') }),
  z.object({ op: OpIdSchema, state: z.literal('failed'), failure: RuntimeFailureSchema }),
]);

export type OpState = z.infer<typeof OpStateSchema>;

/**
 * The lines a runtime writes, with `display` (on `ready`, on an exec's or prompt's `accepted`, and on `alive`) and the init reply's `can` read by the schemas
 * given. A runtime checks what it writes against `RuntimeMessageSchema`; teamai reads a display apart from its event,
 * so a runtime that gets it wrong loses only its display, and reads `can` as its own driver offer.
 */
export function runtimeMessageSchemas<TDisplay extends z.ZodType, TCan extends z.ZodType>({ display, can }: { display: TDisplay; can: TCan }) {
  /**
   * A reply to `init`: the runtime's offer, or why it cannot run with the options it was given. `prompt: true` says it
   * launches agents its own way, so teamai sends it each prompt step as a `prompt`, never as an `exec` of the tool.
   * With `can.exec: false` it runs no command: command steps, and steps with setup, go to the next runtime.
   */
  const InitReply = z.discriminatedUnion('ok', [
    z.object({ type: z.literal('init'), ok: z.literal(true), can, prompt: z.boolean().optional() }),
    z.object({ type: z.literal('init'), ok: z.literal(false), error: RuntimeFailureSchema }),
  ]);

  const OpEvent = z.discriminatedUnion('event', [
    /** `display` on an exec's or prompt's acceptance: what the runtime shows once that operation exists, such as an agent's thread. */
    z.object({ op: OpIdSchema, event: z.literal('accepted'), handle: RuntimeHandleSchema.optional(), display }),
    z.object({ op: OpIdSchema, event: z.literal('ready'), display }),
    z.object({ op: OpIdSchema, event: z.literal('failed'), failure: RuntimeFailureSchema }),
    z.object({ op: OpIdSchema, event: z.literal('output'), stream: z.enum(['stdout', 'stderr']), data: z.string() }),
    z.object({ op: OpIdSchema, event: z.literal('exited'), code: z.number().int(), stdout: z.string() }),
    z.object({ op: OpIdSchema, event: z.literal('finished'), ...finishedPrompt }),
    z.object({ op: OpIdSchema, event: z.literal('cancelled') }),
  ]);

  const HandleEvent = z.discriminatedUnion('event', [
    z.object({ event: z.literal('collected'), handle: RuntimeHandleSchema }),
    z.object({ event: z.literal('collect_failed'), handle: RuntimeHandleSchema, failure: RuntimeFailureSchema }),
    z.object({ event: z.literal('alive'), handle: RuntimeHandleSchema, ops: z.array(OpStateSchema), display }),
    z.object({ event: z.literal('gone'), handle: RuntimeHandleSchema }),
    z.object({ event: z.literal('closed'), handle: RuntimeHandleSchema }),
    /** The runtime could not end the place, so what it started there may still run. */
    z.object({ event: z.literal('close_failed'), handle: RuntimeHandleSchema, failure: RuntimeFailureSchema }),
  ]);

  return { OpEvent, HandleEvent, Message: z.union([InitReply, OpEvent, HandleEvent, z.object({ event: z.literal('error'), message: z.string() })]) };
}

/** What a runtime may write, display and offer included: a check for its own output. */
export const RuntimeMessageSchema = runtimeMessageSchemas({ display: RuntimeDisplaySchema.optional(), can: z.record(z.string(), z.unknown()) }).Message;

export type RuntimeMessage = z.infer<typeof RuntimeMessageSchema>;
