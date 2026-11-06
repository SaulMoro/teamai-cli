import { getUserHome } from '@teamai/tool-core/home';
import { ACCESS_LEVELS, CONFINED_LEVELS } from '@teamai/tool-core/launch';
import type { TokenUsage } from '@teamai/tool-core/stdout';
import { z } from 'zod';

// ─── Runtime protocol 1 ──────────────────────────────────
//
//  JSON lines over stdio between teamai and a step runtime. teamai writes one request per line to the runtime's stdin;
//  the runtime writes replies and events to its stdout. Every operation is accepted first and ends later, under an id
//  teamai persists before it sends the request, and a runtime answers a repeated id with the same acceptance and the
//  same terminal outcome until `close`. Both sides parse with the schemas below.
//
//    > {"type":"init","protocol":1,"mode":"unattended","options":{...},"credentials":{"env":["ANTHROPIC_API_KEY"],"logins":[]},"instances":[{"name":"acme-claude","tool":"claude","command":"acme-claude"}]}
//    < {"type":"init","ok":true,"can":{...},"prompt":true}           prompt: it launches agents its own way
//                                                                    permissions: {"claude":"full-access"}, the tools it runs without prompts
//                                                                    confinedPrompt: it answers confined prompts, so it may offer can.confined
//    > {"type":"open","op":"op-7f2a…","run":"r…","attempt":"a…","tool":"claude","view":{...},"credentials":{}}   tool: the prompt's, when it has one
//    < {"op":"op-7f2a…","event":"accepted","handle":"toy-r…-a…"}
//    < {"op":"op-7f2a…","event":"ready","display":{"label":"…","url":"…","fields":{…}}}       display optional
//    > {"type":"exec","op":"op-8b10…","handle":"…","argv":[...],"env":{...},"unset":[...],"credentials":{...},"cwd":"…"}
//    < {"op":"op-8b10…","event":"accepted"}
//    < {"op":"op-8b10…","event":"output","stream":"stdout","data":"…"}
//    < {"op":"op-8b10…","event":"exited","code":0,"stdout":"…complete stdout…"}
//    > {"type":"prompt","op":"op-91c4…","handle":"…","lease":{...},"env":{...},"provided":[...],"unset":[...],"credentials":{...},"cwd":"…"}
//    < {"op":"op-91c4…","event":"accepted"}                                     accepted before the slow launch
//    < {"op":"op-91c4…","event":"display","display":{"label":"…","url":"…"}}        once the agent exists; neither accepts nor ends it
//    < {"op":"op-91c4…","event":"finished","session":{"tool":"claude","id":"…","home":"…"},"result":{"output":{…}},"usage":{…},"resumed":true}   resumed: true only when it continued lease.resume
//    > {"type":"open",…,"credentials":{}}                                      no view: the place of a confined prompt
//    > {"type":"prompt",…,"confined":{"dir":"…","level":"verified","access":"read","schema":{…}}}
//    < {"op":"op-a3d5…","event":"finished",…,"result":{"output":{…}},"confined":{"level":"verified","access":"read"}}
//    > {"type":"collect","handle":"…"}              < {"event":"collected","handle":"…"}
//    > {"type":"reattach","handle":"…"}             < {"event":"alive","handle":"…","ops":[...]} or {"event":"gone",…}
//    > {"type":"close","handle":"…"}                < {"event":"closed","handle":"…"} or {"event":"close_failed","handle":"…","failure":{…}}
//    < {"event":"notice","op":"op-8b10…","message":"…"}   any time, op or handle optional: a line for the person; it answers nothing
//    > {"type":"cancel","op":"op-8b10…"}            the operation then ends {"op":"op-8b10…","event":"cancelled"}
//                                                   or, when the stop is not confirmed, {"op":"op-8b10…","event":"failed",
//                                                   "failure":{"code":"cancel_failed",…}}, which reattach keeps reporting
//
//  A `reattach`, `collect` or `close` the runtime cannot answer gets the failure reply for its handle,
//  {"event":"failed","handle":"…","failure":{…}}; one for an operation gets that operation's `failed`. An
//  {"event":"error"} names no request, so teamai fails every request still waiting with `runtime_unanswered`: an
//  `open` fails, and an `exec` or `prompt` ends `lost`, since what it started may still run. So does an `init`, a
//  `reattach` or a `close` with no reply within 15 s, and an `open`, `exec` or `prompt` with no answer within 15 s, so a
//  runtime accepts one before any slow work. A `cancel` has no answer of its own: its outcome is the operation's end,
//  which `reattach` shows.
//
//  To stop what it ran, teamai opens a runtime in `recover` mode, and opens it for new work only when it refuses that mode:
//    > {"type":"init","protocol":1,"mode":"recover","options":{...}}
//    < {"type":"init","ok":true,"can":{}}
//
//  `max_parallel` and `credentials` in a driver definition's options are teamai's: it strips them before `init`, so a
//  runtime never sees or validates them. The credential values travel only in requests, in memory: on `open` for the
//  attempt, and on each `exec` and `prompt` that gets them, so a runtime that restarted holds none and needs none.
//

