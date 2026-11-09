/**
 * The fleet: a run offers single attempts on `teamai-reports`, and other installs of the same business repository take
 * them with `teamai workflow resume --next --pool <name>`. Each attempt has one record, at
 * `workflows/attempts/<run>/<attempt>.json`, which a write replaces only while origin still holds the write it read, as
 * run handoff does for snapshots. A member pushes the attempt's work only to its own ref, `teamai/attempts/<run>/<attempt>`;
 * only the run's owner moves the workflow's branch.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { OpIdSchema, type OpId } from '@teamai/runtime-protocol';
import { sanitizeGitUrl } from '@teamai/shared/redact';
import { getReportsDir, type LocalConfig } from '../../types.js';
import { gitRoot } from '../../utils/branch-worktree.js';
import { log } from '../../utils/logger.js';
import { getCurrentVersion } from '../../package-info.js';
import { fetchReportsOriginFile, updateReports, type ReportsChange } from '../../utils/reports-branch.js';
import { isJsonObject } from '../../types.js';
import { JsonValueSchema, parseJson, type JsonValue } from '../../utils/json.js';
import { TurnLimitsSchema } from '../requirements.js';
import { TokenUsageSchema } from '../step-state.js';
import { expressionPaths, isIndex, type PathField } from '../expression.js';
import { firstUnfit, RunDefinitionSchema, type HandoffOwner } from '../snapshot.js';
import { attemptDir, AttemptIdSchema, RunIdSchema, type AttemptId, type RunId } from '../store.js';
import { parseTemplate, renderLeaseText, renderStrings, renderText, templatedTexts, templateExpressions, type TemplateContext } from '../template.js';
import { isWorkflowFile, stepWorkflow, type InlineWorkflow, type WorkflowDefinition, type WorkflowFailure, type WorkflowStep } from '../types.js';
import type { ExecAnswer, ExecQuestion } from '../runtimes/step-runtime.js';
import { inlineReads, wholeInputs } from '../whole-workflow.js';

/** The pool a fleet offers to when its definition names none, which `resume --next --pool` takes when given no name. */
export const DEFAULT_FLEET_POOL = 'default';

/** Where the records of every offered attempt live on `teamai-reports`. */
const ATTEMPTS_DIR = 'workflows/attempts';

const OwnerSchema = z.strictObject({ id: z.string().min(1), user: z.string() });

/** A full commit id, never a name git would resolve on the reading machine, such as a branch or `stash@{0}`, or read as an option. */
const CommitSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'must be a full commit id');

/**
 * What a member runs, as the owner rendered it: never an argv, a credential value or a path of the owner's machine.
 * `env` is the step's rendered `env`. A command step carries its command; a prompt step its rendered prompt, and the
 * limits its turn ends at, which the member keeps on the tool it picks.
 */
const CommandLeaseSchema = z.strictObject({
  kind: z.literal('command'),
  step: z.string().min(1),
  command: z.string().min(1),
  env: z.record(z.string(), z.string()),
});

const PromptLeaseSchema = z.strictObject({
  kind: z.literal('prompt'),
  step: z.string().min(1),
  prompt: z.string(),
  env: z.record(z.string(), z.string()),
  limits: TurnLimitsSchema.strict().optional(),
});

/**
 * A `workflow:` step leased whole: the inputs its workflow starts with, as the owner rendered them from the step's `with`,
 * which the member renders again from its own copy of the step and the offer's values. The sub-graph is the member's
 * own: the record names none of its steps.
 */
const WorkflowLeaseSchema = z.strictObject({
  kind: z.literal('workflow'),
  step: z.string().min(1),
  inputs: JsonValueSchema,
  env: z.record(z.string(), z.string()),
});

/** What a member runs, told apart by `kind`: a command step, a prompt step, or a `workflow:` step whole. */
const FleetLeaseSchema = z.discriminatedUnion('kind', [CommandLeaseSchema, PromptLeaseSchema, WorkflowLeaseSchema]);

export type FleetLease = z.infer<typeof FleetLeaseSchema>;

/** The text of `lease` a member runs, with the field that holds it: its command, or its prompt; none for a whole workflow. */
function leaseText(lease: FleetLease): { field: 'command' | 'prompt'; text: string } | undefined {
  switch (lease.kind) {
    case 'command': return { field: 'command', text: lease.command };
    case 'prompt': return { field: 'prompt', text: lease.prompt };
    case 'workflow': return undefined;
    default: {
      const unhandled: never = lease;

      return unhandled;
    }
  }
}

/**
 * What the step's env reads, which a member renders the env from with its own copy of the step: the inputs it reads, by
 * name, the outputs of the steps it reads, by step id, and the item. Values only: the command and the env's templates
 * come from the team's workflow, never from the record.
 */
const LeaseValuesSchema = z.strictObject({
  inputs: JsonValueSchema.optional(),
  outputs: z.record(z.string(), JsonValueSchema).optional(),
  item: JsonValueSchema.optional(),
});

export type LeaseValues = z.infer<typeof LeaseValuesSchema>;

