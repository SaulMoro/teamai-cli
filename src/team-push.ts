import YAML from 'yaml';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readUsageEvents, truncateUsageAfterReport } from './usage-tracker.js';
import { aggregateUsage } from './stats.js';
import { readEvents, aggregateSessionMetrics, dataHomeKey } from './dashboard-collector.js';
import {
  createGit,
  pushRepoDirectly,
  pullRepo,
  resetToCleanMaster,
  isDedicatedRepoRoot,
  getFileContentAtRev,
} from './utils/git.js';
import { writeFile, readFileSafe, ensureDir, pathExists, readJson, writeJson } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { UserStats, UserInterventionStats, SessionMetrics, TokenUsage, DashboardEvent, LocalConfig } from './types.js';
import { getVotesDir, getDataHome, emptyTokenUsage, addTokenUsage, usesBranchWorktree } from './types.js';
import { filterEventsByScope, runsOfLog } from './dashboard-scope.js';
import {
  creditedPrompts, interventionsEntry, promptTokensEntry, readOwnerCredits, recordSessionOwners, reportedBeyondShared, reportedSize,
  sharedSnapshotPath, snapshotPathIn,
  type ReportedInterventions, type ReportedPromptTokens, type ReportedSegments, type ReportedSnapshotName,
} from './session-owners.js';
import {
  aggregateDailySessions,
  computeDailyStatsDelta,
  mergeDailyStats,
  takeDailySession,
  type DailySessionSnapshot,
  type ReportedDailySessions,
} from './session-trends.js';

/** Cumulative delta for conversation-turn count + token usage (Issue #75). */
interface PromptTokenDelta {
  prompts: number;
  tokens: TokenUsage;
}

// ─── Auto-report flow (during teamai pull) ─────────────
//
//  teamai pull
//      │
//      ▼
//  [pull team resources] ── existing flow ──
//      │
//      ▼
//  [reportUsageToTeam()]
//      │
//      ▼
//  [git pull latest] ── get freshest remote state ──
//      │
//      ▼
//  [read scope usage file] ─has events?─▶ merge stats
//      │                                           │
//      ▼                                           ▼
//  [stage pending votes from scope votes dir]   [write stats/<user>.yaml]
//      │                                           │
//      ▼  ◄────────────────────────────────────────┘
//  [anything to push?] ──no──▶ SKIP
//      │
//      ▼
//  [git add + commit + push]
//      │
//      ├──success──▶ truncate JSONL (if events existed)
//      └──fail──▶ retain local events and reported snapshots
//  pull bounds its wait for the whole operation, including success bookkeeping.
//

/**
 * Read existing stats YAML for a user, returning null if not found or invalid.
 */
