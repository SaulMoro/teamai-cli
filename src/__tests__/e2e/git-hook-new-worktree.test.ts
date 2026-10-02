/**
 * E2E: a new worktree gets the team's resources before `git worktree add`
 * returns. `teamai init` (project scope) installs a named hook in the
 * repository's git config; real git runs it on `post-checkout`, and it calls
 * the real CLI's dispatcher, which creates the tool roots and pulls into the
 * new worktree.
 *
 * The team remote is a local bare repo reached through a synthetic HTTPS URL
 * (`url.<path>.insteadOf` in the sandbox HOME), as in init-project-all.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/hook-team.git';
const ZERO_OID = '0'.repeat(40);

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

const configHooks = (() => {
  const m = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' }));
  const [major, minor] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  return major > 2 || (major === 2 && minor >= 54);
})();

interface Run {
  code: number | null;
  output: string;
}

describe.skipIf(!configHooks)('git hook: a new worktree gets the team\'s resources (git worktree add)', () => {
  let sandbox: string;
  let home: string;
  let remote: string;
  let claudeProject: string;

  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', ...extra };
    delete base.CLAUDE_CONFIG_DIR;
    delete base.CODEX_HOME;
    return base;
  };

  const run = (command: string, args: string[], cwd: string, extra: Record<string, string> = {}): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(extra) });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const git = (args: string[], cwd: string, extra: Record<string, string> = {}): Run => run('git', args, cwd, extra);
  const gitOk = (args: string[], cwd: string): string => {
    const r = git(args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
    return r.output.trim();
  };
  const teamai = (args: string[], cwd: string, extra: Record<string, string> = {}): Run => run('node', [CLI, ...args], cwd, extra);

  /** A business repo with one commit, `teamai init`-ed in project scope. */
  const project = (name: string, initArgs: string[]): string => {
    const dir = path.join(sandbox, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), '.teamai/\n');
    gitOk(['init', '-q', '-b', 'main'], dir);
    gitOk(['add', '-A'], dir);
    gitOk(['commit', '-q', '-m', 'project'], dir);
    const init = teamai(['init', FAKE_URL, '--scope', 'project', '--force', ...initArgs], dir);
    if (init.code !== 0) throw new Error(`teamai init failed: ${init.output}`);
    return dir;
  };

  const worktreeAdd = (repo: string, name: string, extra: Record<string, string> = {}): { dir: string } & Run => {
    const dir = path.join(sandbox, name);
    return { dir, ...git(['worktree', 'add', '-q', dir], repo, extra) };
  };

  const delivered = (dir: string) => ({
    skill: fs.existsSync(path.join(dir, '.claude', 'skills', 'team-skill', 'SKILL.md')),
    rule: fs.existsSync(path.join(dir, '.claude', 'rules', 'team-rule.md')),
    mcp: fs.existsSync(path.join(dir, '.mcp.json')) && fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8').includes('team-api'),
  });
  const ALL = { skill: true, rule: true, mcp: true };
  const NOTHING = { skill: false, rule: false, mcp: false };

  /** The project partition (data home) `init` created for the repo at `root`. */
  const partitionOf = (root: string): string => {
    const projectsDir = path.join(home, '.teamai', 'projects');
    const found = fs.readdirSync(projectsDir).map((d) => path.join(projectsDir, d)).find((d) => {
      const config = path.join(d, 'config.yaml');
      return fs.existsSync(config) && fs.readFileSync(config, 'utf8').includes(`projectRoot: ${root}`);
    });
    if (!found) throw new Error(`No project partition for ${root}`);
    return found;
  };

  /** Entries the worktree has beyond what the branch tracks. */
  const untracked = (dir: string) =>
    fs.readdirSync(dir).filter((entry) => entry !== '.git' && entry !== '.gitignore').sort();

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);

    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-hook-e2e-')));
    home = path.join(sandbox, 'home');
    remote = path.join(sandbox, 'team.git');
    const seed = path.join(sandbox, 'seed');
    fs.mkdirSync(home);
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
      fs.writeFileSync(path.join(seed, rel), content);
    };
    write('teamai.yaml', `team: git-hook-e2e\nrepo: ${FAKE_URL}\nprovider: git\nreviewers: []\nsharing:\n  mcp:\n    autoApply: true\n`);
    write('skills/team-skill/SKILL.md', '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n');
    write('rules/team-rule.md', '# Team rule\n');
    write('mcp/mcp.yaml', 'servers:\n  - name: team-api\n    transport: http\n    url: https://team.example.com/mcp\n');
    gitOk(['init', '-q', '-b', 'main'], seed);
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', 'seed'], seed);
    gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
    gitOk(['config', '--global', `url.${remote}.insteadOf`, FAKE_URL], sandbox);

    claudeProject = project('claude-project', ['--agent', 'claude']);
  }, 60_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('init installs one named hook per git event in the repository config', () => {
    expect(gitOk(['hook', 'list', 'post-checkout'], claudeProject)).toBe('teamai-post-checkout');
    expect(gitOk(['hook', 'list', 'post-merge'], claudeProject)).toBe('teamai-post-merge');
  });

  it('delivers skills, rules and MCP for enabledAgents before git worktree add returns, silently', () => {
    const wt = worktreeAdd(claudeProject, 'wt-claude');

    expect(wt.code).toBe(0);
    expect(wt.output).toBe('');
    expect(delivered(wt.dir)).toEqual(ALL);
    expect(fs.existsSync(path.join(wt.dir, '.codex'))).toBe(false);
  });

  it('does the same for a worktree an app creates from a script, without a login PATH or a session', () => {
    // Only git on PATH: teamai is found through the wrapper in ~/.teamai/bin.
    const onlyGit = path.join(sandbox, 'only-git');
    fs.mkdirSync(onlyGit, { recursive: true });
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    if (!fs.existsSync(path.join(onlyGit, 'git'))) fs.symlinkSync(realGit, path.join(onlyGit, 'git'));
    const dir = path.join(sandbox, 'wt-app');
    const script = path.join(sandbox, 'app.sh');
    fs.writeFileSync(script, `#!/bin/sh\ncd "$1" && git worktree add -q "$2"\n`, { mode: 0o755 });

    const r = run('/bin/sh', [script, claudeProject, dir], sandbox, { PATH: `${onlyGit}:/usr/bin:/bin` });

    expect(r.code, r.output).toBe(0);
    expect(r.output).toBe('');
    expect(delivered(dir)).toEqual(ALL);
  });

  it('a branch switch in an existing checkout triggers no sync', () => {
    const wt = worktreeAdd(claudeProject, 'wt-switch');
    expect(delivered(wt.dir)).toEqual(ALL);
    fs.rmSync(path.join(wt.dir, '.claude'), { recursive: true, force: true });

    const r = git(['checkout', '-q', '-b', 'feature-switch'], wt.dir);

    expect(r.code, r.output).toBe(0);
    expect(r.output).toBe('');
    expect(fs.existsSync(path.join(wt.dir, '.claude'))).toBe(false);
  });

  it('runs beside an existing .git/hooks/post-checkout script', () => {
    const marker = path.join(sandbox, 'hooks-dir-ran');
    const hookFile = path.join(claudeProject, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hookFile, `#!/bin/sh\necho "$1" > "${marker}"\n`, { mode: 0o755 });
    try {
      const wt = worktreeAdd(claudeProject, 'wt-hooks-dir');

      expect(wt.code, wt.output).toBe(0);
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe(ZERO_OID);
      expect(delivered(wt.dir)).toEqual(ALL);
    } finally {
      fs.rmSync(hookFile, { force: true });
    }
  });

  it('runs beside a core.hooksPath hook manager', () => {
    const marker = path.join(sandbox, 'hooks-path-ran');
    const managerDir = path.join(sandbox, 'manager-hooks');
    fs.mkdirSync(managerDir, { recursive: true });
    fs.writeFileSync(path.join(managerDir, 'post-checkout'), `#!/bin/sh\necho "$1" > "${marker}"\n`, { mode: 0o755 });
    gitOk(['config', '--local', 'core.hooksPath', managerDir], claudeProject);
    try {
      const wt = worktreeAdd(claudeProject, 'wt-hooks-path');

      expect(wt.code, wt.output).toBe(0);
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe(ZERO_OID);
      expect(delivered(wt.dir)).toEqual(ALL);
    } finally {
      gitOk(['config', '--local', '--unset', 'core.hooksPath'], claudeProject);
    }
  });

  it('prints nothing and exits 0 when the pull fails', () => {
    const away = `${remote}.away`;
    fs.renameSync(remote, away);
    try {
      const wt = worktreeAdd(claudeProject, 'wt-offline');

      expect(wt.code).toBe(0);
      expect(wt.output).toBe('');
      expect(fs.existsSync(path.join(wt.dir, '.gitignore'))).toBe(true);
    } finally {
      fs.renameSync(away, remote);
    }
  });

  it('an unreadable project config means no sync', () => {
    const config = path.join(partitionOf(claudeProject), 'config.yaml');
    const original = fs.readFileSync(config, 'utf8');
    fs.writeFileSync(config, 'repo: [unclosed\n');
    try {
      const wt = worktreeAdd(claudeProject, 'wt-unreadable');

      expect(wt.code).toBe(0);
      expect(wt.output).toBe('');
      expect(fs.existsSync(path.join(wt.dir, '.claude'))).toBe(false);
    } finally {
      fs.writeFileSync(config, original);
    }
  });

  it('a repository without teamai config does nothing with a hook left behind', () => {
    const other = path.join(sandbox, 'no-teamai');
    fs.mkdirSync(other);
    gitOk(['init', '-q', '-b', 'main'], other);
    gitOk(['commit', '-q', '--allow-empty', '-m', 'init'], other);
    gitOk(['config', '--local', 'hook.teamai-post-checkout.command',
      gitOk(['config', '--local', '--get', 'hook.teamai-post-checkout.command'], claudeProject)], other);
    gitOk(['config', '--local', 'hook.teamai-post-checkout.event', 'post-checkout'], other);
    fs.mkdirSync(path.join(other, '.claude'));

    const wt = worktreeAdd(other, 'wt-no-teamai');

    expect(wt.code).toBe(0);
    expect(wt.output).toBe('');
    expect(untracked(wt.dir)).toEqual([]);
  });

  it('a worktree teamai creates under its own data home is left alone', () => {
    const dir = path.join(partitionOf(claudeProject), 'own-worktree');

    const r = git(['worktree', 'add', '-q', '--detach', dir], claudeProject);

    expect(r.code, r.output).toBe(0);
    expect(fs.existsSync(path.join(dir, '.claude'))).toBe(false);
  });

  it('clears the repository Git exports to the hook before running git', () => {
    // A worktree created with the hook off, then the dispatcher run the way git
    // runs it for `git --git-dir=... worktree add`: GIT_DIR names the business
    // repo, and the team clone's pull must not act on it.
    const dir = path.join(sandbox, 'wt-git-dir');
    gitOk(['-c', 'hook.teamai-post-checkout.enabled=false', 'worktree', 'add', '-q', dir], claudeProject);
    expect(delivered(dir)).toEqual(NOTHING);
    const head = gitOk(['rev-parse', 'HEAD'], dir);

    const r = teamai(['hook-dispatch', 'post-checkout', '--tool', 'git', ZERO_OID, head, '1'], dir, {
      GIT_DIR: path.join(claudeProject, '.git'),
      GIT_WORK_TREE: claudeProject,
    });

    expect(r.code).toBe(0);
    expect(r.output).toBe('');
    expect(delivered(dir)).toEqual(ALL);
  });

  it('with no enabledAgents, creates the tool roots the main checkout has, and only those', () => {
    const codexProject = project('codex-project', []);
    fs.mkdirSync(path.join(codexProject, '.codex'));

    const wt = worktreeAdd(codexProject, 'wt-codex');

    expect(wt.code).toBe(0);
    expect(wt.output).toBe('');
    expect(fs.statSync(path.join(wt.dir, '.codex')).isDirectory()).toBe(true);
    expect(untracked(wt.dir).filter((entry) => entry.startsWith('.') && fs.statSync(path.join(wt.dir, entry)).isDirectory()))
      .toEqual(['.codex']);
  });
});