/**
 * How a member's run of the lease ended: its command's exit code, the JSON its stdout held, and the start of its stderr,
 * as the local loop reports a command (`commandEnd`); the whole stdout stays on the member. `to`: the commit it pushed
 * to the attempt's ref, absent when it pushed none.
 */
const FleetResultSchema = z.strictObject({
  exitCode: z.number().int(),
  outputs: JsonValueSchema.optional(),
  stderr: z.string(),
  to: CommitSchema.optional(),
  /**
   * A prompt step's: the tool the member ran it on, the id of the session it ran there, which the member pushed to the team
   * session archive, its model and tokens, and why it failed, as the member's report said.
   */
  tool: z.string().min(1).optional(),
  session: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  tokens: TokenUsageSchema.optional(),
  failure: z.strictObject({ code: z.string().min(1), message: z.string() }).optional(),
  /** A whole workflow's: the end its nested run reached. */
  end: z.string().min(1).optional(),
});

export type FleetResult = z.infer<typeof FleetResultSchema>;

/**
 * The format of the attempt records this teamai writes and reads. 2: prompt leases, a prompt's session, whole
 * workflow leases and their gates. Every object of a record is strict, so a field this format does not name makes the record
 * unreadable rather than read without it: a newer format bumps this, and a teamai that reads it refuses it by version.
 */
const RECORD_VERSION = 2;

/** What any teamai's record says of its format, whatever else it holds. */
const RecordFormatSchema = z.object({ version: z.number(), teamai: z.string().optional().catch(undefined) });

const OfferedSchema = z.strictObject({
  /** The record's format. A teamai that reads a newer one refuses it, naming the teamai that wrote it (`teamai`). */
  version: z.literal(RECORD_VERSION),
  /** The version of the teamai that wrote the record. */
  teamai: z.string().optional(),
  run: RunIdSchema,
  attempt: AttemptIdSchema,
  pool: z.string().min(1),
  /** The business repository the attempt runs in, as `getRepoIdentity` names it. */
  repository: z.string().min(1),
  owner: OwnerSchema,
  /** The write that produced this record, which the next write replaces. */
  write: z.string().min(1),
  offeredAt: z.string(),
  /** The commit the attempt starts from, which the owner pushed to the attempt's ref. */
  start: CommitSchema,
  /** How long a claim may go without progress before the owner gives it up, in milliseconds. */
  staleAfterMs: z.number().int().positive(),
  lease: FleetLeaseSchema,
  /** The definitions the run executes, which a member reads from its own team repository and checks the lease against. */
  definition: RunDefinitionSchema.strict(),
  values: LeaseValuesSchema,
  state: z.literal('offered'),
});

/**
 * A member's claim: `progressAt`, when it last wrote that it still runs the attempt, and `pushed`, the last commit it
 * pushed to the attempt's ref, from which a retry starts once the claim went stale.
 */
const ClaimedSchema = OfferedSchema.extend({ state: z.literal('claimed'), member: OwnerSchema, claimedAt: z.string(), progressAt: z.string(), pushed: CommitSchema });

const FinishedSchema = ClaimedSchema.extend({ state: z.literal('finished'), finishedAt: z.string(), result: FleetResultSchema });

/**
 * A claim the owner gave up once no progress came for `stale_after`, or no answer to its cancel (`cancelAt`): nothing the
 * member writes later counts.
 */
const ExpiredSchema = ClaimedSchema.extend({ state: z.literal('expired'), expiredAt: z.string(), cancelAt: z.string().optional() });

/** An offer the owner took back, before any member claimed it: the step was cancelled. */
const WithdrawnSchema = OfferedSchema.extend({ state: z.literal('withdrawn'), withdrawnAt: z.string() });

/** A gate a whole workflow reached on the member, as the owner's person sees it. */
const QuestionSchema = z.strictObject({
  step: z.string().min(1), kind: z.enum(['approve', 'choose']), message: z.string(), options: z.array(z.string()), required: z.boolean(), default: z.string().optional(),
}) satisfies z.ZodType<ExecQuestion>;

/** The owner's answer: the choice and note its person gave, or why none comes. */
const AnswerSchema = z.union([z.strictObject({ choice: z.string().min(1), note: z.string().optional() }), z.strictObject({ refused: z.string().min(1) })]) satisfies z.ZodType<ExecAnswer>;

/**
 * A claim whose whole workflow waits at a gate: the member asks the owner `question`, and keeps asking in its progress
 * until it reads the answer.
 */
const AskingSchema = ClaimedSchema.extend({ state: z.literal('asking'), question: QuestionSchema });

/** The owner's answer to the question of a claim, which the member takes at its next read; its next progress is a claim again. */
const AnsweredSchema = AskingSchema.extend({ state: z.literal('answered'), answer: AnswerSchema });

/** A claim the owner asked its member to stop, which the member answers with `cancelled` once its step stopped. */
const CancellingSchema = ClaimedSchema.extend({ state: z.literal('cancelling'), cancelAt: z.string() });

