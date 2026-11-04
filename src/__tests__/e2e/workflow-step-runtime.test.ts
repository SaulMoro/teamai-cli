import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveProjectDataHome } from '../../config.js';
import type { RunState } from '../../workflow/types.js';
import { hasPython, TYPED_TERMINAL } from '../helpers/in-terminal.js';
import { TOY_RUNTIME } from '../helpers/toy-runtime.js';
import { attemptOf, CLAUDE_SESSIONS, CLI, CODEBUDDY_SESSIONS, envelope, fakeTool, runCLI, type Ran } from '../helpers/step-runtime-e2e.js';

describe('workflow steps on a step runtime a driver definition chooses', () => {
  let sandbox: string;
  let repo: string;
  let bin: string;
  let launches: string;
  let dataHome: string;

  const env = (): NodeJS.ProcessEnv => ({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, LAUNCHES: launches });

  const writeDefinition = (name: string, options: Record<string, string>, { use = 'toy', dir = path.join(repo, '.teamai', 'drivers') } = {}): void => {
    fs.mkdirSync(dir, { recursive: true });
    const lines = Object.entries(options).map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`);
    fs.writeFileSync(path.join(dir, `${name}.yaml`), [
      'schemaVersion: v1alpha1', `name: ${name}`, 'tool: claude', 'runtimes:', `  - use: ${use}`, ...(lines.length > 0 ? ['    options:', ...lines] : []), '',
    ].join('\n'));
  };

  /** A team runtime: the toy behind a script that notes each spawn in `spawns`. */
  const writeTeamRuntime = (relative: string, spawns: string): string => {
    const dir = path.join(repo, '.teamai', 'runtimes', relative);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runtime'), `#!/bin/sh\necho spawned >> "${spawns}"\nexec "${process.execPath}" "${TOY_RUNTIME}" "$@"\n`, { mode: 0o755 });
    return dir;
  };

  const runtimeRecords = (runId: string): Array<Record<string, unknown>> => fs.readdirSync(attemptsOf(runId))
    .map((attempt) => JSON.parse(fs.readFileSync(path.join(attemptsOf(runId), attempt, 'runtime.json'), 'utf8')) as Record<string, unknown>);

  const startedRun = (ran: Ran): string => {
    const id = /Run (r[0-9a-f]+) started/.exec(ran.stderr)?.[1];
    if (id === undefined) throw new Error(`no run started:\n${ran.stdout}\n${ran.stderr}`);
    return id;
  };

  /** The id of the run `ran` finished, which must have succeeded. */
  const succeededRun = (ran: Ran): string => {
    const done = envelope(ran);
    expect(done, ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = 'data' in done && typeof done.data.done === 'object' && done.data.done !== null && 'run' in done.data.done ? done.data.done.run : undefined;
    if (typeof run !== 'string') throw new Error(`no run in the envelope:\n${ran.stdout}`);
    return run;
  };

  /** The open operations the toy with state `state` recorded: one per attempt it opened, however often it was asked. */
  const toyOpens = (state: string): Array<{ handle: string }> => fs.readdirSync(path.join(state, 'ops'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(state, 'ops', name), 'utf8')) as { kind: string; handle: string })
    .filter((op) => op.kind === 'open');

  const readRunState = (runId: string): RunState => JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${runId}.json`), 'utf8')) as RunState;
  const attemptsOf = (runId: string): string => path.join(dataHome, 'workflows', 'runs', runId, 'attempts');

  beforeAll(async () => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-runtime-e2e-')));
    repo = path.join(sandbox, 'repo');
    bin = path.join(sandbox, 'fake-bin');
    launches = path.join(sandbox, 'launches.jsonl');
    fs.mkdirSync(repo);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], { cwd: repo });
    const initialized = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
    // Then a bare origin on disk, so a step's branch is pushed.
    const origin = path.join(sandbox, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['remote', 'set-url', 'origin', origin], { cwd: repo });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(bin, 'claude'), fakeTool({ tool: 'claude', version: '2.1.0 (Claude Code)', homeVariable: 'CLAUDE_CONFIG_DIR', sessions: CLAUDE_SESSIONS }));
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    fs.writeFileSync(path.join(bin, 'codebuddy'), fakeTool({ tool: 'codebuddy', version: '2.179.1', homeVariable: 'CODEBUDDY_CONFIG_DIR', sessions: CODEBUDDY_SESSIONS }));
    fs.chmodSync(path.join(bin, 'codebuddy'), 0o755);
    // The toy is the member's own runtime here, which runs without acceptance.
    const runtimeDir = path.join(os.homedir(), '.teamai', 'runtimes', 'toy');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.copyFileSync(TOY_RUNTIME, path.join(runtimeDir, 'runtime'));
    fs.chmodSync(path.join(runtimeDir, 'runtime'), 0o755);
    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, 'toyflow.yaml'), `schemaVersion: v1alpha1
name: toyflow
description: A command step and two prompt steps, the second resuming the first's session.
steps:
  - id: prepare
    command: node -e "process.stdout.write(JSON.stringify({ready:true}))"
    output:
      ready: boolean
  - id: review
    needs: [prepare]
    prompt: Review the repository without changing it.
    scorers: [quality]
    output:
      ok: boolean
  - id: followup
    needs: [review]
    session: { from: review }
    prompt: Follow up on the review.
    output:
      ok: boolean
`);
    const flows: Record<string, string> = {
      onecommand: `  - id: build
    command: node -e "require('fs').appendFileSync(process.env.RUNS_FILE, 'x'); process.stdout.write(JSON.stringify({built:true}))"
    output:
      built: boolean`,
      oneprompt: `  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean`,
      buddyprompt: `  - id: review
    tool: codebuddy
    prompt: Review the repository without changing it.
    scorers: [quality]
    output:
      ok: boolean`,
      failwork: `  - id: build
    workspace: new
    command: run=\${TEAMAI_WORKFLOW_ATTEMPT%%/*}; if git fetch -q origin "teamai/$run/build/p1" && test "$(git show FETCH_HEAD:work.txt)" = kept; then echo found; else echo kept > work.txt; exit 1; fi`,
      planthook: `  - id: build
    workspace: new
    command: git config extensions.worktreeConfig true && git config --worktree core.hooksPath "$PLANTED_HOOKS" && echo change > planted.txt`,
      sleeper: `  - id: wait
    command: sleep 60 & echo $! > "$CHILD_PID"; wait`,
    };
    for (const [name, steps] of Object.entries(flows)) {
      fs.writeFileSync(path.join(workflows, `${name}.yaml`), `schemaVersion: v1alpha1\nname: ${name}\ndescription: ${name}\nsteps:\n${steps}\n`);
    }
    fs.mkdirSync(path.join(repo, '.teamai', 'scorers'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.teamai', 'scorers', 'quality.md'), `---
labels:
  - { value: good, score: 1, description: Finds the real defects }
  - { value: missed, score: 0, description: Misses a real defect }
passingScore: 0.5
samplingRate: 0
---
Judge the review.
`);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
    dataHome = await resolveProjectDataHome(repo);
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('runs a command step and prompt steps on the toy runtime, each prompt in its attempt\'s tool home, the next resuming from a seeded copy', async () => {
    writeDefinition('toyd', { state: path.join(sandbox, 'toy-state-1') });
    fs.rmSync(launches, { force: true });

    const ran = await runCLI(['workflow', 'start', 'toyflow', '--driver', 'toyd'], repo, env());

    const runId = succeededRun(ran);
    const stored = readRunState(runId);
    expect(stored.steps.map((step) => [step.id, step.status])).toEqual([['prepare', 'succeeded'], ['review', 'succeeded'], ['followup', 'succeeded']]);
    expect(stored.steps[0]).toMatchObject({ outputs: { ready: true } });
    expect(stored.steps[1]).toMatchObject({ tool: 'claude', session: `sess-${attemptOf(stored.steps[1])}`, outputs: { ok: true } });
    // The follow-up resumed the review's session, from a copy of the review's tool home in its own.
    expect(stored.steps[2]).toMatchObject({ session: `sess-${attemptOf(stored.steps[1])}` });

    const records = fs.readdirSync(attemptsOf(runId)).map((attempt) => JSON.parse(fs.readFileSync(path.join(attemptsOf(runId), attempt, 'runtime.json'), 'utf8')) as Record<string, unknown>);
    expect(records).toHaveLength(3);
    for (const record of records) expect(record).toMatchObject({ runtime: 'toy', driver: 'toyd', phase: 'closed' });

    const launched = fs.readFileSync(launches, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { home: string; resumed?: string; sessionFoundBefore: boolean });
    const reviewAttempt = attemptOf(stored.steps[1]);
    const followupAttempt = attemptOf(stored.steps[2]);
    expect(launched).toEqual([
      { home: path.join(attemptsOf(runId), reviewAttempt, 'tool-home', 'claude'), sessionFoundBefore: false, secret: null },
      { home: path.join(attemptsOf(runId), followupAttempt, 'tool-home', 'claude'), resumed: `sess-${reviewAttempt}`, sessionFoundBefore: true, secret: null },
    ]);
    // Each prompt's result came back through the attempt's out/ directory.
    expect(fs.existsSync(path.join(attemptsOf(runId), reviewAttempt, 'out', 'result.json'))).toBe(true);

    // Scoring reads the review's session from its attempt's tool home: the member's own store has none.
    const scored = await runCLI(['score', '--run', runId, '--step', 'review', '--scorer', 'quality'], repo, env());
    expect(envelope(scored), scored.stderr).toMatchObject({ data: { label: { scorer: 'quality', label: 'good' } } });
  });

  it('runs a CodeBuddy prompt step on the toy runtime with CODEBUDDY_CONFIG_DIR set to its attempt\'s tool home', async () => {
    writeDefinition('toybuddy', { state: path.join(sandbox, 'toy-state-buddy') });
    fs.rmSync(launches, { force: true });

    const ran = await runCLI(['workflow', 'start', 'buddyprompt', '--driver', 'toybuddy'], repo, env());

    const runId = succeededRun(ran);
    const [review] = readRunState(runId).steps;
    expect(review).toMatchObject({ tool: 'codebuddy', session: `sess-${attemptOf(review)}`, outputs: { ok: true } });
    const launched = fs.readFileSync(launches, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { home: string });
    expect(launched).toEqual([{ home: path.join(attemptsOf(runId), attemptOf(review), 'tool-home', 'codebuddy'), sessionFoundBefore: false, secret: null }]);

    // Scoring reads the step's session from its attempt's CodeBuddy home: the member's own store has none.
    const scored = await runCLI(['score', '--run', runId, '--step', 'review', '--scorer', 'quality'], repo, env());
    expect(envelope(scored), scored.stderr).toMatchObject({ data: { label: { scorer: 'quality', label: 'good' } } });
  });

  it('resumes on the same handle after teamai is killed once the runtime accepted open, before it wrote the handle', async () => {
    const state = path.join(sandbox, 'toy-state-open');
    const runs = path.join(sandbox, 'runs-open');
    writeDefinition('toyopen', { state, die_at: 'open-accepted' });

    const killed = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'toyopen'], repo, { ...env(), RUNS_FILE: runs });
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    const runId = startedRun(killed);
    const [attempt] = fs.readdirSync(attemptsOf(runId));
    expect(JSON.parse(fs.readFileSync(path.join(attemptsOf(runId), String(attempt), 'runtime.json'), 'utf8'))).toMatchObject({ phase: 'opening', open: { op: expect.any(String) } });

    const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'toyopen'], repo, { ...env(), RUNS_FILE: runs });

    expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const [opened] = toyOpens(state);
    expect(toyOpens(state)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(attemptsOf(runId), String(attempt), 'runtime.json'), 'utf8'))).toMatchObject({ open: { handle: opened?.handle }, phase: 'closed' });
    expect(fs.readFileSync(runs, 'utf8')).toBe('x');
  });

  it('resumes on the definition the run was started with when the printed resume command names none', async () => {
    const state = path.join(sandbox, 'toy-state-recorded');
    const runs = path.join(sandbox, 'runs-recorded');
    writeDefinition('toyrecorded', { state, die_at: 'open-accepted' });

    const killed = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'toyrecorded'], repo, { ...env(), RUNS_FILE: runs });
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    const runId = startedRun(killed);
    expect(killed.stderr).toContain(`continue it with: teamai workflow resume ${runId}\n`);

    const resumed = await runCLI(['workflow', 'resume', runId], repo, { ...env(), RUNS_FILE: runs });

    expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(runs, 'utf8')).toBe('x');
    const [attempt] = fs.readdirSync(attemptsOf(runId));
    expect(toyOpens(state)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(attemptsOf(runId), String(attempt), 'runtime.json'), 'utf8'))).toMatchObject({ runtime: 'toy', driver: 'toyrecorded', phase: 'closed' });
  });

  it('refuses to resume a run whose recorded definition no longer resolves, naming it and how to go on', async () => {
    const state = path.join(sandbox, 'toy-state-gone');
    writeDefinition('toygone', { state, die_at: 'open-accepted' });
    const killed = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'toygone'], repo, { ...env(), RUNS_FILE: path.join(sandbox, 'runs-gone') });
    const runId = startedRun(killed);
    fs.rmSync(path.join(repo, '.teamai', 'drivers', 'toygone.yaml'));

    const resumed = await runCLI(['workflow', 'resume', runId], repo, env());

    expect(envelope(resumed)).toMatchObject({ error: { code: 'driver_not_found', message: expect.stringContaining('toygone') } });
  });

  it('reports the output, session and usage of an exec that finished while teamai was killed, without running it again', async () => {
    writeDefinition('toyexec', { state: path.join(sandbox, 'toy-state-exec'), die_at: 'exec-exited' });
    fs.rmSync(launches, { force: true });

    const killed = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'toyexec'], repo, env());
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    const runId = startedRun(killed);

    const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'toyexec'], repo, env());

    expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const [review] = readRunState(runId).steps;
    expect(review).toMatchObject({ status: 'succeeded', session: `sess-${attemptOf(review)}`, model: 'fake-claude', outputs: { ok: true }, tokens: { input: 4, output: 2 } });
    expect(fs.readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('commits and pushes a failed step\'s work, which its retry reads from the failed pass\'s branch', async () => {
    writeDefinition('toyretry', { state: path.join(sandbox, 'toy-state-retry') });

    const failed = await runCLI(['workflow', 'start', 'failwork', '--driver', 'toyretry'], repo, env());
    expect(envelope(failed), failed.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const runId = startedRun(failed);
    const retried = await runCLI(['workflow', 'retry', runId, 'build'], repo, env());
    expect(retried.code, retried.stderr).toBe(0);

    const resumed = await runCLI(['workflow', 'resume', runId, '--driver', 'toyretry'], repo, env());

    expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('does not run a hook the step planted in config.worktree while it commits the step\'s work', async () => {
    writeDefinition('toyhook', { state: path.join(sandbox, 'toy-state-hook') });
    const hooks = path.join(sandbox, 'planted-hooks');
    const mark = path.join(sandbox, 'hook-ran');
    fs.mkdirSync(hooks, { recursive: true });
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push']) {
      fs.writeFileSync(path.join(hooks, hook), `#!/bin/sh\necho ${hook} >> "${mark}"\n`, { mode: 0o755 });
    }

    const ran = await runCLI(['workflow', 'start', 'planthook', '--driver', 'toyhook'], repo, { ...env(), PLANTED_HOOKS: hooks });

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const [build] = readRunState(String(startedRun(ran))).steps;
    expect(build).toMatchObject({ status: 'succeeded', changes: { commits: [expect.any(String)] } });
    expect(fs.existsSync(mark)).toBe(false);
  });

  it('cancels a running step with the processes it started', async () => {
    writeDefinition('toycancel', { state: path.join(sandbox, 'toy-state-cancel') });
    const pidFile = path.join(sandbox, 'sleeper.pid');

    const running = runCLI(['workflow', 'start', 'sleeper', '--driver', 'toycancel'], repo, { ...env(), CHILD_PID: pidFile });
    const deadline = Date.now() + 30_000;
    while (!(fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const child = Number(fs.readFileSync(pidFile, 'utf8').trim());
    const runs = fs.readdirSync(path.join(dataHome, 'workflows', 'runs')).filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, ''));
    const runId = runs.find((id) => readRunState(id).name === 'sleeper');
    expect(runId).toBeDefined();

    const cancelled = await runCLI(['workflow', 'cancel', String(runId)], repo, env());
    expect(cancelled.code, cancelled.stderr).toBe(0);

    const ended = await running;
    expect(envelope(ended), ended.stderr).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
    expect(() => process.kill(child, 0)).toThrow();
  });

  it('does not spawn a team runtime at a revision no one accepted here, and runs it once a person accepts it at the terminal', async () => {
    const spawns = path.join(sandbox, 'team-spawns');
    const runtimeDir = writeTeamRuntime('teamtoy', spawns);
    writeDefinition('teamd', { state: path.join(sandbox, 'toy-state-team') }, { use: 'teamtoy' });
    const runs = path.join(sandbox, 'runs-team');

    const refused = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'teamd'], repo, { ...env(), RUNS_FILE: runs });

    expect(envelope(refused)).toMatchObject({ error: { code: 'runtime_not_accepted', message: expect.stringContaining('runtimes/teamtoy') } });
    expect(fs.existsSync(spawns)).toBe(false);
    if (!hasPython) return;

    const pidFile = path.join(sandbox, 'pty.pid');
    const screen = path.join(sandbox, 'pty.out');
    const typed = path.join(sandbox, 'pty.in');
    const attended = spawn('python3', ['-c', TYPED_TERMINAL, pidFile, screen, typed, process.execPath, CLI, 'workflow', 'start', 'onecommand', '--driver', 'teamd'], {
      cwd: repo, env: { ...process.env, ...env(), RUNS_FILE: runs, TEAMAI_MODE: 'attended', FORCE_COLOR: '0' }, stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => attended.on('close', resolve));
    const deadline = Date.now() + 30_000;
    while (!(fs.existsSync(screen) && fs.readFileSync(screen, 'utf8').includes('Run it? [y/N]')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(spawns)).toBe(false);
    fs.writeFileSync(typed, 'y\r');

    expect(await exited, fs.readFileSync(screen, 'utf8')).toBe(0);
    expect(fs.readFileSync(spawns, 'utf8')).toBe('spawned\n');
    expect(fs.readFileSync(runs, 'utf8')).toBe('x');

    // Any change to the runtime's directory is a new revision, which needs accepting again.
    fs.writeFileSync(path.join(runtimeDir, 'notes.txt'), 'changed\n');
    const changed = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'teamd'], repo, { ...env(), RUNS_FILE: runs });
    expect(envelope(changed)).toMatchObject({ error: { code: 'runtime_not_accepted' } });
    expect(fs.readFileSync(spawns, 'utf8')).toBe('spawned\n');
  });

  it('runs the same definition for --driver x and --driver teamai-x', async () => {
    writeDefinition('teamai-toyx', { state: path.join(sandbox, 'toy-state-x') });

    for (const name of ['toyx', 'teamai-toyx']) {
      const ran = await runCLI(['workflow', 'start', 'onecommand', '--driver', name], repo, { ...env(), RUNS_FILE: path.join(sandbox, `runs-${name}`) });

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(runtimeRecords(startedRun(ran))).toEqual([expect.objectContaining({ runtime: 'toy', driver: 'teamai-toyx' })]);
    }
  });

  it('runs the member\'s own definition over the team\'s of the same name, and never for a run resume --next takes', async () => {
    const teamState = path.join(sandbox, 'toy-state-team-own');
    const ownState = path.join(sandbox, 'toy-state-own');
    writeDefinition('toyown', { state: teamState });
    writeDefinition('toyown', { state: ownState }, { dir: path.join(os.homedir(), '.teamai', 'drivers') });
    writeDefinition('onlymine', { state: ownState }, { dir: path.join(os.homedir(), '.teamai', 'drivers') });

    const ran = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'toyown'], repo, { ...env(), RUNS_FILE: path.join(sandbox, 'runs-own') });

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(toyOpens(ownState)).toHaveLength(1);
    expect(fs.existsSync(teamState)).toBe(false);

    const next = await runCLI(['workflow', 'resume', '--next', '--driver', 'onlymine'], repo, env());
    expect(envelope(next)).toMatchObject({ error: { code: 'driver_not_found', message: expect.stringContaining('"onlymine"') } });
  });

  it('refuses a runtime name two active namespaces define, and an option the runtime does not take', async () => {
    writeTeamRuntime(path.join('ns-one', 'dup'), path.join(sandbox, 'dup-spawns'));
    writeTeamRuntime(path.join('ns-two', 'dup'), path.join(sandbox, 'dup-spawns'));
    writeDefinition('toydup', {}, { use: 'dup' });
    writeDefinition('toybad', { state: path.join(sandbox, 'toy-state-bad'), imgae: 'x' });

    const conflict = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'toydup'], repo, env());
    const badOption = await runCLI(['workflow', 'start', 'onecommand', '--driver', 'toybad'], repo, env());

    expect(envelope(conflict)).toMatchObject({ error: { code: 'runtime_namespace_conflict', message: expect.stringContaining('ns-one') } });
    expect(envelope(badOption)).toMatchObject({ error: { code: 'bad_option', message: expect.stringContaining('"imgae"') } });
    expect(fs.existsSync(path.join(sandbox, 'dup-spawns'))).toBe(false);
  });
});
