import { getUserHome } from '@teamai/tool-core/home';
import { z } from 'zod';

// ─── Runtime protocol 1 ──────────────────────────────────
//
//  JSON lines over stdio between teamai and a step runtime. teamai writes one request per line to the runtime's stdin;
//  the runtime writes replies and events to its stdout. Every operation is accepted first and ends later, under an id
//  teamai persists before it sends the request, and a runtime answers a repeated id with the same acceptance and the
//  same terminal outcome until `close`. Both sides parse with the schemas below.
//
//    > {"type":"init","protocol":1,"mode":"unattended","options":{...}}
//    < {"type":"init","ok":true,"can":{...}}
//    > {"type":"open","op":"op-7f2a…","run":"r…","attempt":"a…","view":{...},"credentials":{}}
//    < {"op":"op-7f2a…","event":"accepted","handle":"toy-r…-a…"}
//    < {"op":"op-7f2a…","event":"ready","display":{"label":"…","url":"…","fields":{…}}}       display optional
//    > {"type":"exec","op":"op-8b10…","handle":"…","argv":[...],"env":{...},"unset":[...],"cwd":"…"}
//    < {"op":"op-8b10…","event":"accepted"}
//    < {"op":"op-8b10…","event":"output","stream":"stdout","data":"…"}
//    < {"op":"op-8b10…","event":"exited","code":0,"stdout":"…complete stdout…"}
//    > {"type":"collect","handle":"…"}              < {"event":"collected","handle":"…"}
//    > {"type":"reattach","handle":"…"}             < {"event":"alive","handle":"…","ops":[...]} or {"event":"gone",…}
//    > {"type":"close","handle":"…"}                < {"event":"closed","handle":"…"}
//    > {"type":"cancel","op":"op-8b10…"}            the operation then ends {"op":"op-8b10…","event":"cancelled"}
//

export const RUNTIME_PROTOCOL = 1;

/** Whether a person is there for the run: `attended` where one launched it, `unattended` in CI or a cloud agent. */
export const RUNTIME_MODES = ['attended', 'unattended'] as const;

/** An operation id: what teamai persists before it sends an `open` or an `exec`. */
export const OpIdSchema = z.string().regex(/^op-[0-9a-f]{8,32}$/, 'An operation id looks like op- followed by hex digits').brand<'OpId'>();

export type OpId = z.infer<typeof OpIdSchema>;

/** A runtime's id for one opened place, which teamai persists to reconnect after a restart. */
export const RuntimeHandleSchema = z.string().min(1).max(256);

const EnvSchema = z.record(z.string(), z.string());

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

const InitRequestSchema = z.object({ type: z.literal('init'), protocol: z.literal(RUNTIME_PROTOCOL), mode: z.enum(RUNTIME_MODES), options: RuntimeOptionsSchema });

export const OpenRequestSchema = z.object({
  type: z.literal('open'),
  op: OpIdSchema,
  run: z.string(),
  attempt: z.string(),
  view: PlaceViewSchema,
  /** The credentials of this attempt: names and values, never set when the place is created, only per `exec`. */
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
  cwd: z.string(),
});

/** A request teamai writes to a runtime's stdin. */
export const RuntimeRequestSchema = z.discriminatedUnion('type', [
  InitRequestSchema,
  OpenRequestSchema,
  ExecRequestSchema,
  z.object({ type: z.literal('cancel'), op: OpIdSchema }),
  z.object({ type: z.enum(['collect', 'reattach', 'close']), handle: RuntimeHandleSchema }),
]);

export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;

/** What a runtime retains of one operation of a handle, which `reattach` reports. */
export const OpStateSchema = z.discriminatedUnion('state', [
  z.object({ op: OpIdSchema, state: z.literal('running') }),
  z.object({ op: OpIdSchema, state: z.literal('exited'), code: z.number().int(), stdout: z.string() }),
  z.object({ op: OpIdSchema, state: z.literal('cancelled') }),
  z.object({ op: OpIdSchema, state: z.literal('failed'), failure: RuntimeFailureSchema }),
]);

export type OpState = z.infer<typeof OpStateSchema>;

/**
 * The lines a runtime writes, with `display` (on `ready` and `alive`) and the init reply's `can` read by the schemas
 * given. A runtime checks what it writes against `RuntimeMessageSchema`; teamai reads a display apart from its event,
 * so a runtime that gets it wrong loses only its display, and reads `can` as its own driver offer.
 */
export function runtimeMessageSchemas<TDisplay extends z.ZodType, TCan extends z.ZodType>({ display, can }: { display: TDisplay; can: TCan }) {
  /** A reply to `init`: the runtime's offer, or why it cannot run with the options it was given. */
  const InitReply = z.discriminatedUnion('ok', [
    z.object({ type: z.literal('init'), ok: z.literal(true), can }),
    z.object({ type: z.literal('init'), ok: z.literal(false), error: RuntimeFailureSchema }),
  ]);

  const OpEvent = z.discriminatedUnion('event', [
    z.object({ op: OpIdSchema, event: z.literal('accepted'), handle: RuntimeHandleSchema.optional() }),
    z.object({ op: OpIdSchema, event: z.literal('ready'), display }),
    z.object({ op: OpIdSchema, event: z.literal('failed'), failure: RuntimeFailureSchema }),
    z.object({ op: OpIdSchema, event: z.literal('output'), stream: z.enum(['stdout', 'stderr']), data: z.string() }),
    z.object({ op: OpIdSchema, event: z.literal('exited'), code: z.number().int(), stdout: z.string() }),
    z.object({ op: OpIdSchema, event: z.literal('cancelled') }),
  ]);

  const HandleEvent = z.discriminatedUnion('event', [
    z.object({ event: z.literal('collected'), handle: RuntimeHandleSchema }),
    z.object({ event: z.literal('collect_failed'), handle: RuntimeHandleSchema, failure: RuntimeFailureSchema }),
    z.object({ event: z.literal('alive'), handle: RuntimeHandleSchema, ops: z.array(OpStateSchema), display }),
    z.object({ event: z.literal('gone'), handle: RuntimeHandleSchema }),
    z.object({ event: z.literal('closed'), handle: RuntimeHandleSchema }),
  ]);

  return { OpEvent, HandleEvent, Message: z.union([InitReply, OpEvent, HandleEvent, z.object({ event: z.literal('error'), message: z.string() })]) };
}

/** What a runtime may write, display and offer included: a check for its own output. */
export const RuntimeMessageSchema = runtimeMessageSchemas({ display: RuntimeDisplaySchema.optional(), can: z.record(z.string(), z.unknown()) }).Message;

export type RuntimeMessage = z.infer<typeof RuntimeMessageSchema>;