/** A cancelled claim: the member stopped its step and pushed its work up to `pushed`, which a retry goes on from. */
const CancelledSchema = CancellingSchema.extend({ state: z.literal('cancelled'), cancelledAt: z.string() });

export const FleetRecordSchema = z.discriminatedUnion('state', [OfferedSchema, ClaimedSchema, AskingSchema, AnsweredSchema, FinishedSchema, ExpiredSchema, WithdrawnSchema, CancellingSchema, CancelledSchema]);

export type FleetRecord = z.infer<typeof FleetRecordSchema>;

export type Offered = Extract<FleetRecord, { state: 'offered' }>;

export type Claimed = Extract<FleetRecord, { state: 'claimed' }>;

export type Cancelling = Extract<FleetRecord, { state: 'cancelling' }>;

/** A claim its member holds: running, asking the owner a gate, or with the owner's answer to read. */
export type HeldAttempt = Extract<FleetRecord, { state: 'claimed' | 'asking' | 'answered' }>;

export type Asking = Extract<FleetRecord, { state: 'asking' }>;

/** Whether `record` is a claim its member holds. */
export function isHeld(record: FleetRecord): record is HeldAttempt {
  return record.state === 'claimed' || record.state === 'asking' || record.state === 'answered';
}

/** Claim `held` as a plain claim, without a question or an answer. */
function claimOf(held: HeldAttempt): Claimed {
  switch (held.state) {
    case 'claimed':
      return held;
    case 'asking': {
      const { question: _question, ...claim } = held;

      return { ...claim, state: 'claimed' };
    }

    case 'answered': {
      const { question: _question, answer: _answer, ...claim } = held;

      return { ...claim, state: 'claimed' };
    }

    default: {
      const unhandled: never = held;

      return unhandled;
    }
  }
}

export type FleetError =
  | { code: 'state_moved'; message: string }
  | { code: 'reports_unreachable' | 'reports_failed' | 'fleet_unpublishable' | 'fleet_record_unreadable' | 'fleet_record_newer'; message: string };

type Written<T> = { ok: true; value: T } | { ok: false; error: FleetError };

/** The ref a member pushes an attempt's work to, and the owner fetches it from. */
export function attemptRef(run: RunId, attempt: AttemptId): string {
  return `refs/heads/teamai/attempts/${run}/${attempt}`;
}

function recordPath(run: RunId, attempt: AttemptId): string {
  return `${ATTEMPTS_DIR}/${run}/${attempt}.json`;
}

