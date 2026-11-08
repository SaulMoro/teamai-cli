import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LAUNCH_ADAPTERS } from '../../tool-launch/adapters.js';
import type { LaunchAdapter } from '@teamai/tool-core/launch';
import { stringify } from 'yaml';
import { z } from 'zod';
import { resolveProjectDataHome } from '../../config.js';
import type { RunState } from '../../workflow/types.js';
import { CLAUDE_SESSIONS, envelope, fakeTool, ROOT, runCLI, type Ran } from '../helpers/step-runtime-e2e.js';

// The sandbox runtime teamai ships, on a fake docker whose containers run on the host
// (packages/runtime-sandbox/src/testing/fake-engine.mjs), driven by the built CLI.

const IMAGE = 'e2e/agent:1';
const FAKE_ENGINE = path.join(ROOT, 'packages', 'runtime-sandbox', 'src', 'testing', 'fake-engine.mjs');

let dir: string;
let repo: string;
let engineLog: string;
let engineEnv: NodeJS.ProcessEnv;
let dataHome: string;
/** The member's sign-in variables, kept out of every run here and put back after. */
const signIns = Object.values(LAUNCH_ADAPTERS).flatMap((adapter: LaunchAdapter) => [...(adapter.signIn?.variables ?? []), ...(adapter.signIn?.alongside ?? [])]);
const savedSignIns = Object.fromEntries(signIns.map((name) => [name, process.env[name]]));

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
const engineCalls = (): string[][] => (fs.existsSync(engineLog) ? fs.readFileSync(engineLog, 'utf8').trim().split('\n').map((line) => z.array(z.string()).parse(JSON.parse(line)).slice(1)) : []);

/** The names each `exec` passes into the container with `-e`. */
const passedNames = (exec: string[]): string[] => exec.flatMap((arg, at) => (exec[at - 1] === '-e' ? [arg] : []));

beforeAll(async () => {
  for (const name of signIns) delete process.env[name];
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
  fs.writeFileSync(path.join(repo, '.teamai', 'drivers', 'keychain.yaml'), stringify({
    schemaVersion: 'v1alpha1', name: 'keychain', tool: 'claude', runtimes: [{ use: 'sandbox', options: { provider: 'docker', image: IMAGE } }],
  }));
  fs.mkdirSync(path.join(repo, '.teamai', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.teamai', 'workflows', 'review.yaml'), 'schemaVersion: v1alpha1\nname: review\ndescription: review\nsteps:\n  - id: review\n    tool: claude\n    prompt: Review the repository.\n    output:\n      ok: boolean\n');
  // Setup prints the names it gets, then fails, so its output is quoted in the failure.
  writeFlow('setupnames', 'env | cut -d= -f1 | sort | tr "\\n" " "; exit 3');
  writeFlow('setupsecret', 'printf "%s" "$NPM_TOKEN" > .npmrc');
  const pulled = await runCLI(['pull'], repo);
  expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
  dataHome = await resolveProjectDataHome(repo);
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedSignIns)) if (value !== undefined) process.env[name] = value;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the workflow's setup", () => {
  it("runs setup in the step's container with setup's keys only, and fails the step with setup_failed when it exits non-zero", async () => {
    const before = engineCalls().length;
    const ran = await start('setupnames');

    expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const [review] = readRunState(ran).steps;
    expect(review).toMatchObject({ id: 'review', status: 'failed', failure: { code: 'setup_failed', message: expect.stringContaining('exited with code 3, so the step did not run') } });
    const printed = review !== undefined && 'failure' in review ? String(review.failure?.message) : '';
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
});

it('fails a Claude step whose only login is on this machine, in the Keychain, naming CLAUDE_CODE_OAUTH_TOKEN, before any container starts', async () => {
  const before = engineCalls().length;
  const ran = await runCLI(['workflow', 'start', 'review', '--driver', 'keychain'], repo, engineEnv);

  expect(envelope(ran), ran.stderr).toMatchObject({ data: { done: { outcome: 'failed' } } });
  expect(readRunState(ran).steps).toMatchObject([{
    id: 'review', status: 'failed',
    failure: { code: 'tool_unavailable', message: expect.stringMatching(/a Claude login kept in the macOS Keychain or in ~\/\.claude never crosses into a container; run `claude setup-token` and add CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN/) },
  }]);
  expect(engineCalls().slice(before).filter(([command, ...rest]) => command === 'run' && rest.includes('-d'))).toEqual([]);
});
