/**
 * Which scope reports a dashboard session (#785): the real dispatcher records
 * the sessions, the real report reads them, observed through the stats file
 * each scope pushes. Only the reports-branch push and the handlers that reach
 * the network or spawn processes are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { LocalConfig } from '../types.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  // The detached background pass: run inline instead (bgOnly) so its writes are observable.
  spawn: vi.fn(() => ({ on: vi.fn(), stdin: { on: vi.fn(), end: vi.fn((_: string, done: () => void) => done()) }, unref: vi.fn() })),
}));
vi.mock('../pull.js', () => ({ pull: vi.fn(async () => undefined) }));
vi.mock('../update.js', () => ({ doUpdate: vi.fn(async () => undefined) }));
vi.mock('../local-agent.js', () => ({ reportAndSyncFromHook: vi.fn(async () => null) }));
// Each scope's reports branch is a plain directory next to its team repo.
vi.mock('../utils/reports-branch.js', () => ({
  updateReports: vi.fn(async (cfg: LocalConfig, write: (wt: string) => Promise<unknown>) => {
    const dir = path.join(path.dirname(cfg.repo.localPath), 'reports-wt');
    fs.mkdirSync(dir, { recursive: true });
    return (await write(dir)) != null;
  }),
}));

const { hookDispatchCli } = await import('../hook-dispatch-cli.js');
const { resolveProjectDataHome, saveLocalConfigForScope, resolveConfigForDir, loadLocalConfig } = await import('../config.js');
const { reportUsageToTeam } = await import('../team-push.js');
const { getDataHome } = await import('../types.js');

let tmp: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dashboard-scope-')));
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const teamaiHome = () => path.join(tmp, 'home', '.teamai');

/** Run one hook event the way a host does: foreground pass, then the background pass. */
async function hook(event: string, tool: string, payload: Record<string, unknown>): Promise<void> {
  for (const bgOnly of [false, true]) {
    const stdinFile = path.join(tmp, `stdin-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(stdinFile, JSON.stringify(payload));
    await hookDispatchCli(event, tool, '*', { bgOnly, stdinFile });
  }
}

/** One complete session: start, a prompt, stop. */
async function session(tool: string, base: Record<string, unknown>): Promise<void> {
  await hook('session-start', tool, { ...base, hook_event_name: 'SessionStart' });
  await hook('prompt-submit', tool, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  await hook('stop', tool, { ...base, hook_event_name: 'Stop' });
}

async function setup(): Promise<{ root: string; user: LocalConfig; project: LocalConfig }> {
  const userRepo = path.join(teamaiHome(), 'team-repo');
  fs.mkdirSync(userRepo, { recursive: true });
  fs.writeFileSync(path.join(teamaiHome(), 'config.yaml'),
    `repo:\n  localPath: ${userRepo}\n  remote: https://example.test/acme/user-team.git\n  kind: git\nusername: tester\nscope: user\n`);
  const root = path.join(tmp, 'project-p');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dataHome = await resolveProjectDataHome(root);
  fs.mkdirSync(path.join(dataHome, 'team-repo'), { recursive: true });
  await saveLocalConfigForScope({
    repo: { localPath: path.join(dataHome, 'team-repo'), remote: 'https://example.test/acme/team-p.git', kind: 'git' },
    username: 'tester', scope: 'project', projectRoot: root, additionalRoles: [], dataHome,
  });
  // The configs as pull resolves them.
  const user = await loadLocalConfig();
  const project = await resolveConfigForDir(root);
  if (!user || !project) throw new Error('fixture configs did not resolve');
  return { root, user, project };
}

/** Report the way pull does, and return the stats that scope has pushed so far. */
async function report(config: LocalConfig): Promise<unknown> {
  await reportUsageToTeam(config.repo.localPath, config.username, { skipTruncate: true, selfConfig: config });
  const statsPath = path.join(path.dirname(config.repo.localPath), 'reports-wt', 'stats', `${config.username}.yaml`);
  return fs.existsSync(statsPath) ? YAML.parse(fs.readFileSync(statsPath, 'utf-8')) : null;
}

/** Report the way pull does, and return the sessions that scope's stats now hold. */
async function reportedSessions(config: LocalConfig): Promise<number> {
  const stats = await report(config);
  const daily = stats && typeof stats === 'object' && 'daily' in stats && stats.daily && typeof stats.daily === 'object' ? stats.daily : {};
  return Object.values(daily).reduce((sum: number, day: unknown) =>
    sum + (day && typeof day === 'object' && 'sessionsEnded' in day && typeof day.sessionsEnded === 'number' ? day.sessionsEnded : 0), 0);
}

describe('each scope reports only the dashboard sessions recorded in it (#785)', () => {
  it('a user-scope report leaves out a session recorded in a project, and the project reports it', async () => {
    const { root, user, project } = await setup();
    await session('claude', { session_id: 'sid-p', cwd: root });

    expect(await reportedSessions(user)).toBe(0);
    expect(await reportedSessions(project)).toBe(1);
  });

  it('a user-scope session is reported by the user scope only', async () => {
    const { user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    await session('claude', { session_id: 'sid-u', cwd: elsewhere });

    expect(await reportedSessions(project)).toBe(0);
    expect(await reportedSessions(user)).toBe(1);
  });

  it.each([
    ['names its cwd', true],
    ['sends no cwd, from a hook running in the project', false],
  ])('a Copilot session, whose events record no cwd, is reported by its project: payload %s', async (_, withCwd) => {
    const { root, user, project } = await setup();
    if (!withCwd) process.chdir(root);
    await session('copilot', withCwd ? { session_id: 'copilot-p', cwd: root } : { session_id: 'copilot-p' });

    expect(await reportedSessions(user)).toBe(0);
    expect(await reportedSessions(project)).toBe(1);
  });

  it('a Copilot event records its scope without persisting a path (#666)', async () => {
    const { root, project } = await setup();
    await session('copilot', { session_id: 'copilot-p', cwd: root });

    const log = fs.readFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), 'utf-8');
    const partition = getDataHome(project);
    expect(log).not.toContain(root);
    expect(log).not.toContain(partition);
    expect(log).not.toContain(path.basename(partition));
  });

  it('a session started under a symlinked path of the project is reported by the project', async () => {
    const { root, user, project } = await setup();
    const link = path.join(tmp, 'link-p');
    fs.symlinkSync(root, link, 'dir');
    await session('claude', { session_id: 'sid-link', cwd: link });

    expect(await reportedSessions(user)).toBe(0);
    expect(await reportedSessions(project)).toBe(1);
  });

  it('events recorded before sessions carried a data home go to the scope their cwd resolves to now', async () => {
    const { root, user, project } = await setup();
    const link = path.join(tmp, 'link-p');
    fs.symlinkSync(root, link, 'dir');
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    // A nested clone under P resolves to no project, so it is the user scope's, not P's too.
    fs.mkdirSync(path.join(root, 'nested'));
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'nested') });
    // A sibling whose name only starts with P's.
    fs.mkdirSync(`${root}-ab`);
    const timestamp = new Date().toISOString();
    const old = (sessionId: string, cwd: string | undefined) => [
      { type: 'session_start', timestamp, sessionId, tool: 'claude', cwd },
      { type: 'stop', timestamp, sessionId, tool: 'claude', cwd },
    ];
    const eventsPath = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.writeFileSync(eventsPath, [
      ...old('old-in-p', path.join(root, 'src')),
      ...old('old-via-link', link),
      ...old('old-elsewhere', path.join(tmp, 'elsewhere')),
      ...old('old-nested', path.join(root, 'nested')),
      ...old('old-sibling', `${root}-ab`),
      // Nothing can tell whose these were, so no scope reports them.
      ...old('old-gone', path.join(root, 'removed-worktree')),
      ...old('old-no-cwd', undefined),
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');

    expect(await reportedSessions(user)).toBe(3);
    expect(await reportedSessions(project)).toBe(2);
  });
});

