/**
 * E2E (#823, items 2 and 3): push must not offer a teammate's update back as
 * the member's older copy.
 *
 * Item 2: in single-repo mode push runs against a knowledge worktree whose
 * team root is `<wt>/.teamai`, a subdirectory of the git repo. The pre-push
 * sync read each base version with a path relative to that subdirectory, which
 * `git show <rev>:<path>` resolves from the repo root, so it never found one:
 * every rule a teammate updated read as a local edit.
 *
 * Item 3: an agent this machine placed with --role/--project was compared with
 * the project's shared lastPullRev, which a pull in another checkout moves past
 * a copy a stale worktree still holds unedited (the #812 revert, for agents).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../../utils/partition.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

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

function runCLI(args: string[], cwd: string, home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

function requireCli(): void {
  if (!fs.existsSync(CLI)) {
    throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  }
}

describe('pre-push sync in single-repo mode (#823 item 2)', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let teammate: string;

  const R1 = '# Team rule\n\nVersion one.\n';
  const R2 = '# Team rule\n\nVersion two, from a teammate.\n';
  const localRule = () => path.join(projectRoot, '.claude', 'rules', 'team-rule.md');

  beforeEach(() => {
    requireCli();
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue823-self-e2e-')));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    teammate = path.join(sandbox, 'teammate');
    const remote = path.join(sandbox, 'project-remote.git');

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.teamai', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), '{}\n');
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.claude/skills/\n.claude/rules/\n.claude/agents/\n');
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'teamai.yaml'), [
      'team: issue-823-self-e2e',
      'repo: https://github.com/acme/project.git',
      'provider: github',
      'mode: self',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'rules', 'team-rule.md'), R1);
    git(['init', '-q', '-b', 'main'], projectRoot);
    git(['add', '-A'], projectRoot);
    git(['commit', '-q', '-m', 'project'], projectRoot);
    git(['clone', '-q', '--bare', projectRoot, remote], sandbox);
    git(['remote', 'add', 'origin', remote], projectRoot);
    git(['fetch', '-q', 'origin'], projectRoot);
    git(['clone', '-q', remote, teammate], sandbox);

    const partition = path.join(home, '.teamai', 'projects', projectSlug(projectRoot));
    fs.mkdirSync(partition, { recursive: true });
    fs.writeFileSync(path.join(partition, 'anchor'), `${projectRoot}\n`);
    fs.writeFileSync(path.join(partition, 'config.yaml'), [
      'repo:',
      '  kind: self',
      `  localPath: ${path.join(projectRoot, '.teamai')}`,
      "  remote: ''",
      `  businessRepoRoot: ${projectRoot}`,
      'username: ci-823-self',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      'enabledAgents: [claude]',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const run = async (args: string[]): Promise<string> => {
    const r = await runCLI(args, projectRoot, home);
    expect(r.code, r.output).toBe(0);
    return r.output;
  };

  it('syncs a teammate\'s update to .teamai/rules instead of listing the old copy as modified', async () => {
    await run(['pull']);
    expect(fs.readFileSync(localRule(), 'utf8')).toBe(R1);

    // A teammate lands R2 on the default branch. The member's branch takes it
    // with git, but `teamai pull` has not run, so .claude/rules still has R1.
    fs.writeFileSync(path.join(teammate, '.teamai', 'rules', 'team-rule.md'), R2);
    git(['commit', '-q', '-am', 'rule R2'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
    git(['fetch', '-q', 'origin'], projectRoot);
    git(['merge', '-q', '--ff-only', 'origin/main'], projectRoot);

    const push = await run(['--dry-run', 'push']);
    expect(push).not.toContain('team-rule (modified)');
    expect(fs.readFileSync(localRule(), 'utf8'), push).toBe(R2);
  });

  it('still lists a genuine local edit as modified', async () => {
    await run(['pull']);
    fs.writeFileSync(localRule(), `${R1}\nA local edit.\n`);

    const push = await run(['--dry-run', 'push']);
    expect(push).toContain('[rules] team-rule (modified)');
  });
});

describe('placed agent in a stale linked worktree (#823 item 3)', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let worktree: string;
  let remote: string;
  let teamRepo: string;

  const A1 = '---\nname: vr\ndescription: reviews code\n---\n\nYou review.\n';
  const agentIn = (root: string) => path.join(root, '.claude', 'agents', 'vr.md');

  /** Commit on the remote's default branch through a throwaway clone, as a teammate or a merged PR does. */
  const onMain = (change: (clone: string) => void): void => {
    const clone = fs.mkdtempSync(path.join(sandbox, 'mate-'));
    git(['clone', '-q', remote, clone], sandbox);
    change(clone);
    git(['push', '-q', 'origin', 'main'], clone);
    fs.rmSync(clone, { recursive: true, force: true });
  };

  beforeEach(() => {
    requireCli();
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue823-agent-e2e-')));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    worktree = path.join(sandbox, 'wt-b');
    remote = path.join(sandbox, 'team-remote.git');
    teamRepo = path.join(projectRoot, '.teamai', 'team-repo');
    const seed = path.join(sandbox, 'seed');

    fs.mkdirSync(home, { recursive: true });
    for (const dir of ['skills', 'rules', 'agents']) {
      fs.mkdirSync(path.join(seed, dir), { recursive: true });
      fs.writeFileSync(path.join(seed, dir, '.gitkeep'), '');
    }
    fs.mkdirSync(path.join(seed, 'manifest'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), [
      'version: 1',
      'projects:',
      '  - id: front-app',
      '    name: Front App',
      '    description: Front end',
      '    resources:',
      '      knowledge: [fe-know]',
      '      skills: [fe-skills]',
      '      learnings: []',
      '      agents: [fe-agents]',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: issue-823-agent-e2e',
      'repo: https://example.com/team.git',
      'provider: tgit',
      '',
    ].join('\n'));
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);

    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), '{}\n');
    fs.writeFileSync(
      path.join(projectRoot, '.gitignore'),
      '.teamai/\n.claude/skills/\n.claude/rules/\n.claude/agents/\n',
    );
    git(['init', '-q', '-b', 'main'], projectRoot);
    git(['add', '-A'], projectRoot);
    git(['commit', '-q', '-m', 'project'], projectRoot);

    fs.mkdirSync(path.join(projectRoot, '.teamai'), { recursive: true });
    git(['clone', '-q', remote, teamRepo], sandbox);
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      'username: ci-823',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      'enabledAgents: [claude]',
      '',
    ].join('\n'));
    fs.mkdirSync(path.dirname(agentIn(projectRoot)), { recursive: true });
    fs.writeFileSync(agentIn(projectRoot), A1);
  });

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const run = async (args: string[], cwd: string): Promise<string> => {
    const r = await runCLI(args, cwd, home);
    expect(r.code, r.output).toBe(0);
    return r.output;
  };

  /**
   * The author publishes the agent into front-app's namespace, never activated
   * here, and the PR merges. A local bare remote has no PR API, so the push
   * exits 1 after pushing the branch.
   */
  const placeAndMerge = async (): Promise<void> => {
    const published = await runCLI(['push', '--project', 'front-app', '--all'], projectRoot, home);
    expect(published.output).toContain('[agents] vr → agents/fe-agents/vr.yaml');
    const branch = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/'], remote)
      .split('\n').filter(Boolean).at(-1) ?? '';
    expect(branch).not.toBe('');
    onMain((clone) => {
      git(['merge', '--no-edit', '-q', `origin/${branch}`], clone);
      git(['push', '-q', 'origin', '--delete', branch], clone);
    });
  };
  const teammateRewrites = (): void => onMain((clone) => {
    const file = path.join(clone, 'agents', 'fe-agents', 'vr.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('You review.', 'A teammate rewrote this.'));
    git(['commit', '-q', '-am', 'teammate: rewrite vr'], clone);
  });
  const HELD = 'changed on the team since this checkout last synced it';

  it('holds a placed agent a teammate changed that only another checkout has pulled', async () => {
    await placeAndMerge();

    // Both checkouts pull it; the worktree gets the agent from the record.
    await run(['pull'], projectRoot);
    git(['worktree', 'add', '-q', worktree, '-b', 'wt-b'], projectRoot);
    await run(['pull'], worktree);
    const pulled = fs.readFileSync(agentIn(worktree), 'utf8');
    expect(pulled).toContain('You review.');

    // A teammate rewrites it, and only the main checkout pulls the rewrite.
    teammateRewrites();
    await run(['pull'], projectRoot);

    const push = await run(['--dry-run', 'push'], worktree);
    expect(push).toContain(HELD);
    expect(fs.readFileSync(agentIn(worktree), 'utf8')).toBe(pulled);
  }, 60_000);

  it('holds a placed agent a teammate changed after it landed, before this checkout pulled', async () => {
    // The checkout's last pull predates the placement, so no pull revision has
    // the file. Push records the team HEAD as a base before the scan, and the
    // file there is the teammate's version, so only the version it was added
    // with shows the author's copy is stale.
    await run(['pull'], projectRoot);
    await placeAndMerge();
    teammateRewrites();

    const push = await run(['--dry-run', 'push'], projectRoot);
    expect(push).toContain(HELD);
    expect(fs.readFileSync(agentIn(projectRoot), 'utf8')).toBe(A1);
  }, 60_000);
});