async function readExistingStats(statsPath: string): Promise<UserStats | null> {
  try {
    const content = await readFileSafe(statsPath);
    if (!content) return null;
    const parsed = YAML.parse(content) as UserStats;
    if (parsed?.username && parsed?.skills) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Merge new aggregated events into existing stats.
 * Counts are cumulative; lastUsed takes the more recent value.
 */
export function mergeStats(
  existing: UserStats | null,
  username: string,
  newEvents: { name: string; count: number; lastUsed: Date }[],
): UserStats {
  const skills: Record<string, { count: number; lastUsed: string }> = {};

  if (existing?.skills) {
    for (const [name, data] of Object.entries(existing.skills)) {
      skills[name] = { count: data.count, lastUsed: data.lastUsed };
    }
  }

  for (const stat of newEvents) {
    const prev = skills[stat.name];
    const newLastUsed = stat.lastUsed.toISOString();

    if (prev) {
      prev.count += stat.count;
      if (newLastUsed > prev.lastUsed) {
        prev.lastUsed = newLastUsed;
      }
    } else {
      skills[stat.name] = { count: stat.count, lastUsed: newLastUsed };
    }
  }

  return {
    username,
    updatedAt: new Date().toISOString(),
    skills,
    // Preserve session metrics across partial reports (Issue #425).
    // mergeStats only refreshes skills/username/updatedAt; callers overwrite
    // interventions/prompts/tokens when that report carries a non-empty delta.
    ...(existing?.interventions !== undefined ? { interventions: existing.interventions } : {}),
    ...(existing?.prompts !== undefined ? { prompts: existing.prompts } : {}),
    ...(existing?.tokens !== undefined ? { tokens: existing.tokens } : {}),
    ...(existing?.daily !== undefined ? { daily: existing.daily } : {}),
  };
}

// ─── Human Intervention reporting (Issue #34) ──────────
//
//  events.jsonl ──aggregateSessionInterventions──▶ current per-session snapshot
//       │                                                │
//       ▼                                                ▼
//  reported-interventions.json (last reported)  ──delta──▶ merge into stats/<user>.yaml
//
//  The local reported snapshot makes reporting idempotent: re-running pull never
//  double-counts a session, since we only add the positive change since last report.
//

// ─── Reported snapshots, one set per scope (#786) ──────
//
//  <dataHome>/dashboard/reported-<name>.json          project scope
//  ~/.teamai/dashboard/user-reported-<name>.json      user scope
//  ~/.teamai/dashboard/reported-<name>.json           shared, written before #786
//
//  A session can record events in two scopes (a `cd` mid-session), so each
//  scope compares against what it reported itself. The first time a scope needs
//  a snapshot, it migrates the shared entries for its retained unkeyed runs;
//  path-keyed releases already wrote scope snapshots. After that only its own
//  file is read. No scope writes the shared file any more, only an earlier
//  release after a rollback (and a caller without a scope config, which reads
//  the whole log and reports into it).
//

/** A scope's own snapshot. The user scope's data home holds the shared one, hence its prefix. */
function scopeSnapshotPath(name: ReportedSnapshotName, config: LocalConfig | undefined): string {
  return config ? snapshotPathIn(getDataHome(config), name) : sharedSnapshotPath(name);
}


/**
 * A scope's snapshot, seeded from the shared one when the scope has none yet.
 * The shared file summed every scope's runs of an ID, so they consume it in
 * the order of the whole log, and the scope keeps its own runs' shares.
 * `split` gives each run of the log its entry at its own totals and its share
 * of a bare entry, for {@link adoptBareKeys}.
 */
async function readSnapshot<T>(
  name: ReportedSnapshotName,
  config: LocalConfig | undefined,
  split: (events: DashboardEvent[]) => Promise<{ current: Record<string, T>; take: TakeReported<T> }>,
): Promise<Record<string, T> | null> {
  const own = scopeSnapshotPath(name, config);
  if (!config || await pathExists(own)) return readJson<Record<string, T>>(own);
  const shared = await readJson<Record<string, T>>(sharedSnapshotPath(name));
  const logged = await readEvents();
  const all = await runsOfLog(logged);
  const events = await filterEventsByScope(logged, config);
  const { current, take } = await split(all);
  const adopted = adoptBareKeys(shared ?? {}, all, current, take, 'shared');
  // A tool's own session ID is one session, so its entry is copied whole, as
  // before: resumed after compaction dropped its events, it is not sent again.
  // A fallback entry is copied only as a run of this scope: an unmatched bare
  // one cannot be allowed to attach to a future reuse of its PID.
  const ownRuns = new Set(events.map((e) => e.sessionId));
  const seed: Record<string, T> = {};
  for (const [id, entry] of Object.entries(adopted)) {
    if (!id.startsWith('pid-') || ownRuns.has(id)) seed[id] = entry;
  }
  try {
    await writeJson(own, seed);
  } catch (e) {
    // Seeded again next time: the shared file is not written any more.
    log.debug(`Could not seed ${own}: ${(e as Error).message}`);
  }
  return seed;
}

export async function readReportedInterventions(config: LocalConfig | undefined): Promise<ReportedInterventions> {
  const parsed = await readSnapshot('interventions', config, async (events) => ({
    current: Object.fromEntries(interventionCounts(aggregateSessionMetrics(events))),
    take: takeInterventions(await sharedCoverage(events)),
  }));
  return parsed && typeof parsed === 'object' ? parsed : {};
}

async function writeReportedInterventions(data: ReportedInterventions, config: LocalConfig | undefined): Promise<void> {
  try {
    await writeJson(scopeSnapshotPath('interventions', config), data);
  } catch (e) {
    log.error(`Failed to persist reported interventions: ${(e as Error).message}`);
  }
}

/** Each session's intervention counts, the shape its snapshot entry holds. */
export function interventionCounts(metrics: Map<string, SessionMetrics>): Map<string, ReportedInterventions[string]> {
  return new Map([...metrics].map(([sid, m]) => [sid, { interrupt: m.interrupt, toolReject: m.toolReject, correction: m.correction }]));
}

/** A counter's share of what is left: up to the run's own. */
function upTo(own: number, left: number): number {
  return Math.max(0, Math.min(own, left));
}

/**
 * A run's prompt and token share of a bare entry. This snapshot decides which
 * runs of the ID that release reported: the ones its prompts and tokens reach.
 */
const takePromptTokens: TakeReported<ReportedPromptTokens[string]> = (run, entry) => {
  // Read from a snapshot file an earlier release wrote, so parsed, not trusted.
  const left = promptTokensEntry(entry);
  if (left.prompts <= 0 && !hasPromptTokenDelta({ prompts: 0, tokens: left.tokens })) return undefined;
  const taken = {
    prompts: upTo(run.prompts, left.prompts),
    tokens: {
      input: upTo(run.tokens.input, left.tokens.input),
      output: upTo(run.tokens.output, left.tokens.output),
      cacheRead: upTo(run.tokens.cacheRead, left.tokens.cacheRead),
      cacheCreation: upTo(run.tokens.cacheCreation, left.tokens.cacheCreation),
    },
  };
  return { taken, left: { prompts: left.prompts - taken.prompts, tokens: tokenDelta(left.tokens, taken.tokens) } };
};

/**
 * A run's intervention share, for the runs `covered`, the prompt-token
 * snapshot's: these counts are mostly zero, so running out says nothing.
 */
function takeInterventions(covered: (runId: string) => boolean): TakeReported<ReportedInterventions[string]> {
  return (run, entry, runId) => {
    if (!covered(runId)) return undefined;
    const left = interventionsEntry(entry);
    const taken = {
      interrupt: upTo(run.interrupt, left.interrupt),
      toolReject: upTo(run.toolReject, left.toolReject),
      correction: upTo(run.correction, left.correction),
    };
    return {
      taken,
      left: {
        interrupt: left.interrupt - taken.interrupt,
        toolReject: left.toolReject - taken.toolReject,
        correction: left.correction - taken.correction,
      },
    };
  };
}

/** The runs of the whole log (`all`) the shared prompt-token snapshot covers, for seeding. */
async function sharedCoverage(all: DashboardEvent[]): Promise<(runId: string) => boolean> {
  const shared = await readJson<ReportedPromptTokens>(sharedSnapshotPath('prompt-tokens'));
  const current = computePromptTokenDelta(aggregateSessionMetrics(all), {}).nextReported;
  const covered = adoptBareKeys(shared ?? {}, all, current, takePromptTokens, 'shared');
  return (runId) => Object.hasOwn(covered, runId);
}

/** A run's daily share, for the runs `covered`, as for interventions. */
function takeDaily(covered: (runId: string) => boolean): TakeReported<DailySessionSnapshot> {
  return (run, left, runId) => (covered(runId) ? takeDailySession(run, left) : undefined);
}

/**
 * Compute the intervention delta to report: for each current session, the positive
 * change since it was last reported. A session not seen before contributes +1 to
 * `sessions`. The next snapshot keeps only sessions still present in events.jsonl
 * (already-compacted sessions are final and stay folded into the team total).
 */
export function computeInterventionDelta(
  current: Map<string, { interrupt: number; toolReject: number; correction: number }>,
  reported: ReportedInterventions,
): { delta: UserInterventionStats; nextReported: ReportedInterventions } {
  const delta: UserInterventionStats = { sessions: 0, interrupt: 0, toolReject: 0, correction: 0 };
  const nextReported: ReportedInterventions = {};

  for (const [sid, cur] of current) {
    const prev = reported[sid];
    if (!prev) delta.sessions += 1;
    delta.interrupt += Math.max(0, cur.interrupt - (prev?.interrupt ?? 0));
    delta.toolReject += Math.max(0, cur.toolReject - (prev?.toolReject ?? 0));
    delta.correction += Math.max(0, cur.correction - (prev?.correction ?? 0));
    nextReported[sid] = cur;
  }

  return { delta, nextReported };
}

/** Accumulate an intervention delta onto the user's existing totals. */
export function mergeInterventionStats(
  existing: UserInterventionStats | undefined,
  delta: UserInterventionStats,
): UserInterventionStats {
  return {
    sessions: (existing?.sessions ?? 0) + delta.sessions,
    interrupt: (existing?.interrupt ?? 0) + delta.interrupt,
    toolReject: (existing?.toolReject ?? 0) + delta.toolReject,
    correction: (existing?.correction ?? 0) + delta.correction,
  };
}

/** True when a delta carries any new data worth pushing. */
function hasInterventionDelta(d: UserInterventionStats): boolean {
  return d.sessions > 0 || d.interrupt > 0 || d.toolReject > 0 || d.correction > 0;
}

// ─── Conversation-turn + token reporting (Issue #75) ───
//
//  events.jsonl ──aggregateSessionMetrics──▶ current per-session {prompts, tokens}
//       │                                              │
//       ▼                                              ▼
//  reported-prompt-tokens.json (last reported)  ──delta──▶ merge into stats/<user>.yaml
//
//  Separate snapshot from interventions so each metric stays independently idempotent.
//

export async function readReportedPromptTokens(config: LocalConfig | undefined): Promise<ReportedPromptTokens> {
  const parsed = await readSnapshot('prompt-tokens', config, async (events) => ({
    current: computePromptTokenDelta(aggregateSessionMetrics(events), {}).nextReported,
    take: takePromptTokens,
  }));
  return parsed && typeof parsed === 'object' ? parsed : {};
}

async function writeReportedPromptTokens(data: ReportedPromptTokens, config: LocalConfig | undefined): Promise<void> {
  try {
    await writeJson(scopeSnapshotPath('prompt-tokens', config), data);
  } catch (e) {
    log.error(`Failed to persist reported prompt/token snapshot: ${(e as Error).message}`);
  }
}

/** Field-by-field positive token delta (never negative if a snapshot shrinks). */
function tokenDelta(cur: TokenUsage, prev: TokenUsage | undefined): TokenUsage {
  return {
    input: Math.max(0, cur.input - (prev?.input ?? 0)),
    output: Math.max(0, cur.output - (prev?.output ?? 0)),
    cacheRead: Math.max(0, cur.cacheRead - (prev?.cacheRead ?? 0)),
    cacheCreation: Math.max(0, cur.cacheCreation - (prev?.cacheCreation ?? 0)),
  };
}

/** A rollout's key in a snapshot: its transcript path, hashed. */
function segmentKey(transcript: string): string {
  return createHash('sha256').update(transcript).digest('hex').slice(0, 16);
}

/** The reported rollouts of a snapshot entry read from a file; empty when it holds none. */
function reportedSegments(entry: unknown): ReportedSegments {
  const segments: ReportedSegments = {};
  if (!entry || typeof entry !== 'object' || !('segments' in entry) || !entry.segments || typeof entry.segments !== 'object') {
    return segments;
  }
  for (const [key, segment] of Object.entries(entry.segments)) segments[key] = promptTokensEntry(segment);
  return segments;
}

/**
 * Compute the prompt-count + token delta to report: for each current session, the
 * positive change since it was last reported. Idempotent (a re-run reports nothing
 * new), and never negative if a snapshot shrinks. The next snapshot keeps only
 * sessions still present in events.jsonl (compacted sessions stay folded into totals).
 *
 * A transcript-scoped session (Codex) is reported per rollout: each rollout's
 * counters restart, and the session's total sums those still in the log. A
 * rollout already reported that compaction has since dropped keeps its reported
 * totals in the sum, so a later rollout of the session is reported in full
 * rather than against them. An entry written before rollouts were kept is
 * compared as a whole, then kept per rollout.
 */
export function computePromptTokenDelta(
  current: Map<string, SessionMetrics>,
  reported: ReportedPromptTokens,
): { delta: PromptTokenDelta; nextReported: ReportedPromptTokens } {
  const delta: PromptTokenDelta = { prompts: 0, tokens: emptyTokenUsage() };
  const nextReported: ReportedPromptTokens = {};

  for (const [sid, cur] of current) {
    const prev = reported[sid];
    let prompts = cur.prompts;
    let tokens = cur.tokens;
    let segments: ReportedSegments | undefined;
    if (cur.segments) {
      segments = {};
      for (const [transcript, segment] of Object.entries(cur.segments)) {
        segments[segmentKey(transcript)] = { prompts: segment.prompts, tokens: { ...segment.tokens } };
      }
      for (const [key, gone] of Object.entries(reportedSegments(prev))) {
        if (Object.hasOwn(segments, key)) continue;
        segments[key] = gone;
        prompts += gone.prompts;
        tokens = addTokenUsage(tokens, gone.tokens);
      }
    }
    delta.prompts += Math.max(0, prompts - (prev?.prompts ?? 0));
    delta.tokens = addTokenUsage(delta.tokens, tokenDelta(tokens, prev?.tokens));
    nextReported[sid] = { prompts, tokens, ...(segments ? { segments } : {}) };
  }

  return { delta, nextReported };
}

/** Accumulate a prompt/token delta onto the user's existing totals. */
export function mergePromptTokenStats(
  existingPrompts: number | undefined,
  existingTokens: TokenUsage | undefined,
  delta: PromptTokenDelta,
): { prompts: number; tokens: TokenUsage } {
  return {
    prompts: (existingPrompts ?? 0) + delta.prompts,
    tokens: addTokenUsage(existingTokens, delta.tokens),
  };
}

/** True when a prompt/token delta carries any new data worth pushing. */
function hasPromptTokenDelta(d: PromptTokenDelta): boolean {
  return d.prompts > 0 || d.tokens.input > 0 || d.tokens.output > 0
    || d.tokens.cacheRead > 0 || d.tokens.cacheCreation > 0;
}

async function readReportedDailySessions(config: LocalConfig | undefined): Promise<ReportedDailySessions> {
  return (await readSnapshot('daily-sessions', config, async (events) => ({
    current: computeDailyStatsDelta(aggregateDailySessions(events), {}).nextReported,
    take: takeDaily(await sharedCoverage(events)),
  }))) ?? {};
}

async function writeReportedDailySessions(data: ReportedDailySessions, config: LocalConfig | undefined): Promise<void> {
  await writeJson(scopeSnapshotPath('daily-sessions', config), data);
}

function hasDailyDelta(delta: ReturnType<typeof computeDailyStatsDelta>['delta']): boolean {
  return Object.values(delta).some((bucket) =>
    // sessionsSucceeded can be negative (a resumed session that later failed
    // claws back an earlier increment), so it must not be checked with the
    // same "> 0" as the other, purely monotonic counters (#473).
    bucket.sessionsEnded > 0 || bucket.sessionsSucceeded !== 0 || bucket.promptTurns > 0
    || bucket.durationMs > 0 || bucket.sessionsCorrected > 0 || bucket.pricedRequests > 0
    || bucket.costMicros > 0 || bucket.cacheReadTokens > 0 || bucket.cacheEligibleInputTokens > 0,
  );
}

/**
 * A session main split across scopes, crediting every part it reported. Main
 * (#795) gave each event to the scope its `dataHome` names and reported each
 * part against that scope's own snapshot, so a scope's entry may hold only its
 * part (prompts counted before any Stop carried the transcript's total). The
 * scope that owns the whole run now takes as reported the metrics of the union
 * of those parts: for each scope, the shortest prefix of its events whose own
 * metrics reach its snapshot. Only an entry that union exceeds is replaced, so a
 * run already reported past it is left alone; runs whose events name at most
 * one data home are untouched.
 */
async function creditSplitRuns(
  events: DashboardEvent[],
  reported: { interventions: ReportedInterventions; promptTokens: ReportedPromptTokens; daily: ReportedDailySessions },
): Promise<{
  interventions: ReportedInterventions; promptTokens: ReportedPromptTokens; daily: ReportedDailySessions; changed: boolean;
}> {
  const byRun = new Map<string, DashboardEvent[]>();
  for (const e of events) byRun.set(e.sessionId, [...(byRun.get(e.sessionId) ?? []), e]);
  const result = {
    interventions: { ...reported.interventions }, promptTokens: { ...reported.promptTokens }, daily: { ...reported.daily },
    changed: false,
  };
  const credits = await readOwnerCredits();
  for (const [runId, runEvents] of byRun) {
    const homes = new Set(runEvents.flatMap((e) => (typeof e.dataHome === 'string' ? [e.dataHome] : [])));
    // Its parts' events are gone: the credit the owners file seeded from their snapshots.
    const credit = homes.size < 2 ? credits.get(runId) : undefined;
    if (credit) {
      // Placed by the transcript where it can tell what the parts overlapped.
      const transcripts = runEvents.flatMap((e) => (typeof e.transcriptPath === 'string' ? [e.transcriptPath] : []));
      const prompts = (await creditedPrompts(credit, transcripts)) ?? credit.promptTokens.prompts;
      if (reportedSize(result.promptTokens[runId]).prompts >= prompts) continue;
      result.promptTokens[runId] = { ...credit.promptTokens, prompts };
      result.interventions[runId] = credit.interventions;
      if (credit.daily) result.daily[runId] = { ...credit.daily, prompts };
      result.changed = true;
      continue;
    }
    if (homes.size < 2) continue;
    // Main keyed its snapshots by the session ID, before runs had their own.
    const id = runId.startsWith('pid-') ? runId.slice(0, runId.lastIndexOf('@')) : runId;
    const counted = new Set<DashboardEvent>();
    for (const home of homes) {
      const snapshot = await readJson<Record<string, unknown>>(snapshotPathIn(home, 'prompt-tokens'));
      const target = reportedSize(snapshot?.[id]);
      if (!snapshot || !Object.hasOwn(snapshot, id)) continue;
      const part = runEvents.filter((e) => e.dataHome === home);
      for (let k = 1; k <= part.length; k++) {
        const size = aggregateSessionMetrics(part.slice(0, k)).get(runId);
        const tokens = size ? size.tokens.input + size.tokens.output + size.tokens.cacheRead + size.tokens.cacheCreation : 0;
        if (k === part.length || (size && size.prompts >= target.prompts && tokens >= target.tokens)) {
          for (const e of part.slice(0, k)) counted.add(e);
          break;
        }
      }
    }
    const union = runEvents.filter((e) => counted.has(e));
    if (union.length === 0) continue;
    const metrics = aggregateSessionMetrics(union);
    const promptTokens = computePromptTokenDelta(metrics, {}).nextReported[runId];
    if (!promptTokens || reportedSize(result.promptTokens[runId]).prompts >= promptTokens.prompts) continue;
    result.promptTokens[runId] = promptTokens;
    const interventions = interventionCounts(metrics).get(runId);
    if (interventions) result.interventions[runId] = interventions;
    const daily = computeDailyStatsDelta(aggregateDailySessions(union), {}).nextReported[runId];
    if (daily) result.daily[runId] = daily;
    result.changed = true;
  }
  return result;
}

/**
 * A scope's reported snapshots as its report and `teamai stats` compare them:
 * bare entries adopted by the runs of `events` (prompt tokens first, since they
 * decide which runs of a bare ID were reported), and a session an earlier
 * release split across scopes credited with every part. With `persist`, what
 * changed is written out at once, even with nothing to report, so the report's
 * success writes, which merge into the files, cannot bring a retired entry back.
 */
export async function reportedBaselines(
  events: DashboardEvent[],
  metrics: Map<string, SessionMetrics>,
  currentDaily: Map<string, DailySessionSnapshot>,
  config: LocalConfig | undefined,
  persist: boolean,
): Promise<{ interventions: ReportedInterventions; promptTokens: ReportedPromptTokens; daily: ReportedDailySessions }> {
  const adopt = async <T>(
    read: (config: LocalConfig | undefined) => Promise<Record<string, T>>,
    write: (data: Record<string, T>, config: LocalConfig | undefined) => Promise<void>,
    current: Record<string, T>,
    take: TakeReported<T>,
  ): Promise<Record<string, T>> => {
    const stored = await read(config);
    const adopted = adoptBareKeys(stored, events, current, take);
    if (persist && adopted !== stored) await write(adopted, config);
    return adopted;
  };
  const promptTokens = await adopt(
    readReportedPromptTokens, writeReportedPromptTokens, computePromptTokenDelta(metrics, {}).nextReported, takePromptTokens,
  );
  const covered = (runId: string) => Object.hasOwn(promptTokens, runId);
  const interventions = await adopt(
    readReportedInterventions, writeReportedInterventions, Object.fromEntries(interventionCounts(metrics)),
    takeInterventions(covered),
  );
  const daily = await adopt(
    readReportedDailySessions, writeReportedDailySessions, computeDailyStatsDelta(currentDaily, {}).nextReported,
    takeDaily(covered),
  );
  const credited = await creditSplitRuns(events, { interventions, promptTokens, daily });
  if (persist && credited.changed) {
    await writeReportedInterventions(credited.interventions, config);
    await writeReportedPromptTokens(credited.promptTokens, config);
    await writeReportedDailySessions(credited.daily, config);
  }
  return { interventions: credited.interventions, promptTokens: credited.promptTokens, daily: credited.daily };
}

/**
 * A run's share of what is left of a bare snapshot entry, or undefined when
 * nothing is left: that run and every later one of its ID were not reported.
 */
export type TakeReported<T> = (run: T, left: T, runId: string) => { taken: T; left: T } | undefined;

/**
 * A reported snapshot as the run IDs of {@link filterEventsByScope} read it.
 * Snapshots written before fallback runs had their own IDs are keyed by the
 * bare `pid-…` ID, holding the sum of the runs of that ID in the log at that
 * release's last report; compaction keeps or drops the runs of an ID together.
 * So the runs of that ID in `events` (the scope's, as that filter returns them)
 * consume the entry in order, each taking its share, from its totals in
 * `current`, of what is left; once nothing is left, the later runs take none
 * and are reported as new. The first run always takes one: the entry means
 * that release reported it. A run's own entry is never replaced, and the bare
 * entry is retired, so no later run of that ID reads it. Only an earlier
 * release wrote bare entries, and only for runs it recorded, so a run whose
 * first event carries a `dataHomeKey`, and every later run of its ID, takes
 * none: the entry may be another scope's run under a reused PID-fallback ID.
 * Shared snapshots also exclude path-keyed runs: that release already had
 * per-scope snapshots. A tool's own session ID keys its one run as it is, so
 * its entry needs no adoption. Returns `reported` itself when there is nothing
 * to retire; otherwise the caller persists the result.
 */
export function adoptBareKeys<T>(
  reported: Record<string, T>,
  events: Iterable<DashboardEvent>,
  current: Record<string, T>,
  take: TakeReported<T>,
  source: 'scope' | 'shared' = 'scope',
): Record<string, T> {
  const legacyRuns = new Map<string, string[]>();
  const recorded = new Set<string>();
  const seen = new Set<string>();
  for (const { sessionId: runId, dataHomeKey, dataHome } of events) {
    if (seen.has(runId) || !runId.startsWith('pid-')) continue;
    seen.add(runId);
    const id = runId.slice(0, runId.lastIndexOf('@'));
    if (recorded.has(id) || !Object.hasOwn(reported, id)) continue;
    if (typeof dataHomeKey === 'string' || (source === 'shared' && typeof dataHome === 'string')) {
      recorded.add(id);
      continue;
    }
    legacyRuns.set(id, [...(legacyRuns.get(id) ?? []), runId]);
  }
  if (legacyRuns.size === 0) return reported;
  const adopted = { ...reported };
  for (const [id, runs] of legacyRuns) {
    let left = reported[id];
    let first = true;
    for (const runId of runs) {
      if (!Object.hasOwn(current, runId)) continue;
      const share = take(current[runId], left, runId);
      if (!share) {
        if (first && !Object.hasOwn(adopted, runId)) adopted[runId] = left;
        break;
      }
      if (!Object.hasOwn(adopted, runId)) adopted[runId] = share.taken;
      left = share.left;
      first = false;
    }
    delete adopted[id];
  }
  return adopted;
}

/**
 * Auto-report usage data to team repo during pull.
 * Merges new events with existing stats to preserve historical data.
 * Best-effort: silently fails on any error.
 * Resolves only after push and success bookkeeping settle. The caller may bound
 * its wait, but must keep this operation alive so late success is acknowledged.
 * Returns false when reporting was skipped or failed; true when there is no
 * pending data or the report completed successfully.
 */
export async function reportUsageToTeam(
  repoPath: string,
  username: string,
  options?: { skipTruncate?: boolean; selfConfig?: LocalConfig },
): Promise<boolean> {
  // Non-HTTP repos: stats + votes are report data → the teamai-reports orphan
  // branch (isolated worktree). We must NOT resetToCleanMaster / pullRepo /
  // pushRepoDirectly on the default branch (or, in self mode, the business
  // working tree). The dedicated writer handles the worktree + rebase race.
  const reportsConfig = options?.selfConfig;
  const useReportsBranch = !!reportsConfig && usesBranchWorktree(reportsConfig);
  let restoreStats: (() => Promise<void>) | undefined;

  // Reports-branch writes use the reports-lock, not the partition sync-lock
  // (non-reentrant; pull() already holds it). The else-branch clone reset is
  // only for callers that did not pass a config.

  try {
    // This scope's own skill usage (#748); a caller without a scope reports none.
    const events = reportsConfig ? await readUsageEvents(reportsConfig) : [];
    // This scope's own votes (#787), likewise.
    const votesDir = reportsConfig ? getVotesDir(reportsConfig) : undefined;
    const filesToPush: string[] = [];

    // Fold the local dashboard event log into per-session metrics once, then derive
    // both the intervention delta and the prompt-count/token delta from it.
    // Only the sessions recorded in this scope (#785).
    const dashboardEvents = await filterEventsByScope(await readEvents(), reportsConfig);
    const metrics = aggregateSessionMetrics(dashboardEvents);

    const currentInterventions = interventionCounts(metrics);
    const currentDaily = aggregateDailySessions(dashboardEvents);
    const {
      interventions: reportedInterventions, promptTokens: reportedPromptTokens, daily: reportedDailySessions,
    } = await reportedBaselines(dashboardEvents, metrics, currentDaily, reportsConfig, true);
    const { delta: promptTokenDelta, nextReported: nextReportedPromptTokens } = computePromptTokenDelta(
      metrics,
      reportedPromptTokens,
    );
    const { delta: interventionDelta, nextReported } = computeInterventionDelta(
      currentInterventions,
      reportedInterventions,
    );
    const { delta: dailyDelta, nextReported: nextReportedDailySessions } = computeDailyStatsDelta(
      currentDaily,
      reportedDailySessions,
    );
    // This scope's sessions, and those of its snapshots no owner claims yet
    // (a project whose data home is in its workspace, which the seed may miss).
    if (reportsConfig) {
      await recordSessionOwners([
        ...dashboardEvents.map((e) => e.sessionId),
        ...await reportedBeyondShared(reportedPromptTokens, reportedInterventions, reportedDailySessions),
      ], await dataHomeKey(getDataHome(reportsConfig)));
    }

    const hasUsage = events.length > 0;
    const hasInterventions = hasInterventionDelta(interventionDelta);
    const hasPromptTokens = hasPromptTokenDelta(promptTokenDelta);
    const hasDaily = hasDailyDelta(dailyDelta);

    const hasStats = hasUsage || hasInterventions || hasPromptTokens || hasDaily;
    const commitMsg = hasUsage
      ? `[teamai] Update usage stats for ${username}`
      : (hasInterventions || hasPromptTokens || hasDaily)
        ? `[teamai] Update session stats for ${username}`
        : `[teamai] Update votes for ${username}`;

    const writeReportFiles = async (writeRoot: string): Promise<void> => {
      // Process usage and/or intervention/prompt/token stats if anything is new to report.
      if (hasStats) {
        const statsDir = path.join(writeRoot, 'stats');
        await ensureDir(statsDir);
        const statsPath = path.join(statsDir, `${username}.yaml`);

        // See also: stats.ts mergeLocalAndReported() — same merge logic for display.
        // mergeStats with [] preserves existing skills while refreshing username/updatedAt,
        // and carries interventions/prompts/tokens so partial reports do not clobber them (#425).
        const existing = await readExistingStats(statsPath);
        if (useReportsBranch) {
          const previousContent = await readFileSafe(statsPath);
          // A failed push can leave an already-incremented file in the reports
          // worktree. Restore its input so a normal retry does not add it twice.
          restoreStats = () => writeFile(statsPath, previousContent ?? '');
        }
        const newStats = hasUsage ? aggregateUsage(events) : [];
        const merged = mergeStats(existing, username, newStats);
        if (hasInterventions) {
          merged.interventions = mergeInterventionStats(existing?.interventions, interventionDelta);
        }
        if (hasPromptTokens) {
          const pt = mergePromptTokenStats(existing?.prompts, existing?.tokens, promptTokenDelta);
          merged.prompts = pt.prompts;
          merged.tokens = pt.tokens;
        }
        if (hasDaily) {
          merged.daily = mergeDailyStats(existing?.daily, dailyDelta);
        }

        await writeFile(statsPath, YAML.stringify(merged));
        filesToPush.push(`stats/${username}.yaml`);
      }

      // Always stage pending local votes (V2 delta-aware merge)
      try {
        if (votesDir && await pathExists(votesDir)) {
          const { syncVotesToTeam } = await import('./votes.js');
          const synced = await syncVotesToTeam(writeRoot, username, votesDir);
          if (synced) {
            filesToPush.push(`votes/${username}.yaml`);
          }
        }
      } catch (e) {
        log.error(`Vote staging skipped: ${(e as Error).message}`);
      }
    };

    // Keep push and acknowledgement in the same operation. A caller timing out
    // must not abandon the success bookkeeping below.
    if (useReportsBranch && reportsConfig) {
      let hasVotes = false;
      if (!hasStats && votesDir && await pathExists(votesDir)) {
        const { hasPendingVoteDeltas } = await import('./votes.js');
        hasVotes = await hasPendingVoteDeltas(votesDir, username);
      }
      if (!hasStats && !hasVotes) {
        log.debug('No usage events or votes to report');
        return true;
      }
      const { updateReports } = await import('./utils/reports-branch.js');
      const pushed = await updateReports(reportsConfig, async (wt) => {
        filesToPush.length = 0;
        await writeReportFiles(wt);
        return filesToPush.length > 0 ? { files: [...filesToPush], message: commitMsg } : null;
      }, { pushIfUnchanged: true });
      if (!pushed) {
        log.debug('Auto-report push was not confirmed; keeping local report data');
        await restoreStats?.();
        return false;
      }
    } else {
      // The team repo is a disposable cache clone here — safe to discard local state
      // and reset to the default branch before pulling (same pattern as push.ts).
      //
      // Defense-in-depth: this whole else-branch assumes repoPath is a dedicated clone
      // ROOT with its own .git. If it is not the git top level, git commands here bubble
      // up to the nearest enclosing .git and act on the USER'S BUSINESS REPO instead —
      // reset --hard wipes their uncommitted work and checkout switches them off their
      // branch. Two known ways repoPath ends up inside the business repo:
      //   - self mode: localPath is `<businessRoot>/.teamai`
      //   - project scope: localPath is `<projectRoot>/.teamai/team-repo`, and when that
      //     dir has no dedicated .git (clone missing/incomplete) it resolves to the
      //     business repo root.
      // In either case bail out: there is no safe cache root to report into.
      const git = createGit(repoPath);
      if (!(await isDedicatedRepoRoot(repoPath))) {
        log.debug(`Skipping report: ${repoPath} is not a dedicated team-repo root (safety guard)`);
        return false;
      }
      const { isImportInProgress } = await import('./utils/import-lock.js');
      if (await isImportInProgress(repoPath)) {
        log.debug(`Skipping report: import in progress for ${repoPath} (would reset uncommitted artifacts)`);
        return false;
      }
      const yamlPath = path.join(repoPath, 'teamai.yaml');
      const workingContent = await readFileSafe(yamlPath);
      const committedContent = workingContent === null
        ? null
        : await getFileContentAtRev(repoPath, 'HEAD', 'teamai.yaml');
      const pendingTeamConfig = workingContent !== null
        && (committedContent === null || committedContent.toString() !== workingContent)
        ? workingContent
        : null;

      try {
        await resetToCleanMaster(git, repoPath);
        await pullRepo(repoPath);
      } finally {
        // `source add` and `source remove` intentionally leave teamai.yaml
        // uncommitted until `teamai push`. Auto-report must not discard those edits.
        // Keep the complete local version, matching pushCore: it remains an explicit
        // working-tree diff for review instead of being silently committed here.
        if (pendingTeamConfig !== null) {
          await writeFile(yamlPath, pendingTeamConfig);
        }
      }

      await writeReportFiles(repoPath);
      if (filesToPush.length === 0) {
        log.debug('No usage events or votes to report');
        return true;
      }
      await pushRepoDirectly(repoPath, commitMsg, filesToPush);
    }
    restoreStats = undefined;

    // Success — truncate reported usage events (only if caller allows it)
    if (hasUsage && reportsConfig && !options?.skipTruncate) {
      await truncateUsageAfterReport(events.length, reportsConfig);
      log.debug(`Reported ${events.length} usage events to team repo`);
    } else if (hasUsage) {
      log.debug(`Reported ${events.length} usage events to team repo (kept local copy)`);
    }
    // Success — advance the reported snapshots so we don't re-count.
    // Merge (not overwrite) because each scope only touches its own sessions.
    if (hasInterventions) {
      const existingIv = await readReportedInterventions(reportsConfig);
      await writeReportedInterventions({ ...existingIv, ...nextReported }, reportsConfig);
      log.debug(`Reported intervention delta (${interventionDelta.sessions} new sessions) to team repo`);
    }
    if (hasPromptTokens) {
      const existingPt = await readReportedPromptTokens(reportsConfig);
      await writeReportedPromptTokens({ ...existingPt, ...nextReportedPromptTokens }, reportsConfig);
      log.debug(`Reported prompt/token delta (${promptTokenDelta.prompts} prompts) to team repo`);
    }
    if (hasDaily) {
      const existingDaily = await readReportedDailySessions(reportsConfig);
      await writeReportedDailySessions({ ...existingDaily, ...nextReportedDailySessions }, reportsConfig);
      log.debug(`Reported daily session trends (${Object.keys(dailyDelta).length} UTC day buckets) to team repo`);
    }
    if (!hasUsage && !hasInterventions && !hasPromptTokens && !hasDaily) {
      log.debug('Pushed pending votes to team repo');
    }
    return true;
  } catch (e) {
    try {
      await restoreStats?.();
    } catch (restoreError) {
      log.error(`Could not restore report stats after failure: ${(restoreError as Error).message}`);
    }
    log.error(`Auto-report skipped: ${(e as Error).message}`);
    return false;
  }
}
