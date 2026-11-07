import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { resolveProjectDataHome } from '../../config.js';
import type { RunState } from '../../workflow/types.js';
import { CLAUDE_SESSIONS, envelope, fakeTool, ROOT, runCLI, type Ran } from '../helpers/step-runtime-e2e.js';

// The workflow's setup on the sandbox runtime teamai ships, on a fake docker whose containers run on the host
// (packages/runtime-sandbox/src/testing/fake-engine.mjs): setup runs in the step's container, with setup's keys only,
// and teamai's checks of what it left still hold there.

const IMAGE = 'e2e/agent:1';
const FAKE_ENGINE = path.join(ROOT, 'packages', 'runtime-sandbox', 'src', 'testing', 'fake-engine.mjs');

let dir: string;
let repo: string;
let engineLog: string;
let engineEnv: NodeJS.ProcessEnv;
let dataHome: string;

const writeFlow = (name: string, setup: string): void => {
  fs.writeFileSync(path.join(repo, '.teamai', 'workflows', `${name}.yaml`), `schemaVersion: v1alpha1
name: ${name}
description: ${name}
setup:
  command: ${JSON.stringify(setup)}
  requires: { env: [NPM_TOKEN] }
steps:
  - id: review
    workspace: new
    tool: claude
    prompt: Review the change in a fresh worktree.
    requires: { env: [PROMPT_KEY] }
    output:
      ok: boolean
`);
};

const start = (flow: string): Promise<Ran> => runCLI(['workflow', 'start', flow, '--driver', 'containers'], repo, {
  ...engineEnv, NPM_TOKEN: 'npm-value-7f3a', PROMPT_KEY: 'prompt-value-91c2', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-4d8e',
});

const readRunState = (ran: Ran): RunState => {
  const done = envelope(ran);
  const run = 'data' in done && typeof done.data.done === 'object' && done.data.done !== null && 'run' in done.data.done ? done.data.done.run : undefined;

  if (typeof run !== 'string') throw new Error(`no run in the envelope:\n${ran.stdout}\n${ran.stderr}`);

  return JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${run}.json`), 'utf8')) as RunState;
};

/** Each command the fake docker ran, as its argv. */
const engineCalls = (): string[][] => (fs.existsSync(engineLog) ? fs.readFileSync(engineLog, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as string[]).slice(1)) : []);

/** The names each `exec` passes into the container with `-e`. */
const passedNames = (exec: string[]): string[] => exec.flatMap((arg, at) => (exec[at - 1] === '-e' ? [arg] : []));

beforeAll(async () => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sandbox-setup-e2e-')));
  repo = path.join(dir, 'repo');
  engineLog = path.join(dir, 'engine.log');
  const engineBin = path.join(dir, 'engine-bin');
  const imageBin = path.join(dir, 'image-bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(engineBin);
  fs.mkdirSync(imageBin);
  fs.writeFileSync(path.join(engineBin, 'docker'), `#!/bin/sh\nFAKE_ENGINE_NAME=docker exec "${process.execPath}" "${FAKE_ENGINE}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(imageBin, 'claude'), fakeTool({ tool: 'claude', version: '2.1.0 (Claude Code)', homeVariable: 'CLAUDE_CONFIG_DIR', sessions: CLAUDE_SESSIONS }), { mode: 0o755 });
  engineEnv = {
    PATH: `${engineBin}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_ENGINE_STATE: path.join(dir, 'engine-state'), FAKE_ENGINE_LOG: engineLog, FAKE_ENGINE_IMAGES: JSON.stringify({ [IMAGE]: imageBin }),
  };

  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.npmrc\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['add', 'README.md', '.gitignore'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], { cwd: repo });
  const initialized = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
  expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
  const origin = path.join(dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['remote', 'set-url', 'origin', origin], { cwd: repo });
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repo });

  fs.mkdirSync(path.join(repo, '.teamai', 'drivers'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.teamai', 'drivers', 'containers.yaml'), stringify({
    schemaVersion: 'v1alpha1', name: 'containers', tool: 'claude',
    runtimes: [{ use: 'sandbox', options: { provider: 'docker', image: IMAGE, credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'env:CLAUDE_CODE_OAUTH_TOKEN' } } }],
  }));
  fs.mkdirSync(path.join(repo, '.teamai', 'workflows'), { recursive: true });
  // Setup prints the names it gets, then fails, so its output is quoted in the failure.
  writeFlow('setupnames', 'env | cut -d= -f1 | sort | tr "\\n" " "; exit 3');
  writeFlow('setupsecret', 'printf "%s" "$NPM_TOKEN" > .npmrc');
  const pulled = await runCLI(['pull'], repo);
  expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
  dataHome = await resolveProjectDataHome(repo);
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

it("runs setup in the step's container with setup's keys only, and fails the step with setup_failed when it exits non-zero", async () => {
  const before = engineCalls().length;
  const ran = await start('setupnames');

  expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
  const [review] = readRunState(ran).steps;
  expect(review).toMatchObject({ id: 'review', status: 'failed', failure: { code: 'setup_failed', message: expect.stringContaining('exited with code 3, so the step did not run') } });
  const printed = String(review?.failure?.message);
  expect(printed).toMatch(/\bNPM_TOKEN\b/);
  expect(printed).not.toMatch(/\bPROMPT_KEY\b/);
  expect(printed).not.toMatch(/\bCLAUDE_CODE_OAUTH_TOKEN\b/);
  // Setup ran in the container teamai created for the attempt, and the step's tool never started.
  const calls = engineCalls().slice(before);
  const execs = calls.filter(([command]) => command === 'exec');
  expect(execs).toEqual([expect.arrayContaining(['/bin/sh', '-c'])]);
  expect(passedNames(execs[0] ?? []).sort()).toEqual(['NPM_TOKEN', 'TEAMAI_MODE', 'TEAMAI_RUN_DIR', 'TEAMAI_WORKFLOW_ATTEMPT']);
  expect(execs.flat()).not.toContain('claude');
  expect(JSON.stringify(calls)).not.toMatch(/npm-value|prompt-value|oauth-value/);
});

it("fails the step with setup_secret when setup in the container leaves a key's value in a file, naming the file, never the value", async () => {
  const before = engineCalls().length;
  const ran = await start('setupsecret');

  expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
  expect(readRunState(ran).steps).toMatchObject([{
    id: 'review', status: 'failed',
    failure: { code: 'setup_secret', message: expect.stringMatching(/left the value of NPM_TOKEN in \.npmrc/) },
  }]);
  expect(`${ran.stdout}${ran.stderr}`).not.toContain('npm-value-7f3a');
  const execs = engineCalls().slice(before).filter(([command]) => command === 'exec');
  expect(execs).toHaveLength(1);
  expect(execs.flat()).not.toContain('claude');
});
