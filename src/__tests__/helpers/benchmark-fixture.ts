/**
 * One member of a team that benchmarks a project, for the real CLI. The fixture owns every repo it makes:
 *   app.git     the project origin, `https://github.com/fixture/app.git` to git. Its first commit is a task's starting
 *               commit: `node test.js` fails there until answer.js exports 42.
 *   team.git    the team origin, `https://github.com/acme/team.git` to git, with the suite `fix` (by default one task,
 *               `fix`, and one arm, `claude`).
 *   home/       the member's HOME: `.gitconfig` with both URL rewrites, and the teamai install a workspace init made.
 *   home/work   the member's checkout of the project, where every command runs.
 *   bin/        a fake `claude` and a fake `codex` that answer the way `tool` says, and log where they ran, the model
 *               they were launched with and what they found there to tool.log, beside links to node and git. Each prints
 *               the model it was launched with as the one it ran, `fake-<tool>` without one, and a cost of 0.25 USD. PATH is bin/, /usr/bin and /bin, so a tool
 *               the fixture leaves out is not found. Launched as a judge (with --json-schema), the fake `claude` answers the
 *               way `judge` says, at a cost of 0.1 USD, and logs to judge.log the labels it could give, the diff.patch of its
 *               evidence and what is left under the trial root then. Each launch also checks out a branch and back in its cwd under a
 *               HOME whose `.teamai/bin/teamai` writes hook.marker, so a teamai git hook there leaves the marker. Once
 *               `probeControl(run)` is called, each launch also runs `teamai workflow cancel <run>` in its own cwd and
 *               logs the answer to probe.log.
 *   tmp/        TMPDIR for every command, so whatever a run leaves in the temp dir is this fixture's.
 * Every command also has FIXTURE_ROOT, the fixture's root, so a suite's setup or check can leave what it saw there.
 *
 * `startBenchmarkRun` makes a run in process instead, for tests that call the engine without the CLI.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';
import type { LocalConfig } from '../../types.js';
import { compilePlan, freezePlan, runSourceHash } from '../../workflow/benchmark/plan.js';
import { parseSuite } from '../../workflow/benchmark/suite.js';
import type { BenchmarkSuiteFiles } from '../../workflow/conformance-interpreter.js';
import { createRun, error, leaseNext, reportAttempt } from '../../workflow/engine.js';
import type { DriverCan } from '../../workflow/requirements.js';
import { readRun } from '../../workflow/store.js';
import type { DriverIdentity, WorkflowEnvelope } from '../../workflow/types.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'index.js');
export const TEAM_URL = 'https://github.com/acme/team.git';
export const PRODUCT_URL = 'https://github.com/fixture/app.git';

/**
 * What a fake tool does in the trial's clone: make the check pass, leave the clone as it was, or, on the fixture's first
 * launch of any fake tool, exit 1 without a change and make the check pass on every later one. The last three game a
 * check that reads them: set `skip` in check.config.js, add test/pass.setup.js, which stubs out assert, or commit that
 * helper as test/helpers/pass.setup.js into a git repository of its own. `writes-a-passing-test` writes an executable
 * test/auth/refresh.test.js that always passes, and no fix. `hangs` never exits; `fixes-and-hangs` makes the check pass,
 * takes git's index lock in the clone as a commit does, and never exits.
 */
export type FakeTool = 'fixes' | 'does-nothing' | 'fails-first' | 'skips-the-check' | 'adds-a-helper' | 'adds-a-helper-repository' | 'writes-a-passing-test' | 'hangs'
  | 'fixes-and-hangs';

/**
 * What a fake tool does on the fixture's first launch of any fake tool, before it answers: push a team commit of
 * `teamChange` and run `teamai pull` in the member's checkout, or kill the process that launched it and exit. Only the
 * local driver may be killed: the fake external driver runs inside the test.
 */
export type FirstLaunch = 'pulls-a-team-change' | 'kills-its-driver';

/** What the fake `claude` judge answers: the first label of its scorer, `incorrect` where its scorer has one, a label its scorer lacks, or exit 1. */
export type FakeJudge = 'first-label' | 'incorrect' | 'another-label' | 'fails' | 'hangs';

/** One launch of the fake judge: the labels its answer schema allows, its evidence's diff.patch, and the trial roots left. */
const JudgeLaunchSchema = z.object({ labels: z.array(z.string()), diff: z.string().nullable(), trialRoots: z.array(z.string()) });
export type JudgeLaunch = z.infer<typeof JudgeLaunchSchema>;