function recordText(record: FleetRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Why `record` may not leave this machine, naming the field: a value that looks like a secret, among them those of
 * `secrets`, or an absolute path of this machine, which a member cannot use.
 */
function unpublishable(record: FleetRecord, secrets: Record<string, string>): FleetError | undefined {
  // A command or a prompt names the paths it reads and writes, such as /dev/null, wherever it runs: only a secret keeps it here.
  const leased = leaseText(record.lease);
  const inText = leased && firstUnfit(leased.text, secrets);
  const textHit = leased && inText?.unfit.kind === 'secret' ? { at: ['lease', leased.field], unfit: inText.unfit } : undefined;
  const hit = textHit ?? firstUnfit(JsonValueSchema.parse(leased ? { ...record, lease: { ...record.lease, [leased.field]: '' } } : record), secrets);

  if (hit === undefined) return undefined;
  const at = hit.at.join('.');
  const what = hit.unfit.kind === 'secret' ? `what looks like a secret (${hit.unfit.label})` : 'an absolute path of this machine';

  return { code: 'fleet_unpublishable', message: `Attempt ${record.attempt} of run ${record.run} was not written to teamai-reports: its "${at}" holds ${what}.` };
}

/**
 * The texts of step `step` a fleet lease renders from values: its `env` and, for a prompt step, its `with`, `prompt` and
 * `model`, as `templatedTexts` names them.
 */
function leasedTexts(step: Pick<WorkflowStep, 'prompt' | 'env' | 'with' | 'model'>): Array<{ what: string; text: string }> {
  return templatedTexts(step).filter(({ what }) => what.startsWith('env.') || what.startsWith('with.') || what === 'prompt' || what === 'model');
}

/** How a message names the text at `what`: `env NAME` for an env entry, as a person writes it. */
function textLabel(what: string): string {
  return what.startsWith('env.') ? `env ${what.slice('env.'.length)}` : what;
}

/**
 * What the texts of step `step` a fleet lease renders read in `context`, the context its lease rendered them in, or why
 * a member could not render them from values: one reads something besides inputs, the item, the run's id and steps'
 * outputs. A read of the step's own `with` is rendered from the `with` texts. For an inline workflow, the inputs its
 * steps read too.
 */
export function leaseValues(step: Pick<WorkflowStep, 'id' | 'prompt' | 'env' | 'with' | 'model' | 'workflow'>, context: TemplateContext): { values: LeaseValues } | { error: string } {
  const given = JsonValueSchema.safeParse(context.inputs ?? {});
  const item = JsonValueSchema.safeParse(context.item);
  let inputs: JsonValue | undefined;
  let itemValues: JsonValue | undefined;
  const outputs: Record<string, JsonValue> = {};

  for (const { what, text } of leasedTexts(step)) {
    const parsed = parseTemplate(text, Object.hasOwn(context, 'item'));

    if (!parsed.ok) return { error: `Step "${step.id}" ${textLabel(what)} does not parse: ${parsed.errors[0]?.message ?? ''}` };

    for (const read of templateExpressions(parsed.template).flatMap(expressionPaths)) {
      if (read.root === 'steps' && read.field !== 'outputs') {
        return { error: `Step "${step.id}" ${textLabel(what)} reads steps.${read.step}.${read.field}, which a fleet member cannot render: on the fleet a step's env, with, prompt and model read only inputs, item, run.id and steps' outputs.` };
      }

      if (read.root === 'inputs' && given.success) inputs = withPath(inputs, given.data, read.fields);

      if (read.root === 'steps') {
        const stepOutputs = JsonValueSchema.safeParse(context.steps[read.step]?.outputs);
        const picked = stepOutputs.success ? withPath(outputs[read.step], stepOutputs.data, read.fields) : undefined;

        if (picked !== undefined) outputs[read.step] = picked;
      }

      // A text that reads the item renders against one, even when the field it reads is missing.
      if (read.root === 'item' && item.success) itemValues = withPath(itemValues, item.data, read.fields) ?? {};
    }
  }

  // The steps of an inline workflow read the inputs around it, which its nested run starts with.
  const runs = stepWorkflow(step);
  const inner = runs?.kind === 'inline' && given.success ? inlineReads(runs.workflow).flatMap(({ paths }) => paths) : [];

  for (const read of inner) if (read.root === 'inputs' && given.success) inputs = withPath(inputs, given.data, read.fields);

  return {
    values: {
      ...(inputs !== undefined && { inputs }),
      ...(Object.keys(outputs).length > 0 && { outputs }),
      ...(itemValues !== undefined && { item: itemValues }),
    },
  };
}

/**
 * `picked` with what `from` holds at `fields` added, so a record carries only what the env reads: a path that reads an
 * array element carries the whole array, and a path that reads nothing there adds nothing. A whole value is added as
 * `from` itself, which a later, longer path then finds already there.
 */
function withPath(picked: JsonValue | undefined, from: JsonValue, fields: PathField[]): JsonValue | undefined {
  const [field, ...rest] = fields;

  if (field === undefined || isIndex(field) || picked === from) return from;

  if (!isJsonObject(from) || !Object.hasOwn(from, field)) return picked;

  const value = from[field];

  if (value === undefined) return picked;

  const into = picked !== undefined && isJsonObject(picked) ? picked : {};
  const inner = withPath(into[field], value, rest);

  return inner === undefined ? into : { ...into, [field]: inner };
}

/** The context step texts render in from `values`, as its owner's lease rendered them from the run. */
function valuesContext(values: LeaseValues, run: RunId): TemplateContext {
  return {
    inputs: values.inputs ?? {},
    steps: Object.fromEntries(Object.entries(values.outputs ?? {}).map(([id, outputs]) => [id, { outputs }])),
    run: { id: run },
    ...(Object.hasOwn(values, 'item') && { item: values.item }),
  };
}

/** The env of step `step` in run `run`, rendered from `values` as its owner's lease rendered it from the run. */
export function leaseEnv(step: Pick<WorkflowStep, 'id' | 'env'>, values: LeaseValues, run: RunId): { env: Record<string, string> } | { error: string } {
  const context = valuesContext(values, run);
  const env: Record<string, string> = {};

  for (const [name, text] of Object.entries(step.env ?? {})) {
    const parsed = parseTemplate(text, Object.hasOwn(context, 'item'));

    if (!parsed.ok) return { error: `env ${name} does not parse: ${parsed.errors[0]?.message ?? ''}` };
    env[name] = renderText(parsed.template, context);
  }

  return { env };
}

/**
 * The prompt of prompt step `step` in run `run`, and its model when a template names it, rendered from `values` after
 * its `with`, as the engine renders a lease's. A model that renders empty is kept empty: it asks for the tool's default.
 */
export function leasePrompt(step: Pick<WorkflowStep, 'id' | 'prompt' | 'with' | 'model'>, values: LeaseValues, run: RunId): { prompt: string; model?: string } | { error: string } {
  if (step.prompt === undefined) return { error: `step "${step.id}" is no prompt step` };
  const context = valuesContext(values, run);

  if (step.with !== undefined) {
    const rendered = renderStrings(step.with, context);

    if (!rendered.ok) return { error: `with ${rendered.error.source}: ${rendered.error.message}` };
    context.with = rendered.value;
  }

  const prompt = renderLeaseText(context, step, { what: 'prompt', text: step.prompt });

  if (prompt instanceof Object) return { error: prompt.message };

  if (step.model === undefined || step.model instanceof Object) return { prompt };
  const model = renderLeaseText(context, step, { what: 'model', text: step.model });

  if (model instanceof Object) return { error: model.message };

  return { prompt, model };
}

/**
 * The inputs workflow `child` starts with when step `step` of run `run` runs it whole, rendered from `values` as its
 * owner's lease rendered them from the run. An inline workflow takes no `with`: it reads the inputs around it, which
 * `values` carries as its steps read them.
 */
export function leaseInputs(step: Pick<WorkflowStep, 'with'>, child: WorkflowDefinition | InlineWorkflow, values: LeaseValues, run: RunId): { inputs: JsonValue } | { error: string } {
  if (!isWorkflowFile(child)) return { inputs: values.inputs ?? {} };

  return wholeInputs(step, child, valuesContext(values, run));
}

/** Offers `lease` of attempt `attempt` to pool `pool`, once its start commit is on the attempt's ref. */
export async function offerAttempt(config: LocalConfig, input: {
  run: RunId; attempt: AttemptId; pool: string; repository: string; owner: HandoffOwner; start: string; staleAfterMs: number; lease: FleetLease;
  definition: Offered['definition']; values: LeaseValues; secrets: Record<string, string>;
}): Promise<Written<Offered>> {
  const { secrets, ...fields } = input;
  const record: Offered = { version: RECORD_VERSION, teamai: getCurrentVersion(), ...fields, write: randomUUID(), offeredAt: new Date().toISOString(), state: 'offered' };
  const unfit = unpublishable(record, secrets);

  if (unfit) return { ok: false, error: unfit };
  // An attempt is offered once: a record already there is the one an earlier drive of this attempt wrote.
  const written = await writeRecord(config, record, { replaces: undefined, message: `[teamai] Offer attempt ${record.attempt} of run ${record.run}` });

  return written.ok ? { ok: true, value: record } : written;
}

/**
 * Replaces offer `offered` with this install's claim; another member's claim first answers `state_moved`. The claim is
 * noted in this install's data home before it is written, so a restarted member finishes only claims it wrote.
 */
export async function claimAttempt(config: LocalConfig, offered: Offered, member: HandoffOwner): Promise<Written<Claimed>> {
  const now = new Date().toISOString();
  const claim: Claimed = { ...offered, write: randomUUID(), state: 'claimed', member, claimedAt: now, progressAt: now, pushed: offered.start };
  const marker = claimedMarker(config, offered.run, offered.attempt);
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, `${JSON.stringify({ write: claim.write })}\n`, 'utf8');
  const written = await writeRecord(config, claim, { replaces: offered.write, message: `[teamai] Claim attempt ${offered.attempt} of run ${offered.run}` });

  if (!written.ok && written.error.code === 'state_moved') await fs.rm(marker, { force: true });

  return written.ok ? { ok: true, value: claim } : written;
}

