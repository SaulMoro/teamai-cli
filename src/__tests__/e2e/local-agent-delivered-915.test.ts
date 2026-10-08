/**
 * E2E (#915): the skills and rules the HTTP local agent installs in a project
 * stay out of git, in the `local-agent` block of the exclude file of the
 * repository they land in, while the workspace's git exclude flag is on. The
 * flag is read per project: one project on, one off. A member's file at a path
 * the agent would install to is kept, and named. `teamai uninstall` removes
 * the block from every exclude file the agent recorded, a second repository's
 * too.
 *
 * Runs the built CLI against an in-process mock backend, so the CLI is spawned
 * asynchronously. Each case gets its own HOME and repositories.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';
import { startMockServer, type MockCommand, type MockServerHandle } from '../helpers/mock-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');
const API_KEY = 'e2e-http-key';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run { code: number | null; output: string }

let sandbox: string;
let detached: ReturnType<typeof trackDetachedProcesses>;
let server: MockServerHandle;

beforeAll(async () => {
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-local-agent-915-')));
  detached = trackDetachedProcesses(sandbox);
  server = await startMockServer({ apiKey: API_KEY, skillNames: { 'renamed-slug': 'renamed-skill' } });
});

afterAll(async () => {
  await detached?.waitForExit();
  await server?.close();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

function machine(name: string) {
  const base = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', SHELL: '/bin/bash', FORCE_COLOR: '0',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' '),
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.TEAMAI_API_TOKEN;
  delete env.TEAMAI_API_KEY;
  const git = (args: string[], cwd: string): { code: number | null; out: string } => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  // Spawned asynchronously: the mock backend runs in this process.
  const cli = (args: string[], cwd: string, input?: string): Promise<Run> => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(input ?? '');
  });
  return {
    home,
    git,
    cli,
    /** A committed repository with teamai initialized in HTTP mode, project scope, for Claude. */
    async project(dir: string): Promise<string> {
      const root = path.join(base, dir);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'README.md'), `# ${dir}\n`);
      git(['init', '-q', '-b', 'main'], root);
      git(['add', '-A'], root);
      git(['commit', '-q', '-m', dir], root);
      const real = fs.realpathSync.native(root);
      const init = await cli(['init', '--http', server.url, '--token', API_KEY, '--scope', 'project', '--agent', 'claude', '--force'], real);
      expect(init.code, init.output).toBe(0);
      return real;
    },
    /** The member's git exclude override in the project's partition config. */
    setFlag(project: string, on: boolean): void {
      const projects = path.join(home, '.teamai', 'projects');
      const config = fs.readdirSync(projects).map((d) => path.join(projects, d, 'config.yaml'))
        .find((file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(`projectRoot: ${project}\n`));
      if (!config) throw new Error(`no partition config for ${project}`);
      const lines = fs.readFileSync(config, 'utf8').split('\n').filter((line) => !line.startsWith('gitExcludeEnabled:'));
      fs.writeFileSync(config, [...lines.filter(Boolean), `gitExcludeEnabled: ${on}`, ''].join('\n'));
    },
    async sessionStart(cwd: string, commands: MockCommand[]): Promise<void> {
      server.seedCommands(commands);
      const run = await cli(['hook-dispatch', 'session-start', '--tool', 'claude'], cwd,
        JSON.stringify({ cwd, session_id: `s-${path.basename(cwd)}`, hook_event_name: 'SessionStart', source: 'startup' }));
      await detached.waitForExit();
      expect(run.code, run.output).toBe(0);
    },
  };
}

const install = (id: number, kind: 'skill' | 'rule', slug: string, workspace: string): MockCommand => ({
  id,
  type: `install_${kind}`,
  [`${kind}_slug`]: slug,
  [`${kind}_version`]: '1.0.0',
  download_url: `${server.url}/download?kind=${kind}&slug=${slug}`,
  scope: 'workspace',
  workspace_path: workspace,
});

const block = (project: string): string[] | null => {
  const file = path.join(project, '.git', 'info', 'exclude');
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const match = /# \[teamai:local-agent:start\]\n([\s\S]*?)# \[teamai:local-agent:end\]\n/.exec(content);
  return match ? match[1].split('\n').filter(Boolean) : null;
};