export const RUNTIME_PROTOCOL = 1;

/**
 * The variable every process of a step gets, on the host and on a runtime's place: the run's scratch directory, which
 * `PlaceView.runDir` names, which its steps share, sub-workflows included, and which teamai removes when the run ends.
 */
export const RUN_DIR_ENV = 'TEAMAI_RUN_DIR';

/**
 * Why a runtime process is started. `attended`: a person launched the run; `unattended`: in CI or a cloud agent.
 * `recover`: only to cancel, reattach, collect and close the handles teamai recorded, which teamai opens it in to stop
 * them, so that a provider that is down, stalls or signed it out cannot hold the stop: it runs no sign-in or tool check,
 * gets no credentials, offers nothing and answers from its own journal.
 */
export const RUNTIME_MODES = ['attended', 'unattended', 'recover'] as const;

export type RuntimeMode = (typeof RUNTIME_MODES)[number];

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

/**
 * The one code of a stop a runtime could not confirm: a `cancel` it could not carry out ends the operation `failed` with
 * it, and `reattach` keeps reporting that until a later `cancel` replaces it: from the moment the runtime reads that
 * `cancel`, `reattach` reports the operation `running` until the new stop is confirmed or fails again, so teamai never
 * reads the old failure as the new cancel's outcome. teamai takes an operation as still running while it reports
 * `running`, or `failed` with this code; any other `failed` is the operation's end.
 */
export const CANCEL_FAILED = 'cancel_failed';

/** A runtime's options, as a driver definition gives them; the runtime validates them at `init`. */
export const RuntimeOptionsSchema = z.record(z.string(), z.json());

export type RuntimeOptions = z.infer<typeof RuntimeOptionsSchema>;

/**
 * What a runtime may touch for one attempt: the worktree read-write at its host path, the git paths read-only, the
 * attempt's result directory read-write, the run's scratch directory read-write, which `RUN_DIR_ENV` names in what
 * runs there, and the attempt's tool home under the variable its tool reads.
 */
export const PlaceViewSchema = z.object({
  worktree: z.string(),
  readonly: z.array(z.string()),
  result: z.string(),
  runDir: z.string(),
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

/**
 * A tool's session: the tool that keeps it, and its id there, which a later pass resumes and scoring reads. `home` is
 * the absolute path of the tool home it lives in (the directory `CLAUDE_CONFIG_DIR` or `CODEX_HOME` would name), when
 * that is not the tool's default home, such as a T3 provider instance's own. A runtime that omits it, as one before
 * protocol 1 had it does, keeps the session in the tool's default home.
 */
export const PromptSessionSchema = z.object({
  tool: z.string().min(1),
  id: z.string().min(1),
  home: z.string().regex(/^(?:\/|[A-Za-z]:[\\/])/, 'A session home is an absolute path').optional(),
});

/** The tokens a prompt billed, as far as the runtime knows them. */
export const PromptUsageSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cachedInput: z.number().nonnegative().optional(),
}).strict() satisfies z.ZodType<TokenUsage>;