/**
 * Writes that the member of claim `held` still runs it, and has pushed `pushed` to the attempt's ref: asking the owner
 * `question` while its whole workflow waits at that gate.
 */
export async function recordProgress(config: LocalConfig, held: HeldAttempt, pushed: string, asked?: { question: ExecQuestion; secrets: Record<string, string> }): Promise<Written<HeldAttempt>> {
  const claim: Claimed = { ...claimOf(held), write: randomUUID(), progressAt: new Date().toISOString(), pushed };
  const progressed: HeldAttempt = asked === undefined ? claim : { ...claim, state: 'asking', question: asked.question };
  // A gate's message is rendered from the run, so it is checked as a finished result is before it is published.
  const unfit = asked && unpublishable(progressed, asked.secrets);

  if (unfit) return { ok: false, error: unfit };
  const written = await writeRecord(config, progressed, { replaces: held.write, message: `[teamai] Progress of attempt ${held.attempt} of run ${held.run}` });

  return written.ok ? { ok: true, value: progressed } : written;
}

/**
 * Gives up claim `claimed`, whose member wrote no progress for longer than the pool allows, or did not answer the cancel
 * of it in that time.
 */
export async function expireClaim(config: LocalConfig, claimed: HeldAttempt | Cancelling): Promise<Written<Extract<FleetRecord, { state: 'expired' }>>> {
  const expired: Extract<FleetRecord, { state: 'expired' }> = { ...(claimed.state === 'cancelling' ? claimed : claimOf(claimed)), write: randomUUID(), state: 'expired', expiredAt: new Date().toISOString() };
  const written = await writeRecord(config, expired, { replaces: claimed.write, message: `[teamai] Expire attempt ${claimed.attempt} of run ${claimed.run}` });

  return written.ok ? { ok: true, value: expired } : written;
}

/**
 * Cancels attempt `record` through its record: an offer no member claimed is withdrawn, and a claim becomes `cancelling`,
 * which its member answers once it stopped the step. Another write first answers `state_moved`.
 */
