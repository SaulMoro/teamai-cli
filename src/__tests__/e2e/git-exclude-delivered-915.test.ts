/**
 * E2E (#915 ticket 02): with `sharing.gitExclude.enabled` on, or the member's
 * `gitExcludeEnabled` override in the partition config, a pull keeps the
 * skills the skills handler delivered out of `git status`, through teamai's
 * `delivered` block in the clone's `.git/info/exclude`, while a file the member
 * owns stays visible and addable. The setting takes effect on the next pull,
 * fast path included; off, the next pull removes only that block.
 *
 * The CLI-owned `teamai` skill and source skills are ticket 03's, so the
 * assertions name the team skills only.
 *
 * Each case gets its own HOME, team remote (a local bare repo reached through
 * a synthetic HTTPS URL) and business repo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run { code: number | null; output: string }

let sandbox: string;
/** Keeps a retried case off the directories its first attempt left. */
let attempt = 0;

function env(home: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '0',
  };
  delete base.CLAUDE_CONFIG_DIR;
  delete base.CODEX_HOME;
  return base;
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');

const skillMd = (name: string, body: string): string => `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${body}\n`;
const MY_SKILL = '---\nname: fe-skill\ndescription: my own skill\n---\nMY OWN CONTENT\n';
const TEAM_SKILLS = {
  'skills/fe-skill/SKILL.md': skillMd('fe-skill', 'Team skill.'),
  'skills/other-skill/SKILL.md': skillMd('other-skill', 'Other skill.'),
};
const ON = 'sharing:\n  gitExclude:\n    enabled: true\n';
const OFF = 'sharing:\n  gitExclude:\n    enabled: false\n';

/** One member's machine: a HOME with Claude Code and Codex installed, a team remote, and a business repo. */
interface Machine {
  dir: string;
  home: string;
  /** The team repo's working clone the fixture commits from, and its bare remote. */
  seed: string;
  remote: string;
  run(args: string[]): Run;
  ok(args: string[]): Run;
  git(args: string[], cwd?: string): string;
  /** `git status --porcelain -uall` of the business repo, one entry per line. */
  status(): string[];
  /** Status entries naming a team skill's delivered copy. */
  teamSkillEntries(): string[];
  partitionConfig(): string;
  statePath(): string;
  excludeFile(): string;
  /** Commit `files` to the team remote, as a teammate would. */
  teamCommit(files: Record<string, string>): void;
  setOverride(value: boolean | null): void;
}

