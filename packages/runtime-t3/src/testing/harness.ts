import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { z } from 'zod';
import type { StepMode } from '../t3.js';

// ─── Test support: the runtime over its stdio, on a fake T3 Code server ───
//
//  `bundleRuntime` builds the executable as the package ships it. `fakeT3` starts fake-t3.mjs, a T3 server with the
//  MCP tools the runtime calls and the OAuth endpoints a sign-in walks. `connect` starts the runtime against it and
//  speaks protocol 1 to it as JSON lines.
//

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_T3 = path.join(HERE, 'fake-t3.mjs');
const ENTRY = path.join(HERE, '..', 'main.ts');

/** Builds the runtime's executable into `dir`, as tsup bundles it, and returns its path. */
export async function bundleRuntime(dir: string): Promise<string> {
  const outfile = path.join(dir, 'teamai-runtime-t3.mjs');

  await build({
    entryPoints: [ENTRY], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
    banner: { js: "import { createRequire as __teamaiCreateRequire } from 'node:module';\nconst require = __teamaiCreateRequire(import.meta.url);" },
  });

  return outfile;
}

export interface FakeAgent {
  /** The output the agent writes to the result file. */
  output?: unknown;
  /** The failure the agent writes to the result file, saying the step failed. */
  failure?: { code: string; message: string };
  /** The run ends failed. */
  fail?: boolean;
  /** The agent works until its thread is interrupted. */
  hold?: boolean;
  /** The agent works until this file exists. */
  release?: string;
  /** The agent asks for an approval and waits for it. */
  waits?: boolean;
  /** The agent delegates a task, whose own thread asks for an approval and waits for it, and waits for the task. */
  delegatedWaits?: boolean;
  /** The agent writes no transcript. */
  noSession?: boolean;
  /** The agent's last message in the thread, which a judge's reply is. */
  reply?: string;
}

export interface FakeProvider {
  providerInstanceId: string;
  driverKind: string;
  displayName: string;
  models: Array<{ id: string; options?: Array<{ id: string; values: unknown[] }> }>;
  constraints: string[];
}

export interface FakeT3Config {
  token: string;
  /** The sign-in session the token belongs to: T3 finds a repeated launch only under the session that sent it. Unset: `session-1`. */
  namespace?: string;
  environment: { environmentId: string; label: string; serverVersion: string };
  projects: Array<{ id: string; title: string; workspaceRoot: string; deletedAt?: string | null; scripts?: Array<{ id: string; name: string; command: string; runOnWorktreeCreate: boolean; runOnSettle?: boolean }> }>;
  providers: FakeProvider[];
  agent: FakeAgent;
  /** The mode teamai's sign-in was approved with; T3 refuses a thread in a broader one. Unset: the access the last pairing-code decision approved, else any mode. */
  access?: StepMode;
  /** T3 refuses to interrupt a thread, as when it lost track of its run. */
  interruptFails?: boolean;
  /** How long T3 takes to answer an interrupt, in ms. */
  interruptMs?: number;
  /** The longest a wait holds before it answers that the run still goes, in ms, whatever the caller asked. */
  waitCapMs?: number;
  /** T3 refuses to settle a thread. */
  organizeFails?: boolean;
  /** How long after T3 acknowledged a stop the thread's run ends, in ms; at once otherwise. */
  stopLagMs?: number;
  /**
   * Work the thread's run delegated is still going: a wait answers the run's own status with `timedOut: true` until
   * this is cleared, as T3 does for a wait until delegated work settled.
   */
  delegatesPending?: boolean;
  /** The status of the run that answered once delegated work settled, such as one a task's delivery started; the thread's own otherwise. */
  resultRunStatus?: string;
  /** T3 refuses every launch, a repeated one too. */
  launchFails?: boolean;
  /** A check a new launch runs refuses every launch, a repeated one too, with `invalid_request`: T3 launched nothing. */
  launchInvalid?: boolean;
  /** T3 answers every launch with its generic `orchestration_error` refusal, as when it could not complete the call. */
  launchUnavailable?: boolean;
  /** How long after it launched the thread a launch answers, in ms. */
  launchMs?: number;
  /** A launch launches its thread, then its reply never comes: the call fails as a lost connection does, not as a refusal. */
  launchReplyLost?: boolean;
  /** How long the project list takes to answer, in ms. */
  projectsMs?: number;
  /** How long the environment read takes to answer, in ms. */
  environmentMs?: number;
  /** T3 refuses every sign-in decision, as it does a pairing code it does not accept. */
  decisionRefused?: boolean;
  /** T3 answers a sign-in decision with a redirect that carries no code. */
  decisionNoCode?: boolean;
  /** How long a sign-in decision takes to answer, in ms. */
  decisionMs?: number;
  /** The `t3` command fails with this exit status, saying why on stderr. */
  commandFails?: number;
  /** `t3 project add` fails with this exit status, saying why on stderr. */
  projectAddFails?: number;
  /** Another caller adds the folder first, as a parallel step's open may, so `t3 project add` fails as T3 does then. */
  projectAddRaced?: boolean;
}

