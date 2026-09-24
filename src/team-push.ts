import YAML from 'yaml';
import fs from 'node:fs';
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
import { getVotesDir, getDataHome, getTeamaiHomeDir, emptyTokenUsage, addTokenUsage, usesBranchWorktree } from './types.js';
import { getUserHome } from './utils/home.js';
import {
  aggregateDailySessions,
  computeDailyStatsDelta,
  mergeDailyStats,
  takeDailySession,
  type DailySessionSnapshot,
  type ReportedDailySessions,
} from './session-trends.js';

/** Snapshot of already-reported per-session intervention counts (idempotency basis). */
type ReportedInterventions = Record<string, { interrupt: number; toolReject: number; correction: number }>;

/** Snapshot of already-reported per-session prompt counts + token usage (idempotency basis). */
type ReportedPromptTokens = Record<string, { prompts: number; tokens: TokenUsage }>;

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

type ReportedSnapshotName = 'interventions' | 'prompt-tokens' | 'daily-sessions';

/** The machine-level snapshot every scope shared before #786 (evaluated at call time for tests). */
function sharedSnapshotPath(name: ReportedSnapshotName): string {
  return path.join(getTeamaiHomeDir(), 'dashboard', `reported-${name}.json`);
}

/** A scope's own snapshot. The user scope's data home holds the shared one, hence its prefix. */
function scopeSnapshotPath(name: ReportedSnapshotName, config: LocalConfig | undefined): string {
  if (!config) return sharedSnapshotPath(name);
  const dataHome = getDataHome(config);
  const file = `reported-${name}.json`;
  if (path.resolve(dataHome) !== path.resolve(getTeamaiHomeDir())) return path.join(dataHome, 'dashboard', file);
  return path.join(dataHome, 'dashboard', `user-${file}`);
}

/**
 * A scope's snapshot, seeded from the shared one when the scope has none yet.
 * `split` gives each run's entry at its own totals and its share of a bare
 * entry, for {@link adoptBareKeys}.
 */