function machine(base: string, opts: { team?: string; files?: Record<string, string>; business?: Record<string, string>; init?: boolean } = {}): Machine {
  const name = `${base}-${++attempt}`;
  const home = path.join(sandbox, `${name}-home`);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const run = (command: string, args: string[], cwd: string): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(home), stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const gitOk = (args: string[], cwd: string): string => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
    return r.output;
  };
  const url = `https://git.example.com/team/${name}.git`;
  const seed = path.join(sandbox, `${name}-seed`);
  const remote = path.join(sandbox, `${name}.git`);
  writeFile(path.join(seed, 'teamai.yaml'), [`team: ${name}`, `repo: ${url}`, 'provider: git', 'reviewers: []', opts.team ?? ''].join('\n'));
  for (const [rel, content] of Object.entries(opts.files ?? TEAM_SKILLS)) writeFile(path.join(seed, rel), content);
  gitOk(['init', '-q', '-b', 'main'], seed);
  gitOk(['add', '-A'], seed);
  gitOk(['commit', '-q', '-m', 'seed'], seed);
  gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
  gitOk(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);
  gitOk(['remote', 'add', 'origin', remote], seed);
  gitOk(['fetch', '-q', 'origin'], seed);
  gitOk(['branch', '-q', '--set-upstream-to=origin/main', 'main'], seed);

  const dir = path.join(sandbox, `${name}-biz`);
  writeFile(path.join(dir, 'README.md'), '# app\n');
  gitOk(['init', '-q', '-b', 'main'], dir);
  gitOk(['add', '-A'], dir);
  gitOk(['commit', '-q', '-m', 'app'], dir);
  for (const [rel, content] of Object.entries(opts.business ?? {})) writeFile(path.join(dir, rel), content);
  const realDir = fs.realpathSync.native(dir);

  const teamai = (args: string[]): Run => run(process.execPath, [CLI, ...args], realDir);
  const ok = (args: string[]): Run => {
    const r = teamai(args);
    if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
    return r;
  };
  const partitionDir = (): string => {
    const projects = path.join(home, '.teamai', 'projects');
    const found = fs.readdirSync(projects).map((d) => path.join(projects, d)).filter((d) => fs.existsSync(path.join(d, 'config.yaml')));
    if (found.length !== 1) throw new Error(`expected one partition under ${projects}, found ${found.length}`);
    return found[0];
  };
  const status = (): string[] => gitOk(['status', '--porcelain', '-uall'], realDir).split('\n').filter(Boolean);
  const m: Machine = {
    dir: realDir,
    home,
    seed,
    remote,
    run: teamai,
    ok,
    git: (args, cwd = realDir) => gitOk(args, cwd),
    status,
    teamSkillEntries: () => status().filter((line) => /\/(fe-skill|other-skill)\//.test(line)),
    partitionConfig: () => path.join(partitionDir(), 'config.yaml'),
    statePath: () => path.join(partitionDir(), 'state.json'),
    excludeFile: () => path.join(realDir, '.git', 'info', 'exclude'),
    teamCommit: (files) => {
      for (const [rel, content] of Object.entries(files)) writeFile(path.join(seed, rel), content);
      gitOk(['add', '-A'], seed);
      gitOk(['commit', '-q', '-m', 'team change'], seed);
      gitOk(['push', '-q', 'origin', 'main'], seed);
    },
    setOverride: (value) => {
      const config = m.partitionConfig();
      const lines = read(config).split('\n').filter((line) => !line.startsWith('gitExcludeEnabled:'));
      if (value !== null) lines.splice(lines.length - 1, 0, `gitExcludeEnabled: ${value}`);
      fs.writeFileSync(config, lines.join('\n'));
    },
  };
  if (opts.init !== false) ok(['init', url, '--provider', 'git', '--agent', 'claude,codex', '--scope', 'project', '--force']);
  return m;
}