const CallSchema = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()), bearer: z.string() });

export type FakeCall = z.infer<typeof CallSchema>;

const ThreadSchema = z.object({
  threadId: z.string(), title: z.string(), message: z.string().optional(), worktreePath: z.string().optional(), projectId: z.string().optional(),
  provider: z.string(), model: z.string().optional(), runtimeMode: z.string().optional(), status: z.string(), settled: z.boolean(),
  /** The thread that delegated this one's task, for a delegated task's thread. */
  parentThreadId: z.string().optional(),
  /** What the thread binds: the project's own folder, one of its worktrees, or a scratch folder. */
  workspace: z.enum(['root', 'existing_worktree', 'worktree', 'scratch']).optional(),
  /** The files the agent found under its thread's folder, and whether it could write there. */
  sees: z.array(z.string()).optional(), couldWrite: z.boolean().optional(),
});

export type FakeThread = z.infer<typeof ThreadSchema>;

export const CLAUDE: FakeProvider = {
  providerInstanceId: 'claudeAgent', driverKind: 'claudeAgent', displayName: 'Claude', constraints: [],
  models: [{ id: 'claude-opus-5-5', options: [{ id: 'effort', values: ['low', 'medium', 'high'] }] }, { id: 'claude-sonnet-5-5' }],
};