export async function cancelAttempt(config: LocalConfig, record: Offered | HeldAttempt): Promise<Written<Extract<FleetRecord, { state: 'withdrawn' | 'cancelling' }>>> {
  const now = new Date().toISOString();
  const cancel: Extract<FleetRecord, { state: 'withdrawn' | 'cancelling' }> = record.state === 'offered' ? { ...record, write: randomUUID(), state: 'withdrawn', withdrawnAt: now } : { ...claimOf(record), write: randomUUID(), state: 'cancelling', cancelAt: now };
  const written = await writeRecord(config, cancel, { replaces: record.write, message: `[teamai] Cancel attempt ${record.attempt} of run ${record.run}` });

  return written.ok ? { ok: true, value: cancel } : written;
}

/** Writes the owner's answer `answer` to the question of claim `asking`; a progress of its member that landed first answers `state_moved`. */
export async function answerQuestion(config: LocalConfig, asking: Asking, answer: ExecAnswer): Promise<Written<Extract<FleetRecord, { state: 'answered' }>>> {
  const answered: Extract<FleetRecord, { state: 'answered' }> = { ...asking, write: randomUUID(), state: 'answered', answer };
  const written = await writeRecord(config, answered, { replaces: asking.write, message: `[teamai] Answer attempt ${asking.attempt} of run ${asking.run}` });

  return written.ok ? { ok: true, value: answered } : written;
}

/** Answers the cancel of claim `cancelling`: its member stopped the step, whose work up to `pushed` is on the attempt's ref. */
export async function answerCancel(config: LocalConfig, cancelling: Cancelling, pushed: string): Promise<Written<Extract<FleetRecord, { state: 'cancelled' }>>> {
  const cancelled: Extract<FleetRecord, { state: 'cancelled' }> = { ...cancelling, write: randomUUID(), state: 'cancelled', cancelledAt: new Date().toISOString(), pushed };
  const written = await writeRecord(config, cancelled, { replaces: cancelling.write, message: `[teamai] Cancelled attempt ${cancelling.attempt} of run ${cancelling.run}` });

  return written.ok ? { ok: true, value: cancelled } : written;
}

/**
 * Writes how claim `claimed` ended. A stderr snippet that may not leave this machine, such as a tool's warning that
 * names its cwd, is left out and the result stands; any other field that may not fails the attempt instead, naming the
 * field, so the owner does not wait on it.
 */
export async function finishAttempt(config: LocalConfig, claimed: HeldAttempt, result: FleetResult, secrets: Record<string, string>): Promise<Written<FleetRecord>> {
  const finished: FleetRecord = { ...claimOf(claimed), write: randomUUID(), state: 'finished', finishedAt: new Date().toISOString(), result };

  // A tool's failure message is as free as stderr, so it goes too, keeping its code.
  const quiet: FleetRecord = {
    ...finished,
    result: { ...result, stderr: 'Its stderr is not shown here: it names a path of the member\'s machine or a secret.', ...(result.failure && { failure: { code: result.failure.code, message: 'Its message is not shown here: it names a path of the member\'s machine or a secret.' } }) },
  };

  const fit = [finished, quiet].find((candidate) => unpublishable(candidate, secrets) === undefined);
  const record: FleetRecord = fit ?? { ...finished, result: { exitCode: 1, stderr: unpublishable(quiet, secrets)?.message ?? '' } };
  const written = await writeRecord(config, record, { replaces: claimed.write, message: `[teamai] Finish attempt ${claimed.attempt} of run ${claimed.run}` });

  return written.ok ? { ok: true, value: record } : written;
}

/** The record of attempt `attempt` as origin holds it now, or `absent`. */
export async function readAttemptRecord(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<Written<FleetRecord | 'absent'>> {
  // The team clone, which every install has: its reports checkout may not exist yet.
  const read = await fetchReportsOriginFile(gitRoot(config), recordPath(run, attempt));

  switch (read.status) {
    case 'absent':
      return { ok: true, value: 'absent' };
    case 'unreachable':
      return { ok: false, error: { code: 'reports_unreachable', message: `teamai-reports could not be read (${sanitizeGitUrl(read.reason)}).` } };
    case 'found':
      return parseRecord(read.text, run, attempt);
    default: {
      const unhandled: never = read;

      return unhandled;
    }
  }
}

/** Whether record text `text` says it is in a format of another teamai's, older or newer than this one's. */
function isOtherFormat(text: string): boolean {
  const format = RecordFormatSchema.safeParse(jsonOf(text));

  return format.success && format.data.version !== RECORD_VERSION;
}

function parseRecord(text: string, run: string, attempt: string): Written<FleetRecord> {
  const raw = jsonOf(text);
  const format = RecordFormatSchema.safeParse(raw);

  // A newer teamai's format may mean anything here: it is never read as this one's.
  if (format.success && format.data.version > RECORD_VERSION) {
    const by = format.data.teamai;

    return { ok: false, error: { code: 'fleet_record_newer', message: `The record of attempt ${attempt} of run ${run} on teamai-reports was written by teamai ${by ?? 'newer than this one'}, in a format this teamai cannot read. Upgrade teamai${by === undefined ? '' : ` to ${by} or later`}.` } };
  }

  if (format.success && format.data.version < RECORD_VERSION) {
    return { ok: false, error: { code: 'fleet_record_unreadable', message: `The record of attempt ${attempt} of run ${run} on teamai-reports was written by teamai ${format.data.teamai ?? 'older than this one'}, in an older format this teamai does not read. Upgrade teamai on the install that offered it.` } };
  }

  const parsed = FleetRecordSchema.safeParse(raw);

  if (!parsed.success || parsed.data.run !== run || parsed.data.attempt !== attempt) {
    return { ok: false, error: { code: 'fleet_record_unreadable', message: `The record of attempt ${attempt} of run ${run} on teamai-reports cannot be read.` } };
  }

  return { ok: true, value: parsed.data };
}

/**
 * The records of run `run`, or of every run, as this machine's copy of `teamai-reports` holds them: refresh it first. A
 * record that does not parse, or names another run or attempt than its path, is left out.
 */
async function listRecords(config: LocalConfig, run?: RunId): Promise<FleetRecord[]> {
  const root = path.join(getReportsDir(config), ATTEMPTS_DIR);
  const runs = run === undefined ? (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).flatMap((entry) => (entry.isDirectory() ? [entry.name] : [])) : [run];
  const records: FleetRecord[] = [];

  for (const name of runs) {
    const files = await fs.readdir(path.join(root, name)).catch(() => []);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const text = await fs.readFile(path.join(root, name, file), 'utf8').catch(() => '');
      const parsed = parseRecord(text, name, file.slice(0, -'.json'.length));

      if (parsed.ok) records.push(parsed.value);
      // Another teamai's format is worth saying: one of the two installs is to upgrade.
      else if (isOtherFormat(text)) log.warn(`Skipped an attempt: ${parsed.error.message}`);
    }
  }

  return records;
}

