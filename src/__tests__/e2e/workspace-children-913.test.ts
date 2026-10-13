import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// ─── A workspace delivers what the repos inside it select (#913) ────────────
//
// Run through the compiled CLI. A plain folder `ws/` is set up with `init`,
// and so is each repo inside it, each with its own project. A pull in `ws/`
// delivers the workspace's own selection plus every child's, names the
// children, and leaves out a child that uses another team repo.
//
// The team remote is a synthetic HTTPS URL that git's `url.<base>.insteadOf`
// rewrites to a local bare repo, with a test-only `git` wrapper that reports
// the synthetic URL for `remote get-url` (see init-project-all.test.ts).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/team.git';
const OTHER_URL = 'https://git.example.com/other/team.git';

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

function git(args: string[], cwd: string, home?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...(home ? { HOME: home, USERPROFILE: home } : {}) },
  }).trim();
}

function installGitRemoteGetUrlWrapper(binDir: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // The origin a clone reports is the URL it was cloned from, read back from
  // its config before insteadOf rewrites it.
  fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh
if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then
  case "$3" in
    ""|origin|--all)
      url=$('${realGit}' config --get teamai-test.origin) && { printf '%s\\n' "$url"; exit 0; }
      ;;
  esac
fi
exec '${realGit}' "$@"
`, { mode: 0o755 });
  return binDir;
}

function runCLI(args: string[], cwd: string, home: string, extraEnv: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function seedTeamRepo(seed: string, url: string): void {
  fs.mkdirSync(path.join(seed, 'manifest'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
    'team: ws-children-e2e',
    `repo: ${url}`,
    'provider: git',
    'reviewers: []',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), YAML.stringify({
    version: 1,
    projects: ['svc-a', 'svc-b', 'platform'].map((id) => ({
      id,
      resources: { skills: id === 'platform' ? [id] : [id, 'payments'], knowledge: [id], learnings: [id] },
    })),
  }));
  // A root instruction file svc-a replaces with its own; svc-b still reads the root one.
  fs.mkdirSync(path.join(seed, 'claudemd', 'svc-a'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'claudemd', 'style.md'), '# Style\n\nRoot style for every service.\n');
  fs.writeFileSync(path.join(seed, 'claudemd', 'svc-a', 'style.md'), '# Style\n\nStyle of svc-a.\n');
  fs.mkdirSync(path.join(seed, 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'mcp', 'mcp.yaml'), 'servers:\n  - { name: team-db, transport: http, url: https://db.example.com/mcp }\n');
  for (const [namespace, name] of [['svc-a', 'svc-a-tool'], ['svc-a', 'svc-a-extra'], ['svc-b', 'svc-b-tool'], ['platform', 'platform-tool'], ['payments', 'payments-tool']]) {
    const dir = path.join(seed, 'skills', namespace!, name!);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\n# ${name}\n`);
  }
}