export const CODEX: FakeProvider = {
  providerInstanceId: 'codex', driverKind: 'codex', displayName: 'Codex', constraints: [],
  models: [{ id: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', values: ['low', 'high'] }] }],
};

export interface FakeT3 {
  /** T3's data directory, as T3CODE_HOME names it. */
  t3Home: string;
  /** The member's home the runtime and the fake agent's tools share. */
  home: string;
  /** A directory that holds the `t3` command of this machine, which mints pairing codes for this server. */
  bin: string;
  /** The arguments of each run of the `t3` command. */
  commandRuns(): string[][];
  /** The pairing codes the `t3` command created, which nothing may print. */
  pairingCodes(): string[];
  /** Where the running server listens, as T3 writes it in its runtime file. */
  origin(): string;
  config(change: Partial<FakeT3Config>): void;
  /** Writes the member's T3 settings, `userdata/settings.json` in T3's data directory. */
  settings(value: Line): void;
  calls(): FakeCall[];
  threads(): FakeThread[];
  /** A thread someone else launched, such as the person, ended at `status`. */
  addThread(thread: { threadId: string; title: string; status: string }): void;
  /** The person deletes the thread in T3 Code: T3 answers every later call on it `thread_not_found`. */
  deleteThread(threadId: string): void;
  /** Starts the fake server, or starts it again on the same state. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** A fake T3 Code server over `dir`, serving the project at `workspaceRoot`, with a member token for the runtime. */
export function fakeT3(dir: string, workspaceRoot: string): FakeT3 {
  const state = path.join(dir, 't3-state');
  const t3Home = path.join(dir, 't3-home');
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 't3-bin');
  let server: ChildProcess | undefined;
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 't3'), t3Command(state), { mode: 0o755 });
  fs.mkdirSync(t3Home, { recursive: true });
  const runs = path.join(state, 't3-command.jsonl');

  let current: FakeT3Config = {
    token: 'fake-t3-token-0123456789',
    environment: { environmentId: 'env-fake-1', label: 'fake-laptop', serverVersion: '0.1.7-fake' },
    projects: [{ id: 'project-1', title: 'acme-app', workspaceRoot, deletedAt: null }],
    providers: [CLAUDE, CODEX],
    agent: { output: { verdict: 'approve' } },
  };

  const write = () => fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(current));
  write();
  const runtimeFile = path.join(t3Home, 'userdata', 'server-runtime.json');

  return {
    t3Home, home, bin,
    pairingCodes: () => {
      const file = path.join(state, 'pairings.jsonl');

      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => z.object({ credential: z.string() }).parse(JSON.parse(line)).credential) : [];
    },
    origin: () => z.object({ origin: z.string() }).parse(JSON.parse(fs.readFileSync(runtimeFile, 'utf8'))).origin,
    commandRuns: () => (fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => z.array(z.string()).parse(JSON.parse(line))) : []),
    config(change) {
      current = { ...current, ...change };
      write();
    },
    settings(value) {
      fs.mkdirSync(path.join(t3Home, 'userdata'), { recursive: true });
      fs.writeFileSync(path.join(t3Home, 'userdata', 'settings.json'), JSON.stringify(value));
    },
    calls: () => {
      const file = path.join(state, 'calls.jsonl');

      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => CallSchema.parse(JSON.parse(line))) : [];
    },
    threads: () => fs.readdirSync(path.join(state, 'threads')).filter((file) => file.endsWith('.json')).map((file) => ThreadSchema.parse(JSON.parse(fs.readFileSync(path.join(state, 'threads', file), 'utf8')))),
    addThread(thread) {
      fs.mkdirSync(path.join(state, 'threads'), { recursive: true });
      fs.writeFileSync(path.join(state, 'threads', `${encodeURIComponent(thread.threadId)}.json`), JSON.stringify({ ...thread, provider: 'claudeAgent', settled: false, runCount: 1 }));
    },
    deleteThread: (threadId) => fs.rmSync(path.join(state, 'threads', `${encodeURIComponent(threadId)}.json`)),
    async start() {
      fs.rmSync(runtimeFile, { force: true });
      server = spawn(process.execPath, [FAKE_T3], { env: { ...process.env, FAKE_T3_STATE: state, T3CODE_HOME: t3Home, FAKE_T3_HOME: home }, stdio: ['ignore', 'ignore', 'inherit'] });
      const deadline = Date.now() + 10_000;

      while (!fs.existsSync(runtimeFile)) {
        if (Date.now() > deadline) throw new Error('The fake T3 server did not start.');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async stop() {
      const running = server;
      server = undefined;

      if (!running || running.exitCode !== null) return;
      const exited = new Promise((resolve) => running.once('exit', resolve));
      running.kill('SIGTERM');
      await exited;
    },
  };
}

/**
 * The `t3` command, as T3 Code installs it: `t3 auth pairing create --json` mints a pairing code for the server whose
 * data directory `--base-dir` names, or `T3CODE_HOME`, or `~/.t3`, as the real one does. It logs its arguments.
 */
function t3Command(state: string): string {
  return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const state = ${JSON.stringify(state)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 't3-command.jsonl'), JSON.stringify(args) + '\\n');
