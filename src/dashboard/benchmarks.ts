/**
 * The dashboard's Benchmarks page (#1180): the ended benchmark runs of a workspace, through `BenchmarkHistory`. It reads
 * this machine's run files and the team's run records on `teamai-reports`, and only their benchmark runs: a file is
 * parsed once, and again only when its size or modification time changed, so a page of hundreds of records re-reads
 * nothing it read before. A run this machine has a file for is read from it, not from its published copy.
 *
 * Each team revision the selected suite's runs installed is named from this machine's team clone, with the asset files
 * each tool and model's revision changed since the one it ran on before: a commit never changes, so each is read once.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readRecordedAgent } from '../agent-observation.js';
import { getReportsDir, usesBranchWorktree, type LocalConfig } from '../types.js';
import { BENCHMARK_WINDOWS, BenchmarkHistory, type BenchmarkHistoryQuery, type BenchmarkHistoryView, type BenchmarkRunInput } from '../benchmark/history.js';
import { BenchmarkRecordSchema } from '../benchmark/result.js';
import { buildEndRecord, RECORDS_DIR } from '../workflow/records.js';
import { isRunId, readRun, runsDir } from '../workflow/store.js';
import { git } from '../workflow/worktree.js';
import { HttpError } from './http.js';

const QuerySchema = z.object({
  window: z.coerce.number().refine((days) => BENCHMARK_WINDOWS.some((offered) => offered === days)).optional(),
  suite: z.string().min(1).max(256).optional(),
});

/** The page's query string as a query. Throws an HttpError the page shows for a window it does not offer. */
export function parseBenchmarkQuery(params: URLSearchParams): BenchmarkHistoryQuery {
  const parsed = QuerySchema.safeParse(Object.fromEntries(['window', 'suite'].flatMap((key) => {
    const value = params.get(key);
    return value ? [[key, value]] : [];
  })));
  if (!parsed.success) throw new HttpError(400, `Benchmark history takes window ${BENCHMARK_WINDOWS.join(', ')} and a suite name.`);
  return { windowDays: parsed.data.window ?? 90, ...(parsed.data.suite ? { suite: parsed.data.suite } : {}) };
}

/** What a published record holds that the page reads. */
const RecordSchema = z.object({
  run: z.string().refine(isRunId),
  startedAt: z.string(),
  username: z.string().optional(),
  steps: z.array(z.object({ step: z.string(), agent: z.unknown().transform(readRecordedAgent) })).optional().catch(undefined),
  benchmark: BenchmarkRecordSchema,
});

/** A file read, by path: what it held at the size and modification time `stamp` names. Undefined: not a benchmark run. */
const reads = new Map<string, { stamp: string; input: BenchmarkRunInput | undefined }>();

/** Every record names its benchmark block with this key; a file without it is skipped before it is parsed. */
const BENCHMARK_KEY = '"benchmark"';

async function readReported(file: string): Promise<BenchmarkRunInput | undefined> {
  const text = await fs.readFile(file, 'utf8');
  if (!text.includes(BENCHMARK_KEY)) return undefined;
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return undefined;
    const { run, startedAt, username, steps, benchmark } = parsed.data;
    return {
      run, source: 'reported', startedAt, ...(username ? { username } : {}), benchmark,
      ...(steps ? { steps: steps.map(({ step, agent }) => ({ step, ...(agent ? { agent } : {}) })) } : {}),
    };
  } catch {
    return undefined;
  }
}

/** An ended benchmark run of this machine, as the record it publishes. */
async function readLocal(config: LocalConfig, file: string): Promise<BenchmarkRunInput | undefined> {
  if (!(await fs.readFile(file, 'utf8')).includes(BENCHMARK_KEY)) return undefined;
  const run = await readRun(config, path.basename(file, '.json'));
  if (typeof run !== 'object' || run.status === 'running' || run.benchmark === undefined) return undefined;
  const record = buildEndRecord(run, run.driver, config.username ?? '');
  if (!record.benchmark) return undefined;
  return {
    run: run.id, source: 'local', startedAt: record.startedAt, ...(config.username ? { username: config.username } : {}), benchmark: record.benchmark,
    ...(record.steps ? { steps: record.steps } : {}),
  };
}

/**
 * The benchmark runs of the `.json` files in `dir`, each parsed only when it changed since the last read. A file that
 * could not be read, such as one another process holds open on Windows, is read again next time.
 */
async function readDir(dir: string, read: (file: string) => Promise<BenchmarkRunInput | undefined>): Promise<BenchmarkRunInput[]> {
  const files = (await fs.readdir(dir).catch(() => [])).filter((file) => file.endsWith('.json')).map((file) => path.join(dir, file));
  const present = new Set(files);
  for (const file of reads.keys()) if (path.dirname(file) === dir && !present.has(file)) reads.delete(file);
  const inputs = await Promise.all(files.map(async (file) => {
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat) return undefined;
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const kept = reads.get(file);
    if (kept?.stamp === stamp) return kept.input;
    try {
      const input = await read(file);
      reads.set(file, { stamp, input });
      return input;
    } catch {
      return undefined;
    }
  }));
  return inputs.filter((input) => input !== undefined);
}

/** A team revision as this machine's team clone has it. */
export interface TeamCommit {
  committedAt: string;
  subject: string;
}

