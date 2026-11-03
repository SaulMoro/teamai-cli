import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveProjectDataHome } from '../../config.js';
import type { StepState } from '../../workflow/step-state.js';
import type { RunState, WorkflowEnvelope } from '../../workflow/types.js';
import { TOY_RUNTIME } from '../helpers/toy-runtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

interface Ran {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runCLI(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...extraEnv, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function attemptOf(step: StepState | undefined): string {
  const attempt = step && 'attempt' in step ? step.attempt : undefined;
  if (typeof attempt !== 'string') throw new Error(`step ${step?.id ?? '?'} has no attempt`);
  return attempt;
}

function envelope(ran: Ran): WorkflowEnvelope {
  const line = ran.stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
  if (!line) throw new Error(`no JSON envelope in stdout:\n${ran.stdout}\n${ran.stderr}`);
  return JSON.parse(line) as WorkflowEnvelope;
}

// A fake claude: it writes its result, records how it was launched, keeps its session in $CLAUDE_CONFIG_DIR as Claude
// Code does, and on --resume continues that session.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2.1.0 (Claude Code)\\n');
  process.exit(0);
}
if (process.env.TEAMAI_WORKFLOW_RESULT === undefined) {
  // A judge: it reads the prompt on stdin and answers with a label.
  process.stdin.resume();
  process.stdin.on('end', () => process.stdout.write(JSON.stringify({ type: 'result', structured_output: { label: 'good', reasoning: 'read it' } }) + '\\n'));
  return;
}
const at = args.indexOf('--resume');
const resumed = at === -1 ? undefined : args[at + 1];
const session = resumed ?? 'sess-' + path.basename(process.env.TEAMAI_WORKFLOW_ATTEMPT);
const home = process.env.CLAUDE_CONFIG_DIR;
const project = path.join(home, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
const file = path.join(project, session + '.jsonl');
const before = fs.existsSync(file);
fs.mkdirSync(project, { recursive: true });
fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId: session, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'step' } }) + '\\n');
fs.appendFileSync(process.env.LAUNCHES, JSON.stringify({ home, resumed, sessionFoundBefore: before, secret: process.env.STEP_RUNTIME_SECRET ?? null }) + '\\n');
fs.mkdirSync(path.dirname(process.env.TEAMAI_WORKFLOW_RESULT), { recursive: true });
fs.writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, JSON.stringify({ output: { ok: true } }));
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-claude', session_id: session }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', session_id: session, usage: { input_tokens: 4, output_tokens: 2 } }) + '\\n');
`;

describe('workflow steps on a step runtime a driver definition chooses', () => {
  let sandbox: string;
  let repo: string;
  let bin: string;
  let launches: string;
  let dataHome: string;

  const env = (): NodeJS.ProcessEnv => ({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, LAUNCHES: launches });

  const writeDefinition = (name: string, options: Record<string, string>): void => {
    const drivers = path.join(repo, '.teamai', 'drivers');
    fs.mkdirSync(drivers, { recursive: true });
    const lines = Object.entries(options).map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`);
    fs.writeFileSync(path.join(drivers, `${name}.yaml`), [
      'schemaVersion: v1alpha1', `name: ${name}`, 'tool: claude', 'runtimes:', '  - use: toy', ...(lines.length > 0 ? ['    options:', ...lines] : []), '',
    ].join('\n'));
  };

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
    fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE);
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
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

    const done = envelope(ran);
    expect(done, ran.stderr).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    if ('error' in done) throw new Error(done.error.message);
    const runId = String((done.data.done as { run: string }).run);
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
});