describe('a workspace delivers what the repos inside it select (#913)', () => {
  let sandbox: string;
  let home: string;
  let ws: string;
  let cliEnv: Record<string, string>;

  const run = (args: string[], cwd: string): Promise<RunResult> => runCLI(args, cwd, home, cliEnv);
  const skillsIn = (root: string): string[] => {
    const dir = path.join(root, '.claude', 'skills');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => !name.startsWith('teamai')).sort() : [];
  };
  const setUpRepo = async (dir: string, args: string[], url = FAKE_URL): Promise<void> => {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    git(['init', '-q', '-b', 'main'], dir);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], dir);
    const result = await run(['init', url, '--scope', 'workspace', '--agent', 'claude', '--force', ...args], dir);
    expect(result.code, result.output).toBe(0);
  };

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-ws-children-e2e-')));
    home = path.join(sandbox, 'home');
    ws = path.join(sandbox, 'ws');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });

    for (const [name, url] of [['team', FAKE_URL], ['other', OTHER_URL]] as const) {
      const seed = path.join(sandbox, `seed-${name}`);
      seedTeamRepo(seed, url);
      git(['init', '-q', '-b', 'main'], seed);
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', 'seed'], seed);
      // One learning per project, on the branch learnings are published to.
      git(['checkout', '-q', '--orphan', 'teamai-learnings'], seed);
      git(['rm', '-rfq', '.'], seed);
      for (const [namespace, word] of [['svc-a', 'narwhal'], ['platform', 'okapi']]) {
        fs.mkdirSync(path.join(seed, 'learnings', namespace!), { recursive: true });
        fs.writeFileSync(path.join(seed, 'learnings', namespace!, `${word}.md`), `# ${word} rollout\n\nThe ${word} rollout needs the ${word} cache warmed first.\n`);
      }
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', 'learnings'], seed);
      git(['checkout', '-q', 'main'], seed);
      const bare = path.join(sandbox, `${name}.git`);
      git(['clone', '-q', '--bare', seed, bare], sandbox);
      git(['config', '--global', `url.${bare}.insteadOf`, url], sandbox, home);
    }
    cliEnv = { PATH: `${installGitRemoteGetUrlWrapper(path.join(sandbox, 'bin'))}${path.delimiter}${process.env.PATH ?? ''}` };

    await setUpRepo(path.join(ws, 'svc-a'), ['--project', 'svc-a']);
    await setUpRepo(path.join(ws, 'backend', 'svc-b'), ['--project', 'svc-b']);
    await setUpRepo(path.join(ws, 'carol'), ['--project', 'svc-b'], OTHER_URL);
    for (const clone of fs.readdirSync(path.join(home, '.teamai', 'projects'))) {
      const config = YAML.parse(fs.readFileSync(path.join(home, '.teamai', 'projects', clone, 'config.yaml'), 'utf8'));
      git(['config', 'teamai-test.origin', config.repo.remote], config.repo.localPath);
    }
    const result = await run(['init', FAKE_URL, '--scope', 'workspace', '--agent', 'claude', '--force'], ws);
    expect(result.code, result.output).toBe(0);
    git(['config', 'teamai-test.origin', FAKE_URL], path.join(ws, '.teamai', 'team-repo'));
  }, 180_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('delivers every child\'s projects, names the children, and leaves out one of another team repo', async () => {
    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('[workspace] Workspace with 2 children: backend/svc-b, svc-a');
    expect(result.output).toContain('[workspace] Workspace child carol is left out: it uses another team repo (https://git.example.com/other/team.git)');
    expect(skillsIn(ws)).toEqual(['payments-tool', 'svc-a-extra', 'svc-a-tool', 'svc-b-tool']);
  });

  it('gives the workspace the instructions of each child, a root file only one child replaces included', async () => {
    const result = await run(['pull', '--force'], ws);

    expect(result.code, result.output).toBe(0);
    const instructions = fs.readFileSync(path.join(ws, '.claude', 'rules', 'teamai-context.md'), 'utf8');
    expect(instructions).toContain('Style of svc-a.');
    expect(instructions).toContain('Root style for every service.');
  });

  it('follows a child that changes its selection without a team commit', async () => {
    const svcA = path.join(ws, 'svc-a');
    const exclude = await run(['skill', 'exclude', 'add', 'svc-a-extra'], svcA);
    expect(exclude.code, exclude.output).toBe(0);
    const projects = await run(['projects', 'set', 'svc-a', 'platform'], svcA);
    expect(projects.code, projects.output).toBe(0);

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain('Already synced');
    expect(skillsIn(ws)).toEqual(['payments-tool', 'platform-tool', 'svc-a-tool', 'svc-b-tool']);
  });

  it('gives the workspace\'s MCP servers to Claude through its local scope, so a child does not load them', async () => {
    const result = await run(['pull', '--force'], ws);

    expect(result.code, result.output).toBe(0);
    expect(fs.existsSync(path.join(ws, '.mcp.json'))).toBe(false);
    const claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(Object.keys(claudeJson.projects?.[ws]?.mcpServers ?? {})).toEqual(['team-db']);
  });

  it('keeps a scope without children as it was: its own selection, its project MCP file, no workspace line', async () => {
    const lone = path.join(sandbox, 'lone');
    await setUpRepo(lone, ['--project', 'svc-b']);
    git(['config', 'teamai-test.origin', FAKE_URL], YAML.parse(fs.readFileSync(path.join(home, '.teamai', 'projects', fs.readdirSync(path.join(home, '.teamai', 'projects')).find((slug) => slug.includes('lone'))!, 'config.yaml'), 'utf8')).repo.localPath);

    const result = await run(['pull'], lone);

    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain('Workspace');
    expect(skillsIn(lone)).toEqual(['payments-tool', 'svc-b-tool']);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(lone, '.mcp.json'), 'utf8')).mcpServers)).toEqual(['team-db']);
    expect(fs.existsSync(path.join(lone, '.claude', 'settings.local.json'))
      && JSON.parse(fs.readFileSync(path.join(lone, '.claude', 'settings.local.json'), 'utf8')).claudeMdExcludes).toBeFalsy();
    const state = JSON.parse(fs.readFileSync(path.join(home, '.teamai', 'projects', fs.readdirSync(path.join(home, '.teamai', 'projects')).find((slug) => slug.includes('lone'))!, 'state.json'), 'utf8'));
    expect(Object.values(state.lastPullByWorkspace).every((record) => !('children' in (record as object)))).toBe(true);
  });

  it('excludes the workspace\'s instructions from Claude Code in a child', async () => {
    const svcA = path.join(ws, 'svc-a');

    const result = await run(['pull'], svcA);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('[workspace] Excluded the instructions of the workspace above this repo from Claude Code sessions here');
    const settings = JSON.parse(fs.readFileSync(path.join(svcA, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.claudeMdExcludes).toEqual([
      path.join(ws, 'CLAUDE.md'), path.join(ws, '.claude', 'CLAUDE.md'), path.join(ws, 'AGENTS.md'), path.join(ws, '.claude', 'rules', '**'),
    ]);
  });

  it('shows the children in status, projects list and doctor', async () => {
    const status = await run(['status'], ws);
    expect(status.output).toContain('workspace: 2 children: backend/svc-b, svc-a (1 left out; run `teamai doctor` for why)');
    const projects = await run(['projects', 'list'], ws);
    expect(projects.output).toContain('This workspace also delivers what its children select:');
    expect(projects.output).toContain('  backend/svc-b: svc-b');
    expect(projects.output).toContain('  carol: left out, it uses another team repo (https://git.example.com/other/team.git)');
    const doctor = await run(['doctor'], ws);
    expect(doctor.output).toContain('The workspace reads every child set up under it');
    expect(doctor.output).toContain('carol is left out: it uses another team repo');
  });

  it('recalls the children\'s project learnings, and follows a child that changes its selection before the next pull', async () => {
    const recalledFile = async (word: string): Promise<string | undefined> => {
      const result = await run(['recall', word], ws);
      expect(result.code, result.output).toBe(0);
      return result.output.match(/^File: (.+)$/m)?.[1];
    };
    const pull = await run(['pull'], ws);
    expect(pull.code, pull.output).toBe(0);
    expect(await recalledFile('narwhal')).toContain(path.join('learnings', 'svc-a', 'narwhal.md'));
    expect(await recalledFile('okapi')).toContain(path.join('learnings', 'platform', 'okapi.md'));

    const projects = await run(['projects', 'set', 'svc-a'], path.join(ws, 'svc-a'));
    expect(projects.code, projects.output).toBe(0);

    expect(await recalledFile('okapi')).toBeUndefined();
    expect(await recalledFile('narwhal')).toContain(path.join('learnings', 'svc-a', 'narwhal.md'));
  });

  it('contributes to its own selection by default and to any namespace it reads with --namespace', async () => {
    const note = path.join(sandbox, 'note.md');
    fs.writeFileSync(note, '# Walrus cutover\n\nThe walrus cutover drains the queue before the switch.\n');
    const contribute = (args: string[]): Promise<RunResult> => run(['contribute', '--file', note, ...args], ws);

    const shared = await contribute(['--title', 'walrus-shared']);
    expect(shared.code, shared.output).toBe(0);
    expect(shared.output).toContain('Contributing to learnings/ (shared root). To choose a namespace, pass --namespace <ns>: svc-b, svc-a.');
    expect(shared.output).toMatch(/Contributed: learnings\/walrus-shared-/);

    const child = await contribute(['--title', 'walrus-child', '--namespace', 'svc-b']);
    expect(child.code, child.output).toBe(0);
    expect(child.output).toMatch(/Contributed: learnings\/svc-b\/walrus-child-/);
    const recall = await run(['recall', 'narwhal'], ws);
    expect(recall.output.match(/^File: (.+)$/m)?.[1]).toContain(path.join('learnings', 'svc-a', 'narwhal.md'));

    const own = await run(['projects', 'set', 'platform'], ws);
    expect(own.code, own.output).toBe(0);
    const projects = await run(['projects', 'list'], ws);
    expect(projects.output).toContain('Contributes to: learnings/platform/   --namespace accepts: platform, svc-b, svc-a');
    const owned = await contribute(['--title', 'walrus-own']);
    expect(owned.code, owned.output).toBe(0);
    expect(owned.output).toMatch(/Contributed: learnings\/platform\/walrus-own-/);
    expect(owned.output).not.toContain('To choose a namespace');
  });
});