async function readSnapshot<T>(
  name: ReportedSnapshotName,
  config: LocalConfig | undefined,
  split: (events: DashboardEvent[]) => Promise<{ current: Record<string, T>; take: TakeReported<T> }>,
): Promise<Record<string, T> | null> {
  const own = scopeSnapshotPath(name, config);
  if (!config || await pathExists(own)) return readJson<Record<string, T>>(own);
  const shared = await readJson<Record<string, T>>(sharedSnapshotPath(name));
  const events = await filterEventsByScope(await readEvents(), config);
  const { current, take } = await split(events);
  const adopted = adoptBareKeys(shared ?? {}, events, current, take, 'shared');
  // Copy only resolved run IDs. An unmatched bare entry cannot be allowed to
  // attach to a future reuse after the source of the snapshot has been lost.
  const seed: Record<string, T> = {};
  for (const { sessionId } of events) {
    if (Object.hasOwn(adopted, sessionId)) seed[sessionId] = adopted[sessionId];
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
  const parsed = await readSnapshot('interventions', config, async (events) => {
    const promptTokens = await readReportedPromptTokens(config);
    return {
      current: Object.fromEntries(interventionCounts(aggregateSessionMetrics(events))),
      take: takeInterventions((runId) => Object.hasOwn(promptTokens, runId)),
    };
  });
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
function interventionCounts(metrics: Map<string, SessionMetrics>): Map<string, ReportedInterventions[string]> {
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
export const takePromptTokens: TakeReported<ReportedPromptTokens[string]> = (run, left) => {
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
export function takeInterventions(covered: (runId: string) => boolean): TakeReported<ReportedInterventions[string]> {
  return (run, left, runId) => {
    if (!covered(runId)) return undefined;
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

/**
 * Compute the prompt-count + token delta to report: for each current session, the
 * positive change since it was last reported. Idempotent (a re-run reports nothing
 * new), and never negative if a snapshot shrinks. The next snapshot keeps only
 * sessions still present in events.jsonl (compacted sessions stay folded into totals).
 */
export function computePromptTokenDelta(
  current: Map<string, SessionMetrics>,
  reported: ReportedPromptTokens,
): { delta: PromptTokenDelta; nextReported: ReportedPromptTokens } {
  const delta: PromptTokenDelta = { prompts: 0, tokens: emptyTokenUsage() };
  const nextReported: ReportedPromptTokens = {};

  for (const [sid, cur] of current) {
    const prev = reported[sid];
    delta.prompts += Math.max(0, cur.prompts - (prev?.prompts ?? 0));
    delta.tokens = addTokenUsage(delta.tokens, tokenDelta(cur.tokens, prev?.tokens));
    nextReported[sid] = { prompts: cur.prompts, tokens: cur.tokens };
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
  return (await readSnapshot('daily-sessions', config, async (events) => {
    const promptTokens = await readReportedPromptTokens(config);
    return {
      current: computeDailyStatsDelta(aggregateDailySessions(events), {}).nextReported,
      take: takeDaily((runId) => Object.hasOwn(promptTokens, runId)),
    };
  })) ?? {};
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
 * The dashboard events a scope reports (#785): every event of the sessions
 * recorded in it. A session is the run of one ID up to its session_end or
 * process_exit, since a PID-fallback ID comes back for a later run; each run
 * is returned under its own ID (see {@link adoptBareKeys}). It is
 * decided once, whole, by its first event keyed with a data home
 * (`dataHomeKey`, or the path an unreleased build of #795 wrote), because a
 * Stop carries the whole transcript's totals: split per event, a session that
 * moved into another scope would count there again the part recorded before
 * the move. A project also owns the key of its in-repo `.teamai`, where a
 * hook recorded until migration moved the project to a partition. A session
 * written before events carried a key is decided by its first cwd, by the
 * dispatcher's rule: the scope that directory resolves to now, so a nested
 * clone under a project is not the project's; one with no cwd, or a cwd gone
 * since, is no scope's. A caller without a scope config reads the whole log.
 */
export async function filterEventsByScope(
  events: DashboardEvent[],
  config?: LocalConfig,
): Promise<DashboardEvent[]> {
  if (!config) return events;
  const ownKey = await dataHomeKey(getDataHome(config));
  const keys = new Set([ownKey]);
  if (config.projectRoot) {
    // Unless the project is rooted at HOME, where that is the user scope's.
    const legacy = await dataHomeKey(path.join(config.projectRoot, '.teamai'));
    if (legacy !== (await dataHomeKey(path.join(getUserHome(), '.teamai')))) keys.add(legacy);
  }
  const { resolveConfigForDir } = await import('./config.js');
  const resolvesHere = new Map<string, Promise<boolean>>();
  const ownsCwd = (cwd: string): Promise<boolean> => {
    let owns = resolvesHere.get(cwd);
    if (!owns) {
      owns = pathExists(cwd).then(async (exists) => {
        const resolved = exists ? await resolveConfigForDir(cwd) : null;
        return !!resolved && keys.has(await dataHomeKey(getDataHome(resolved)));
      });
      resolvesHere.set(cwd, owns);
    }
    return owns;
  };
  // The log is hand-editable: a key that is not a string counts as absent.
  // An unreleased build of #795 recorded the data home path in place of its key.
  const hashes = new Map<string, Promise<string>>();
  const eventKeys = await Promise.all(events.map((e) => {
    if (typeof e.dataHomeKey === 'string') return e.dataHomeKey;
    if (typeof e.dataHome !== 'string') return undefined;
    let key = hashes.get(e.dataHome);
    if (!key) {
      key = dataHomeKey(e.dataHome);
      hashes.set(e.dataHome, key);
    }
    return key;
  }));
  // A tool's own session ID is one run, whatever ends it records: `claude
  // --resume` continues it, in a new process, and its Stop carries the whole
  // transcript. It is returned under the ID itself, so it stays the session
  // already reported after compaction drops its events. A PID-fallback ID
  // (`pid-…`) names one run until it ends, then comes back for a later one,
  // maybe in another scope, so each run is decided on its own and returned
  // under the ID plus its first event's timestamp, which stays the same
  // whichever earlier runs compaction has dropped. A second end with nothing recorded since the first
  // (the dashboard monitor's process_exit after SessionEnd) belongs to the run
  // just closed. A start from another process than its open run's begins a new
  // run, though nothing ended that one (a crash with no dashboard running).
  const runOf: Array<number | undefined> = [];
  const runPid: Array<number | undefined> = [];
  const observedRuns = new Map<string, number>();
  const openRun = new Map<string, number>();
  const closedRun = new Map<string, number>();
  const deciding: Array<number | undefined> = [];
  const runIds: string[] = [];
  events.forEach((e, i) => {
    const fallback = e.sessionId.startsWith('pid-');
    const ends = e.type === 'session_end' || e.type === 'process_exit';
    const observed = e.type === 'process_exit' && typeof e.processExitAfter === 'string';
    const starts = e.type === 'session_start' && typeof e.monitorPid === 'number';
    const open = openRun.get(e.sessionId);
    if (starts && open !== undefined && fallback
      && typeof runPid[open] === 'number' && runPid[open] !== e.monitorPid) openRun.delete(e.sessionId);
    let run = observed ? observedRuns.get(`${e.sessionId}@${e.processExitAfter}`)
      : openRun.get(e.sessionId) ?? (ends ? closedRun.get(e.sessionId) : undefined);
    // The observed run may have been compacted. Its delayed exit must not
    // manufacture a new session or close a later reuse of the same ID.
    if (observed && run === undefined) {
      runOf.push(undefined);
      return;
    }
    if (run === undefined) {
      run = deciding.push(undefined) - 1;
      runIds.push(fallback ? `${e.sessionId}@${e.timestamp}` : e.sessionId);
    }
    if (ends && fallback && (!observed || openRun.get(e.sessionId) === run)) {
      openRun.delete(e.sessionId);
      closedRun.set(e.sessionId, run);
    } else if (!ends || !fallback) {
      openRun.set(e.sessionId, run);
    }
    if (starts) runPid[run] ??= e.monitorPid;
    runOf.push(run);
    observedRuns.set(`${e.sessionId}@${e.timestamp}`, run);
    const current = deciding[run];
    if (eventKeys[i] !== undefined ? current === undefined || eventKeys[current] === undefined
      : current === undefined && !!e.cwd) deciding[run] = i;
  });
  const owned = await Promise.all(deciding.map(async (i) => {
    if (i === undefined) return false;
    const key = eventKeys[i];
    const cwd = events[i].cwd;
    return key !== undefined ? keys.has(key) : !!cwd && await ownsCwd(cwd);
  }));
  return events.flatMap((e, i) => {
    const run = runOf[i];
    return run !== undefined && owned[run] ? [{ ...e, sessionId: runIds[run] }] : [];
  });
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
    // A retired bare entry is written out now, even with nothing to report, so
    // the success writes below, which merge into the file, cannot bring it back.
    const adopt = async <T>(
      read: (config: LocalConfig | undefined) => Promise<Record<string, T>>,
      write: (data: Record<string, T>, config: LocalConfig | undefined) => Promise<void>,
      current: Record<string, T>,
      take: TakeReported<T>,
    ): Promise<Record<string, T>> => {
      const stored = await read(reportsConfig);
      const adopted = adoptBareKeys(stored, dashboardEvents, current, take);
      if (adopted !== stored) await write(adopted, reportsConfig);
      return adopted;
    };
    // Prompt tokens first: they decide which runs of a bare ID were reported.
    const reportedPromptTokens = await adopt(
      readReportedPromptTokens, writeReportedPromptTokens, computePromptTokenDelta(metrics, {}).nextReported,
      takePromptTokens,
    );
    const covered = (runId: string) => Object.hasOwn(reportedPromptTokens, runId);
    const { delta: promptTokenDelta, nextReported: nextReportedPromptTokens } = computePromptTokenDelta(
      metrics,
      reportedPromptTokens,
    );
    const reportedInterventions = await adopt(
      readReportedInterventions, writeReportedInterventions, Object.fromEntries(currentInterventions),
      takeInterventions(covered),
    );
    const { delta: interventionDelta, nextReported } = computeInterventionDelta(
      currentInterventions,
      reportedInterventions,
    );
    const reportedDailySessions = await adopt(
      readReportedDailySessions, writeReportedDailySessions, computeDailyStatsDelta(currentDaily, {}).nextReported,
      takeDaily(covered),
    );
    const { delta: dailyDelta, nextReported: nextReportedDailySessions } = computeDailyStatsDelta(
      currentDaily,
      reportedDailySessions,
    );

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