/** An attempt out on a fleet: offered, claimed (asking or answered too), or claimed and asked to stop. */
export type OpenAttempt = Extract<FleetRecord, { state: 'offered' | 'claimed' | 'asking' | 'answered' | 'cancelling' }>;

/** The attempts out for business repository `repository`, oldest offer first, as `workflow resume` lists them. */
export async function listOpenAttempts(config: LocalConfig, repository: string): Promise<OpenAttempt[]> {
  const open = (await listRecords(config)).flatMap((record) => (record.repository === repository && (record.state === 'offered' || isHeld(record) || record.state === 'cancelling') ? [record] : []));

  return open.sort((left, right) => left.offeredAt.localeCompare(right.offeredAt));
}

/**
 * The attempts offered to pool `pool` for business repository `repository`, oldest offer first, as this machine's copy
 * of `teamai-reports` holds them: refresh it first.
 */
export async function listOffers(config: LocalConfig, { pool, repository }: { pool: string; repository: string }): Promise<Offered[]> {
  const offers = (await listRecords(config)).flatMap((record) => (record.state === 'offered' && record.pool === pool && record.repository === repository ? [record] : []));

  return offers.sort((left, right) => left.offeredAt.localeCompare(right.offeredAt));
}

type Gone = Extract<FleetRecord, { state: 'expired' | 'cancelling' | 'cancelled' }>;

/** When the owner gave the claim of `record` up or cancelled it, by the owner's clock: a member's may be off. */
function goneAt(record: Gone): string {
  switch (record.state) {
    case 'expired': return record.expiredAt;
    case 'cancelling': return record.cancelAt;
    case 'cancelled': return record.cancelAt;
    default: {
      const unhandled: never = record;

      return unhandled;
    }
  }
}

/**
 * The last attempt of step `step` of run `run` that this install offered and whose claim it gave up or cancelled after
 * its member pushed work, as this machine's copy of `teamai-reports` holds it: refresh it first. A retry of the step
 * goes on from that work. A cancel its member never answered counts with the work it pushed before: a member that
 * answers later changes nothing.
 */
export async function lastGoneWork(config: LocalConfig, { run, step }: { run: RunId; step: string }): Promise<{ attempt: AttemptId; pushed: string } | undefined> {
  let last: Gone | undefined;

  for (const record of await listRecords(config, run)) {
    if (record.state !== 'expired' && record.state !== 'cancelling' && record.state !== 'cancelled') continue;

    if (record.lease.step !== step || record.pushed === record.start) continue;

    // Only an attempt this install offered: anyone who can write teamai-reports can write a record, naming any owner.
    if (await offeredPool(config, run, record.attempt) === undefined) continue;

    if (last === undefined || goneAt(record) > goneAt(last)) last = record;
  }

  return last && { attempt: last.attempt, pushed: last.pushed };
}

/** A record a member's claim wrote: claimed, finished, given up, cancelling or cancelled. */
export type MemberRecord = Exclude<FleetRecord, Offered | Extract<FleetRecord, { state: 'withdrawn' }>>;

/**
 * The records of claims this install wrote as member `member` for business repository `repository`, oldest claim
 * first, as this machine's copy of `teamai-reports` holds them: refresh it first. A member that starts stops what its
 * earlier runs of these left, and finishes the claims it still holds before it takes a new offer. A record that names
 * this member for a claim it never wrote here is not its own: anyone who can write teamai-reports can write one.
 */
