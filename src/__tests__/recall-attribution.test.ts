/**
 * Recall attribution acceptance harness (#884). Each row drives `recall()` and
 * the real hook dispatcher (`hookDispatchCli`, the real handler registry) with
 * the payloads an agent sends, then asserts on the votes the scope holds.
 *
 * Every row of the spec's acceptance contract is listed here: rows a ticket has
 * shipped run, the rest are `it.todo` named after the ticket that ships them.
 * Paths are whatever recall printed, so the rows hold on every OS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { LocalConfig } from '../types.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  // The dispatcher's detached background pass: nothing under test runs there.
  spawn: vi.fn(() => ({ on: vi.fn(), stdin: { on: vi.fn(), end: vi.fn((_: string, done: () => void) => done()) }, unref: vi.fn() })),
}));
vi.mock('../pull.js', () => ({ pull: vi.fn(async () => undefined) }));
vi.mock('../update.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../update.js')>()),
  doUpdate: vi.fn(async () => undefined),
}));
vi.mock('../local-agent.js', () => ({ reportAndSyncFromHook: vi.fn(async () => null) }));
vi.mock('../code-knowledge-recall.js', () => ({ queryCodeKnowledge: vi.fn(async () => []) }));
// A vote sync lands in a reports checkout beside the clone instead of being pushed.
vi.mock('../utils/reports-branch.js', async () => {
  const nodePath = await import('node:path');
  const nodeFs = await import('node:fs');
  const checkout = (config: LocalConfig): string => {
    const dir = nodePath.join(nodePath.dirname(config.repo.localPath), 'reports-wt');
    nodeFs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  return {
    updateReports: vi.fn(async (config: LocalConfig, write: (wt: string) => Promise<unknown>) => (await write(checkout(config))) !== null),
    ensureReportsWorktree: vi.fn(async (config: LocalConfig) => checkout(config)),
    readableReportsWorktree: vi.fn(async (config: LocalConfig) => checkout(config)),
    indexableVotesDir: vi.fn(async (config: LocalConfig) => nodePath.join(checkout(config), 'votes')),
  };
});

const { hookDispatchCli } = await import('../hook-dispatch-cli.js');
const { resolveProjectDataHome, saveLocalConfigForScope } = await import('../config.js');
const { recall } = await import('../recall.js');
const { buildIndex } = await import('../utils/search-index.js');
const { loadUserVotes } = await import('../votes.js');
const { getProjectSearchIndexPath, getUserLearningsDir, getUserSearchIndexPath, getVotesDir } = await import('../types.js');
const { readRecallLog, recallLogPath } = await import('../recall-log.js');
const { parseTranscriptForVotes } = await import('../transcript-parser.js');

const SESSION = 'sess-main';
/** A Codex session started from the main session's shell, which also sees CLAUDE_CODE_SESSION_ID. */
const CODEX = 'sess-codex';
/** Both session variables a `codex exec` run from Claude's shell sees: two candidates, so the run is ambiguous. */
const NESTED_ENV = { CLAUDE_CODE_SESSION_ID: SESSION, CODEX_SESSION_ID: CODEX };
const T0 = Date.parse('2026-09-01T09:00:00.000Z');

function doc(title: string, tags: string[], body: string): string {
  return `---\ntitle: "${title}"\nauthor: tester\ndate: 2026-05-01\ntags: [${tags.join(', ')}]\n---\n\n${body}\n`;
}

/** The subagent a Claude hook fires in: its payloads carry `agent_id`, and `agent_type` when the agent has one. */
interface Subagent {
  id: string;
  type?: string;
}

/** The recall subagent as Claude Code reports it: `agent_type` is the agent file's `name`. */
const RECALL_SUBAGENT: Subagent = { id: 'agent-recall', type: 'teamai-recall' };
const GENERAL_SUBAGENT: Subagent = { id: 'agent-general', type: 'general-purpose' };

interface RecallRun {
  /** recall's stdout. */
  output: string;
  /** The `File:` paths it printed, in order. */
  files: string[];
  /** The run id on the region's start line, if any. */
  run?: string;
}

/** One agent session against a project scope and the user scope it may inherit. */
class Harness {
  readonly tmp: string;
  readonly root: string;
  project!: LocalConfig;
  user!: LocalConfig;
  teamRepo!: string;
  /** The project's recalled docs, by name. */
  readonly docs: Record<string, string> = {};

  constructor() {
    this.tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-attr-')));
    this.root = path.join(this.tmp, 'proj');
  }

