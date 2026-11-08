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
import { sanitizeGitUrl } from '@teamai/shared/redact';
import { getReportsDir, type LocalConfig } from '../../types.js';
import { gitRoot } from '../../utils/branch-worktree.js';
import { fetchReportsOriginFile, updateReports, type ReportsChange } from '../../utils/reports-branch.js';
import { isJsonObject } from '../../types.js';
import { JsonValueSchema, parseJson, type JsonValue } from '../../utils/json.js';
import { expressionPaths, isIndex } from '../expression.js';
import { firstUnfit, RunDefinitionSchema, type HandoffOwner } from '../snapshot.js';
import { attemptDir, AttemptIdSchema, RunIdSchema, type AttemptId, type RunId } from '../store.js';
import { parseTemplate, renderText, templateExpressions, type TemplateContext } from '../template.js';
import type { WorkflowFailure, WorkflowStep } from '../types.js';

/** Where the records of every offered attempt live on `teamai-reports`. */
const ATTEMPTS_DIR = 'workflows/attempts';

const OwnerSchema = z.object({ id: z.string().min(1), user: z.string() });

/** A full commit id, never a name git would resolve on the reading machine, such as a branch or `stash@{0}`, or read as an option. */
const CommitSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'must be a full commit id');

/**
 * What a member runs, as the owner rendered it: never an argv, a credential value or a path of the owner's machine.
 * `env` is the step's rendered `env`.
 */
const FleetLeaseSchema = z.object({
  step: z.string().min(1),
  command: z.string().min(1),
  env: z.record(z.string(), z.string()),
});

export type FleetLease = z.infer<typeof FleetLeaseSchema>;

/**
 * What the step's env reads, which a member renders the env from with its own copy of the step: the inputs it reads, by
 * name, the outputs of the steps it reads, by step id, and the item. Values only: the command and the env's templates
 * come from the team's workflow, never from the record.
 */