/**
 * The workflow result the agent wrote to the lease's `result` file: its output, or a failure with a code and a message.
 * An agent that writes `"failure": null` beside its output reports no failure, as the local driver reads it.
 */
export const PromptResultSchema = z.object({
  output: z.unknown().optional(),
  failure: z.object({ code: z.string(), message: z.string() }).nullish().transform((failure) => failure ?? undefined).optional(),
});

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
  /**
   * The file the agent writes the workflow result to, in the place's result directory. The runtime lets the agent
   * write this one file without asking, whatever `permissions` is, as teamai's own launch does (for Claude,
   * `--allowedTools=Edit(/<result>)`), so an attended step asks for no approval for it and an unattended one does not fail on it.
   */
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

/** How far a driver keeps a step from the member's machine, weakest first. A workspace contract is at least `worktree`. */
export const ISOLATION_LEVELS = ['none', 'worktree', 'sandbox'] as const;

/**
 * Where a step runs: in the checkout as it is, in a new copy, in the copy an enclosing step opened, in a fresh clone
 * teamai prepares, or in a fresh clone of the team repo. A driver lists the ones it provides in `can.workspace`.
 */
export const WORKSPACE_MODES = ['read-only', 'new', 'continue', 'clone', 'team'] as const;

/** The level a confined step runs at, which its `confined.json` sets: `verified` or `best-effort`. */
export const ConfinedLevelSchema = z.enum(CONFINED_LEVELS);

/** One offer of `can.confined`: tools a driver runs confined at `level`, which can do `access` there. */
export const ConfinedOfferSchema = z.object({
  level: ConfinedLevelSchema,
  access: z.enum(ACCESS_LEVELS).optional(),
  tools: z.array(z.string().min(1)).min(1),
});

/**
 * `driver.can`: what the driver declares it can do on this request. An omitted key means "not offered". The engine
 * never stores it. Parsed by `parseNextPayload`; the local driver builds every key.
 * - `network`: the driver can deny a step the network.
 * - `isolation`: the level the driver keeps every step it runs at.
 * - `env`: the driver resolves `envScope.provide` itself, removes `envScope.withhold`, and keeps the values from
 *   whatever runs the step. `true` covers every step; `'commands'` only command steps and setup, which run in the
 *   driver's own processes, so a prompt step that requires env is held. A driver whose executor is the agent leaves it out.
 * - `tokens`: every success report of a headless prompt step carries the tokens it spent.
 * - `max_turns`: the driver passes `maxTurns` to the tools it can cap, and reports `unenforced: ['max_turns']` for the others.
 * - `setup`: in each workspace it creates, the driver runs `lease.setup` before the step with only setup's keys, and
 *   fails the step without running it when setup exits non-zero (`setup_failed`), changes a tracked or non-ignored path
 *   (`setup_dirty`), or leaves a value of one of its keys in a file it created or changed (`setup_secret`).
 * - `tools`: the tools the driver launches a prompt step on that names its `tool`. A runtime of a driver definition is
 *   also held from a step that names none when it leaves out the tool teamai picks for it, such as the definition's
 *   `tool`. Omitted: no such step.
 * - `end_turn`: the driver holds a prompt leased with `limits` to them from its tool's launch, stops the tool at the
 *   first it reaches and reports it as `limit`, with `durationMs`. Without it, such a prompt gets the `on_limit: fail`
 *   lease, and its pass records `on_limit` as not enforced.
 * - `unattended`: the driver launches a prompt leased with `permissions: 'unattended'` in its tool's own mode for
 *   editing and running commands without asking, and fails the step rather than launch a tool that has none.
 * - `role`: the driver runs a step leased with `role` with what teamai delivered into its prepared copy for that role,
 *   and starts nothing that delivers the member's own assets there instead.
 * - `confined`: the tools the driver runs a prompt on with one directory as its only readable root, each offer at the
 *   level it reaches, with what those tools can do there. An offer without `access` counts as `full`.
 */