/** Drop `gitExcludePaths` from every checkout record, as state an older CLI saved holds none. */
function asOlderCliState(statePath: string): void {
  const state = JSON.parse(read(statePath)) as { lastPullByWorkspace?: Record<string, Record<string, unknown>> };
  for (const record of Object.values(state.lastPullByWorkspace ?? {})) delete record.gitExcludePaths;
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

describe('delivered team skills stay out of git (#915)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-exclude-e2e-')));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('with the team setting on, keeps every delivered team skill out of git status, and a member\'s own skill of a team skill\'s name visible and addable', () => {
    const m = machine('team-on', { team: ON, business: { '.claude/skills/fe-skill/SKILL.md': MY_SKILL, 'notes.md': 'mine\n' } });
    expect(fs.existsSync(path.join(m.dir, '.claude', 'skills', 'other-skill', 'SKILL.md'))).toBe(true);

    for (const step of ['init', 'pull']) {
      if (step === 'pull') m.ok(['pull']);
      expect(m.teamSkillEntries(), step).toEqual(['?? .claude/skills/fe-skill/SKILL.md']);
      expect(m.status(), step).toContain('?? notes.md');
    }
    expect(read(path.join(m.dir, '.claude', 'skills', 'fe-skill', 'SKILL.md'))).toBe(MY_SKILL);
    m.git(['add', '-A']);
    const staged = m.git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    expect(staged).toEqual(expect.arrayContaining(['.claude/skills/fe-skill/SKILL.md', 'notes.md']));
    expect(staged.filter((f) => f.includes('other-skill') || /(codex|agents)\/skills\/fe-skill/.test(f))).toEqual([]);
  });

  it('applies the member override on the next pull, fast path included, and off removes only teamai\'s delivered block', () => {
    const m = machine('override');
    const visible = m.teamSkillEntries();
    expect(visible).toEqual(expect.arrayContaining(['?? .claude/skills/fe-skill/SKILL.md', '?? .claude/skills/other-skill/SKILL.md']));
    // Another owner's block, which pull itself never writes here.
    const members = ['mine.log', '# [teamai:local-agent:start]', '/other.md', '# [teamai:local-agent:end]', ''].join('\n');
    writeFile(m.excludeFile(), members);

    m.setOverride(true);
    const on = m.ok(['pull']);
    expect(on.output).toContain('Already synced');
    expect(m.teamSkillEntries(), on.output).toEqual([]);
    expect(read(m.excludeFile())).toContain('# [teamai:delivered:start]');

    m.setOverride(false);
    const off = m.ok(['pull']);
    expect(off.output).toContain('Already synced');
    expect(m.teamSkillEntries()).toEqual(visible);
    expect(read(m.excludeFile())).toBe(members);
  });

  it('applies a team commit that changes only sharing.gitExclude.enabled on that pull, and a later override over it', () => {
    const m = machine('team-commit', { team: OFF });
    expect(m.teamSkillEntries()).not.toEqual([]);

    m.teamCommit({ 'teamai.yaml': read(path.join(m.seed, 'teamai.yaml')).replace(OFF, ON) });
    const pulled = m.ok(['pull']);
    expect(m.teamSkillEntries(), pulled.output).toEqual([]);

    m.setOverride(false);
    m.ok(['pull']);
    expect(m.teamSkillEntries()).not.toEqual([]);
  });

  it.each([['off', OFF], ['on', ON]])('runs a full sync on the first pull after an older CLI saved the state, with the setting %s', (_label, team) => {
    const m = machine(`upgrade-${_label}`, { team });
    expect(m.ok(['pull']).output).toContain('Already synced');

    asOlderCliState(m.statePath());
    const first = m.ok(['pull']);
    expect(first.output).not.toContain('Already synced');
    expect(first.output).toMatch(/Synced/);
    expect(m.ok(['pull']).output).toContain('Already synced');
    expect(m.teamSkillEntries().length === 0).toBe(team === ON);
  });

  it('keeps the lines when the fast path holds an agent for its model and resets the checkout for a full sync', () => {
    const m = machine('held-agent', {
      team: ON,
      files: {
        ...TEAM_SKILLS,
        'models/aliases.yaml': 'aliases:\n  strong:\n    claude: { model: opus }\n    codex: { model: gpt-6-sol }\n',
        'agents/implementer.yaml': 'name: implementer\ndescription: Implements a change\ninstructions: Make the change.\nmodel: strong\n',
      },
    });
    expect(m.teamSkillEntries()).toEqual([]);
    writeFile(path.join(m.home, '.teamai', 'models', 'aliases.yaml'), 'aliases: [broken\n');

    const held = m.ok(['pull']);
    expect(held.output).toContain('Already synced');
    expect(held.output).toContain('Held implementer');
    expect(m.teamSkillEntries(), held.output).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('keeps a copy\'s line when the full sync that should rewrite it fails', () => {
    const m = machine('failed-writer', { team: ON });
    // The copy is rewritten in place: a directory that refuses new entries fails it.
    const copy = path.join(m.dir, '.claude', 'skills', 'fe-skill');
    expect(m.teamSkillEntries()).toEqual([]);
    fs.chmodSync(copy, 0o555);
    try {
      const pulled = m.ok(['pull', '--force']);
      expect(pulled.output).toContain('Failed to sync skill fe-skill to claude');
      expect(m.teamSkillEntries(), pulled.output).toEqual([]);
    } finally {
      fs.chmodSync(copy, 0o755);
    }
  });

  it('skips the sync while another process holds the scope\'s sync lock, and the next pull applies it', () => {
    const m = machine('contended');
    m.setOverride(true);
    const lock = path.join(path.dirname(m.partitionConfig()), '.sync-lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'e2e-holder' }));
    try {
      const skipped = m.ok(['pull']);
      expect(skipped.output).toContain('sync in progress elsewhere');
      expect(m.teamSkillEntries()).not.toEqual([]);
    } finally {
      fs.rmSync(lock, { force: true });
    }
    m.ok(['pull']);
    expect(m.teamSkillEntries()).toEqual([]);
  });

  it('in single-repo mode, applies an uncommitted edit of .teamai/teamai.yaml on the next pull', () => {
    const name = `self-${++attempt}`;
    const home = path.join(sandbox, `${name}-home`);
    const remote = path.join(sandbox, `${name}.git`);
    const projectRoot = path.join(sandbox, name);
    const knowledge = path.join(projectRoot, '.teamai');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const run = (command: string, args: string[]): Run => {
      const r = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', env: env(home), stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    };
    const gitOk = (...args: string[]): string => {
      const r = run('git', args);
      if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
      return r.output;
    };
    const teamYaml = ['team: self-e2e', 'mode: self', 'repo: https://git.example.com/team/self.git', 'provider: git', ''].join('\n');
    writeFile(path.join(knowledge, 'teamai.yaml'), teamYaml);
    writeFile(path.join(knowledge, '.gitignore'), 'config.yaml\nstate.json\n');
    for (const [rel, content] of Object.entries(TEAM_SKILLS)) writeFile(path.join(knowledge, rel), content);
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: env(home) });
    gitOk('init', '-q', '-b', 'main');
    gitOk('add', '-A');
    gitOk('commit', '-q', '-m', 'project');
    gitOk('remote', 'add', 'origin', remote);
    gitOk('push', '-q', '-u', 'origin', 'main');
    // The machine config an install leaves in the checkout; the first pull moves it into the partition.
    writeFile(path.join(knowledge, 'config.yaml'), [
      'repo:', `  localPath: ${knowledge}`, `  remote: ${remote}`, '  kind: self', `  businessRepoRoot: ${projectRoot}`,
      'username: ci-915', 'updatePolicy: auto', 'scope: project', `projectRoot: ${projectRoot}`, 'enabledAgents: [claude]', '',
    ].join('\n'));
    // Claude Code in this project: its root, as a session there creates it.
    fs.mkdirSync(path.join(projectRoot, '.claude'));
    const pull = (): Run => {
      const r = run(process.execPath, [CLI, 'pull']);
      if (r.code !== 0) throw new Error(`teamai pull failed: ${r.output}`);
      return r;
    };
    const skillEntries = (): string[] => gitOk('status', '--porcelain', '-uall').split('\n').filter((line) => /\.claude\/skills\/(fe-skill|other-skill)\//.test(line));

    const first = pull();
    expect(skillEntries(), first.output).toEqual(['?? .claude/skills/fe-skill/SKILL.md', '?? .claude/skills/other-skill/SKILL.md']);

    fs.writeFileSync(path.join(knowledge, 'teamai.yaml'), `${teamYaml}${ON}`);
    const on = pull();
    expect(skillEntries(), on.output).toEqual([]);
    expect(gitOk('status', '--porcelain', '-uall')).toContain(' M .teamai/teamai.yaml');

    fs.writeFileSync(path.join(knowledge, 'teamai.yaml'), teamYaml);
    pull();
    expect(skillEntries()).toHaveLength(2);
  });

  it('writes the setting on into a new team\'s teamai.yaml, and never into an existing one\'s', () => {
    const m = machine('existing', { team: '' });
    expect(m.git(['show', 'HEAD:teamai.yaml'], m.remote)).not.toContain('gitExclude');

    const name = `new-team-${++attempt}`;
    const remote = path.join(sandbox, `${name}.git`);
    const url = `https://git.example.com/team/${name}.git`;
    m.git(['init', '-q', '--bare', '-b', 'main', remote], sandbox);
    m.git(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);
    const project = path.join(sandbox, `${name}-biz`);
    writeFile(path.join(project, 'README.md'), '# app\n');
    m.git(['init', '-q', '-b', 'main'], project);
    m.git(['add', '-A'], project);
    m.git(['commit', '-q', '-m', 'app'], project);
    const created = spawnSync(process.execPath, [CLI, 'init', url, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--force'], {
      cwd: project, encoding: 'utf8', env: env(m.home), stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(created.status, `${created.stdout}${created.stderr}`).toBe(0);
    expect(m.git(['show', 'HEAD:teamai.yaml'], remote)).toMatch(/gitExclude:\n\s+enabled: true/);
  });
});