const LeaseValuesSchema = z.object({
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
const FleetResultSchema = z.object({
  exitCode: z.number().int(),
  outputs: JsonValueSchema.optional(),
  stderr: z.string(),
  to: CommitSchema.optional(),
});

export type FleetResult = z.infer<typeof FleetResultSchema>;

const OfferedSchema = z.object({
  version: z.literal(1),
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
  definition: RunDefinitionSchema,
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

/** A claim the owner asked its member to stop, which the member answers with `cancelled` once its step stopped. */
const CancellingSchema = ClaimedSchema.extend({ state: z.literal('cancelling'), cancelAt: z.string() });

/** A cancelled claim: the member stopped its step and pushed its work up to `pushed`, which a retry goes on from. */
const CancelledSchema = CancellingSchema.extend({ state: z.literal('cancelled'), cancelledAt: z.string() });

export const FleetRecordSchema = z.discriminatedUnion('state', [OfferedSchema, ClaimedSchema, FinishedSchema, ExpiredSchema, WithdrawnSchema, CancellingSchema, CancelledSchema]);

export type FleetRecord = z.infer<typeof FleetRecordSchema>;

type Offered = Extract<FleetRecord, { state: 'offered' }>;

export type Claimed = Extract<FleetRecord, { state: 'claimed' }>;

export type Cancelling = Extract<FleetRecord, { state: 'cancelling' }>;

/** A record no write replaces: whatever its member does later changes nothing. */
export type Settled = Extract<FleetRecord, { state: 'finished' | 'expired' | 'withdrawn' | 'cancelled' }>;

export type FleetError =
  | { code: 'state_moved'; message: string }
  | { code: 'reports_unreachable' | 'reports_failed' | 'fleet_unpublishable' | 'fleet_record_unreadable'; message: string };

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
  // A command names the paths it reads and writes, such as /dev/null, wherever it runs: only a secret keeps it here.
  const inCommand = firstUnfit(record.lease.command, secrets);
  const commandHit = inCommand?.unfit.kind === 'secret' ? { at: ['lease', 'command'], unfit: inCommand.unfit } : undefined;
  const hit = commandHit ?? firstUnfit(JsonValueSchema.parse({ ...record, lease: { ...record.lease, command: '' } }), secrets);

  if (hit === undefined) return undefined;
  const field = hit.at.join('.');
  const what = hit.unfit.kind === 'secret' ? `what looks like a secret (${hit.unfit.label})` : 'an absolute path of this machine';

  return { code: 'fleet_unpublishable', message: `Attempt ${record.attempt} of run ${record.run} was not written to teamai-reports: its "${field}" holds ${what}.` };
}

/**
 * What the env of command step `step` reads in `context`, the context its lease rendered the env in, or why a member
 * could not render the env from values: it reads something besides inputs, the item, the run's id and steps' outputs.
 */
export function leaseValues(step: Pick<WorkflowStep, 'id' | 'env'>, context: TemplateContext): { values: LeaseValues } | { error: string } {
  const inputs = new Set<string>();
  const outputs = new Set<string>();
  let wholeInputs = false;
  let readsItem = false;

  for (const [name, text] of Object.entries(step.env ?? {})) {
    const parsed = parseTemplate(text, Object.hasOwn(context, 'item'));

    if (!parsed.ok) return { error: `Step "${step.id}" env ${name} does not parse: ${parsed.errors[0]?.message ?? ''}` };

    for (const read of templateExpressions(parsed.template).flatMap(expressionPaths)) {
      if (read.root === 'steps' && read.field !== 'outputs') {
        return { error: `Step "${step.id}" env ${name} reads steps.${read.step}.${read.field}, which a fleet member cannot render: on the fleet a step's env reads only inputs, item, run.id and steps' outputs.` };
      }

      const [first] = read.fields;

      if (read.root === 'inputs') {
        if (first === undefined || isIndex(first)) wholeInputs = true;
        else inputs.add(first);
      }

      if (read.root === 'steps') outputs.add(read.step);

      if (read.root === 'item') readsItem = true;
    }
  }

  const values: LeaseValues = {};
  const given = JsonValueSchema.safeParse(context.inputs ?? {});
  const all = given.success ? given.data : {};

  if (wholeInputs || !isJsonObject(all)) values.inputs = all;
  else if (inputs.size > 0) {
    values.inputs = Object.fromEntries([...inputs].flatMap((name) => {
      const value = all[name];

      return value === undefined ? [] : [[name, value]];
    }));
  }

  if (outputs.size > 0) {
    values.outputs = Object.fromEntries([...outputs].flatMap((id) => {
      const read = JsonValueSchema.safeParse(context.steps[id]?.outputs);

      return read.success ? [[id, read.data]] : [];
    }));
  }

  const item = JsonValueSchema.safeParse(context.item);

  if (readsItem && item.success) values.item = item.data;

  return { values };
}

/** The env of command step `step` in run `run`, rendered from `values` as its owner's lease rendered it from the run. */
export function leaseEnv(step: Pick<WorkflowStep, 'id' | 'env'>, values: LeaseValues, run: RunId): { env: Record<string, string> } | { error: string } {
  const context: TemplateContext = {
    inputs: values.inputs ?? {},
    steps: Object.fromEntries(Object.entries(values.outputs ?? {}).map(([id, outputs]) => [id, { outputs }])),
    run: { id: run },
    ...(Object.hasOwn(values, 'item') && { item: values.item }),
  };

  const env: Record<string, string> = {};

  for (const [name, text] of Object.entries(step.env ?? {})) {
    const parsed = parseTemplate(text, Object.hasOwn(context, 'item'));

    if (!parsed.ok) return { error: `env ${name} does not parse: ${parsed.errors[0]?.message ?? ''}` };
    env[name] = renderText(parsed.template, context);
  }

  return { env };
}

/** Offers `lease` of attempt `attempt` to pool `pool`, once its start commit is on the attempt's ref. */
export async function offerAttempt(config: LocalConfig, input: {
  run: RunId; attempt: AttemptId; pool: string; repository: string; owner: HandoffOwner; start: string; staleAfterMs: number; lease: FleetLease;
  definition: Offered['definition']; values: LeaseValues; secrets: Record<string, string>;
}): Promise<Written<Offered>> {
  const { secrets, ...fields } = input;
  const record: Offered = { version: 1, ...fields, write: randomUUID(), offeredAt: new Date().toISOString(), state: 'offered' };
  const unfit = unpublishable(record, secrets);

  if (unfit) return { ok: false, error: unfit };
  // An attempt is offered once: a record already there is the one an earlier drive of this attempt wrote.
  const written = await writeRecord(config, record, { replaces: undefined, message: `[teamai] Offer attempt ${record.attempt} of run ${record.run}` });

  return written.ok ? { ok: true, value: record } : written;
}

/** Replaces offer `offered` with this install's claim; another member's claim first answers `state_moved`. */
export async function claimAttempt(config: LocalConfig, offered: Offered, member: HandoffOwner): Promise<Written<Claimed>> {
  const now = new Date().toISOString();
  const claim: Claimed = { ...offered, write: randomUUID(), state: 'claimed', member, claimedAt: now, progressAt: now, pushed: offered.start };
  const written = await writeRecord(config, claim, { replaces: offered.write, message: `[teamai] Claim attempt ${offered.attempt} of run ${offered.run}` });

  return written.ok ? { ok: true, value: claim } : written;
}

/** Writes that the member of claim `claimed` still runs it, and has pushed `pushed` to the attempt's ref. */
export async function recordProgress(config: LocalConfig, claimed: Claimed, pushed: string): Promise<Written<Claimed>> {
  const progressed: Claimed = { ...claimed, write: randomUUID(), progressAt: new Date().toISOString(), pushed };
  const written = await writeRecord(config, progressed, { replaces: claimed.write, message: `[teamai] Progress of attempt ${claimed.attempt} of run ${claimed.run}` });

  return written.ok ? { ok: true, value: progressed } : written;
}

/**
 * Gives up claim `claimed`, whose member wrote no progress for longer than the pool allows, or did not answer the cancel
 * of it in that time.
 */
export async function expireClaim(config: LocalConfig, claimed: Claimed | Cancelling): Promise<Written<Extract<FleetRecord, { state: 'expired' }>>> {
  const expired: Extract<FleetRecord, { state: 'expired' }> = { ...claimed, write: randomUUID(), state: 'expired', expiredAt: new Date().toISOString() };
  const written = await writeRecord(config, expired, { replaces: claimed.write, message: `[teamai] Expire attempt ${claimed.attempt} of run ${claimed.run}` });

  return written.ok ? { ok: true, value: expired } : written;
}

/**
 * Cancels attempt `record` through its record: an offer no member claimed is withdrawn, and a claim becomes `cancelling`,
 * which its member answers once it stopped the step. Another write first answers `state_moved`.
 */
export async function cancelAttempt(config: LocalConfig, record: Offered | Claimed): Promise<Written<Extract<FleetRecord, { state: 'withdrawn' | 'cancelling' }>>> {
  const now = new Date().toISOString();
  const cancel: Extract<FleetRecord, { state: 'withdrawn' | 'cancelling' }> = record.state === 'offered' ? { ...record, write: randomUUID(), state: 'withdrawn', withdrawnAt: now } : { ...record, write: randomUUID(), state: 'cancelling', cancelAt: now };
  const written = await writeRecord(config, cancel, { replaces: record.write, message: `[teamai] Cancel attempt ${record.attempt} of run ${record.run}` });

  return written.ok ? { ok: true, value: cancel } : written;
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
export async function finishAttempt(config: LocalConfig, claimed: Claimed, result: FleetResult, secrets: Record<string, string>): Promise<Written<FleetRecord>> {
  const finished: FleetRecord = { ...claimed, write: randomUUID(), state: 'finished', finishedAt: new Date().toISOString(), result };
  const quiet: FleetRecord = { ...finished, result: { ...result, stderr: 'Its stderr is not shown here: it names a path of the member\'s machine or a secret.' } };
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

function parseRecord(text: string, run: string, attempt: string): Written<FleetRecord> {
  const parsed = FleetRecordSchema.safeParse(jsonOf(text));

  if (!parsed.success || parsed.data.run !== run || parsed.data.attempt !== attempt) {
    return { ok: false, error: { code: 'fleet_record_unreadable', message: `The record of attempt ${attempt} of run ${run} on teamai-reports cannot be read.` } };
  }

  return { ok: true, value: parsed.data };
}

/**
 * The attempts offered to pool `pool` for business repository `repository`, oldest offer first, as this machine's copy
 * of `teamai-reports` holds them: refresh it first.
 */
export async function listOffers(config: LocalConfig, { pool, repository }: { pool: string; repository: string }): Promise<Offered[]> {
  const root = path.join(getReportsDir(config), ATTEMPTS_DIR);
  const runs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const offers: Offered[] = [];

  for (const run of runs) {
    if (!run.isDirectory()) continue;
    const files = await fs.readdir(path.join(root, run.name)).catch(() => []);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const text = await fs.readFile(path.join(root, run.name, file), 'utf8').catch(() => '');
      const parsed = parseRecord(text, run.name, file.slice(0, -'.json'.length));

      if (parsed.ok && parsed.value.state === 'offered' && parsed.value.pool === pool && parsed.value.repository === repository) offers.push(parsed.value);
    }
  }

  return offers.sort((left, right) => left.offeredAt.localeCompare(right.offeredAt));
}

/** When the claim of `record`, expired or cancelled, stopped counting. */
function goneAt(record: Extract<FleetRecord, { state: 'expired' | 'cancelled' }>): string {
  return record.state === 'expired' ? record.expiredAt : record.cancelledAt;
}

/**
 * The last attempt of step `step` of run `run` whose claim the owner gave up or cancelled after its member pushed work,
 * as this machine's copy of `teamai-reports` holds it: refresh it first. A retry of the step goes on from that work.
 */
export async function lastGoneWork(config: LocalConfig, { run, step, owner }: { run: RunId; step: string; owner: HandoffOwner }): Promise<{ attempt: AttemptId; pushed: string } | undefined> {
  const dir = path.join(getReportsDir(config), ATTEMPTS_DIR, run);
  const files = await fs.readdir(dir).catch(() => []);
  let last: Extract<FleetRecord, { state: 'expired' | 'cancelled' }> | undefined;

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const text = await fs.readFile(path.join(dir, file), 'utf8').catch(() => '');
    const parsed = parseRecord(text, run, file.slice(0, -'.json'.length));

    if (!parsed.ok || (parsed.value.state !== 'expired' && parsed.value.state !== 'cancelled')) continue;
    const gone = parsed.value;

    // Only an attempt this install offered: anyone who can write teamai-reports can write a record.
    if (gone.owner.id !== owner.id || gone.lease.step !== step || gone.pushed === gone.start) continue;

    if (last === undefined || goneAt(gone) > goneAt(last)) last = gone;
  }

  return last && { attempt: last.attempt, pushed: last.pushed };
}

/** A record a member's claim wrote: claimed, finished, given up, cancelling or cancelled. */
export type MemberRecord = Exclude<FleetRecord, Offered | Extract<FleetRecord, { state: 'withdrawn' }>>;

/**
 * The records that name member `member` for business repository `repository`, oldest claim first, as this machine's copy
 * of `teamai-reports` holds them: refresh it first. A member that starts stops what its earlier runs of these left, and
 * finishes the claims it still holds before it takes a new offer.
 */
export async function listMemberRecords(config: LocalConfig, { member, repository }: { member: HandoffOwner; repository: string }): Promise<MemberRecord[]> {
  const root = path.join(getReportsDir(config), ATTEMPTS_DIR);
  const runs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const named: MemberRecord[] = [];

  for (const run of runs) {
    if (!run.isDirectory()) continue;
    const files = await fs.readdir(path.join(root, run.name)).catch(() => []);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const text = await fs.readFile(path.join(root, run.name, file), 'utf8').catch(() => '');
      const parsed = parseRecord(text, run.name, file.slice(0, -'.json'.length));

      if (!parsed.ok || parsed.value.state === 'offered' || parsed.value.state === 'withdrawn') continue;

      if (parsed.value.member.id === member.id && parsed.value.repository === repository) named.push(parsed.value);
    }
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
    await fs.writeFile(path.join(worktree, rel), recordText(record), 'utf8');

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

/** Notes, before the offer is written, that attempt `attempt` goes to pool `pool`, so a restarted owner waits on it again. */
export async function markOffered(config: LocalConfig, run: RunId, attempt: AttemptId, pool: string): Promise<void> {
  const file = offeredMarker(config, run, attempt);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ pool })}\n`, 'utf8');
}

/** The pool this install offered attempt `attempt` to, or undefined when it offered it to none. */
export async function offeredPool(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<string | undefined> {
  const text = await fs.readFile(offeredMarker(config, run, attempt), 'utf8').catch(() => undefined);

  if (text === undefined) return undefined;
  const parsed = z.object({ pool: z.string().min(1) }).safeParse(jsonOf(text));

  return parsed.success ? parsed.data.pool : undefined;
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
