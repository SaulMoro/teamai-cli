import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { resolveProjectDataHome } from '../../config.js';
import type { RunState } from '../../workflow/types.js';
import { attemptOf, CLAUDE_SESSIONS, CLI, envelope, fakeTool, ROOT, runCLI, type Ran } from '../helpers/step-runtime-e2e.js';
import { TOY_RUNTIME } from '../helpers/toy-runtime.js';

// A driver definition that lists several runtimes: each `next` offers one runtime's `can`, in definition order, and a
// step goes to the first that can take it. The toy runtime is the member's own here, and `local` runs on the host.

describe('a driver definition with several runtimes', () => {
  let sandbox: string;
  let repo: string;
  let bin: string;
  let launches: string;
  let dataHome: string;
  let state: string;
  const memberConfig = (): string => path.join(os.homedir(), '.teamai', 'config.yaml');
  let memberConfigBefore: string | undefined;

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, LAUNCHES: launches, ...extra });

  /** A team definition `name` whose runtimes are `runtimes`, as YAML gives them. */
  const writeDefinition = (name: string, runtimes: Array<{ use: string; options?: Record<string, unknown> }>, { tool = 'claude', dir = path.join(repo, '.teamai', 'drivers') } = {}): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.yaml`), stringify({ schemaVersion: 'v1alpha1', name, tool, runtimes }));
  };

  const writeFlow = (name: string, steps: string): void => {
    fs.writeFileSync(path.join(repo, '.teamai', 'workflows', `${name}.yaml`), `schemaVersion: v1alpha1\nname: ${name}\ndescription: ${name}\nsteps:\n${steps}\n`);
  };

  /** Sets `workflows` keys in the member's own config, over what `init` wrote there. */
  const setMemberWorkflows = (workflows: Record<string, unknown>): void => {
    const current = (fs.existsSync(memberConfig()) ? parse(fs.readFileSync(memberConfig(), 'utf8')) : {}) as Record<string, unknown> | null;
    const base = current ?? {};
    const before = (base.workflows ?? {}) as Record<string, unknown>;
    fs.writeFileSync(memberConfig(), stringify({ ...base, workflows: { ...before, ...workflows } }));
  };

  const readRunState = (runId: string): RunState => JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${runId}.json`), 'utf8')) as RunState;
  const attemptDir = (runId: string, attempt: string): string => path.join(dataHome, 'workflows', 'runs', runId, 'attempts', attempt);
  const runtimeRecord = (runId: string, attempt: string): Record<string, unknown> | undefined => {
    const file = path.join(attemptDir(runId, attempt), 'runtime.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> : undefined;
  };

  const toyOpens = (): number => (fs.existsSync(path.join(state, 'ops'))
    ? fs.readdirSync(path.join(state, 'ops')).filter((name) => (JSON.parse(fs.readFileSync(path.join(state, 'ops', name), 'utf8')) as { kind: string }).kind === 'open').length
    : 0);

  const runOf = (ran: Ran): string => {
    const done = envelope(ran);
    const run = 'data' in done && typeof done.data.done === 'object' && done.data.done !== null && 'run' in done.data.done ? done.data.done.run : undefined;
    if (typeof run !== 'string') throw new Error(`no run in the envelope:\n${ran.stdout}\n${ran.stderr}`);
    return run;
  };

  beforeAll(async () => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-driver-runtimes-e2e-')));
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
    const origin = path.join(sandbox, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['remote', 'set-url', 'origin', origin], { cwd: repo });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(bin, 'claude'), fakeTool({ tool: 'claude', version: '2.1.0 (Claude Code)', homeVariable: 'CLAUDE_CONFIG_DIR', sessions: CLAUDE_SESSIONS }), { mode: 0o755 });
    const runtimeDir = path.join(os.homedir(), '.teamai', 'runtimes', 'toy');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.copyFileSync(TOY_RUNTIME, path.join(runtimeDir, 'runtime'));
    fs.chmodSync(path.join(runtimeDir, 'runtime'), 0o755);
    fs.mkdirSync(path.join(repo, '.teamai', 'workflows'), { recursive: true });
    writeFlow('mixed', `  - id: build
    workspace: new
    command: node -e "process.stdout.write(JSON.stringify({built:true}))"
    output:
      built: boolean
  - id: review
    needs: [build]
    tool: claude
    prompt: Review the repository without changing it.
    output:
      ok: boolean`);
    writeFlow('sandboxed', `  - id: review
    tool: claude
    prompt: Review the repository in a sandbox.
    requires: { isolation: sandbox, strict: true }
    output:
      ok: boolean`);
    writeFlow('pair', `  - id: left
    workspace: new
    prompt: Review the left half.
    output:
      ok: boolean
  - id: right
    needs: []
    workspace: new
    prompt: Review the right half.
    output:
      ok: boolean`);
    writeFlow('online', `  - id: fetch
    tool: claude
    prompt: Fetch the release notes.
    requires: { network: true }
    output:
      ok: boolean`);
    writeFlow('oneprompt', `  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean`);
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
    memberConfigBefore = fs.existsSync(memberConfig()) ? fs.readFileSync(memberConfig(), 'utf8') : undefined;
  });

  beforeEach(() => {
    state = fs.mkdtempSync(path.join(sandbox, 'toy-state-'));
    fs.rmSync(launches, { force: true });
    if (memberConfigBefore === undefined) fs.rmSync(memberConfig(), { force: true });
    else fs.writeFileSync(memberConfig(), memberConfigBefore);
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('runs a command step and a prompt step the first runtime cannot take on local, in the same run', async () => {
    // The toy offers no tool and only read-only places: the command needs a new worktree, the prompt a tool.
    writeDefinition('toyfirst', [{ use: 'toy', options: { state, can: { tools: [], workspace: ['read-only'] } } }, { use: 'local' }]);

    const ran = await runCLI(['workflow', 'start', 'mixed', '--driver', 'toyfirst'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(ran);
    const stored = readRunState(runId);
    expect(stored.steps.map((step) => [step.id, step.status])).toEqual([['build', 'succeeded'], ['review', 'succeeded']]);
    // Neither ran on the toy: it opened no place, and no attempt has a step runtime's record.
    expect(toyOpens()).toBe(0);
    for (const step of stored.steps) expect(runtimeRecord(runId, attemptOf(step))).toBeUndefined();
    // The prompt ran on the host, in the member's own Claude home.
    const launched = fs.readFileSync(launches, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { home: string });
    expect(launched).toEqual([expect.objectContaining({ home: path.join(os.homedir(), '.claude') })]);
  });

  it('fails a step whose requirements no single runtime meets, naming each runtime and what it lacks', async () => {
    // The toy is a sandbox with no tool; local has the tool and no sandbox.
    writeDefinition('splitd', [{ use: 'toy', options: { state, can: { isolation: 'sandbox', tools: [] } } }, { use: 'local' }]);

    const ran = await runCLI(['workflow', 'start', 'sandboxed', '--driver', 'splitd'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const [review] = readRunState(runOf(ran)).steps;
    expect(review).toMatchObject({ id: 'review', status: 'failed', failure: { code: 'requirement_unmet' } });
    const message = review && 'failure' in review ? review.failure?.message : '';
    expect(message).toContain('driver "splitd"');
    expect(message).toContain('runtime toy lacks tools');
    expect(message).toContain('runtime local lacks isolation');
    expect(toyOpens()).toBe(0);
  });

  it('refuses at start a strict sandbox step that no runtime of the definition is, naming the driver and its runtimes', async () => {
    writeDefinition('nosandbox', [{ use: 'toy', options: { state } }, { use: 'local' }]);
    const runs = (): string[] => (fs.existsSync(path.join(dataHome, 'workflows', 'runs')) ? fs.readdirSync(path.join(dataHome, 'workflows', 'runs')) : []);
    const before = runs();

    const ran = await runCLI(['workflow', 'start', 'sandboxed', '--driver', 'nosandbox'], repo, env());

    expect(envelope(ran)).toMatchObject({ error: { code: 'requirement_unmet' } });
    const refused = envelope(ran);
    const message = 'error' in refused ? refused.error.message : '';
    expect(message).toContain('Step "review" requires strict isolation');
    expect(message).toContain('driver "nosandbox"');
    expect(message).toContain('toy, local');
    // No run was created.
    expect(runs()).toEqual(before);
  });

  it('keeps what the runtime shows of the place in the attempt\'s record, for the run\'s details', async () => {
    const display = { label: 'toy place', url: 'https://runtimes.example.test/place/1', fields: { place: 'toy-1', image: 'warm:3f9c' } };
    writeDefinition('shown', [{ use: 'toy', options: { state, display } }]);

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'shown'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(ran);
    const [review] = readRunState(runId).steps;
    expect(runtimeRecord(runId, attemptOf(review))).toMatchObject({ runtime: 'toy', phase: 'closed', display });
  });

  it('records why each runtime holds a step back, which the run\'s details show once the driver stops', async () => {
    setMemberWorkflows({ allow: { network: false } });
    writeDefinition('both', [{ use: 'toy', options: { state } }, { use: 'local' }]);
    const runsDir = path.join(dataHome, 'workflows', 'runs');
    const before = new Set(fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []);

    const ran = await runCLI(['workflow', 'start', 'online', '--driver', 'both'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ error: { code: 'busy' } });
    const [runId] = fs.readdirSync(runsDir).filter((name) => !before.has(name) && name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length));
    const reason = 'step "fetch" needs network, which workflows.allow in local config does not allow on this machine';
    expect(JSON.parse(fs.readFileSync(path.join(runsDir, String(runId), 'held.json'), 'utf8'))).toEqual({
      driver: 'both',
      runtimes: [{ runtime: 'toy', held: [{ step: 'fetch', reason }] }, { runtime: 'local', held: [{ step: 'fetch', reason }] }],
    });
    expect(toyOpens()).toBe(0);
  });

  it('refuses a bad option of any runtime before a step runs, naming the key', async () => {
    writeDefinition('badparallel', [{ use: 'toy', options: { state, max_parallel: 'two' } }, { use: 'local' }]);
    const engineKey = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'badparallel'], repo, env());
    expect(envelope(engineKey)).toMatchObject({ error: { code: 'bad_option', message: expect.stringContaining('"max_parallel"') } });

    writeDefinition('badsecond', [{ use: 'local' }, { use: 'toy', options: { state, imgae: 'x' } }]);
    const runtimeKey = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'badsecond'], repo, env());
    expect(envelope(runtimeKey)).toMatchObject({ error: { code: 'bad_option', message: expect.stringContaining('"imgae"') } });

    writeDefinition('badlogin', [{ use: 'toy', options: { state, credentials: { codex: 'logn' } } }]);
    const credential = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'badlogin'], repo, env());
    expect(envelope(credential)).toMatchObject({ error: { code: 'bad_option', message: expect.stringContaining('"credentials.codex"') } });
    // No step ran: the fake tool was never launched.
    expect(fs.existsSync(launches)).toBe(false);
  });

  it('runs a team definition over the shipped one of its name, with the member\'s option over the team\'s', async () => {
    const teamState = path.join(sandbox, 'team-state');
    // The team replaces the shipped teamai-claude, which runs on local, with the toy.
    writeDefinition('teamai-claude', [{ use: 'toy', options: { state: teamState } }]);
    setMemberWorkflows({ drivers: { 'teamai-claude': { runtimes: { toy: { state } } } } });

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'claude'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(ran);
    const [review] = readRunState(runId).steps;
    expect(runtimeRecord(runId, attemptOf(review))).toMatchObject({ runtime: 'toy', driver: 'teamai-claude' });
    expect(toyOpens()).toBe(1);
    expect(fs.existsSync(teamState)).toBe(false);
    fs.rmSync(path.join(repo, '.teamai', 'drivers', 'teamai-claude.yaml'));
  });

  it('resolves the shipped teamai-t3, teamai-claude, teamai-codex and teamai-opencode, by either name', async () => {
    const t3 = envelope(await runCLI(['workflow', 'start', 'oneprompt', '--driver', 't3'], repo, env()));
    // The definition resolved: what is missing is the t3 runtime itself.
    expect(t3).toMatchObject({ error: { code: 'runtime_not_found', message: expect.stringContaining('Driver "teamai-t3" uses runtime "t3"') } });

    const claude = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'teamai-claude'], repo, env());
    expect(envelope(claude), claude.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    // Stand-ins for Codex and OpenCode, ahead of any real one, note each launch and fail the step.
    for (const tool of ['codex', 'opencode']) {
      fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.0.0; exit 0; fi\necho ${tool} >> "$LAUNCHES"\nexit 3\n`, { mode: 0o755 });
    }
    for (const tool of ['codex', 'opencode']) {
      fs.rmSync(launches, { force: true });
      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', tool], repo, env());
      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
      const [review] = readRunState(runOf(ran)).steps;
      expect(review).toMatchObject({ status: 'failed', tool });
      expect(fs.readFileSync(launches, 'utf8').trim()).toBe(tool);
    }
    for (const tool of ['codex', 'opencode']) fs.rmSync(path.join(bin, tool));
  });

  it('gives two parallel attempts of one run their own tool homes, and finds both transcripts once both are collected', async () => {
    writeDefinition('toyonly', [{ use: 'toy', options: { state } }]);
    setMemberWorkflows({ max_parallel: 2 });
    const spans = path.join(sandbox, 'spans-homes.jsonl');

    const ran = await runCLI(['workflow', 'start', 'pair', '--driver', 'toyonly'], repo, env({ FAKE_TOOL_SPANS: spans, FAKE_TOOL_BARRIER: '2', FAKE_TOOL_HOLD_MS: '15000' }));

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(ran);
    const steps = readRunState(runId).steps;
    const homes = steps.map((step) => path.join(attemptDir(runId, attemptOf(step)), 'tool-home', 'claude'));
    const launched = fs.readFileSync(launches, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { home: string }).home);
    expect(launched.sort()).toEqual([...homes].sort());
    // They overlapped: each started before the other ended.
    const edges = fs.readFileSync(spans, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { edge: string });
    expect(edges.map((edge) => edge.edge)).toEqual(['start', 'start', 'end', 'end']);
    for (const step of steps) {
      expect(step).toMatchObject({ status: 'succeeded', session: `sess-${attemptOf(step)}` });
      const scored = await runCLI(['score', '--run', runId, '--step', step.id, '--scorer', 'quality'], repo, env());
      expect(scored.stdout + scored.stderr).not.toContain('evidence_missing');
    }
  });

  it('caps a runtime at its own max_parallel, and offers the next runtime the step it has no room for', async () => {
    writeDefinition('toyone', [{ use: 'toy', options: { state, max_parallel: 1 } }, { use: 'local' }]);
    setMemberWorkflows({ max_parallel: 2 });
    const spans = path.join(sandbox, 'spans-cap.jsonl');

    const ran = await runCLI(['workflow', 'start', 'pair', '--driver', 'toyone'], repo, env({ FAKE_TOOL_SPANS: spans, FAKE_TOOL_BARRIER: '2', FAKE_TOOL_HOLD_MS: '15000' }));

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(ran);
    const ranOn = readRunState(runId).steps.map((step) => (runtimeRecord(runId, attemptOf(step))?.runtime as string | undefined) ?? 'local');
    expect(ranOn.sort()).toEqual(['local', 'toy']);
    const edges = fs.readFileSync(spans, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { edge: string });
    expect(edges.map((edge) => edge.edge)).toEqual(['start', 'start', 'end', 'end']);
  });

  it('runs a shipped runtime from the packed package, found in teamai\'s package directory before a same-named executable on PATH', async () => {
    // The package as npm packs it, with one more runtime entry, as a first-party runtime adds its own.
    const packs = path.join(sandbox, 'packs');
    fs.mkdirSync(packs, { recursive: true });
    const packed = execFileSync('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', packs], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').at(-1) ?? '';
    execFileSync('tar', ['-xzf', path.join(packs, packed), '-C', packs]);
    const pkg = path.join(packs, 'package');
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(pkg, 'node_modules'));
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')) as { bin: Record<string, string> };
    manifest.bin['teamai-runtime-shiptoy'] = 'dist/runtime-shiptoy.js';
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(manifest, null, 2));
    fs.copyFileSync(TOY_RUNTIME, path.join(pkg, 'dist', 'runtime-shiptoy.js'));
    // A stray executable of the same name on PATH, which must never run.
    const stray = path.join(sandbox, 'stray-ran');
    fs.writeFileSync(path.join(bin, 'teamai-runtime-shiptoy'), `#!/bin/sh\ntouch "${stray}"\nexit 1\n`, { mode: 0o755 });
    writeDefinition('shipd', [{ use: 'shiptoy', options: { state } }]);

    const ran = spawnSync(process.execPath, [path.join(pkg, 'dist', 'index.js'), 'workflow', 'start', 'oneprompt', '--driver', 'shipd'], { cwd: repo, env: { ...process.env, ...env(), FORCE_COLOR: '0' }, encoding: 'utf8' });

    const done = envelope({ code: ran.status, signal: null, stdout: ran.stdout, stderr: ran.stderr });
    expect(done, ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf({ code: ran.status, signal: null, stdout: ran.stdout, stderr: ran.stderr });
    const [review] = readRunState(runId).steps;
    expect(runtimeRecord(runId, attemptOf(review))).toMatchObject({ runtime: 'shiptoy', driver: 'shipd', phase: 'closed' });
    expect(toyOpens()).toBe(1);
    expect(fs.existsSync(stray)).toBe(false);
    fs.rmSync(path.join(bin, 'teamai-runtime-shiptoy'));
  });

  it('runs the member\'s own credential helper on the host push, never one the step planted in the checkout\'s config', async () => {
    // An origin that asks for credentials, so the push runs every credential helper git knows.
    const server = http.createServer((_request, response) => { response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="team"' }); response.end(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const planted = path.join(sandbox, 'planted-helper-ran');
    const member = path.join(sandbox, 'member-helper-ran');
    const gitconfig = path.join(os.homedir(), '.gitconfig');
    const gitconfigBefore = fs.existsSync(gitconfig) ? fs.readFileSync(gitconfig, 'utf8') : undefined;
    fs.appendFileSync(gitconfig, `[credential]\n\thelper = "!f() { touch '${member}'; }; f"\n`);
    writeFlow('plantcred', `  - id: build
    workspace: new
    command: git config extensions.worktreeConfig true && git config --worktree credential.helper "!f() { touch '${planted}'; }; f" && git config --worktree remote.origin.pushurl http://127.0.0.1:${port}/team/workflow.git && echo change > planted.txt`);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code).toBe(0);

    try {
      const ran = await runCLI(['workflow', 'start', 'plantcred', '--driver', 'local'], repo, env({ GIT_TERMINAL_PROMPT: '0' }));

      // The push was refused for want of credentials, after the member's helper was asked.
      expect(fs.existsSync(member), ran.stderr).toBe(true);
      expect(fs.existsSync(planted)).toBe(false);
    } finally {
      server.close();
      if (gitconfigBefore === undefined) fs.rmSync(gitconfig, { force: true });
      else fs.writeFileSync(gitconfig, gitconfigBefore);
    }
  });

  describe('with credentials: { codex: login }', () => {
    const dedicated = (): string => path.join(os.homedir(), '.teamai', 'logins', 'codex', 'auth.json');
    const auth = (account: string, refresh: string): string => JSON.stringify({ OPENAI_API_KEY: null, tokens: { account_id: account, refresh_token: refresh, access_token: 'access', id_token: 'id' }, last_refresh: '2026-11-01T00:00:00Z' });
    const dedicatedTokens = (): { account_id: string; refresh_token: string } => (JSON.parse(fs.readFileSync(dedicated(), 'utf8')) as { tokens: { account_id: string; refresh_token: string } }).tokens;
    const codexLaunches = (): Array<{ home: string; account: string; refresh: string }> => fs.readFileSync(launches, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { home: string; account: string; refresh: string });

    // A fake Codex: it reads the login in its home, records whose it is, holds, then refreshes it, as Codex does, for
    // the same account or for FAKE_CODEX_ACCOUNT's.
    const fakeCodex = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('codex-cli 0.130.0\\n'); process.exit(0); }
const home = process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex');
const file = path.join(home, 'auth.json');
const login = JSON.parse(fs.readFileSync(file, 'utf8'));
const span = (edge) => process.env.FAKE_TOOL_SPANS && fs.appendFileSync(process.env.FAKE_TOOL_SPANS, JSON.stringify({ attempt: process.env.TEAMAI_WORKFLOW_ATTEMPT, edge }) + '\\n');
span('start');
if (process.env.FAKE_CODEX_PID) fs.writeFileSync(process.env.FAKE_CODEX_PID, String(process.pid));
fs.appendFileSync(process.env.LAUNCHES, JSON.stringify({ home, account: login.tokens.account_id, refresh: login.tokens.refresh_token }) + '\\n');
if (process.env.FAKE_TOOL_HOLD_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_TOOL_HOLD_MS));
const next = 'r' + (Number(login.tokens.refresh_token.slice(1)) + 1);
fs.writeFileSync(file, JSON.stringify({ ...login, tokens: { ...login.tokens, account_id: process.env.FAKE_CODEX_ACCOUNT || login.tokens.account_id, refresh_token: next } }));
fs.mkdirSync(path.dirname(process.env.TEAMAI_WORKFLOW_RESULT), { recursive: true });
fs.writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, JSON.stringify({ output: { ok: true } }));
const thread = 'th-' + path.basename(process.env.TEAMAI_WORKFLOW_ATTEMPT);
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: thread }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } }) + '\\n');
span('end');
`;

    beforeEach(() => {
      fs.writeFileSync(path.join(bin, 'codex'), fakeCodex, { mode: 0o755 });
      fs.mkdirSync(path.dirname(dedicated()), { recursive: true });
      fs.writeFileSync(dedicated(), auth('acct-1', 'r1'), { mode: 0o600 });
      fs.chmodSync(dedicated(), 0o600);
      // The member's daily Codex login, which no step may ever see.
      fs.mkdirSync(path.join(os.homedir(), '.codex'), { recursive: true });
      fs.writeFileSync(path.join(os.homedir(), '.codex', 'auth.json'), auth('acct-daily', 'r900'));
    });

    afterAll(() => {
      fs.rmSync(path.join(bin, 'codex'), { force: true });
    });

    const loginDefinition = (name: string, toyState: string, extra: Record<string, unknown> = {}): void => {
      writeDefinition(name, [{ use: 'toy', options: { state: toyState, credentials: { codex: 'login' }, ...extra } }], { tool: 'codex' });
    };

    /** Starts `args` in the background, and resolves once its stderr holds `text`, or rejects after a while. */
    const startWatching = (args: string[], extra: NodeJS.ProcessEnv): { stderr: () => string; ended: Promise<Ran>; kill: () => void } => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: { ...process.env, ...env(extra), FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const ended = new Promise<Ran>((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
      return { stderr: () => stderr, ended, kill: () => child.kill('SIGKILL') };
    };

    const pidAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const lockFile = (): string => path.join(os.homedir(), '.teamai', 'logins', 'codex.lock');

    /** Starts a run whose fake Codex holds the login until stopped, and resolves with its run id and Codex's pid once Codex runs. */
    const holdingRun = async (definition: string): Promise<{ run: string; pid: number; watched: ReturnType<typeof startWatching> }> => {
      const pidFile = path.join(sandbox, `${definition}.pid`);
      fs.rmSync(pidFile, { force: true });
      const watched = startWatching(['workflow', 'start', 'oneprompt', '--driver', definition], { FAKE_TOOL_HOLD_MS: '120000', FAKE_CODEX_PID: pidFile });
      await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '', 'Codex to start');
      const run = /Run (r[0-9a-f]+) started/.exec(watched.stderr())?.[1] ?? '';
      expect(run).not.toBe('');
      return { run, pid: Number(fs.readFileSync(pidFile, 'utf8')), watched };
    };

    const waitFor = async (check: () => boolean, what: string): Promise<void> => {
      for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`timed out waiting for ${what}`);
    };

    it('copies the dedicated login into the attempt\'s tool home, never the member\'s own, and writes the refreshed one back', async () => {
      loginDefinition('codexlogin', state);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexlogin'], repo, env());

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const runId = runOf(ran);
      const [review] = readRunState(runId).steps;
      expect(codexLaunches()).toEqual([{ home: path.join(attemptDir(runId, attemptOf(review)), 'tool-home', 'codex'), account: 'acct-1', refresh: 'r1' }]);
      // Written back by compare-and-replace, keeping the dedicated file's permissions.
      expect(dedicatedTokens()).toMatchObject({ account_id: 'acct-1', refresh_token: 'r2' });
      expect(fs.statSync(dedicated()).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'))).toMatchObject({ tokens: { account_id: 'acct-daily', refresh_token: 'r900' } });
    });

    it('keeps the dedicated login when the step left one for another account, and fails the step with login_not_written_back', async () => {
      loginDefinition('codexother', state);

      const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexother'], repo, env({ FAKE_CODEX_ACCOUNT: 'acct-2' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
      const [review] = readRunState(runOf(ran)).steps;
      expect(review).toMatchObject({ status: 'failed', failure: { code: 'login_not_written_back', message: expect.stringContaining('another account') } });
      expect(review && 'failure' in review ? review.failure?.message : '').toContain(`CODEX_HOME=${path.dirname(dedicated())} codex login`);
      expect(dedicatedTokens()).toMatchObject({ account_id: 'acct-1', refresh_token: 'r1' });
    });

    it('runs two parallel attempts on the login one after the other', async () => {
      loginDefinition('codexpair', state);
      setMemberWorkflows({ max_parallel: 2 });
      const spans = path.join(sandbox, 'spans-login.jsonl');
      fs.rmSync(spans, { force: true });
      writeFlow('codexpair', `  - id: left
    workspace: new
    prompt: Review the left half.
    output:
      ok: boolean
  - id: right
    needs: []
    workspace: new
    prompt: Review the right half.
    output:
      ok: boolean`);
      const pulled = await runCLI(['pull'], repo);
      expect(pulled.code).toBe(0);

      const ran = await runCLI(['workflow', 'start', 'codexpair', '--driver', 'codexpair'], repo, env({ FAKE_TOOL_SPANS: spans, FAKE_TOOL_HOLD_MS: '1000' }));

      expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const edges = fs.readFileSync(spans, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { edge: string }).edge);
      expect(edges).toEqual(['start', 'end', 'start', 'end']);
      // The second used the login the first wrote back.
      expect(codexLaunches().map((launch) => launch.refresh)).toEqual(['r1', 'r2']);
      expect(dedicatedTokens().refresh_token).toBe('r3');
    });

    it('keeps the login held by an attempt whose driver was killed, so another run waits naming it until that attempt is resumed and written back', async () => {
      loginDefinition('codexdies', state, { die_at: 'exec-exited' });
      // Written before any run, so no read-only step sees the repository change under it.
      loginDefinition('codexwaits', fs.mkdtempSync(path.join(sandbox, 'toy-state-')));
      const killed = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexdies'], repo, env());
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const holder = /Run (r[0-9a-f]+) started/.exec(killed.stderr)?.[1] ?? '';
      expect(holder).not.toBe('');

      const waiting = startWatching(['workflow', 'start', 'oneprompt', '--driver', 'codexwaits'], {});
      await waitFor(() => waiting.stderr().includes(`login teamai keeps, which attempt`) && waiting.stderr().includes(`of run ${holder} holds`), 'the second run to name the holder');
      // It has not launched: only the killed attempt used the login.
      expect(codexLaunches()).toHaveLength(1);

      const resumed = await runCLI(['workflow', 'resume', holder, '--driver', 'codexdies'], repo, env());
      expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const second = await waiting.ended;
      expect(envelope(second), second.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      // The killed attempt ran once, wrote r2 back on resume, and the waiting one started from it.
      expect(codexLaunches().map((launch) => launch.refresh)).toEqual(['r1', 'r2']);
      expect(dedicatedTokens().refresh_token).toBe('r3');
    });

    it('stops the tool and closes the place of an attempt whose driver was killed when teamai workflow cancel stops its run, then releases the login', async () => {
      loginDefinition('codexorphan', state);
      const { run, pid, watched } = await holdingRun('codexorphan');
      watched.kill();
      await watched.ended;
      // The tool outlives its driver: only its runtime can stop it.
      expect(pidAlive(pid)).toBe(true);

      const cancelled = await runCLI(['workflow', 'cancel', run], repo, env());

      expect(envelope(cancelled), cancelled.stderr).toMatchObject({ data: { run: { status: 'cancelled' } } });
      expect(pidAlive(pid)).toBe(false);
      const [review] = readRunState(run).steps;
      expect(runtimeRecord(run, attemptOf(review))).toMatchObject({ runtime: 'toy', phase: 'closed' });
      expect(cancelled.stderr).toContain(`Released the codex login teamai keeps, which attempt ${attemptOf(review)} of run ${run} held.`);
      expect(fs.existsSync(lockFile())).toBe(false);
    });

    it('keeps the login held when teamai workflow cancel cannot reach the runtime of an attempt whose driver was killed, and says how to free it', async () => {
      loginDefinition('codexunreachable', state);
      const { run, pid, watched } = await holdingRun('codexunreachable');
      watched.kill();
      await watched.ended;
      fs.rmSync(path.join(repo, '.teamai', 'drivers', 'codexunreachable.yaml'));

      try {
        const cancelled = await runCLI(['workflow', 'cancel', run], repo, env());

        expect(envelope(cancelled), cancelled.stderr).toMatchObject({ data: { run: { status: 'cancelled' } } });
        const attempt = attemptOf(readRunState(run).steps[0]);
        expect(cancelled.stderr).toContain(`Could not stop attempt ${attempt} of run ${run} on step runtime "toy" of driver "codexunreachable"`);
        expect(cancelled.stderr).toContain(`The codex login teamai keeps stays held by attempt ${attempt} of run ${run}, whose tool may still run. Stop that tool on its step runtime, then delete ${lockFile()}.`);
        expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ run, attempt });
      } finally {
        process.kill(pid, 'SIGKILL');
        fs.rmSync(lockFile(), { force: true });
      }
    });

    it('leaves the login to a driver that still runs when teamai workflow cancel stops its run, which releases it once its tool stopped', async () => {
      loginDefinition('codexlive', state);
      const { run, pid, watched } = await holdingRun('codexlive');

      const cancelled = await runCLI(['workflow', 'cancel', run], repo, env());

      expect(cancelled.stderr).not.toContain('Released the codex login');
      const driven = await watched.ended;
      expect(envelope(driven), driven.stderr).toMatchObject({ data: { done: { outcome: 'cancelled' } } });
      expect(pidAlive(pid)).toBe(false);
      expect(fs.existsSync(lockFile())).toBe(false);
    });

    it('releases the login when teamai workflow cancel stops the run whose killed attempt held it', async () => {
      loginDefinition('codexcancel', state, { die_at: 'exec-exited' });
      loginDefinition('codexafter', fs.mkdtempSync(path.join(sandbox, 'toy-state-')));
      const killed = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexcancel'], repo, env());
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const holder = /Run (r[0-9a-f]+) started/.exec(killed.stderr)?.[1] ?? '';

      const cancelled = await runCLI(['workflow', 'cancel', holder], repo, env());
      expect(cancelled.stderr).toContain(`Released the codex login teamai keeps, which attempt`);

      const after = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'codexafter'], repo, env());
      expect(envelope(after), after.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(after.stderr).not.toContain('waits for the codex login');
    });
  });
});