export async function listMemberRecords(config: LocalConfig, { member, repository }: { member: HandoffOwner; repository: string }): Promise<MemberRecord[]> {
  const named: MemberRecord[] = [];

  for (const record of await listRecords(config)) {
    if (record.state === 'offered' || record.state === 'withdrawn') continue;

    if (record.member.id === member.id && record.repository === repository && await isClaimedHere(config, record.run, record.attempt)) named.push(record);
  }

  return named.sort((left, right) => left.claimedAt.localeCompare(right.claimedAt));
}

/**
 * Writes `record` while origin still holds the write `replaces`, or no record when `replaces` is undefined. A write in
 * between answers `state_moved`, as does one that landed while this write could not tell.
 */
async function writeRecord(config: LocalConfig, record: FleetRecord, { replaces, message }: { replaces: string | undefined; message: string }): Promise<Written<void>> {
  const rel = recordPath(record.run, record.attempt);
  const moved: FleetError = { code: 'state_moved', message: `Attempt ${record.attempt} of run ${record.run} changed on teamai-reports meanwhile, so this write did not land.` };

  const result = await updateReports(config, async (worktree, update): Promise<ReportsChange<Written<void>>> => {
    const read = await fetchReportsOriginFile(worktree, rel, update);

    if (read.status === 'unreachable') return { value: { ok: false, error: { code: 'reports_unreachable', message: `teamai-reports could not be read (${sanitizeGitUrl(read.reason)}).` } }, write: null };
    const held = read.status === 'found' ? parseRecord(read.text, record.run, record.attempt) : undefined;

    if (held && !held.ok) return { value: held, write: null };

    if ((held?.value.write) !== replaces) return { value: { ok: false, error: moved }, write: null };
    await fs.mkdir(path.join(worktree, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(worktree, rel), recordText({ ...record, teamai: getCurrentVersion() }), 'utf8');

    return { value: { ok: true, value: undefined }, write: { files: [rel], message } };
  });

  if (result.value && !result.value.ok) return result.value;

  if (result.status === 'published' || result.status === 'already-present') return { ok: true, value: undefined };
  // The write may still have landed, or another one first, as when two members race for an offer: origin decides.
  const now = await readAttemptRecord(config, record.run, record.attempt);

  if (now.ok && now.value !== 'absent' && now.value.write === record.write) return { ok: true, value: undefined };

  if (now.ok && (now.value === 'absent' ? undefined : now.value.write) !== replaces) return { ok: false, error: moved };
  const reason = result.status === 'failed' ? ` (${sanitizeGitUrl(result.reason)})` : ' (another write held teamai-reports)';

  return { ok: false, error: { code: 'reports_failed', message: `Attempt ${record.attempt} of run ${record.run} could not be written to teamai-reports${reason}. Try again.` } };
}

/** `attempts/<attempt>/fleet.json` in this install's data home: the pool the owner offered the attempt to. */
function offeredMarker(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'fleet.json');
}

/**
 * Notes, before the offer is written, that attempt `attempt` goes to pool `pool` from the exec `offer.op`, with
 * `offer.staleAfterMs`, so a restarted owner offers it as it was going to and waits on it again, and a cancel with no
 * live driver reaches it.
 */
export async function markOffered(config: LocalConfig, run: RunId, attempt: AttemptId, pool: string, offer?: { op: OpId; staleAfterMs: number }): Promise<void> {
  const file = offeredMarker(config, run, attempt);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ pool, ...offer })}\n`, 'utf8');
}

/** `attempts/<attempt>/fleet-claim.json` in this install's data home: this install claimed the attempt as a member. */
function claimedMarker(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'fleet-claim.json');
}

/** Whether this install wrote a claim of attempt `attempt`. */
async function isClaimedHere(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<boolean> {
  return fs.access(claimedMarker(config, run, attempt)).then(() => true, () => false);
}

const OfferedMarkerSchema = z.object({ pool: z.string().min(1), op: OpIdSchema.optional(), staleAfterMs: z.number().int().positive().optional() });

/** What this install noted when it offered attempt `attempt`: its pool, the exec that offered it and its stale_after; undefined when it offered it to none. */
export async function readOfferedMarker(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<z.infer<typeof OfferedMarkerSchema> | undefined> {
  const text = await fs.readFile(offeredMarker(config, run, attempt), 'utf8').catch(() => undefined);
  const parsed = text === undefined ? undefined : OfferedMarkerSchema.safeParse(jsonOf(text));

  return parsed?.success ? parsed.data : undefined;
}

/** The pool this install offered attempt `attempt` to, or undefined when it offered it to none. */
export async function offeredPool(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<string | undefined> {
  return (await readOfferedMarker(config, run, attempt))?.pool;
}

/** `text` as JSON, or undefined when it does not parse. */
function jsonOf(text: string): JsonValue | undefined {
  try {
    return parseJson(text);
  } catch {
    return undefined;
  }
}

/** A fleet error as the workflow failure a step or a command answers with. */
export function fleetFailure(error: FleetError): WorkflowFailure {
  return { code: error.code, message: error.message };
}