export const CanSchema = z.object({
  hitl: z.boolean().optional(),
  /** `false`: the driver runs no command, so command steps and steps with setup go to another driver. Absent: it does. */
  exec: z.boolean().optional(),
  workspace: z.array(z.enum(WORKSPACE_MODES)).optional(),
  network: z.boolean().optional(),
  isolation: z.enum(ISOLATION_LEVELS).optional(),
  env: z.union([z.boolean(), z.literal('commands')], { error: "Expected true, false or 'commands'" }).optional(),
  tokens: z.boolean().optional(),
  max_turns: z.boolean().optional(),
  setup: z.boolean().optional(),
  tools: z.array(z.string().min(1)).optional(),
  /**
   * The tool the app the runtime drives runs by default, one of `tools`. A prompt step that names no tool, in a run where
   * the member named none for it either, runs on it, before the member's own teamai default.
   */
  default_tool: z.string().min(1).optional(),
  end_turn: z.boolean().optional(),
  unattended: z.boolean().optional(),
  role: z.boolean().optional(),
  confined: z.array(z.lazy(() => ConfinedOfferSchema)).optional(),
});

export type Can = z.infer<typeof CanSchema>;

export type ConfinedOffer = z.infer<typeof ConfinedOfferSchema>;

/**
 * The credentials a driver definition gives a runtime, by name only, never a value: `env`, the names its operations
 * carry; `logins`, the tools whose login teamai copies into an attempt's tool home. A runtime offers by them, such as
 * `can.confined` only for the tools it can sign in. An older teamai sends none, and the runtime offers as it would
 * without them.
 */
export const InitCredentialsSchema = z.object({ env: z.array(z.string()), logins: z.array(z.string()) });

export type InitCredentials = z.infer<typeof InitCredentialsSchema>;

/**
 * A tool instance the member may run: `name`, the name a step and `can.tools` give it; `tool`, the shipped tool it
 * extends; `command`, the executable on PATH that starts it; `home`, its home under `$HOME` and the variable that moves
 * it; `paths`, the tool paths it sets. A runtime lists in `can.tools` the instances it can serve: on one that execs its
 * tool, teamai then launches `command` with `home.env` set to the attempt's tool home.
 */
export const InitInstanceSchema = z.object({
  name: z.string().min(1),
  tool: z.string().min(1),
  command: z.string().min(1).optional(),
  home: z.object({ dir: z.string().min(1), env: z.string().min(1).optional() }).optional(),
  paths: z.record(z.string(), z.unknown()).optional(),
});

export type InitInstance = z.infer<typeof InitInstanceSchema>;

const InitRequestSchema = z.object({
  type: z.literal('init'), protocol: z.literal(RUNTIME_PROTOCOL), mode: z.enum(RUNTIME_MODES), options: RuntimeOptionsSchema,
  credentials: InitCredentialsSchema.optional(),
  instances: z.array(InitInstanceSchema).optional(),
});

