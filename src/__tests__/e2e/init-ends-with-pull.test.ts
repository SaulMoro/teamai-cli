/**
 * E2E: `teamai init` ends with a pull, so the member's first session already
 * has the team's skills, rules and MCP servers (sync-before-session, ticket 02).
 *
 * Claude reads rules and MCP once, at session start, before teamai's
 * SessionStart hook can sync. Unless init itself delivers, the first session
 * after init runs without them; in project scope nothing at all landed,
 * because no tool root existed in the checkout yet.
 *
 * The team remote is a synthetic HTTPS URL that git's `insteadOf` rewrites to a
 * local bare repo in the sandbox HOME (see init-project-all.test.ts), so no
 * network is touched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/team.git';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface RunResult {
  code: number | null;
  output: string;
}

let sandbox: string;
let home: string;
let remote: string;
let binDir: string;

/**
 * A `git` ahead of PATH that reports the synthetic HTTPS origin for
 * `remote get-url` (so a re-init reuses the clone; real `insteadOf` expansion
 * would make it look like another repo), and with TEST_FAIL_FETCH=1 refuses to
 * refresh a clone, as an unreachable remote would.
 */
function writeGitWrapper(): void {
  binDir = path.join(sandbox, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(binDir, 'git'), [
    '#!/bin/sh',
    'if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then',
    `  printf '%s\\n' '${FAKE_URL}'; exit 0`,
    'fi',
    'if [ "$TEST_FAIL_FETCH" = "1" ]; then',
    '  for arg in "$@"; do',
    '    case "$arg" in',
    '      fetch|pull) echo "fatal: unable to access remote (test)" >&2; exit 128 ;;',
    '    esac',
    '  done',
    'fi',
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
}

function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...extraEnv },
  }).trim();
}

function runCLI(args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    FORCE_COLOR: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extraEnv,
  };
  // The sandbox HOME decides where tools live; a developer's override must not.
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  return new Promise((resolve) => {
    // stdin ignored: no terminal, so init never prompts.
    const child = spawn('node', [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function writeSeed(seed: string, relativePath: string, content: string): void {
  const file = path.join(seed, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A git business repo with no tool roots of its own. */
function makeBusinessRepo(name: string): string {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# app\n');
  git(['init', '-q', '-b', 'main'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'app'], dir);
  return dir;
}

const TOOL_ROOTS = ['.claude', '.codex', '.cursor', '.codebuddy', '.opencode', '.config'];

describe.skipIf(process.platform === 'win32')('teamai init ends with a pull', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-pull-e2e-')));
    remote = path.join(sandbox, 'team.git');
    const seed = path.join(sandbox, 'seed');

    writeSeed(seed, 'teamai.yaml', [
      'team: init-pull-e2e',
      `repo: ${FAKE_URL}`,
      'provider: git',
      'reviewers: []',
      'sharing:',
      '  mcp:',
      '    autoApply: true',
      '',
    ].join('\n'));
    writeSeed(seed, 'skills/team-skill/SKILL.md',
      '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n');
    writeSeed(seed, 'rules/team-rule.md', '# Team rule\n');
    writeSeed(seed, 'mcp/mcp.yaml', [
      'servers:',
      '  - name: team-api',
      '    transport: http',
      '    url: https://team.example.com/mcp',
      '',
    ].join('\n'));
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    writeGitWrapper();
  });

  beforeEach(() => {
    home = path.join(sandbox, `home-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(home, { recursive: true });
    // Claude and Codex are installed on this machine.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    git(['config', '--global', `url.${remote}.insteadOf`, FAKE_URL], sandbox, { HOME: home, USERPROFILE: home });
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('user scope: the team skill, rule and MCP server are delivered when init exits', async () => {
    const cwd = path.join(sandbox, 'elsewhere');
    fs.mkdirSync(cwd, { recursive: true });
    const result = await runCLI(['init', FAKE_URL, '--scope', 'user', '--agent', 'claude', '--force'], cwd);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/teamai initialized successfully/);

    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'team-skill', 'SKILL.md')), result.output).toBe(true);
    expect(fs.readFileSync(path.join(home, '.claude', 'rules', 'team-rule.md'), 'utf8')).toContain('Team rule');
    const claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(Object.keys(claudeJson.mcpServers ?? {})).toContain('team-api');
  }, 90_000);

  it('project scope with --agent claude: .claude/ is created and filled, .mcp.json holds the team server', async () => {
    const project = makeBusinessRepo(`app-${Math.random().toString(36).slice(2)}`);
    const result = await runCLI(['init', FAKE_URL, '--scope', 'project', '--agent', 'claude', '--force'], project);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/teamai initialized successfully/);

    expect(fs.existsSync(path.join(project, '.claude', 'skills', 'team-skill', 'SKILL.md')), result.output).toBe(true);
    expect(fs.readFileSync(path.join(project, '.claude', 'rules', 'team-rule.md'), 'utf8')).toContain('Team rule');
    const mcp = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(Object.keys(mcp.mcpServers ?? {})).toContain('team-api');
    // Only the chosen tool's root, although Codex is installed too.
    expect(fs.existsSync(path.join(project, '.codex'))).toBe(false);
  }, 90_000);

  it('project scope re-init with another --agent adds that root even if enabledAgents was narrower', async () => {
    const project = makeBusinessRepo(`app-${Math.random().toString(36).slice(2)}`);
    const first = await runCLI(['init', FAKE_URL, '--scope', 'project', '--agent', 'codex', '--force'], project);
    expect(first.code, first.output).toBe(0);
    expect(fs.existsSync(path.join(project, '.claude'))).toBe(false);

    const second = await runCLI(['init', FAKE_URL, '--scope', 'project', '--agent', 'claude', '--force'], project);
    expect(second.code, second.output).toBe(0);
    expect(fs.existsSync(path.join(project, '.claude', 'skills', 'team-skill', 'SKILL.md')), second.output).toBe(true);
  }, 120_000);

  it('project scope without a terminal and without --agent: no tool root is created', async () => {
    const project = makeBusinessRepo(`app-${Math.random().toString(36).slice(2)}`);
    const result = await runCLI(['init', FAKE_URL, '--scope', 'project', '--force'], project);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/teamai initialized successfully/);
    for (const root of TOOL_ROOTS) {
      expect(fs.existsSync(path.join(project, root)), `${root} was created:\n${result.output}`).toBe(false);
    }
  }, 90_000);

  it('a pull failure inside init is reported the way pull reports it, and init still succeeds', async () => {
    // init's own clone works; the pull that follows cannot refresh the clone.
    const cwd = path.join(sandbox, 'elsewhere');
    fs.mkdirSync(cwd, { recursive: true });
    const result = await runCLI(
      ['init', FAKE_URL, '--scope', 'user', '--agent', 'claude', '--force'],
      cwd,
      { TEST_FAIL_FETCH: '1' },
    );
    expect(result.output).toMatch(/\[user\] Pull failed:/);
    expect(result.output).toMatch(/teamai initialized successfully/);
    expect(result.code, result.output).toBe(0);
  }, 90_000);
});