describe.skipIf(process.platform === 'win32')('the HTTP local agent keeps what it installs in a project out of git (#915)', () => {
  it('lists a skill and a rule where the flag is on and not where it is off, keeps a member\'s file, and uninstall drops the lines in every repository', async () => {
    const m = machine('http');
    const app = await m.project('app');
    const side = await m.project('side');
    m.setFlag(app, true);
    const status = (cwd: string): string[] => m.git(['status', '--porcelain', '-uall'], cwd).out.split('\n').filter(Boolean);
    const ignored = (cwd: string, rel: string): boolean => m.git(['check-ignore', '-q', rel], cwd).code === 0;
    fs.mkdirSync(path.join(app, '.claude', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(app, '.claude', 'rules', 'mine.md'), '# Mine\n');
    const membersRule = path.join(app, '.claude', 'rules', 'members-rule.md');
    fs.writeFileSync(membersRule, '# My own rule of that name\n');

    await m.sessionStart(app, [
      install(1, 'skill', 'renamed-slug', app),
      install(2, 'rule', 'http-rule', app),
      install(3, 'rule', 'members-rule', app),
      install(4, 'skill', 'side-skill', side),
      install(5, 'rule', 'side-rule', side),
    ]);

    expect(server.acks.map(({ id, body }) => [id, (body as { status: string }).status])).toEqual([
      [1, 'success'], [2, 'success'], [3, 'failed'], [4, 'success'], [5, 'success'],
    ]);
    expect((server.acks[2].body as { error: string }).error).toBe(`Kept ${membersRule}: it is not teamai's (not in the local agent's records). `
      + 'Rename or delete it; the local agent installs members-rule on its next sync.');
    expect(fs.readFileSync(membersRule, 'utf8')).toBe('# My own rule of that name\n');
    // Flag on: git ignores both installs, and still sees the member's files.
    expect(ignored(app, '.claude/skills/renamed-skill/SKILL.md')).toBe(true);
    expect(ignored(app, '.claude/rules/http-rule.md')).toBe(true);
    expect(block(app)).toEqual(['/.claude/rules/http-rule.md', '/.claude/skills/renamed-skill/']);
    expect(status(app)).toEqual(['?? .claude/rules/members-rule.md', '?? .claude/rules/mine.md']);
    expect(m.git(['ls-files', '--others', '--exclude-standard', '.claude/rules'], app).out.split('\n').filter(Boolean).sort())
      .toEqual(['.claude/rules/members-rule.md', '.claude/rules/mine.md']);
    // Flag off: no block, and git sees both installs.
    expect(block(side)).toBeNull();
    expect(status(side)).toEqual(expect.arrayContaining(['?? .claude/rules/side-rule.md', '?? .claude/skills/side-skill/SKILL.md']));

    // Turned on in the second project: its next install lists its copies there.
    m.setFlag(side, true);
    await m.sessionStart(side, [install(6, 'rule', 'side-rule-2', side)]);
    expect(block(side)).toEqual(['/.claude/rules/side-rule-2.md', '/.claude/rules/side-rule.md', '/.claude/skills/side-skill/']);
    expect(block(app)).toEqual(['/.claude/rules/http-rule.md', '/.claude/skills/renamed-skill/']);

    const out = await m.cli(['uninstall', '--force'], app);

    expect(out.code, out.output).toBe(0);
    expect(fs.readFileSync(path.join(app, '.git', 'info', 'exclude'), 'utf8')).not.toContain('# [teamai:');
    // The second project's own delivered block is that project's to keep.
    expect(block(side)).toBeNull();
    expect(fs.readFileSync(path.join(side, '.git', 'info', 'exclude'), 'utf8')).toContain('# [teamai:delivered:start]');
    expect(status(app).filter((line) => /renamed-skill|http-rule/.test(line))).toEqual([]);
    expect(fs.readFileSync(membersRule, 'utf8')).toBe('# My own rule of that name\n');
  }, 180_000);
});
