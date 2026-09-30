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
const T0 = Date.parse('2026-09-01T09:00:00.000Z');

function doc(title: string, tags: string[], body: string): string {
  return `---\ntitle: "${title}"\nauthor: tester\ndate: 2026-05-01\ntags: [${tags.join(', ')}]\n---\n\n${body}\n`;
}

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
   * The main agent runs `teamai recall` from its shell (its session in the
   * environment, as Claude Code sets it), then its Bash PostToolUse arrives.
   */
  async recall(query: string, options: { check?: boolean; dryRun?: boolean } = {}): Promise<RecallRun> {
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as never);
    const before = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    try {
      await recall(query, { check: options.check, dryRun: options.dryRun });
    } finally {
      write.mockRestore();
      if (before === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = before;
    }
    await this.postToolUse('Bash', { command: `teamai recall${options.check ? ' --check' : ''} "${query}"`, description: 'Search team knowledge' },
      { stdout: output, stderr: '', interrupted: false, isImage: false });
    return {
      output,
      files: [...output.matchAll(/^File: (.+)$/gm)].map((m) => m[1]),
      run: output.match(/^--- \[teamai:recall:start\] --- \(\d+ results?\) run=(\S+)$/m)?.[1],
    };
  }

  /** Claude's `Read` of `filePath`, from the project root unless `cwd` says otherwise (null: no cwd). */
  async read(filePath: string, options: { cwd?: string | null } = {}): Promise<void> {
    const content = fs.existsSync(path.resolve(this.root, filePath)) ? fs.readFileSync(path.resolve(this.root, filePath), 'utf-8') : '';
    await this.postToolUse('Read', { file_path: filePath },
      { type: 'text', file: { filePath, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } },
      options.cwd);
  }

  async postToolUse(toolName: string, toolInput: Record<string, unknown>, toolResponse: unknown, cwd: string | null = this.root): Promise<void> {
    await this.dispatch('post-tool-use', {
      hook_event_name: 'PostToolUse', tool_name: toolName, tool_input: toolInput, tool_response: toolResponse,
    }, cwd);
  }

  /** Claude's Stop, which carries no `transcript_path` here: the reducer does not need one. Returns the hook's stdout. */
  async stop(): Promise<string> {
    return this.dispatch('stop', { hook_event_name: 'Stop', stop_hook_active: false });
  }

  async dispatch(event: string, payload: Record<string, unknown>, cwd: string | null = this.root): Promise<string> {
    const stdinFile = path.join(this.tmp, `stdin-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(stdinFile, JSON.stringify({ session_id: SESSION, ...(cwd ? { cwd } : {}), ...payload }));
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, cb?: () => void) => {
      output += chunk.toString();
      if (typeof cb === 'function') cb();
      return true;
    }) as never);
    try {
      await hookDispatchCli(event, 'claude', '*', { stdinFile });
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
];

/** Rows later tickets ship: each turns its `todo` into a ROWS entry. */
const TODO_ROWS = [
  '03: the recall subagent runs recall R and reads the doc; the main agent reads the doc; Stop → +1 in project',
  '03: the same, but only the recall subagent reads the doc → 0',
  '03: recall R in the main agent; a general-purpose subagent reads the doc; Stop → +1',
  '04: env run under C with 2 candidates; C reads the doc; C Stops; D\'s claim arrives → 0 for C, D owns the run',
  '04: an outer shell prints the inner recall\'s stdout, with no direct teamai recall in its command → 0 for the outer session',
  '05: Codex recall; sed -n \'1,80p\' learnings/redis-timeout.md; Stop → +1',
  '05: Codex recall; test -e x && cat learnings/redis-timeout.md || true → 0',
  '05: a read that fails (status failure) → 0',
  '06: ls learnings/ and grep -l timeout learnings/ → 0',
  '06: grep -rn timeout learnings/ with output line learnings/redis-timeout.md:12: → +1',
  '06: grep -c timeout learnings/redis-timeout.md → 0',
  '07: Windows Get-Content -LiteralPath \'C:\\kb\\learnings\\redis-timeout.md\' → +1',
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
    expect(runs).toEqual([expect.objectContaining({ kind: 'run', session: SESSION, docs: [] })]);
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
    await h.stop();

    const raw = fs.readFileSync(recallLogPath(h.project), 'utf-8');
    expect(raw).toContain('"kind":"evidence"');
    for (const secret of ['QUERYMARK', 'PROMPTMARK', 'SNIPPETMARK', 'Raise the pool size', 'Author:', 'teamai recall']) {
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