describe('each scope keeps its own reported snapshot (#786)', () => {
  /** The prompts a scope's stats hold, 0 before its first push. */
  async function reportedPrompts(config: LocalConfig): Promise<number> {
    const stats = await report(config);
    return stats && typeof stats === 'object' && 'prompts' in stats && typeof stats.prompts === 'number' ? stats.prompts : 0;
  }

  /** The sessions a scope's intervention stats hold, 0 before its first push. */
  async function reportedInterventionSessions(config: LocalConfig): Promise<number> {
    const stats = await report(config);
    const interventions = stats && typeof stats === 'object' && 'interventions' in stats ? stats.interventions : undefined;
    return interventions && typeof interventions === 'object' && 'sessions' in interventions
      && typeof interventions.sessions === 'number' ? interventions.sessions : 0;
  }

  const shared = (name: string) => path.join(teamaiHome(), 'dashboard', `reported-${name}.json`);
  const SNAPSHOTS = ['interventions', 'prompt-tokens', 'daily-sessions'];

  /** The shared snapshots as a release before #786 left them, with `prompts` reported per session. */
  function writeSharedSnapshots(prompts: Record<string, number>, date: string, config?: LocalConfig): void {
    const entries = (value: (n: number) => unknown) =>
      Object.fromEntries(Object.entries(prompts).map(([sid, n]) => [sid, value(n)]));
    const values: Record<string, unknown> = {
      interventions: entries(() => ({ interrupt: 0, toolReject: 0, correction: 0 })),
      'prompt-tokens': entries((n) => ({ prompts: n, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } })),
      // Longer than any fixture session, so no duration is left to report.
      'daily-sessions': entries((n) => ({ date, prompts: n, durationMs: 3_600_000, succeeded: 1, corrected: 0 })),
    };
    const dir = path.join(config ? getDataHome(config) : teamaiHome(), 'dashboard');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of SNAPSHOTS) fs.writeFileSync(path.join(dir, `reported-${name}.json`), JSON.stringify(values[name]));
  }

  async function prompts(sessionId: string, cwd: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await hook('prompt-submit', 'claude', { session_id: sessionId, cwd, hook_event_name: 'UserPromptSubmit', prompt: `p${i}` });
    }
  }

  /**
   * Run `record` as an earlier release would have: before #785 its events carry
   * no data home, and main since #795 wrote the data home path, `dataHome`.
   */
  async function asEarlierRelease(record: () => Promise<void>, dataHome?: string): Promise<void> {
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '';
    await record();
    const added = fs.readFileSync(log, 'utf-8').slice(before.length).split('\n').filter(Boolean).map((line) => {
      const event = Object.fromEntries(Object.entries(JSON.parse(line)).filter(([field]) => field !== 'dataHomeKey'));
      return `${JSON.stringify(dataHome === undefined ? event : { ...event, dataHome })}\n`;
    });
    fs.writeFileSync(log, before + added.join(''));
  }

  // A Stop carries the whole transcript's totals, so a session is reported once,
  // whole, by the scope it started in; split per event, the later scope would
  // count the earlier scope's part again.
  it('a session that moves from the user scope into a project is reported once, by the user scope', async () => {
    const { root, user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    await hook('session-start', 'claude', { session_id: 'moved', cwd: elsewhere, hook_event_name: 'SessionStart' });
    await prompts('moved', elsewhere, 3);
    await prompts('moved', root, 2); // `cd` into the project mid-session
    await hook('stop', 'claude', { session_id: 'moved', cwd: root, hook_event_name: 'Stop' });

    expect(await reportedPrompts(project)).toBe(0);
    expect(await reportedPrompts(user)).toBe(5);
  });

  it('a session that moves from one project into another is reported once, by the first', async () => {
    const { root, project } = await setup();
    const rootQ = path.join(tmp, 'project-q');
    fs.mkdirSync(rootQ);
    execFileSync('git', ['init', '-q'], { cwd: rootQ });
    const dataHomeQ = await resolveProjectDataHome(rootQ);
    fs.mkdirSync(path.join(dataHomeQ, 'team-repo'), { recursive: true });
    await saveLocalConfigForScope({
      repo: { localPath: path.join(dataHomeQ, 'team-repo'), remote: 'https://example.test/acme/team-q.git', kind: 'git' },
      username: 'tester', scope: 'project', projectRoot: rootQ, additionalRoles: [], dataHome: dataHomeQ,
    });
    const projectQ = await resolveConfigForDir(rootQ);
    if (!projectQ) throw new Error('fixture config Q did not resolve');
    await hook('session-start', 'claude', { session_id: 'moved', cwd: root, hook_event_name: 'SessionStart' });
    await prompts('moved', root, 3);
    await prompts('moved', rootQ, 2);
    await hook('stop', 'claude', { session_id: 'moved', cwd: rootQ, hook_event_name: 'Stop' });

    expect(await reportedPrompts(projectQ)).toBe(0);
    expect(await reportedPrompts(project)).toBe(5);
  });

  it('a session ID another scope already reported is a new session in this scope (Copilot PID fallback)', async () => {
    const { root, user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    // No session ID: Copilot falls back to `pid-<parent pid>`, reused by the next session.
    await session('copilot', { cwd: elsewhere });
    expect(await reportedSessions(user)).toBe(1);
    // Compaction dropped the ended session; a later one in P gets the same ID.
    fs.writeFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), '');
    await session('copilot', { cwd: root });

    expect(await reportedSessions(project)).toBe(1);
  });

  it('a session ID reused after its session ended goes to the scope that reuses it, while the log still holds the ended one', async () => {
    const { root, user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    await session('copilot', { cwd: elsewhere });
    await hook('session-end', 'copilot', { cwd: elsewhere, hook_event_name: 'SessionEnd' });
    expect(await reportedSessions(user)).toBe(1);
    // Below the compaction threshold the ended `pid-<parent pid>` session stays; the next one in P reuses its ID.
    await session('copilot', { cwd: root });

    expect(await reportedSessions(project)).toBe(1);
    expect(await reportedSessions(user)).toBe(1);
  });

  it('two sessions that reuse one session ID in the same scope are two sessions, while the log holds both', async () => {
    const { root, project } = await setup();
    await session('copilot', { cwd: root });
    await hook('session-end', 'copilot', { cwd: root, hook_event_name: 'SessionEnd' });
    expect(await reportedSessions(project)).toBe(1);
    await session('copilot', { cwd: root });
    await hook('session-end', 'copilot', { cwd: root, hook_event_name: 'SessionEnd' });

    expect(await reportedSessions(project)).toBe(2);
    expect(await reportedPrompts(project)).toBe(2);
  });

  it('a session ID reused in the same scope after compaction dropped the run it reported is a new session', async () => {
    const { root, project } = await setup();
    await session('copilot', { cwd: root });
    await hook('session-end', 'copilot', { cwd: root, hook_event_name: 'SessionEnd' });
    expect(await reportedSessions(project)).toBe(1);
    // Compaction dropped the ended run before P reported again; the next run in P reuses its ID.
    fs.writeFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), '');
    await session('copilot', { cwd: root });

    expect(await reportedSessions(project)).toBe(2);
    expect(await reportedPrompts(project)).toBe(2);
  });

  it('a session that ends twice, SessionEnd then the dashboard monitor\'s process_exit, is one session', async () => {
    const { root, project } = await setup();
    await session('copilot', { cwd: root });
    await hook('session-end', 'copilot', { cwd: root, hook_event_name: 'SessionEnd' });
    // The monitor read the session as still running while SessionEnd was appended.
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    const last = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(log, 'utf-8').trim().split('\n').at(-1) ?? '{}')));
    fs.appendFileSync(log, `${JSON.stringify({ ...last, type: 'process_exit', timestamp: new Date(Date.now() + 1000).toISOString() })}\n`);

    expect(await reportedInterventionSessions(project)).toBe(1);
    expect(await reportedSessions(project)).toBe(1);
  });

  it.each([
    ['after the project first reported', true],
    ['before the project first reported', false],
  ])('a session ID an earlier release reported for the user scope is a new session when this build records it in a project, %s', async (_, reportFirst) => {
    const { root, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const pid = `pid-${process.ppid}`;
    // The ended user-scope run stays in the log, below the compaction threshold.
    await asEarlierRelease(async () => {
      await session('copilot', { cwd: elsewhere });
      await hook('session-end', 'copilot', { cwd: elsewhere, hook_event_name: 'SessionEnd' });
    });
    writeSharedSnapshots({ [pid]: 1 }, new Date().toISOString().slice(0, 10));
    if (reportFirst) expect(await report(project)).toBeNull();
    await session('copilot', { cwd: root });

    expect(await reportedSessions(project)).toBe(1);
    expect(await reportedPrompts(project)).toBe(1);
  });

  it('a run in progress across the upgrade is not reported again for what the earlier release reported', async () => {
    const { root, project } = await setup();
    const pid = `pid-${process.ppid}`;
    await asEarlierRelease(async () => {
      await hook('session-start', 'copilot', { cwd: root, hook_event_name: 'SessionStart' });
      await prompts(pid, root, 1);
    });
    writeSharedSnapshots({ [pid]: 1 }, new Date().toISOString().slice(0, 10));
    await hook('prompt-submit', 'copilot', { cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'after the upgrade' });
    await hook('stop', 'copilot', { cwd: root, hook_event_name: 'Stop' });

    expect(await reportedPrompts(project)).toBe(1);
    expect(await reportedInterventionSessions(project)).toBe(0);
  });

  it.each([
    ['retained', false, false],
    ['compacted', true, false],
    ['seeded before reuse', false, true],
  ])('a path-keyed project run does not inherit a shared user snapshot (%s)', async (_, compact, seedFirst) => {
    const { root, project } = await setup();
    const pid = `pid-${process.ppid}`;
    await asEarlierRelease(async () => {
      await session('copilot', { cwd: tmp });
      await hook('session-end', 'copilot', { cwd: tmp, hook_event_name: 'SessionEnd' });
    });
    writeSharedSnapshots({ [pid]: 1 }, new Date().toISOString().slice(0, 10));
    if (seedFirst) expect(await report(project)).toBeNull();
    if (compact) fs.writeFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), '');
    await asEarlierRelease(() => session('copilot', { cwd: root }), getDataHome(project));

    expect(await reportedSessions(project)).toBe(1);
    expect(await reportedInterventionSessions(project)).toBe(1);
    expect(await reportedPrompts(project)).toBe(1);
  });

  it('a delayed monitor exit does not split the next invocation with the same ID', async () => {
    const { root, project } = await setup();
    const log = path.join(teamaiHome(), 'dashboard', 'events.jsonl');
    await session('copilot', { cwd: root });
    const observed = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1) ?? '{}');
    await hook('session-end', 'copilot', { cwd: root, hook_event_name: 'SessionEnd' });
    await hook('session-start', 'copilot', { cwd: root, hook_event_name: 'SessionStart' });
    fs.appendFileSync(log, JSON.stringify({
      type: 'process_exit', sessionId: observed.sessionId, tool: 'copilot',
      timestamp: new Date().toISOString(), dataHomeKey: observed.dataHomeKey,
      processExitAfter: observed.timestamp,
    }) + '\n');
    await hook('prompt-submit', 'copilot', { cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'second run' });
    await hook('stop', 'copilot', { cwd: root, hook_event_name: 'Stop' });

    expect(await reportedInterventionSessions(project)).toBe(2);
    expect(await reportedSessions(project)).toBe(2);
    expect(await reportedPrompts(project)).toBe(2);
  });

  it('the first report after the upgrade sends nothing a shared snapshot already reported', async () => {
    const { root, user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    await asEarlierRelease(async () => {
      await session('claude', { session_id: 'old-p', cwd: root });
      await session('claude', { session_id: 'old-u', cwd: elsewhere });
    });
    writeSharedSnapshots({ 'old-p': 1, 'old-u': 1 }, new Date().toISOString().slice(0, 10));

    expect(await report(user)).toBeNull();
    expect(await report(project)).toBeNull();
  });

  it('once seeded, a scope reads and writes only its own snapshot, even after a rollback rewrites the shared one', async () => {
    const { root, user, project } = await setup();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const today = new Date().toISOString().slice(0, 10);
    writeSharedSnapshots({ 'old-p': 1 }, today);
    const before = SNAPSHOTS.map((name) => fs.readFileSync(shared(name), 'utf-8'));

    await session('claude', { session_id: 'new-p', cwd: root });
    expect(await reportedPrompts(project)).toBe(1);
    await session('claude', { session_id: 'new-u', cwd: elsewhere });
    expect(await reportedPrompts(user)).toBe(1);
    expect(SNAPSHOTS.map((name) => fs.readFileSync(shared(name), 'utf-8'))).toEqual(before);

    // An earlier release, after a rollback, records and reports two more
    // sessions and writes the shared snapshots again.
    await session('claude', { session_id: 'rollback-p', cwd: root });
    await session('claude', { session_id: 'rollback-u', cwd: elsewhere });
    writeSharedSnapshots({ 'old-p': 1, 'rollback-p': 1, 'rollback-u': 1 }, today);

    // Both scopes were seeded before the rollback and read only their own
    // snapshot, so each reports its session again, as the ticket asks.
    expect(await reportedPrompts(project)).toBe(2);
    expect(await reportedPrompts(user)).toBe(2);
  });

  it.each([
    ['nothing new', 1],
    ['a new prompt', 0],
  ])('a bare snapshot entry a run adopts is written back under the run ID only, with %s to report', async (_, reported) => {
    const { root, project } = await setup();
    const pid = `pid-${process.ppid}`;
    // Main since #795 recorded and reported this run under its bare session ID.
    await asEarlierRelease(() => session('copilot', { cwd: root }), getDataHome(project));
    // Main writes this acknowledgement to P's own snapshot, not the shared file.
    writeSharedSnapshots({ [pid]: reported }, new Date().toISOString().slice(0, 10), project);
    await report(project);

    for (const name of SNAPSHOTS) {
      const own = JSON.parse(fs.readFileSync(path.join(getDataHome(project), 'dashboard', `reported-${name}.json`), 'utf-8'));
      expect(Object.keys(own)).toEqual([expect.stringMatching(new RegExp(`^${pid}@`))]);
    }
    // Compaction dropped that run; the next one in P reuses its ID and is a new session.
    fs.writeFileSync(path.join(teamaiHome(), 'dashboard', 'events.jsonl'), '');
    await session('copilot', { cwd: root });

    expect(await reportedSessions(project)).toBe(1);
  });

  it('a scope first seeded after a rollback skips what the earlier release reported', async () => {
    const { root, project } = await setup();
    await asEarlierRelease(() => session('claude', { session_id: 'rollback-p', cwd: root }));
    writeSharedSnapshots({ 'rollback-p': 1 }, new Date().toISOString().slice(0, 10));

    expect(await report(project)).toBeNull();
  });
});
