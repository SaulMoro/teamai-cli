import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveProjectDataHome } from '../../config.js';
import type { RunState } from '../../workflow/types.js';
import { CLAUDE_SESSIONS, CLI, envelope, fakeTool, runCLI, type Ran } from '../helpers/step-runtime-e2e.js';

// `--driver local`, the member's default driver, as a member runs it: what its runs record and how they end, which the
// split of the host command slot from the runtime that launches tools keeps as it was.

describe('the local driver, end to end', () => {
  let sandbox: string;
  let repo: string;
  let bare: string;
  let bin: string;
  let launches: string;
  const dataHomes = new Map<string, string>();

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, LAUNCHES: launches, ...extra });

  const writeFlow = (at: string, name: string, steps: string): void => {
    fs.mkdirSync(path.join(at, '.teamai', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(at, '.teamai', 'workflows', `${name}.yaml`), `schemaVersion: v1alpha1\nname: ${name}\ndescription: ${name}\nsteps:\n${steps}\n`);
  };

  const runsOf = (at: string): string => path.join(dataHomes.get(at) ?? '', 'workflows', 'runs');

  const runIds = (at = repo): Set<string> => new Set(fs.existsSync(runsOf(at))
    ? fs.readdirSync(runsOf(at)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length))
    : []);

  const readRunState = (runId: string, at = repo): RunState => JSON.parse(fs.readFileSync(path.join(runsOf(at), `${runId}.json`), 'utf8')) as RunState;

  const launched = (): Array<{ resumed?: string }> => (fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { resumed?: string }) : []);

  const initRepo = async (at: string, args: string[]): Promise<void> => {
    fs.mkdirSync(at);
    fs.writeFileSync(path.join(at, 'README.md'), '# fixture\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: at });
    execFileSync('git', ['add', 'README.md'], { cwd: at });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: at });
    execFileSync('git', ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], { cwd: at });
    const initialized = await runCLI(['init', '--self', ...args, '--force'], at);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
    const origin = `${at}.git`;
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['remote', 'set-url', 'origin', origin], { cwd: at });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: at });
  };

  beforeAll(async () => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-local-tools-e2e-')));
    repo = path.join(sandbox, 'repo');
    bare = path.join(sandbox, 'bare');
    bin = path.join(sandbox, 'fake-bin');
    launches = path.join(sandbox, 'launches.jsonl');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), fakeTool({ tool: 'claude', version: '2.1.0 (Claude Code)', homeVariable: 'CLAUDE_CONFIG_DIR', sessions: CLAUDE_SESSIONS }), { mode: 0o755 });
    await initRepo(repo, ['--agent', 'claude']);
    await initRepo(bare, []);
    for (const at of [repo, bare]) dataHomes.set(at, await resolveProjectDataHome(at));
    writeFlow(repo, 'oneprompt', `  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean`);
    writeFlow(repo, 'twoprompts', `  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean
  - id: recall
    needs: [review]
    session: { from: review }
    prompt: Say what you reviewed.
    output:
      ok: boolean`);
    writeFlow(repo, 'sealed', `  - id: sealed
    prompt: Review the repository in a sandbox.
    requires: { isolation: sandbox, strict: true }
    output:
      ok: boolean`);
    writeFlow(bare, 'oneprompt', `  - id: review
    prompt: Review the repository without changing it.
    output:
      ok: boolean`);

    for (const at of [repo, bare]) {
      const pulled = await runCLI(['pull'], at);
      expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
    }
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /** The data home the run records go to, found from the run teamai just started. */
  const runOf = (ran: Ran, before: Set<string>, at = repo): string => {
    const runId = [...runIds(at)].find((id) => !before.has(id));
    if (runId === undefined) throw new Error(`no new run:\n${ran.stdout}\n${ran.stderr}`);

    return runId;
  };

  it('resumes a run whose teamai was killed while its headless prompt ran, and runs the step to the end', async () => {
    fs.rmSync(launches, { force: true });
    const before = runIds();
    const child = spawn(process.execPath, [CLI, 'workflow', 'start', 'oneprompt', '--driver', 'local', '--tools', 'default=claude'], { cwd: repo, env: { ...process.env, ...env({ FAKE_TOOL_HOLD_MS: '60000' }), FORCE_COLOR: '0' }, stdio: 'ignore' });
    const deadline = Date.now() + 30_000;

    while (launched().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(launched()).toHaveLength(1);
    const ended = new Promise((resolve) => child.on('close', resolve));
    child.kill('SIGKILL');
    await ended;

    const runId = [...runIds()].find((id) => !before.has(id));

    const resumed = await runCLI(['workflow', 'resume', String(runId), '--driver', 'local', '--tools', 'default=claude'], repo, env());

    expect(envelope(resumed), resumed.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(readRunState(String(runId)).steps).toMatchObject([{ id: 'review', status: 'succeeded', tool: 'claude', outputs: { ok: true } }]);
    // The resumed teamai launched the step again: the tool the killed one started does not report.
    expect(launched()).toHaveLength(2);
  });

  it('resumes the earlier step\'s session in a session.from step, with no notice and no place held', async () => {
    fs.rmSync(launches, { force: true });
    const before = runIds();

    const ran = await runCLI(['workflow', 'start', 'twoprompts', '--driver', 'local', '--tools', 'default=claude'], repo, env());

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const runId = runOf(ran, before);
    const [review, recall] = readRunState(runId).steps;
    const session = review && 'session' in review ? review.session : undefined;
    expect(recall).toMatchObject({ status: 'succeeded', resumed: { tool: 'claude', id: session } });
    expect(launched().map((launch) => launch.resumed)).toEqual([undefined, session]);
    expect(ran.stderr).not.toContain('did not continue');
    // No attempt kept a record of a runtime, as a place held for a conversation keeps one.
    const attempts = path.join(runsOf(repo), runId, 'attempts');
    expect(fs.readdirSync(attempts).filter((attempt) => fs.existsSync(path.join(attempts, attempt, 'runtime.json')))).toEqual([]);
  });

  it('refuses a strict sandbox step with the text the local driver always gave', async () => {
    const ran = await runCLI(['workflow', 'start', 'sealed', '--driver', 'local'], repo, env());

    expect(envelope(ran)).toMatchObject({ error: { message: 'Step "sealed" requires strict isolation, and the local driver here is not a sandbox. Run it in CI or a container, and declare it with --sandbox or workflows.sandbox: true.' } });
  });

  it('fails an unattended prompt step with no tool set, naming the three places one is set', async () => {
    const before = runIds(bare);

    const ran = await runCLI(['workflow', 'start', 'oneprompt', '--driver', 'local'], bare, env({ TEAMAI_AI_TOOL: '' }));

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(readRunState(runOf(ran, before, bare), bare).steps).toMatchObject([{ status: 'failed', failure: {
      code: 'tool_unconfigured',
      message: expect.stringContaining('Name one with the step\'s tool:, with --tools default=<tool>, or with ai.tool in your teamai config'),
    } }]);
  });
});
