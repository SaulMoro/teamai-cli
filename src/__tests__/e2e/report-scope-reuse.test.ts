import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { DashboardEvent } from '../../types.js';

const cli = path.resolve('dist/index.js');
let sandbox = '';
let dashboard: ChildProcess | undefined;

async function stopDashboard(): Promise<void> {
  if (dashboard && dashboard.exitCode === null) {
    const exited = once(dashboard, 'exit');
    dashboard.kill('SIGTERM');
    await exited;
  }
  dashboard = undefined;
}

afterEach(async () => {
  await stopDashboard();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

/** A git project P whose data home lives in the project, and the real CLI to drive it. */
function fixture() {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-scope-reuse-')));
  const home = path.join(sandbox, 'home');
  const project = path.join(sandbox, 'project');
  const dataHome = path.join(project, '.teamai');
  const remote = path.join(sandbox, 'remote.git');
  const clone = path.join(dataHome, 'team-repo');
  const logDir = path.join(home, '.teamai', 'dashboard');
  const logPath = path.join(logDir, 'events.jsonl');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Scope Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Scope Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', NO_COLOR: '1',
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'teamai.yaml'), YAML.stringify({ team: 'scope-test', repo: remote, provider: 'git' }));
  git('add', 'teamai.yaml');
  git('commit', '-qm', 'fixture');
  git('clone', '-q', '--bare', project, remote);
  git('clone', '-q', remote, clone);
  fs.writeFileSync(path.join(dataHome, 'config.yaml'), YAML.stringify({
    repo: { localPath: clone, remote, kind: 'git' }, username: 'tester', scope: 'project', projectRoot: project,
    updatePolicy: 'skip', enabledAgents: ['claude'], additionalRoles: [],
  }));
  const writeLog = (events: DashboardEvent[]) => fs.writeFileSync(logPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  /** The shared snapshots an earlier release left, `prompts` reported per bare session ID. */
  const writeSharedSnapshots = (prompts: Record<string, number>, date: string) => {
    const entries = (value: (n: number) => unknown) => Object.fromEntries(Object.entries(prompts).map(([sid, n]) => [sid, value(n)]));
    const snapshots = {
      interventions: entries(() => ({ interrupt: 0, toolReject: 0, correction: 0 })),
      'prompt-tokens': entries((n) => ({ prompts: n, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } })),
      'daily-sessions': entries((n) => ({ date, prompts: n, durationMs: 3_600_000, succeeded: 1, corrected: 0 })),
    };
    for (const [name, value] of Object.entries(snapshots)) {
      fs.writeFileSync(path.join(logDir, `reported-${name}.json`), JSON.stringify(value));
    }
  };
  const pull = () => execFileSync(process.execPath, [cli, 'pull'], { cwd: project, env, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
  const stats = () => YAML.parse(git('--git-dir', remote, 'show', 'teamai-reports:stats/tester.yaml'));
  const reportsHead = () => {
    try { return git('--git-dir', remote, 'rev-parse', '--verify', '-q', 'teamai-reports'); } catch { return ''; }
  };
  return { project, dataHome, remote, logPath, env, git, writeLog, writeSharedSnapshots, pull, stats, reportsHead };
}

it('real CLI preserves a path-keyed reuse and replays a delayed exit emitted by the real monitor', async () => {
  const { project, dataHome, logPath, env, git, remote, writeLog, writeSharedSnapshots, pull, stats } = fixture();
  const now = Date.now();
  const timestamp = (offset: number) => new Date(now + offset).toISOString();
  const event = (type: DashboardEvent['type'], offset: number): DashboardEvent => ({
    type, timestamp: timestamp(offset), sessionId: 'pid-123', tool: 'copilot',
  });
  const oldUser = [event('prompt_submit', -120_000), event('session_end', -119_000)];
  const firstRun = [
    { ...event('session_start', -60_000), dataHome, monitorPid: 99999999 },
    { ...event('prompt_submit', -59_000), dataHome },
    { ...event('stop', -58_000), dataHome },
  ];
  writeLog([...oldUser, ...firstRun]);
  writeSharedSnapshots({ 'pid-123': 1 }, timestamp(0).slice(0, 10));
  pull();
  expect(stats()).toMatchObject({ prompts: 1, interventions: { sessions: 1 } });

  // Capture an actual monitor event, then replay the race: SessionEnd and the
  // next invocation arrive after the monitor read but before its exit append.
  dashboard = spawn(process.execPath, [cli, 'dashboard', '--port', '0'], { cwd: project, env, stdio: 'pipe' });
  let output = '';
  dashboard.stdout?.on('data', data => { output += data.toString(); });
  dashboard.stderr?.on('data', data => { output += data.toString(); });
  let exit: DashboardEvent | undefined;
  const deadline = Date.now() + 25_000;
  while (!exit && Date.now() < deadline) {
    if (dashboard.exitCode !== null) throw new Error(output);
    const events: DashboardEvent[] = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    exit = events.find(e => e.type === 'process_exit');
    if (!exit) await new Promise(resolve => setTimeout(resolve, 100));
  }
  await stopDashboard();
  expect(exit?.processExitAfter, output).toBe(firstRun[2].timestamp);
  if (!exit) throw new Error('The dashboard monitor did not record an exit.');
  writeLog([
    ...oldUser, ...firstRun,
    { ...event('session_end', -57_000), dataHome },
    { ...event('session_start', -56_000), dataHome },
    exit,
    { ...event('prompt_submit', 0), timestamp: new Date(Date.parse(exit.timestamp) + 1000).toISOString(), dataHome },
    { ...event('stop', 0), timestamp: new Date(Date.parse(exit.timestamp) + 2000).toISOString(), dataHome },
  ]);
  pull();
  expect(stats()).toMatchObject({ prompts: 2, interventions: { sessions: 2 } });
  const reportedHead = git('--git-dir', remote, 'rev-parse', 'teamai-reports');
  pull();
  expect(git('--git-dir', remote, 'rev-parse', 'teamai-reports')).toBe(reportedHead);
  const shown = execFileSync(process.execPath, [cli, 'stats'], { cwd: project, env, encoding: 'utf8', timeout: 15_000 });
  expect(shown).toMatch(/Sessions:\s+2/);
  expect(shown).toMatch(/Conversation turns:\s+2/);
}, 60_000);

it('real CLI sends no run of an aggregated bare ID again and splits a reused ID a crash left open', () => {
  const { project, dataHome, writeLog, writeSharedSnapshots, pull, stats, reportsHead } = fixture();
  const now = Date.now();
  let offset = -600_000;
  const event = (type: DashboardEvent['type'], sessionId: string, fields: Partial<DashboardEvent> = {}): DashboardEvent =>
    ({ type, timestamp: new Date(now + (offset += 1000)).toISOString(), sessionId, tool: 'claude', ...fields });
  const legacyId = `pid-321-${project}`;
  const legacyRun = () => [
    event('session_start', legacyId, { cwd: project }), event('prompt_submit', legacyId, { cwd: project }),
    event('stop', legacyId, { cwd: project }), event('session_end', legacyId, { cwd: project }),
  ];
  // An earlier release recorded two runs of one fallback ID and reported them as one.
  const legacy = [...legacyRun(), ...legacyRun()];
  writeLog(legacy);
  writeSharedSnapshots({ [legacyId]: 2 }, new Date(now).toISOString().slice(0, 10));
  pull();
  expect(reportsHead()).toBe('');

  // A run that crashed with no dashboard running: nothing ends it.
  const crashed = [
    event('session_start', 'pid-9', { dataHome, monitorPid: 99999998 }),
    event('prompt_submit', 'pid-9', { dataHome }), event('stop', 'pid-9', { dataHome }),
  ];
  writeLog([...legacy, ...crashed]);
  pull();
  expect(stats()).toMatchObject({ prompts: 1, interventions: { sessions: 1 } });

  // The next invocation reuses the ID from another process.
  const next = [
    event('session_start', 'pid-9', { dataHome, monitorPid: 99999999 }),
    event('prompt_submit', 'pid-9', { dataHome }), event('stop', 'pid-9', { dataHome }),
  ];
  writeLog([...legacy, ...crashed, ...next]);
  pull();
  expect(stats()).toMatchObject({ prompts: 2, interventions: { sessions: 2 } });
}, 60_000);
