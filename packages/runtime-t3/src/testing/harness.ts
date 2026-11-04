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
  /** The agent writes no transcript. */
  noSession?: boolean;
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
  environment: { environmentId: string; label: string; serverVersion: string };
  projects: Array<{ id: string; title: string; workspaceRoot: string; deletedAt?: string | null }>;
  providers: FakeProvider[];
  agent: FakeAgent;
  /** The mode teamai's sign-in was approved with; T3 refuses a thread in a broader one. Unset: any mode. */
  access?: StepMode;
}

const CallSchema = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()), bearer: z.string() });

export type FakeCall = z.infer<typeof CallSchema>;

const ThreadSchema = z.object({
  threadId: z.string(), title: z.string(), message: z.string().optional(), worktreePath: z.string().optional(), projectId: z.string().optional(),
  provider: z.string(), model: z.string().optional(), runtimeMode: z.string().optional(), status: z.string(), settled: z.boolean(),
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
  config(change: Partial<FakeT3Config>): void;
  calls(): FakeCall[];
  threads(): FakeThread[];
  /** Starts the fake server, or starts it again on the same state. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** A fake T3 Code server over `dir`, serving the project at `workspaceRoot`, with a member token for the runtime. */
export function fakeT3(dir: string, workspaceRoot: string): FakeT3 {
  const state = path.join(dir, 't3-state');
  const t3Home = path.join(dir, 't3-home');
  const home = path.join(dir, 'home');
  let server: ChildProcess | undefined;
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

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
    t3Home, home,
    config(change) {
      current = { ...current, ...change };
      write();
    },
    calls: () => {
      const file = path.join(state, 'calls.jsonl');

      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => CallSchema.parse(JSON.parse(line))) : [];
    },
    threads: () => fs.readdirSync(path.join(state, 'threads')).filter((file) => file.endsWith('.json')).map((file) => ThreadSchema.parse(JSON.parse(fs.readFileSync(path.join(state, 'threads', file), 'utf8')))),
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

/** Where the runtime keeps its sign-in for the fake server, as `main.ts` lays it out. */
export function credentialsFile(home: string): string {
  return path.join(home, '.teamai', 'runtime-state', 't3', 'credentials.json');
}

/** Signs the member in to the fake server ahead of time, as an earlier attended run would have. */
export function signIn(t3: FakeT3, token = 'fake-t3-token-0123456789', expiresInSeconds = 3600): void {
  const origin = z.object({ origin: z.string() }).parse(JSON.parse(fs.readFileSync(path.join(t3.t3Home, 'userdata', 'server-runtime.json'), 'utf8'))).origin;
  const file = credentialsFile(t3.home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({
    [`${origin}/mcp`]: { tokens: { access_token: token, token_type: 'Bearer' }, expiresAt: Date.now() + expiresInSeconds * 1000 },
  }), { mode: 0o600 });
}

const LineSchema = z.record(z.string(), z.json());

export type Line = z.infer<typeof LineSchema>;

export interface Connection {
  send(request: Line): void;
  /** The first line the runtime wrote that `match` accepts and no earlier `next` took, waiting up to `ms` for it. */
  next(match: (line: Line) => boolean, ms?: number): Promise<Line>;
  lines: Line[];
  stderr(): string;
  close(): Promise<number | null>;
}

/** Starts the runtime at `executable` against `t3`, with `env` over a plain environment. */
export function connect(executable: string, t3: FakeT3, env: Record<string, string> = {}): Connection {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [executable], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: t3.home, T3CODE_HOME: t3.t3Home, ...env },
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