const failure = JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8')).commandFails;
if (failure) { process.stderr.write('Could not reach the T3 Code server.\\n'); process.exit(failure); }
const values = (flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));
if (args.slice(0, 2).join(' ') === 'project add') {
  const config = JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8'));
  if (config.projectAddFails) { process.stderr.write('Could not add the project.\\n'); process.exit(config.projectAddFails); }
  const root = args[args.length - 1];
  const project = { id: 'project-' + randomUUID().slice(0, 8), title: values('--title')[0] ?? path.basename(root), workspaceRoot: root, deletedAt: null };
  config.projects.push(project);
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(config));
  if (config.projectAddRaced) { process.stderr.write("ProjectAlreadyExistsError: An active project already exists for '" + root + "'.\\n"); process.exit(1); }
  process.stdout.write('Added project ' + project.id + ' (' + project.title + ') at ' + root + '.\\n');
  process.exit(0);
}
if (args.slice(0, 3).join(' ') !== 'auth pairing create' || !args.includes('--json')) { process.stderr.write('Unknown command.\\n'); process.exit(2); }
const base = values('--base-dir')[0] ?? process.env.T3CODE_HOME ?? path.join(process.env.HOME, '.t3');
const credential = randomUUID();
fs.appendFileSync(path.join(state, 'pairings.jsonl'), JSON.stringify({ credential, scopes: values('--scope'), base }) + '\\n');
process.stdout.write(JSON.stringify({ id: randomUUID(), credential, label: values('--label')[0] ?? null }) + '\\n');
`;
}

/** PATH with no `t3` command on it: this machine's PATH less every directory that holds one. */
export const PATH_WITHOUT_T3 = (process.env['PATH'] ?? '/usr/bin:/bin').split(path.delimiter).filter((entry) => entry !== '' && !fs.existsSync(path.join(entry, 't3'))).join(path.delimiter);

/** Where the runtime keeps its sign-in for the fake server, as `main.ts` lays it out. */
export function credentialsFile(home: string): string {
  return path.join(home, '.teamai', 'runtime-state', 't3', 'credentials.json');
}

/** Signs the member in to the fake server ahead of time, as an earlier attended run would have. */
export function signIn(t3: FakeT3, token = 'fake-t3-token-0123456789', expiresInSeconds = 3600): void {
  const origin = t3.origin();
  const file = credentialsFile(t3.home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({
    [`${origin}/mcp`]: { tokens: { access_token: token, token_type: 'Bearer' }, expiresAt: Date.now() + expiresInSeconds * 1000 },
  }), { mode: 0o600 });
}

const LineSchema = z.record(z.string(), z.json());

export type Line = z.infer<typeof LineSchema>;

export interface Connection {
  child: ChildProcessWithoutNullStreams;
  send(request: Line): void;
  /** The first line the runtime wrote that `match` accepts and no earlier `next` took, waiting up to `ms` for it. */
  next(match: (line: Line) => boolean, ms?: number): Promise<Line>;
  lines: Line[];
  stderr(): string;
  close(): Promise<number | null>;
}

/**
 * Starts the runtime at `executable` against `t3`, with `env` over a plain environment whose `t3` command is the fake's,
 * in `cwd`, where teamai starts it: the run's checkout.
 */
export function connect(executable: string, t3: FakeT3, env: Record<string, string> = {}, cwd?: string): Connection {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [executable], {
    env: { PATH: `${t3.bin}${path.delimiter}${PATH_WITHOUT_T3}`, HOME: t3.home, T3CODE_HOME: t3.t3Home, ...env }, ...(cwd && { cwd }),
  });

  const lines: Line[] = [];
  const pending: Line[] = [];
  const waiters: Array<() => void> = [];
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });
  readline.createInterface({ input: child.stdout }).on('line', (text) => {
    const line = LineSchema.parse(JSON.parse(text));
    lines.push(line);
    pending.push(line);

    for (const wake of waiters.splice(0)) wake();
  });

  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => {
    resolve(code);

    for (const wake of waiters.splice(0)) wake();
  }));

  return {
    child,
    lines,
    send: (request) => { child.stdin.write(`${JSON.stringify(request)}\n`); },
    async next(match, ms = 10_000) {
      const deadline = Date.now() + ms;

      for (;;) {
        const index = pending.findIndex(match);
        const [found] = index === -1 ? [] : pending.splice(index, 1);

        if (found) return found;

        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`No matching line from the runtime. Lines: ${JSON.stringify(lines)}\nstderr: ${stderr}`);
        await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), new Promise((resolve) => setTimeout(resolve, 50))]);
      }
    },
    stderr: () => stderr,
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      const code = await exited;
      clearTimeout(timer);

      return code;
    },
  };
}

/**
 * A browser for the sign-in: `open` and `xdg-open` in `bin` follow the link they get, as a person who approves at once
 * would, and log each link's path to `visits`.
 */
export function fakeBrowser(dir: string) {
  const bin = path.join(dir, 'browser-bin');
  const log = path.join(dir, 'browser.log');
  fs.mkdirSync(bin, { recursive: true });

  const script = `#!${process.execPath}
const fs = require('node:fs');
const url = process.argv[process.argv.length - 1];
fs.appendFileSync(${JSON.stringify(log)}, new URL(url).pathname + '\\n');
fetch(url, { redirect: 'follow' }).then((res) => res.text()).catch(() => {});
`;

  for (const name of ['open', 'xdg-open']) fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });

  return { bin, visits: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter((line) => line !== '') : []) };
}