/**
 * Where one launch of a fake tool ran: which tool, the `--model` and the effort it was launched with (null without one), its cwd,
 * that cwd's own `.git`, its HEAD and its remotes, every file in it outside `.git`, and its AGENTS.md and CLAUDE.md
 * (null when missing).
 */
const ToolLaunchSchema = z.object({
  tool: z.string(), model: z.string().nullable(), effort: z.string().nullable(), cwd: z.string(), ownGit: z.boolean(), head: z.string(), remotes: z.string(),
  paths: z.array(z.string()), agentFiles: z.object({ 'AGENTS.md': z.string().nullable(), 'CLAUDE.md': z.string().nullable() }),
});
export type ToolLaunch = z.infer<typeof ToolLaunchSchema>;

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const EnvelopeSchema = z.object({
  data: z.record(z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export interface BenchmarkFixture {
  root: string;
  home: string;
  work: string;
  /** Where the fake tools are. */
  bin: string;
  /** The environment every teamai command runs with. */
  env: NodeJS.ProcessEnv;
  teamOrigin: string;
  /** app.git, the project origin. */
  productOrigin: string;
  tmp: string;
  /** The member's clone of the team repo, which `teamai pull` updates. */
  teamClone: string;
  /** The project commit the task starts from. */
  startingCommit: string;
  teamai(args: string[]): Promise<CliResult>;
  /** The run file of `run`, as JSON. */
  runFile(run: string): unknown;
  /** Commits `files` to the team origin's main branch, as another member's push would; a null file or directory is deleted. */
  pushTeam(files: Record<string, string | null>): void;
  /** Commits `files` to the project origin's main branch, which the member's checkout has not fetched, and returns the commit. */
  pushProduct(files: Record<string, string>): string;
  /** The runs stored in the member's workspace data home. */
  runIds(): string[];
  /** `git status --porcelain` of the member's checkout. */
  status(): string;
  /** The end record of `run` on the team origin's teamai-reports branch, as JSON. */
  endRecord(run: string): unknown;
  /** Every launch of the fake tool so far. */
  toolLaunches(): ToolLaunch[];
  /** Every launch of the fake judge so far. */
  judgeLaunches(): JudgeLaunch[];
  /** What is left under the trial root in TMPDIR. */
  trialRootEntries(): string[];
  /** The arguments of each `teamai` call a git hook made in a fake tool's cwd. */
  hookCalls(): string[];
  /** Makes every later launch of a fake tool run `teamai workflow cancel <run>` from its cwd, as an agent might. */
  probeControl(run: string): void;
  /** The envelope of each control command a fake tool ran. */
  probeAnswers(): Envelope[];
  remove(): void;
}

export function said(result: CliResult): string {
  return `exit ${result.code}\n${result.stdout}\n${result.stderr}`;
}

/** The last JSON line a command printed. */
export function envelope(result: CliResult): Envelope {
  const line = result.stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON envelope:\n${said(result)}`);
  return EnvelopeSchema.parse(JSON.parse(line));
}

export const FIX_SUITE = `schemaVersion: v1alpha1
name: fix
description: Fix the answer.
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: claude
repetitions: 1
timeout: 10m
`;

export function fixTask(startingCommit: string, prompt = 'Make node test.js pass.'): string {
  return `schemaVersion: v1alpha1
title: Fix the answer
prompt: ${prompt}
startingCommit: ${startingCommit}
check:
  run: node test.js
  protect: [test.js]
`;
}

const FIX = "fs.writeFileSync('answer.js', 'module.exports = 42;\\n');";
const FAKE_TOOLS: Record<FakeTool, string> = {
  fixes: FIX,
  'does-nothing': '',
  hangs: 'setInterval(() => {}, 60_000);',
  'fixes-and-hangs': `${FIX} fs.writeFileSync('.git/index.lock', ''); setInterval(() => {}, 60_000);`,
  'fails-first': `if (first) process.exitCode = 1; else ${FIX}`,
  'skips-the-check': "fs.writeFileSync('check.config.js', 'module.exports = { skip: true };\\n');",
  'adds-a-helper': "fs.mkdirSync('test', { recursive: true }); fs.writeFileSync('test/pass.setup.js', \"require('node:assert').strictEqual = () => {};\\n\");",
  'writes-a-passing-test': "fs.mkdirSync('test/auth', { recursive: true }); fs.writeFileSync('test/auth/refresh.test.js', '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });",
  'adds-a-helper-repository': `fs.mkdirSync('test/helpers', { recursive: true });
fs.writeFileSync('test/helpers/pass.setup.js', "require('node:assert').strictEqual = () => {};\\n");
for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '-qm', 'helper']]) execFileSync('git', args, { cwd: 'test/helpers' });`,
};

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function seed(dir: string, files: Record<string, string>, origin: string, executable: readonly string[] = []): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  writeFiles(dir, files);
  for (const file of executable) fs.chmodSync(path.join(dir, file), 0o755);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'seed']);
  git(dir, ['push', '-q', origin, 'main']);
  return git(dir, ['rev-parse', 'HEAD']);
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

export interface BenchmarkFixtureOptions {
  tool: FakeTool;
  sandbox: boolean;
  /** The fake tools in bin/; both by default. */
  tools?: Array<'claude' | 'codex'>;
  /** benchmarks/fix/suite.yaml; FIX_SUITE by default. */
  suite?: string;
  /** benchmarks/fix/tasks/<name>.yaml by name; `{{startingCommit}}` is replaced. One task, `fix`, by default. */
  tasks?: Record<string, string>;
  /** More files in the team repo, such as a skill. */
  team?: Record<string, string>;
  /** The team repo files committed executable. */
  executable?: string[];
  /** More files in the starting commit. */
  app?: Record<string, string>;
  firstLaunch?: FirstLaunch;
  /** The files `pulls-a-team-change` pushes; later.md by default. */
  teamChange?: Record<string, string>;
  /** Each launch of a fake tool also writes what `sh -c env` prints to tool.env in the fixture's root. */
  printsEnv?: boolean;
  /** How the fake `claude` judges; `first-label` by default. */
  judge?: FakeJudge;
}

export async function benchmarkFixture(options: BenchmarkFixtureOptions): Promise<BenchmarkFixture> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-')));
  const home = path.join(root, 'home');
  const work = path.join(home, 'work');
  const teamOrigin = path.join(root, 'team.git');
  const productOrigin = path.join(root, 'app.git');
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  for (const dir of [path.join(home, '.claude'), bin, tmp]) fs.mkdirSync(dir, { recursive: true });
  git(root, ['init', '-q', '--bare', '-b', 'main', teamOrigin]);
  git(root, ['init', '-q', '--bare', '-b', 'main', productOrigin]);
  const productSeed = path.join(root, 'seed-app');
  const startingCommit = seed(productSeed, {
    'README.md': '# app\n',
    'answer.js': 'module.exports = 41;\n',
    'test.js': "const assert = require('node:assert');\nassert.strictEqual(require('./answer.js'), 42);\n",
    ...options.app,
  }, productOrigin);
  const teamSeed = path.join(root, 'seed-team');
  const tasks = options.tasks ?? { fix: fixTask('{{startingCommit}}') };
  seed(teamSeed, {
    'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: git\n`,
    'benchmarks/fix/suite.yaml': options.suite ?? FIX_SUITE,
    ...Object.fromEntries(Object.entries(tasks).map(([name, text]) => [`benchmarks/fix/tasks/${name}.yaml`, text.replaceAll('{{startingCommit}}', startingCommit)])),
    ...options.team,
  }, teamOrigin, options.executable);
  const toolLog = path.join(root, 'tool.log');
  const judgeLog = path.join(root, 'judge.log');
  const probeRun = path.join(root, 'probe.run');
  const probeLog = path.join(root, 'probe.log');
  const hookHome = path.join(root, 'hook-home');
  const hookMarker = path.join(root, 'hook.marker');
  fs.mkdirSync(path.join(hookHome, '.teamai', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(hookHome, '.teamai', 'bin', 'teamai'), `#!/bin/sh\necho "$*" >> '${hookMarker}'\n`);
  fs.chmodSync(path.join(hookHome, '.teamai', 'bin', 'teamai'), 0o755);
  const firstLaunch: Record<FirstLaunch, string> = {
    'pulls-a-team-change': `if (first) {
  const team = (...args) => execFileSync('git', args, { cwd: ${JSON.stringify(teamSeed)}, encoding: 'utf8' });
  team('pull', '-q', ${JSON.stringify(teamOrigin)}, 'main');
  for (const [file, text] of Object.entries(${JSON.stringify(options.teamChange ?? { 'later.md': 'A team change pushed during the run.\n' })})) {
    fs.mkdirSync(path.dirname(path.join(${JSON.stringify(teamSeed)}, file)), { recursive: true });
    fs.writeFileSync(path.join(${JSON.stringify(teamSeed)}, file), text);
  }
  team('add', '-A');
  team('-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-qm', 'team change during the run');
  team('push', '-q', ${JSON.stringify(teamOrigin)}, 'main');
  const pulled = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'pull'], { cwd: ${JSON.stringify(work)}, encoding: 'utf8' });
  if (pulled.status !== 0) throw new Error('teamai pull failed: ' + pulled.stderr);
}`,
    'kills-its-driver': `if (first) {
  process.kill(process.ppid, 'SIGKILL');
  process.exit(0);
}`,
  };
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'));
  for (const tool of options.tools ?? ['claude', 'codex']) {
    // Both print what the claude stream and the generic JSON reader each take a model and session from.
    fs.writeFileSync(path.join(bin, tool), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
${tool === 'claude' ? judgeMode(judgeLog, path.join(tmp, 'teamai-trials'), options.judge ?? 'first-label') : ''}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const first = !fs.existsSync(${JSON.stringify(toolLog)});
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => !(dir === '.' && entry.name === '.git'))
  .flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name).split(path.sep).join('/')]));
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const head = git('rev-parse', 'HEAD');
const launchedWith = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : null;
const codexEffort = process.argv.find((arg) => arg.startsWith('model_reasoning_effort='));
const effort = process.argv.includes('--effort') ? process.argv[process.argv.indexOf('--effort') + 1] : codexEffort ? codexEffort.slice('model_reasoning_effort='.length) : null;
const hooked = { ...process.env, HOME: ${JSON.stringify(hookHome)} };
spawnSync('git', ['checkout', '-q', '-b', 'hook-probe'], { env: hooked });
spawnSync('git', ['checkout', '-q', '--detach', head], { env: hooked });
spawnSync('git', ['branch', '-q', '-D', 'hook-probe']);
fs.appendFileSync(${JSON.stringify(toolLog)}, JSON.stringify({
  tool: ${JSON.stringify(tool)}, model: launchedWith, effort, cwd: process.cwd(), ownGit: fs.statSync('.git').isDirectory(), head, remotes: git('remote'),
  paths: files('.'), agentFiles: { 'AGENTS.md': read('AGENTS.md'), 'CLAUDE.md': read('CLAUDE.md') },
}) + '\\n');
${options.printsEnv ? `fs.writeFileSync(${JSON.stringify(path.join(root, 'tool.env'))}, execFileSync('sh', ['-c', 'env'], { encoding: 'utf8' }));` : ''}
${options.firstLaunch ? firstLaunch[options.firstLaunch] : ''}
if (fs.existsSync(${JSON.stringify(probeRun)})) {
  const run = fs.readFileSync(${JSON.stringify(probeRun)}, 'utf8');
  fs.appendFileSync(${JSON.stringify(probeLog)}, spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'workflow', 'cancel', run], { encoding: 'utf8' }).stdout);
}
${FAKE_TOOLS[options.tool]}
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: launchedWith ?? 'fake-${tool}', session_id: 'fake-session' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', session_id: 'fake-session', usage: { input_tokens: 4, output_tokens: 2 }, total_cost_usd: 0.25 }) + '\\n');
`);
    fs.chmodSync(path.join(bin, tool), 0o755);
  }
  fs.writeFileSync(path.join(home, '.gitconfig'), [
    '[user]', '\tname = member', '\temail = member@example.com',
    `[url "file://${teamOrigin}"]`, `\tinsteadOf = ${TEAM_URL}`,
    `[url "file://${productOrigin}"]`, `\tinsteadOf = ${PRODUCT_URL}`, '',
  ].join('\n'));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter), TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0', FIXTURE_ROOT: root,
  };
  for (const name of ['XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GITHUB_TOKEN', 'GH_TOKEN']) delete env[name];
  const teamai = (args: string[]): Promise<CliResult> => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const ok = async (args: string[]): Promise<void> => {
    const result = await teamai(args);
    if (result.code !== 0) throw new Error(`teamai ${args.join(' ')} failed:\n${said(result)}`);
  };

  git(root, ['clone', '-q', PRODUCT_URL, work], env);
  await ok(['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'workspace', '--force']);
  await ok(['pull']);
  const dataHome = (): string => {
    const projects = path.join(home, '.teamai', 'projects');
    const found = fs.readdirSync(projects).map((name) => path.join(projects, name))
      .find((dir) => fs.existsSync(path.join(dir, 'config.yaml')) && fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8').includes(`projectRoot: ${work}`));
    if (!found) throw new Error(`no workspace data home for ${work} under ${projects}`);
    return found;
  };
  const configPath = path.join(dataHome(), 'config.yaml');
  const config: unknown = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  const parsed = z.object({ repo: z.object({ localPath: z.string() }).passthrough(), workflows: z.record(z.unknown()).optional() }).passthrough().parse(config);
  fs.writeFileSync(configPath, YAML.stringify({ ...parsed, workflows: { ...parsed.workflows, sandbox: options.sandbox } }));

  return {
    root, home, work, bin, env, teamOrigin, productOrigin, tmp, teamClone: parsed.repo.localPath, startingCommit, teamai,
    runFile: (run) => {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(dataHome(), 'workflows', 'runs', `${run}.json`), 'utf8'));
      return value;
    },
    pushTeam: (files) => {
      git(teamSeed, ['pull', '-q', teamOrigin, 'main']);
      for (const [file, text] of Object.entries(files)) {
        if (text === null) fs.rmSync(path.join(teamSeed, file), { recursive: true, force: true });
        else writeFiles(teamSeed, { [file]: text });
      }
      git(teamSeed, ['add', '-A']);
      git(teamSeed, ['-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-qm', 'team change']);
      git(teamSeed, ['push', '-q', teamOrigin, 'main']);
    },
    pushProduct: (files) => {
      writeFiles(productSeed, files);
      git(productSeed, ['add', '-A']);
      git(productSeed, ['-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-qm', 'product change']);
      git(productSeed, ['push', '-q', productOrigin, 'main']);
      return git(productSeed, ['rev-parse', 'HEAD']);
    },
    runIds: () => {
      const runs = path.join(dataHome(), 'workflows', 'runs');
      return fs.existsSync(runs) ? fs.readdirSync(runs).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)) : [];
    },
    status: () => git(work, ['status', '--porcelain']),
    endRecord: (run) => {
      const value: unknown = JSON.parse(git(root, ['--git-dir', teamOrigin, 'show', `teamai-reports:workflows/runs/${run}.json`]));
      return value;
    },
    toolLaunches: () => (fs.existsSync(toolLog) ? fs.readFileSync(toolLog, 'utf8').trim().split('\n').map((line) => ToolLaunchSchema.parse(JSON.parse(line))) : []),
    judgeLaunches: () => (fs.existsSync(judgeLog) ? fs.readFileSync(judgeLog, 'utf8').trim().split('\n').map((line) => JudgeLaunchSchema.parse(JSON.parse(line))) : []),
    trialRootEntries: () => (fs.existsSync(path.join(tmp, 'teamai-trials')) ? fs.readdirSync(path.join(tmp, 'teamai-trials')) : []),
    hookCalls: () => (fs.existsSync(hookMarker) ? fs.readFileSync(hookMarker, 'utf8').trim().split('\n') : []),
    probeControl: (run) => fs.writeFileSync(probeRun, run),
    probeAnswers: () => (fs.existsSync(probeLog) ? fs.readFileSync(probeLog, 'utf8').trim().split('\n').map((line) => EnvelopeSchema.parse(JSON.parse(line))) : []),
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** The start of the fake `claude`: its version, which has a verified judge profile, and, launched as a judge, its answer. */
function judgeMode(log: string, trialRoots: string, judge: FakeJudge): string {
  return `if (process.argv.includes('--version')) {
  console.log('2.1.308 (Claude Code)');
  process.exit(0);
}
if (process.argv.includes('--json-schema')) {
  const labels = JSON.parse(process.argv[process.argv.indexOf('--json-schema') + 1]).properties.label.enum;
  const diff = fs.existsSync('diff.patch') ? fs.readFileSync('diff.patch', 'utf8') : null;
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ labels, diff, trialRoots: fs.existsSync(${JSON.stringify(trialRoots)}) ? fs.readdirSync(${JSON.stringify(trialRoots)}) : [] }) + '\\n');
  process.stdin.resume();
  process.stdin.on('end', () => {
    if (${JSON.stringify(judge)} === 'hangs') { setInterval(() => {}, 1000); return; }
    if (${JSON.stringify(judge)} === 'fails') process.exit(1);
    const label = ${JSON.stringify(judge)} === 'another-label' ? 'no-such-label' : ${JSON.stringify(judge)} === 'incorrect' && labels.includes('incorrect') ? 'incorrect' : labels[0];
    console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-judge' }));
    console.log(JSON.stringify({ type: 'result', structured_output: { label, reasoning: 'The fake judge decided.' }, total_cost_usd: 0.1 }));
  });
  return;
}`;
}

/** The commits a run made in process starts from. No repo holds them, so nothing may fetch them. */
export const RUN_START = 'a'.repeat(40);
export const RUN_TEAM = 'b'.repeat(40);

/** A member of a git team, as a trial needs, with nothing on disk but what a run writes under `root`. */
export function benchmarkRunConfig(root: string): LocalConfig {
  return {
    repo: { localPath: path.join(root, 'team'), remote: TEAM_URL, kind: 'git' },
    username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data'),
  };
}

/**
 * A run of the suite in `files`, made in process as startBenchmark makes it, at team commit RUN_TEAM and with RUN_START
 * for `{{startingCommit}}`, without the install startBenchmark reads the suite and the team revision from. An arm's model
 * is planned as written: no aliases resolve it.
 */
export async function startBenchmarkRun(config: LocalConfig, files: BenchmarkSuiteFiles): Promise<WorkflowEnvelope> {
  const parsed = parseSuite({
    suite: { relativePath: `benchmarks/${files.name}/suite.yaml`, content: files.suite },
    tasks: Object.entries(files.tasks).map(([name, content]) => ({
      relativePath: `benchmarks/${files.name}/tasks/${name}.yaml`, content: content.replaceAll('{{startingCommit}}', RUN_START),
    })),
  });
  if (!parsed.ok) return error('benchmark_not_found', parsed.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
  const { suite } = parsed;
  const [first, ...rest] = suite.arms.map((arm) => ({ name: arm.name, tool: arm.tool, ...(arm.model ? { model: arm.model } : {}), source: 'team' as const, teamRevision: RUN_TEAM }));
  const plan = freezePlan({ suite, baselineTeamRevision: RUN_TEAM, selection: { additionalRoles: [], projects: [], excludedSkills: [] }, arms: [first, ...rest], scorers: {} });
  return createRun(config, { name: suite.name, sourceHash: runSourceHash(plan), teamRevision: RUN_TEAM, origin: { source: 'team' }, ...compilePlan(plan, suite, new Map()), benchmark: plan, secrets: {} });
}

const BaselineLeaseSchema = z.object({ data: z.object({ lease: z.object({ step: z.string().startsWith('baselines.'), attempt: z.string(), revision: z.number(), trial: z.object({ task: z.string() }) }) }) });

/**
 * Settles each baseline of a run made in process as teamai settles one: by its task in `baselines`, and `fails` by
 * default, as a check that fails on its starting commit, so that task's trials run.
 */
export async function settleBaselines(
  config: LocalConfig, runId: string, driver: DriverIdentity, can: DriverCan, baselines: Record<string, 'passes' | 'fails' | 'could_not_run'> = {},
): Promise<void> {
  const run = await readRun(config, runId);
  const count = typeof run === 'object' ? run.benchmark?.tasks.filter((task) => task.judge === 'check').length ?? 0 : 0;
  for (let settled = 0; settled < count; settled += 1) {
    const { attempt, revision, trial } = BaselineLeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
    const baseline = baselines[trial.task] ?? 'fails';
    await reportAttempt(config, runId, baseline === 'could_not_run'
      ? { attempt, revision, driver, outcome: 'failed', trialReport: { verdict: { verdict: 'could_not_run', cause: 'not_found' } } }
      : { attempt, revision, driver, outcome: 'success', outputs: { baseline }, trialReport: { verdict: baseline === 'passes' ? { verdict: 'passed' } : { verdict: 'failed', exitCode: 1 } } });
  }
}