export const OpenRequestSchema = z.object({
  type: z.literal('open'),
  op: OpIdSchema,
  run: z.string(),
  attempt: z.string(),
  /** What of the host the place gets. Absent for a confined prompt's place, which gets only the prompt's `confined.dir`. */
  view: PlaceViewSchema.optional(),
  /**
   * The tool the attempt's prompt runs, such as `claude`, so a runtime can make the place for it (an `sbx` sandbox of
   * that agent). Absent for a command step's place, which runs no tool.
   */
  tool: z.string().min(1).optional(),
  /**
   * The latest time the attempt's limits allow, as an ISO timestamp, when it has any. teamai cancels an exec or prompt
   * of the place still running then, fails the open when the place is not ready by then, and waits for a `collect` 15 s
   * past it at most. Absent: the attempt has no time limit.
   */
  deadline: z.iso.datetime({ offset: true }).optional(),
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

/**
 * A prompt confined to `dir`, for a runtime whose `init` says it answers confined prompts: its agent reads `dir`, read
 * only, and nothing else of the host, at `level` or above, with what its offer for the tool said it can do there
 * (`access`). `schema` is the JSON Schema the reply matches, when the step names one. The reply is the result's
 * `output`, and `finished` says the level and access the runtime kept, never more than it enforced. The lease's prompt
 * and `cwd` name the directory exactly as `dir` does, so a runtime may mount or copy it at a neutral path and replace
 * `dir` there, which keeps the member's home and project names out of the agent's view.
 */
export const ConfinedPromptSchema = z.object({
  dir: z.string().min(1),
  level: ConfinedLevelSchema,
  access: z.enum(ACCESS_LEVELS),
  schema: z.json().optional(),
});

export type ConfinedPrompt = z.infer<typeof ConfinedPromptSchema>;

/**
 * A prompt for a runtime that launches agents its own way, or a confined prompt; `env` and `unset` scope the agent's
 * environment as an exec's.
 */
export const PromptRequestSchema = z.object({
  type: z.literal('prompt'),
  op: OpIdSchema,
  handle: RuntimeHandleSchema,
  lease: PromptLeaseSchema,
  env: EnvSchema,
  /**
   * The names of `env` whose values the team provides (`requires.env`), apart from the attempt's markers: a runtime
   * whose tool keeps env in plain text drops these and keeps the rest. An older teamai sends none: such a runtime then
   * treats every name but the attempt's markers as the team's.
   */
  provided: z.array(z.string()).optional(),
  unset: z.array(z.string()),
  /** The credentials the agent gets over its environment. */
  credentials: CredentialsSchema,
  cwd: z.string(),
  confined: ConfinedPromptSchema.optional(),
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
 * is not there, the tool failed, or it hit its usage limit (`usage_limited`, whose message names the tool and the reset
 * time when the tool or the app gives it, never the run or the step: teamai adds the retry). teamai records any other
 * code as `runtime_failed`, naming it in the message.
 */
export const PROMPT_FAILURE_CODES = ['model_unavailable', 'tool_unavailable', 'agent_unavailable', 'tool_failed', 'usage_limited'] as const;

/** What a runtime kept of a confined prompt: the level it enforced, and what the agent could do in the directory. */
export const ConfinedKeptSchema = z.object({ level: ConfinedLevelSchema, access: z.enum(ACCESS_LEVELS) });

export type ConfinedKept = z.infer<typeof ConfinedKeptSchema>;

/** The fields of a finished prompt: the tool's session, the result the agent wrote, and the tokens it billed. */
const finishedPrompt = {
  session: PromptSessionSchema,
  result: PromptResultSchema,
  usage: PromptUsageSchema.optional(),
  /** A confined prompt's: the level and access the runtime kept. */
  confined: ConfinedKeptSchema.optional(),
  /**
   * `true`: the agent continued the session the lease's `resume` names, as it is or in a copy. `false` or absent: it started a
   * new one, so teamai links no session to the one the step asked to resume.
   */
  resumed: z.boolean().optional(),
};

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
 * The lines a runtime writes, with `display` (on `ready`, on an exec's or prompt's `accepted` or `display` event, and on `alive`) and the init reply's `can` read by the schemas
 * given. A runtime checks what it writes against `RuntimeMessageSchema`; teamai reads a display apart from its event,
 * so a runtime that gets it wrong loses only its display, and reads `can` as its own driver offer.
 */
export function runtimeMessageSchemas<TDisplay extends z.ZodType>({ display }: { display: TDisplay }) {
  /**
   * A reply to `init`: the runtime's offer, or why it cannot run with the options it was given. `prompt: true` says it
   * launches agents its own way, so teamai sends it each prompt step as a `prompt`, never as an `exec` of the tool.
   * With `can.exec: false` it runs no command: command steps, and steps with setup, go to the next runtime.
   * `confinedPrompt: true` says it answers a `prompt` with `confined`; without it, teamai drops `can.confined`.
   */
  const InitReply = z.discriminatedUnion('ok', [
    z.object({
      type: z.literal('init'), ok: z.literal(true), can: CanSchema, prompt: z.boolean().optional(), confinedPrompt: z.boolean().optional(),
      // The tools it cannot run now, each with why and what the person does about it; it still offers the rest.
      unavailable: z.record(z.string().min(1), z.string().min(1).max(500)).optional(),
      // The tools it runs without permission prompts, because an option of its definition or of the member set that.
      permissions: z.record(z.string().min(1), z.literal('full-access')).optional(),
    }).strict(),
    z.object({ type: z.literal('init'), ok: z.literal(false), error: RuntimeFailureSchema }).strict(),
  ]);

  const OpEvent = z.discriminatedUnion('event', [
    /** `display` on an exec's or prompt's acceptance: what the runtime shows once that operation exists, such as an agent's thread. */
    z.object({ op: OpIdSchema, event: z.literal('accepted'), handle: RuntimeHandleSchema.optional(), display }).strict(),
    z.object({ op: OpIdSchema, event: z.literal('ready'), display }).strict(),
    /**
     * What the runtime shows of an exec or prompt once it exists, such as the agent it launched after it accepted the
     * prompt. It neither accepts the operation nor ends it; the latest display given is shown.
     */
    z.object({ op: OpIdSchema, event: z.literal('display'), display: display.nonoptional() }).strict(),
    z.object({ op: OpIdSchema, event: z.literal('failed'), failure: RuntimeFailureSchema }).strict(),
    z.object({ op: OpIdSchema, event: z.literal('output'), stream: z.enum(['stdout', 'stderr']), data: z.string() }).strict(),
    z.object({ op: OpIdSchema, event: z.literal('exited'), code: z.number().int(), stdout: z.string() }).strict(),
    z.object({ op: OpIdSchema, event: z.literal('finished'), ...finishedPrompt }).strict(),
    z.object({ op: OpIdSchema, event: z.literal('cancelled') }).strict(),
  ]);

  const HandleEvent = z.discriminatedUnion('event', [
    z.object({ event: z.literal('collected'), handle: RuntimeHandleSchema }).strict(),
    z.object({ event: z.literal('collect_failed'), handle: RuntimeHandleSchema, failure: RuntimeFailureSchema }).strict(),
    z.object({ event: z.literal('alive'), handle: RuntimeHandleSchema, ops: z.array(OpStateSchema), display }).strict(),
    z.object({ event: z.literal('gone'), handle: RuntimeHandleSchema }).strict(),
    z.object({ event: z.literal('closed'), handle: RuntimeHandleSchema }).strict(),
    /** The runtime could not end the place, so what it started there may still run. */
    z.object({ event: z.literal('close_failed'), handle: RuntimeHandleSchema, failure: RuntimeFailureSchema }).strict(),
    /**
     * The runtime could not answer a `reattach`, `collect` or `close` of the handle, such as when its journal cannot be
     * read or its provider cannot be reached: never `gone` for that, since the place may still be there.
     */
    z.object({ event: z.literal('failed'), handle: RuntimeHandleSchema, failure: RuntimeFailureSchema }).strict(),
  ]);

  /**
   * A line for the person, at any time, naming the operation or the place it is about when it is about one: a sign-in
   * page to open, a slow pull, a problem that does not stop the work. It neither answers nor ends any request, so it
   * is no answer teamai waits for. teamai masks it and shows it as a warning.
   */
  const Notice = z.object({ event: z.literal('notice'), op: OpIdSchema.optional(), handle: RuntimeHandleSchema.optional(), message: z.string().min(1) }).strict();

  return { OpEvent, HandleEvent, Notice, Message: z.union([InitReply, OpEvent, HandleEvent, Notice, z.object({ event: z.literal('error'), message: z.string() }).strict()]) };
}

/** What a runtime may write, display and offer included: a check for its own output. */
export const RuntimeMessageSchema = runtimeMessageSchemas({ display: RuntimeDisplaySchema.optional() }).Message;

export type RuntimeMessage = z.infer<typeof RuntimeMessageSchema>;