  async setUp(options: { inheritUserScope?: boolean } = {}): Promise<void> {
    process.env.HOME = path.join(this.tmp, 'home');
    fs.mkdirSync(process.env.HOME, { recursive: true });

    // User scope: one learning in the machine-local mirror, which is a knowledge root.
    const userRepo = path.join(process.env.HOME, '.teamai', 'team-repo');
    fs.mkdirSync(userRepo, { recursive: true });
    fs.writeFileSync(path.join(userRepo, 'teamai.yaml'), 'team: user-team\nrepo: https://example.test/acme/user-team.git\n');
    this.user = { repo: { localPath: userRepo, remote: 'https://example.test/acme/user-team.git' }, username: 'tester', scope: 'user', additionalRoles: [] };
    fs.writeFileSync(path.join(process.env.HOME, '.teamai', 'config.yaml'), YAML.stringify(this.user));
    fs.mkdirSync(getUserLearningsDir(), { recursive: true });
    fs.writeFileSync(path.join(getUserLearningsDir(), 'cache-warmup.md'), doc('Cache warmup', ['cache', 'warmup'], 'Warm the cache first.'));
    await buildIndex({ learningsDir: getUserLearningsDir(), indexPath: getUserSearchIndexPath() });

    // Project scope.
    fs.mkdirSync(this.root, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: this.root });
    const dataHome = await resolveProjectDataHome(this.root);
    this.teamRepo = path.join(dataHome, 'team-repo');
    const learnings = path.join(this.teamRepo, 'learnings');
    const docsDir = path.join(this.teamRepo, 'docs');
    fs.mkdirSync(learnings, { recursive: true });
    fs.mkdirSync(path.join(docsDir, 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(this.teamRepo, 'teamai.yaml'), 'team: team-a\nrepo: https://example.test/acme/team-a.git\n');
    fs.writeFileSync(path.join(learnings, 'redis-timeout.md'), doc('Redis timeout fix', ['redis', 'timeout'], 'Raise the pool size SNIPPETMARK.'));
    fs.writeFileSync(path.join(learnings, 'setup.md'), doc('Setup guide', ['setup'], 'Run the installer.'));
    // A doc that shares the `learnings/setup.md` suffix with the learning above.
    fs.writeFileSync(path.join(docsDir, 'learnings', 'setup.md'), doc('Setup reference', ['setup'], 'Installer flags.'));
    // A same-named file under the knowledge roots that no recall returns.
    fs.mkdirSync(path.join(this.teamRepo, 'team-B', 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(this.teamRepo, 'team-B', 'learnings', 'setup.md'), doc('Other setup', ['setup'], 'Another checkout.'));
    this.docs['redis-timeout'] = path.join(learnings, 'redis-timeout.md');
    this.docs.setup = path.join(learnings, 'setup.md');
    this.docs['team-B/setup'] = path.join(this.teamRepo, 'team-B', 'learnings', 'setup.md');
    this.docs['cache-warmup'] = path.join(getUserLearningsDir(), 'cache-warmup.md');

    this.project = {
      repo: { localPath: this.teamRepo, remote: 'https://example.test/acme/team-a.git' },
      username: 'tester', scope: 'project', projectRoot: this.root, additionalRoles: [], dataHome,
      ...(options.inheritUserScope ? { inheritUserScope: true } : {}),
    };
    await saveLocalConfigForScope(this.project);
    await buildIndex({ learningsDir: learnings, docsDir, indexPath: getProjectSearchIndexPath(this.project) });
    process.chdir(this.root);
  }

  /** Set (a string) or clear (undefined) environment variables for the steps that follow. */
  env(vars: Record<string, string | undefined>): void {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  /** Move the clock to `hours` after the start of the trace. */
  at(hours: number): void {
    vi.setSystemTime(T0 + hours * 60 * 60 * 1000);
  }

  /**
   * The main agent, or `options.agent`, runs `teamai recall` from its shell
   * (the session in the environment, as Claude Code sets it for subagents
   * too), then its Bash PostToolUse arrives. `options.env` replaces the
   * session variables the run sees; `claim: false` sends no PostToolUse, as
   * when the call that ran it is another agent's.
   */
  async recall(query: string, options: {
    check?: boolean; dryRun?: boolean; caller?: string; agent?: Subagent;
    env?: Record<string, string | undefined>; claim?: false;
  } = {}): Promise<RecallRun> {
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as never);
    const vars = options.env ?? { CLAUDE_CODE_SESSION_ID: SESSION };
    const before = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
    this.env(vars);
    try {
      await recall(query, { check: options.check, dryRun: options.dryRun, caller: options.caller });
    } finally {
      write.mockRestore();
      this.env(before);
    }
    const flags = `${options.check ? ' --check' : ''}${options.caller ? ` --caller ${options.caller}` : ''}`;
    if (options.claim !== false) {
      await this.postToolUse('Bash', { command: `teamai recall${flags} "${query}"`, description: 'Search team knowledge' },
        { stdout: output, stderr: '', interrupted: false, isImage: false }, this.root, options.agent);
    }
    return {
      output,
      files: [...output.matchAll(/^File: (.+)$/gm)].map((m) => m[1]),
      run: output.match(/^--- \[teamai:recall:start\] --- \(\d+ results?\) run=(\S+)$/m)?.[1],
    };
  }

  /**
   * Claude's `Read` of `filePath` by the main agent or `options.agent` of
   * `options.session` (default: the main session), from the project root
   * unless `cwd` says otherwise (null: no cwd).
   */
  async read(filePath: string, options: { cwd?: string | null; agent?: Subagent; session?: string } = {}): Promise<void> {
    const content = fs.existsSync(path.resolve(this.root, filePath)) ? fs.readFileSync(path.resolve(this.root, filePath), 'utf-8') : '';
    await this.postToolUse('Read', { file_path: filePath },
      { type: 'text', file: { filePath, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } },
      options.cwd, options.agent, options.session);
  }

  /**
   * A shell call's PostToolUse in `options.session` (default: the main
   * session), from the project root: Claude's Bash, or Codex's, whose
   * `tool_response` is the output string.
   */
  async shell(command: string, stdout: string, options: { session?: string; tool?: 'claude' | 'codex' } = {}): Promise<void> {
    const response = options.tool === 'codex' ? stdout : { stdout, stderr: '', interrupted: false, isImage: false };
    await this.postToolUse('Bash', { command }, response, this.root, undefined, options.session, options.tool);
  }

  /** `file` relative to the project root, the cwd every call is made from. */
  rel(file: string): string {
    return path.relative(this.root, file);
  }

  /**
   * A Codex session (the only session in its environment) runs `teamai
   * recall`, and its shell call's PostToolUse claims the run.
   */
  async codexRecall(query: string): Promise<RecallRun> {
    const run = await this.recall(query, { env: { CODEX_SESSION_ID: CODEX }, claim: false });
    await this.shell(`teamai recall "${query}"`, run.output, { session: CODEX, tool: 'codex' });
    return run;
  }

  /** The Codex session's shell call. */
  async codexShell(command: string, stdout = ''): Promise<void> {
    await this.shell(command, stdout, { session: CODEX, tool: 'codex' });
  }

  async postToolUse(
    toolName: string, toolInput: Record<string, unknown>, toolResponse: unknown, cwd: string | null = this.root, agent?: Subagent,
    session?: string, tool?: string,
  ): Promise<void> {
    await this.dispatch('post-tool-use', {
      hook_event_name: 'PostToolUse', tool_name: toolName, tool_input: toolInput, tool_response: toolResponse,
      ...(agent ? { agent_id: agent.id, ...(agent.type ? { agent_type: agent.type } : {}) } : {}),
      ...(session ? { session_id: session } : {}),
    }, cwd, tool);
  }

  /** `session`'s Stop (default: the main session), which carries no `transcript_path` here: the reducer does not need one. Returns the hook's stdout. */
  async stop(session?: string): Promise<string> {
    return this.dispatch('stop', { hook_event_name: 'Stop', stop_hook_active: false, ...(session ? { session_id: session } : {}) });
  }

  async dispatch(event: string, payload: Record<string, unknown>, cwd: string | null = this.root, tool = 'claude'): Promise<string> {
    const stdinFile = path.join(this.tmp, `stdin-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(stdinFile, JSON.stringify({ session_id: SESSION, ...(cwd ? { cwd } : {}), ...payload }));
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, cb?: () => void) => {
      output += chunk.toString();
      if (typeof cb === 'function') cb();
      return true;
    }) as never);
    try {
      await hookDispatchCli(event, tool, '*', { stdinFile });
    } finally {
      write.mockRestore();
    }
    return output;
  }

  /** Upvotes per doc in a scope's own votes file. */
  async upvotes(config: LocalConfig): Promise<Record<string, number>> {
    const votes = await loadUserVotes(path.join(getVotesDir(config), 'tester.yaml'));
    return Object.fromEntries(Object.entries(votes.votes)
      .filter(([, entry]) => entry.upvoted_count > 0)
      .map(([id, entry]) => [id, entry.upvoted_count]));
  }
}

interface Row {
  name: string;
  inheritUserScope?: boolean;
  trace: (h: Harness) => Promise<void>;
  /** Upvotes the project scope holds afterwards. */
  project: Record<string, number>;
  /** Upvotes the user scope holds afterwards (default: none). */
  user?: Record<string, number>;
}

const ROWS: Row[] = [
  {
    name: '02: recall, then Read of the printed path, then Stop → +1 in project',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.read(files[0]);
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '02: Glob that lists the doc → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('Glob', { pattern: '**/*.md', path: path.dirname(files[0]) },
        { filenames: [files[0]], durationMs: 3, numFiles: 1, truncated: false });
      await h.stop();
    },
    project: {},
  },
  {
    name: '02: recall prints team-A/learnings/setup.md; Read of team-B/learnings/setup.md → 0',
    trace: async (h) => {
      await h.recall('setup');
      await h.read(h.docs['team-B/setup']);
      await h.stop();
    },
    project: {},
  },
  {
    name: '02: run returns only an inherited user-scope doc; the main agent reads it → 0',
    inheritUserScope: true,
    trace: async (h) => {
      const { files } = await h.recall('cache warmup');
      expect(files).toEqual([h.docs['cache-warmup']]);
      await h.read(files[0]);
      await h.stop();
    },
    project: {},
    user: {},
  },
  {
    name: '02: day 2, the resumed session reads the doc again with no new recall → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.read(files[0]);
      await h.stop();
      h.at(25);
      await h.read(files[0]);
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '02: day 2, the resumed session recalls again and reads the doc → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.read(files[0]);
      await h.stop();
      h.at(25);
      await h.recall('redis timeout');
      await h.read(files[0]);
      await h.stop();
    },
    project: { 'redis-timeout': 2 },
  },
  {
    name: '02: a read 24 h after the run is out of its window → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      h.at(24.5);
      await h.read(files[0]);
      await h.stop();
    },
    project: {},
  },
  {
    name: '02: reading the doc twice in the session → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.read(files[0]);
      await h.stop();
      await h.read(files[0]);
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '02: a read before the recall → 0',
    trace: async (h) => {
      await h.read(h.docs['redis-timeout']);
      h.at(1);
      await h.recall('redis timeout');
      await h.stop();
    },
    project: {},
  },
  {
    name: '02: a relative Read with no cwd matches the printed path by its suffix → +1',
    trace: async (h) => {
      await h.recall('redis timeout');
      await h.read(path.join('learnings', 'redis-timeout.md'), { cwd: null });
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '02: a relative Read with no cwd whose suffix two printed paths share → 0',
    trace: async (h) => {
      const { files } = await h.recall('setup');
      expect(files).toHaveLength(2);
      await h.read(path.join('learnings', 'setup.md'), { cwd: null });
      await h.stop();
    },
    project: {},
  },
  {
    name: '02: teamai recall --check, then a read → 0',
    trace: async (h) => {
      await h.recall('redis timeout', { check: true });
      await h.read(h.docs['redis-timeout']);
      await h.stop();
    },
    project: {},
  },
  {
    name: '02: TEAMAI_RECALL_DISABLED=1 during recall and read → 0',
    trace: async (h) => {
      h.env({ TEAMAI_RECALL_DISABLED: '1' });
      const { files } = await h.recall('redis timeout');
      await h.read(files[0]);
      h.env({ TEAMAI_RECALL_DISABLED: undefined });
      await h.stop();
    },
    project: {},
  },
  {
    name: '03: the recall subagent runs recall R and reads the doc; the main agent reads the doc; Stop → +1 in project',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { caller: 'teamai-recall', agent: RECALL_SUBAGENT });
      await h.read(files[0], { agent: RECALL_SUBAGENT });
      await h.read(files[0]);
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '03: the same, but only the recall subagent reads the doc → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { caller: 'teamai-recall', agent: RECALL_SUBAGENT });
      await h.read(files[0], { agent: RECALL_SUBAGENT });
      await h.stop();
    },
    project: {},
  },
  {
    name: '03: the recall subagent runs recall R; a general-purpose subagent reads the doc; Stop → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { caller: 'teamai-recall', agent: RECALL_SUBAGENT });
      await h.read(files[0], { agent: GENERAL_SUBAGENT });
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '03: recall R in the main agent; a general-purpose subagent reads the doc; Stop → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.read(files[0], { agent: GENERAL_SUBAGENT });
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '03: a run marked only by --caller (no agent_type in the payload) still excludes its actor\'s reads → 0',
    trace: async (h) => {
      const agent = { id: RECALL_SUBAGENT.id };
      const { files } = await h.recall('redis timeout', { caller: 'teamai-recall', agent });
      await h.read(files[0], { agent });
      await h.stop();
    },
    project: {},
  },
  {
    name: '03: a run marked only by agent_type (the model dropped --caller) still excludes its actor\'s reads → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { agent: RECALL_SUBAGENT });
      await h.read(files[0], { agent: RECALL_SUBAGENT });
      await h.stop();
    },
    project: {},
  },
  {
    name: '04 (Dan): codex exec from inside Claude; the Codex hook claims the run → the Codex session owns it; Claude-session reads → 0',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      // Codex's hook fires when its shell call ends, before `codex exec` returns to Claude with the output.
      await h.shell('teamai recall "redis timeout"', output, { session: CODEX, tool: 'codex' });
      await h.shell('codex exec "run teamai recall redis timeout and summarize"', output);
      await h.read(files[0]);
      await h.stop();
      expect(await h.upvotes(h.project)).toEqual({});
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '04: an outer shell prints the inner recall\'s stdout, with no direct teamai recall in its command → the claim is ignored, the run owner is unchanged',
    trace: async (h) => {
      // An unambiguous run under Codex, whose own claim never arrives.
      const { output, files } = await h.recall('redis timeout', { env: { CODEX_SESSION_ID: CODEX }, claim: false });
      await h.shell('codex exec "run teamai recall redis timeout"', output);
      await h.read(files[0]);
      await h.stop();
      expect(await h.upvotes(h.project)).toEqual({});
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '04: env run under C with 2 candidates; C reads the doc; C Stops; D\'s claim arrives → 0 for C, D owns the run',
    trace: async (h) => {
      // No hook events yet, so the variable order picks C (the main session).
      const { output, files } = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      await h.read(files[0]);
      await h.stop();
      expect(await h.upvotes(h.project)).toEqual({});
      h.at(1);
      await h.shell('teamai recall "redis timeout"', output, { session: CODEX, tool: 'codex' });
      await h.stop();
      expect(await h.upvotes(h.project)).toEqual({});
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '04: an unambiguous env run with no claim (a long-running Codex command); the session reads the doc → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout', { env: { CODEX_SESSION_ID: CODEX }, claim: false });
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '04: two runs in one shell call (teamai recall a; teamai recall b) → both claimed',
    trace: async (h) => {
      const a = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      const b = await h.recall('setup', { env: NESTED_ENV, claim: false });
      await h.shell('teamai recall "redis timeout"; teamai recall "setup"', `${a.output}${b.output}`, { session: CODEX, tool: 'codex' });
      await h.read(a.files[0], { session: CODEX });
      await h.read(h.docs.setup, { session: CODEX });
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1, setup: 1 },
  },
  {
    name: '04: duplicate delivery of the same claim → a single claim effect',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      await h.shell('teamai recall "redis timeout"', output, { session: CODEX, tool: 'codex' });
      await h.shell('teamai recall "redis timeout"', output, { session: CODEX, tool: 'codex' });
      h.at(1);
      await h.shell('teamai recall "redis timeout"', output, { session: CODEX, tool: 'codex' });
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '04: a later valid claim from another session is kept but not applied → 0 for it',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      await h.shell('teamai recall "redis timeout"', output, { session: CODEX, tool: 'codex' });
      h.at(1);
      await h.shell('npx teamai recall "redis timeout"', output);
      await h.read(files[0]);
      await h.stop();
      expect(await h.upvotes(h.project)).toEqual({});
      await h.read(files[0], { session: CODEX });
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05 (Bob): Codex recall; sed -n \'1,80p\' <doc, relative to the cwd>; Stop → +1',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`sed -n '1,80p' '${h.rel(files[0])}'`, fs.readFileSync(files[0], 'utf-8'));
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05: Codex claims its run with teamai recall … 2>&1 (a redirect is no & operator) → +1',
    trace: async (h) => {
      const { output, files } = await h.recall('redis timeout', { env: NESTED_ENV, claim: false });
      await h.codexShell('teamai recall "redis timeout" 2>&1', output);
      await h.codexShell(`cat '${files[0]}'`, '---');
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05: Codex recall; nl -ba <doc> → +1',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`nl -ba '${files[0]}'`, '     1\t---');
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05: Codex recall; learnings/redis-timeout.md relative to a cwd that holds no such doc → 0',
    trace: async (h) => {
      await h.codexRecall('redis timeout');
      await h.codexShell("sed -n '1,80p' learnings/redis-timeout.md", 'sed: learnings/redis-timeout.md: No such file or directory');
      await h.stop(CODEX);
    },
    project: {},
  },
  {
    name: '05: Claude recall; cat <doc> | head (a pipeline that starts with the reader, status success) → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`cat '${h.rel(files[0])}' | head -n 20`, '---');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05: Codex recall; cat <doc> | head (status unknown, not a simple read) → 0',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`cat '${h.rel(files[0])}' | head -n 20`, '---');
      await h.stop(CODEX);
    },
    project: {},
  },
  {
    name: '05: Codex recall; test -e x && cat <doc> || true → 0',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`test -e x && cat '${h.rel(files[0])}' || true`, '---');
      await h.stop(CODEX);
    },
    project: {},
  },
  {
    name: '05: Claude recall; cat <doc>; echo done, or cat <doc> & (any ;, &&, || or & makes the call no read) → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`cat '${files[0]}'; echo done`, '---\ndone');
      await h.shell(`cat '${files[0]}' &`, '');
      await h.stop();
    },
    project: {},
  },
  {
    name: '05: Claude recall; sed -i \'s/pool/POOL/\' <doc> → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`sed -i 's/pool/POOL/' '${files[0]}'`, '');
      await h.shell(`sed -n -i '1p' '${files[0]}'`, '');
      await h.stop();
    },
    project: {},
  },
  {
    name: '05: the doc as a redirect target or a flag value, not a file operand → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`cat notes.txt > '${files[0]}'`, '');
      await h.shell(`cat < '${files[0]}'`, '---');
      await h.shell(`nl -s '${files[0]}' notes.txt`, '');
      await h.stop();
    },
    project: {},
  },
  {
    name: '05: a read that fails (status failure: CodeBuddy IDE execute_command with exitCode 1) → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('execute_command', { command: `cat '${files[0]}'` },
        { exitCode: 1, stdout: '', stderr: 'cat: permission denied' }, h.root, undefined, undefined, 'codebuddy');
      await h.stop();
    },
    project: {},
  },
  {
    name: '05: the same read with exitCode 0 → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('execute_command', { command: `cat '${files[0]}'` },
        { exitCode: 0, stdout: '---', stderr: '' }, h.root, undefined, undefined, 'codebuddy');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '05: an unknown tool name with the doc path in its input → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('OpenDocument', { file_path: files[0], path: files[0], command: `cat '${files[0]}'` }, { content: '---' });
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: grep -rn timeout learnings/ with output line learnings/redis-timeout.md:12: → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`grep -rn timeout '${h.rel(path.dirname(files[0]))}'`, `${h.rel(files[0])}:12:Raise the pool size.\n`);
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: Codex rg timeout <dir> with a path:text line (no -n) → +1',
    trace: async (h) => {
      const { files } = await h.codexRecall('redis timeout');
      await h.codexShell(`rg timeout ${h.rel(path.dirname(files[0]))}`, `${h.rel(files[0])}:tags: [redis, timeout]\n`);
      await h.stop(CODEX);
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: grep timeout <doc> (a single file operand prints no path prefix) → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`grep timeout '${h.rel(files[0])}'`, 'tags: [redis, timeout]\n');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: grep -l timeout learnings/, grep -l / rg --files / ls / find naming the doc → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      const dir = h.rel(path.dirname(files[0]));
      const doc = h.rel(files[0]);
      await h.shell(`grep -l timeout '${dir}'`, `${doc}\n`);
      await h.shell(`grep -rl timeout '${doc}'`, `${doc}\n`);
      await h.shell(`grep -L pool '${doc}'`, `${doc}\n`);
      await h.shell(`rg --files '${doc}'`, `${doc}\n`);
      await h.shell(`ls '${dir}'`, 'redis-timeout.md\nsetup.md\n');
      await h.shell(`ls -l '${doc}'`, `-rw-r--r-- 1 me staff 120 Sep  1 09:00 ${doc}\n`);
      await h.shell(`find '${dir}' -name '*.md'`, `${doc}\n`);
      await h.shell(`git ls-files '${doc}'`, `${doc}\n`);
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: list tools (glob, list_dir, search_file, list_files) that name the doc → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      for (const name of ['glob', 'list_dir', 'search_file', 'list_files', 'LS']) {
        await h.postToolUse(name, { pattern: '*.md', path: files[0] }, `${files[0]}\n`);
      }
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: grep -c timeout learnings/redis-timeout.md, rg --count, and Grep count mode → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.shell(`grep -c timeout '${h.rel(files[0])}'`, '3\n');
      await h.shell(`grep -rnc timeout '${h.rel(path.dirname(files[0]))}'`, `${h.rel(files[0])}:3\n`);
      await h.shell(`rg --count timeout '${h.rel(path.dirname(files[0]))}'`, `${h.rel(files[0])}:3\n`);
      await h.postToolUse('Grep', { pattern: 'timeout', path: files[0], output_mode: 'count' },
        { mode: 'count', numFiles: 1, filenames: [], content: `${files[0]}:3`, numMatches: 3 });
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: Grep tool with path = the doc, content mode, non-empty output → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('Grep', { pattern: 'timeout', path: files[0], output_mode: 'content', '-n': true },
        { mode: 'content', numFiles: 1, filenames: [], content: '5:tags: [redis, timeout]', numLines: 1 });
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: Grep tool with path = the doc, content mode, empty output → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('Grep', { pattern: 'kubernetes', path: files[0], output_mode: 'content' },
        { mode: 'content', numFiles: 0, filenames: [], content: '', numLines: 0 });
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: Pi-style grep output relative to the searched dir (redis-timeout.md:12:) resolved against the input path → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('grep', { pattern: 'timeout', path: path.dirname(files[0]) },
        'redis-timeout.md:5: tags: [redis, timeout]', h.root, undefined, undefined, 'pi');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: a doc that only links to redis-timeout.md in its text shows up in search output → 0 for redis-timeout',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      const dir = h.rel(path.dirname(files[0]));
      const setup = h.rel(h.docs.setup);
      await h.shell(`grep -rn redis '${dir}'`,
        `${setup}:7:See [redis](redis-timeout.md): raise the pool\n${setup}:8:${h.rel(files[0])}: the fix\n`);
      // One file operand: a line of its text that starts with the doc's path is no path prefix.
      await h.shell(`grep redis '${setup}'`, `${h.rel(files[0])}: the fix\n`);
      await h.postToolUse('Grep', { pattern: 'redis', path: h.docs.setup, output_mode: 'content' },
        { mode: 'content', numFiles: 1, filenames: [], content: `${files[0]}: the fix`, numLines: 1 });
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: structured {filenames[]} output (Grep\'s default files_with_matches mode) → 0',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('Grep', { pattern: 'timeout', path: files[0] }, { mode: 'files_with_matches', filenames: [files[0]], numFiles: 1 });
      await h.postToolUse('Grep', { pattern: 'timeout', path: files[0] }, { filenames: [files[0]], numFiles: 1 });
      await h.postToolUse('Grep', { pattern: 'timeout', path: files[0], output_mode: 'files_with_matches' }, { results: files[0], matchCount: 1 });
      await h.stop();
    },
    project: {},
  },
  {
    name: '06: structured output whose content string has a <doc>: line → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('Grep', { pattern: 'timeout', path: path.dirname(files[0]), output_mode: 'content' },
        { mode: 'content', numFiles: 1, filenames: [], content: `${files[0]}:5:tags: [redis, timeout]`, numLines: 1 });
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
  {
    name: '06: Qoder Grep {results, matchCount} in content mode with a <doc>: line → +1',
    trace: async (h) => {
      const { files } = await h.recall('redis timeout');
      await h.postToolUse('Grep', { pattern: 'timeout', path: path.dirname(files[0]), output_mode: 'content' },
        { results: `${files[0]}:5:tags: [redis, timeout]`, matchCount: 1 }, h.root, undefined, undefined, 'qoder');
      await h.stop();
    },
    project: { 'redis-timeout': 1 },
  },
];

/** Rows later tickets ship: each turns its `todo` into a ROWS entry. */
const TODO_ROWS = [
  '07:Windows Get-Content -LiteralPath \'C:\\kb\\learnings\\redis-timeout.md\' → +1',
  '08: Copilot main agent recalls; view of the doc → +1',
  '08: Cursor recall subagent (its own conversation) with --caller reads the doc → 0',
  '09: OpenCode recall in a task child; the parent reads the doc; task link; Stop → +1 for the parent',
  '11: final Stop; a background worker reads the doc; SubagentStop → +1',
  '13: teamai recall --check then a read → no run in stats',
  '13: recall with no hits → one run in stats',
];

describe('recall attribution acceptance (#884)', () => {
  let h: Harness;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    h = new Harness();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.chdir(originalCwd);
    delete process.env.TEAMAI_RECALL_DISABLED;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(h.tmp, { recursive: true, force: true });
  });

  it.each(ROWS)('$name', async (row) => {
    await h.setUp({ inheritUserScope: row.inheritUserScope });
    await row.trace(h);
    expect(await h.upvotes(h.project)).toEqual(row.project);
    expect(await h.upvotes(h.user)).toEqual(row.user ?? {});
  });

  for (const name of TODO_ROWS) it.todo(name);

  it('prints the run id after the result count on the region start line', async () => {
    await h.setUp();
    const { output, run } = await h.recall('redis timeout');
    expect(output.split('\n')[0]).toMatch(/^--- \[teamai:recall:start\] --- \(1 result\) run=[0-9a-f-]{36}$/);
    expect((await readRecallLog(h.project)).filter((l) => l.kind === 'run').map((l) => l.kind === 'run' && l.run)).toEqual([run]);
  });

  it('Stop tells the user which recalled doc the session adopted', async () => {
    await h.setUp();
    const { files } = await h.recall('redis timeout');
    await h.read(files[0]);
    expect(await h.stop()).toContain('[teamai] Adopted team knowledge this session: redis-timeout');
    expect(await h.stop()).toBe('');
  });

  it('recall with no hits records a run with no docs', async () => {
    await h.setUp();
    await h.recall('kubernetes');
    const runs = (await readRecallLog(h.project)).filter((l) => l.kind === 'run');
    expect(runs).toEqual([expect.objectContaining({ kind: 'run', session: SESSION, agent: 'claude', via: 'env', unambiguous: true, docs: [] })]);
  });

  it('teamai recall --check records no run', async () => {
    await h.setUp();
    const { output } = await h.recall('redis timeout', { check: true });
    expect(output).toMatch(/^RELEVANT /);
    expect(await readRecallLog(h.project)).toEqual([]);
  });

  it('teamai recall --dry-run records no run and prints no run id', async () => {
    await h.setUp();
    const { files, run } = await h.recall('redis timeout', { dryRun: true });
    expect(files).toEqual([h.docs['redis-timeout']]);
    expect(run).toBeUndefined();
    expect(await readRecallLog(h.project)).toEqual([]);
  });

  it('TEAMAI_RECALL_DISABLED=1 leaves nothing in the recall log, from recall or the hook', async () => {
    await h.setUp();
    h.env({ TEAMAI_RECALL_DISABLED: '1' });
    const { output, files } = await h.recall('redis timeout');
    await h.read(files[0]);
    expect(output).not.toContain('run=');
    expect(await readRecallLog(h.project)).toEqual([]);
  });

  it('the recall log never holds the query, prompt, tool output or file content', async () => {
    await h.setUp();
    await h.dispatch('prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: 'why does redis PROMPTMARK time out' });
    const { files } = await h.recall('redis timeout QUERYMARK');
    expect(files).toEqual([h.docs['redis-timeout']]);
    await h.read(files[0]);
    await h.shell(`sed -n '1,80p' '${h.rel(files[0])}'`, fs.readFileSync(files[0], 'utf-8'), { tool: 'codex' });
    await h.shell(`grep -rn GREPMARK '${h.rel(path.dirname(files[0]))}'`, `${h.rel(files[0])}:12:Raise the pool size SNIPPETMARK.\n`);
    await h.stop();

    const raw = fs.readFileSync(recallLogPath(h.project), 'utf-8');
    expect(raw.match(/"kind":"evidence"/g)).toHaveLength(3);
    for (const secret of ['QUERYMARK', 'PROMPTMARK', 'SNIPPETMARK', 'GREPMARK', 'Raise the pool size', 'Author:', 'teamai recall', 'sed -n', '1,80p', ':12:']) {
      expect(raw).not.toContain(secret);
    }
    if (process.platform !== 'win32') {
      expect(fs.statSync(recallLogPath(h.project)).mode & 0o077).toBe(0);
    }
  });

  it('an older CLI still finds the recalled doc in the new output', async () => {
    await h.setUp();
    const { output, run } = await h.recall('redis timeout');
    expect(run).toBeDefined();
    const transcript = path.join(h.tmp, 'transcript.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: output }] } })}\n`);
    expect((await parseTranscriptForVotes(transcript)).recalledDocIds).toEqual(['redis-timeout']);
  });

  it('the recall log sits in the data home of the scope that ran the recall', async () => {
    await h.setUp();
    await h.recall('redis timeout');
    expect(recallLogPath(h.project)).toBe(path.join(h.project.dataHome!, 'dashboard', 'recall.jsonl'));
    expect(fs.existsSync(recallLogPath(h.project))).toBe(true);
    expect(fs.existsSync(recallLogPath(h.user))).toBe(false);
  });
});