/** The files outside benchmarks/ that changed from one team revision to another: at most `CHANGES_SHOWN`, in path order. */
export interface TeamDiff {
  files: Array<{ path: string; added: number; removed: number }>;
  more: number;
}

/**
 * `teamCommits` by revision, for each the clone has. `teamDiffs` by `<before>..<after>`, for each two revisions a tool and
 * model ran on in turn and the clone has both of.
 */
export type BenchmarkPage = BenchmarkHistoryView & { teamCommits: Record<string, TeamCommit>; teamDiffs: Record<string, TeamDiff> };

const CHANGES_SHOWN = 40;
const GIT_TIMEOUT_MS = 10_000;
/** By team clone and commit, or commit pair: what git said, which never changes. One the clone lacked is asked again, as a pull may bring it. */
const commits = new Map<string, Promise<TeamCommit | undefined>>();
const diffs = new Map<string, Promise<TeamDiff | undefined>>();

function commitOf(clone: string, revision: string): Promise<TeamCommit | undefined> {
  const key = `${clone}\0${revision}`;
  const known = commits.get(key) ?? git(clone, ['log', '-1', '--format=%cI%x00%s', revision, '--'], { timeoutMs: GIT_TIMEOUT_MS }).then(({ code, stdout }) => {
    const [committedAt, subject] = stdout.trim().split('\0');
    return code === 0 && committedAt && subject !== undefined ? { committedAt: new Date(committedAt).toISOString(), subject } : undefined;
  });
  commits.set(key, known);
  void known.then((commit) => commit ?? commits.delete(key));
  return known;
}

function diffOf(clone: string, before: string, after: string): Promise<TeamDiff | undefined> {
  const key = `${clone}\0${before}\0${after}`;
  const known = diffs.get(key) ?? git(clone, ['diff', '--numstat', '--no-renames', '--relative', before, after, '--', '.', ':(exclude)benchmarks'], { timeoutMs: GIT_TIMEOUT_MS }).then(({ code, stdout }) => {
    if (code !== 0) return undefined;
    const files = stdout.split('\n').filter(Boolean).map((line) => {
      const [added = '-', removed = '-', ...rest] = line.split('\t');
      return { path: rest.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 };
    }).sort((left, right) => left.path.localeCompare(right.path));
    return { files: files.slice(0, CHANGES_SHOWN), more: Math.max(0, files.length - CHANGES_SHOWN) };
  });
  diffs.set(key, known);
  void known.then((changes) => changes ?? diffs.delete(key));
  return known;
}

/**
 * `view` with its team revisions in commit order when the team clone has every one, each named, and what changed between
 * each two revisions a tool and model ran on in turn.
 */
async function withTeamCommits(config: LocalConfig, view: BenchmarkHistoryView): Promise<BenchmarkPage> {
  const revisions = view.selected?.teamChanges.revisions ?? [];
  if (!view.selected || revisions.length === 0) return { ...view, teamCommits: {}, teamDiffs: {} };
  const clone = config.repo.localPath;
  const named = await Promise.all(revisions.map(async (revision) => ({ revision, commit: await commitOf(clone, revision.revision) })));
  const ordered = named.every(({ commit }) => commit) ? named.toSorted((left, right) => (left.commit?.committedAt ?? '').localeCompare(right.commit?.committedAt ?? '')) : named;
  const teamCommits = Object.fromEntries(ordered.flatMap(({ revision, commit }) => (commit ? [[revision.revision, commit]] : [])));
  const pairs = new Set(view.selected.teamChanges.configs.flatMap(({ key }) => {
    const ran = ordered.map(({ revision }) => revision).filter(({ configs }) => configs.some((one) => one.key === key)).map(({ revision }) => revision);
    return ran.slice(1).map((after, index) => `${ran[index]}..${after}`);
  }));
  const diffed = await Promise.all([...pairs].map(async (pair) => {
    const [before = '', after = ''] = pair.split('..');
    return [pair, await diffOf(clone, before, after)] as const;
  }));
  return {
    ...view,
    selected: { ...view.selected, teamChanges: { ...view.selected.teamChanges, revisions: ordered.map(({ revision }) => revision) } },
    teamCommits,
    teamDiffs: Object.fromEntries(diffed.flatMap(([pair, diff]) => (diff ? [[pair, diff]] : []))),
  };
}

/**
 * The Benchmarks page's answer for one workspace. `refresh` refreshes the reports checkout from origin first, as every
 * reader of it.
 */
export async function benchmarkHistory({ config, query, now = new Date(), refresh = true }: {
  config: LocalConfig;
  query: BenchmarkHistoryQuery;
  now?: Date;
  refresh?: boolean;
}): Promise<BenchmarkPage> {
  if (usesBranchWorktree(config)) {
    const { readableReportsWorktree } = await import('../utils/reports-branch.js');
    await readableReportsWorktree(config, { dryRun: !refresh });
  }
  const [local, reported] = await Promise.all([
    readDir(runsDir(config), (file) => readLocal(config, file)),
    readDir(path.join(getReportsDir(config), RECORDS_DIR), readReported),
  ]);
  const localIds = new Set(local.map(({ run }) => run));
  return withTeamCommits(config, BenchmarkHistory.of({ runs: [...local, ...reported.filter(({ run }) => !localIds.has(run))], query, now }));
}
