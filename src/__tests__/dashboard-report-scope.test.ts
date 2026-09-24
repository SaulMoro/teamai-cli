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

/** Report the way pull does, and return the sessions that scope's stats now hold. */
async function reportedSessions(config: LocalConfig): Promise<number> {
  await reportUsageToTeam(config.repo.localPath, config.username, { skipTruncate: true, selfConfig: config });
  const statsPath = path.join(path.dirname(config.repo.localPath), 'reports-wt', 'stats', `${config.username}.yaml`);
  if (!fs.existsSync(statsPath)) return 0;
  const stats: unknown = YAML.parse(fs.readFileSync(statsPath, 'utf-8'));
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

  it('a Copilot session, which records no cwd, is reported by its project', async () => {
    const { root, user, project } = await setup();
    await session('copilot', { session_id: 'copilot-p', cwd: root });

    expect(await reportedSessions(user)).toBe(0);
    expect(await reportedSessions(project)).toBe(1);
  });

  it('a session started under a symlinked path of the project is reported by the project', async () => {
    const { root, user, project } = await setup();
    const link = path.join(tmp, 'link-p');
    fs.symlinkSync(root, link, 'dir');
    await session('claude', { session_id: 'sid-link', cwd: link });

    expect(await reportedSessions(user)).toBe(0);
    expect(await reportedSessions(project)).toBe(1);
  });

  it('events recorded before sessions carried a data home go to their project, never to the user scope', async () => {
    const { root, user, project } = await setup();
    const link = path.join(tmp, 'link-p');
    fs.symlinkSync(root, link, 'dir');
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
      ...old('old-no-cwd', undefined),
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');

    expect(await reportedSessions(user)).toBe(0);
    expect(await reportedSessions(project)).toBe(2);
  });
});
