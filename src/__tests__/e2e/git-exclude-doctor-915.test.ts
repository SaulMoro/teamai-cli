/**
 * E2E (#915): members can see and trust teamai's delivered git exclude blocks.
 *
 * - `doctor` names where `sharing.gitExclude` comes from. Off, it says how many
 *   delivered resources git sees and how to turn the setting on, and a pull
 *   never says it. On, it fails for a delivered path that is not listed or
 *   that git still sees (naming the rule that re-includes it), a damaged
 *   block, another checkout's own file at a delivered path, and the last
 *   failure of a background pull; the same failures follow an interactive
 *   pull. Paths git tracks and stale lines are information, never failures.
 *   Its git calls are batched: one `ls-files --others` per exclude file, then
 *   `check-ignore -v` only for the paths git still offers.
 * - `pull --dry-run` says what each block would list and drop, which the real
 *   pull then does, and writes nothing: no exclude file, no `info/`, no lock.
 * - A background pull (session start, git hooks) keeps its failure and its
 *   notices for the next interactive pull and `doctor`; the failure goes with
 *   the next sync that succeeds, a notice once a pull has said it.
 *
 * Each case gets its own HOME, team remote (a local bare repo reached through
 * a synthetic HTTPS URL) and business repo. Fixture git calls that fire
 * teamai's git hooks run with the member's HOME.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';

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
let detached: ReturnType<typeof trackDetachedProcesses>;

const write = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const read = (file: string): string => fs.readFileSync(file, 'utf8');
const skillMd = (name: string): string => `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${name} body.\n`;
const rule = (title: string): string => `# ${title}\n\n${title} rule.\n`;

/** Two roles, so two checkouts' lists can differ. */
const TEAM = {
  'manifest/roles.yaml': [
    'version: 1', 'roles:',
    '  - id: fe', '    resources:', '      knowledge: [fe]', '      skills: [fe]',
    '  - id: be', '    resources:', '      knowledge: [be]', '      skills: [be]', '',
  ].join('\n'),
  'skills/fe/fe-skill/SKILL.md': skillMd('fe-skill'),
  'skills/be/be-skill/SKILL.md': skillMd('be-skill'),
  'rules/team-rule.md': rule('Team'),
};
const ON = 'sharing:\n  gitExclude:\n    enabled: true\n';

interface Member {
  home: string;
  run(command: string, args: string[], cwd: string, extraEnv?: NodeJS.ProcessEnv): Run;
  git(args: string[], cwd: string): string;
  teamai(args: string[], cwd: string, extraEnv?: NodeJS.ProcessEnv): string;
  teamCommit(files: Record<string, string | null>): void;
  /** A committed business repo at `dir`, set up with teamai in project scope (role fe). */
  project(dir: string, opts?: { before?: (dir: string) => void }): string;
  /** `git worktree add` (its post-checkout hook pulls there), then an explicit pull. */
  worktree(repo: string, dir: string): Promise<string>;
  /** A Claude Code session starting in `dir`, with the pass it leaves behind joined. */
  sessionStart(dir: string): Promise<Run>;
  partitionConfig(): string;
}

function member(name: string, sharing = ON): Member {
  const base = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = {
      ...process.env,
      ...GIT_ENV,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      FORCE_COLOR: '0',
      ...extra,
    };
    delete e.CLAUDE_CONFIG_DIR;
    delete e.CODEX_HOME;
    e.NODE_OPTIONS = [e.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' ');
    return e;
  };
  const run = (command: string, args: string[], cwd: string, extraEnv?: NodeJS.ProcessEnv, input?: string): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(extraEnv), ...input === undefined ? {} : { input } });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const git = (args: string[], cwd: string): string => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.output}`);
    return r.output;
  };
  const teamai = (args: string[], cwd: string, extraEnv?: NodeJS.ProcessEnv): string => {
    const r = run(process.execPath, [CLI, ...args], cwd, extraEnv);
    // doctor exits 1 when a check fails; its output is what the case reads.
    if (r.code !== 0 && args[0] !== 'doctor') throw new Error(`teamai ${args.join(' ')} failed in ${cwd}: ${r.output}`);
    return r.output;
  };
  const url = `https://git.example.com/team/${path.basename(base)}.git`;
  const seed = path.join(base, 'seed');
  const remote = path.join(base, 'team.git');
  write(path.join(seed, 'teamai.yaml'), [`team: ${path.basename(base)}`, `repo: ${url}`, 'provider: git', 'reviewers: []', sharing].join('\n'));
  for (const [rel, content] of Object.entries(TEAM)) write(path.join(seed, rel), content);
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  git(['clone', '-q', '--bare', seed, remote], base);
  git(['config', '--global', `url.${remote}.insteadOf`, url], base);
  git(['remote', 'add', 'origin', remote], seed);

  return {
    home,
    run,
    git,
    teamai,
    teamCommit: (changes) => {
      for (const [rel, content] of Object.entries(changes)) {
        if (content === null) fs.rmSync(path.join(seed, rel), { force: true });
        else write(path.join(seed, rel), content);
      }
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', 'team change'], seed);
      git(['push', '-q', 'origin', 'main'], seed);
    },
    project: (dir, opts = {}) => {
      write(path.join(dir, 'README.md'), '# app\n');
      git(['init', '-q', '-b', 'main'], dir);
      opts.before?.(dir);
      git(['add', '-A'], dir);
      git(['commit', '-q', '-m', 'app'], dir);
      const real = fs.realpathSync.native(dir);
      teamai(['init', url, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--role', 'fe', '--force'], real);
      return real;
    },
    worktree: async (repo, dir) => {
      git(['worktree', 'add', '-q', dir, '-b', path.basename(dir)], repo);
      await detached.waitForExit();
      const real = fs.realpathSync.native(dir);
      teamai(['pull'], real);
      await detached.waitForExit();
      return real;
    },
    sessionStart: async (dir) => {
      const r = run(process.execPath, [CLI, 'hook-dispatch', 'session-start', '--tool', 'claude'], dir, undefined,
        JSON.stringify({ cwd: dir, session_id: `${path.basename(base)}-session`, hook_event_name: 'SessionStart', source: 'startup' }));
      await detached.waitForExit();
      return r;
    },
    partitionConfig: () => {
      const projects = path.join(home, '.teamai', 'projects');
      const found = fs.readdirSync(projects).map((d) => path.join(projects, d, 'config.yaml')).filter((f) => fs.existsSync(f));
      if (found.length !== 1) throw new Error(`expected one partition under ${projects}, found ${found.length}`);
      return found[0];
    },
  };
}

const caseDir = (name: string): string => fs.mkdtempSync(path.join(sandbox, `${name}-`));

const excludeFileOf = (m: Member, dir: string): string =>
  path.resolve(dir, m.git(['rev-parse', '--git-path', 'info/exclude'], dir).trim());

function blockLines(file: string): string[] {
  const lines = fs.existsSync(file) ? read(file).split('\n') : [];
  const start = lines.indexOf('# [teamai:delivered:start]');
  const end = lines.indexOf('# [teamai:delivered:end]');
  return start < 0 || end < start ? [] : lines.slice(start + 1, end);
}

const status = (m: Member, dir: string): string[] =>
  m.git(['status', '--porcelain', '-uall'], dir).split('\n').filter(Boolean);

function setOverride(m: Member, value: boolean): void {
  const config = m.partitionConfig();
  const lines = read(config).split('\n').filter((line) => !line.startsWith('gitExcludeEnabled:'));
  lines.splice(lines.length - 1, 0, `gitExcludeEnabled: ${value}`);
  fs.writeFileSync(config, lines.join('\n'));
}

/** Hold the exclude file's lock as another live teamai process would. */
function holdLock(excludeFile: string): () => void {
  const lock = `${excludeFile}.teamai-lock`;
  write(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'e2e' }));
  return () => fs.rmSync(lock, { force: true });
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-exclude-doctor-e2e-')));
  detached = trackDetachedProcesses(sandbox);
});

afterAll(async () => {
  if (detached) await detached.waitForExit();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
}, 65_000);

// The hook scripts and the git wrapper are POSIX shell.
describe.skipIf(process.platform === 'win32')('doctor, pull --dry-run and background pulls show what the delivered git exclude blocks do (#915)', () => {
  it('with the setting off, only doctor says what git sees and names both switches; turned on, doctor checks the blocks', () => {
    const m = member('off', '');
    const app = m.project(path.join(caseDir('off'), 'app'));

    const off = m.teamai(['doctor'], app);
    expect(off).toContain('Git exclude for delivered team resources: off, from the default.');
    const visible = /Delivered team resources are visible to git: (\d+) untracked \(first 5: ([^)]*)\)\./.exec(off);
    expect(visible, off).not.toBeNull();
    expect(Number(visible![1])).toBeGreaterThanOrEqual(3);
    const untracked = status(m, app);
    for (const shown of visible![2].split(', ')) expect(untracked.some((entry) => entry.startsWith(`?? ${shown}`)), `${shown} in ${untracked.join('|')}`).toBe(true);
    expect(off).toContain(`set \`sharing.gitExclude.enabled: true\` in teamai.yaml (the whole team) or \`gitExcludeEnabled: true\` in ${m.partitionConfig()} (only you)`);
    expect(off).not.toContain('Delivered team resources are kept out of git');
    expect(m.teamai(['pull', '--force'], app)).not.toContain('visible to git');

    setOverride(m, true);
    const before = m.teamai(['doctor'], app);
    expect(before).toContain(`Git exclude for delivered team resources: on, from gitExcludeEnabled: true in ${m.partitionConfig()}.`);
    expect(before).toContain('✖ Delivered team resources are kept out of git');
    expect(before).toContain(`Not listed in ${excludeFileOf(m, app)}: `);
    m.teamai(['pull'], app);
    const after = m.teamai(['doctor'], app);
    expect(after).toContain('✔ Delivered team resources are kept out of git');
    expect(after).toContain('✔ No other checkout\'s own file leaves a delivered path visible to git');
    expect(after).not.toContain('visible to git: ');
  }, 120_000);

  it('fails for a path git still sees, a missing line and a damaged block, after a pull too, and only notes tracked paths and stale lines', () => {
    const m = member('on');
    const app = m.project(path.join(caseDir('on'), 'app'), { before: (dir) => write(path.join(dir, '.claude/skills/fe-skill/SKILL.md'), skillMd('fe-skill')) });
    const exclude = excludeFileOf(m, app);
    expect(blockLines(exclude)).toEqual(expect.arrayContaining(['/.claude/rules/team-rule.md', '/.claude/skills/fe-skill/', '/.claude/skills/teamai/']));

    const healthy = m.teamai(['doctor'], app);
    expect(healthy).toContain('Git exclude for delivered team resources: on, from sharing.gitExclude.enabled: true in the team\'s teamai.yaml.');
    expect(healthy).toContain('✔ Delivered team resources are kept out of git');
    expect(healthy).toContain(`.claude/skills/fe-skill is delivered by teamai, but git tracks .claude/skills/fe-skill/SKILL.md in it in ${app}, so their changes stay visible. `
      + 'Run `git rm -r --cached .claude/skills/fe-skill` there and commit if the repository should not hold it.');

    write(path.join(app, '.gitignore'), '!/.claude/rules/team-rule.md\n');
    const content = read(exclude);
    write(exclude, `${content.replace('/.claude/skills/teamai/\n', '').replace('# [teamai:delivered:end]\n', '/gone.md\n# [teamai:delivered:end]\n')}# [teamai:delivered:end]\n`);
    const endLine = read(exclude).split('\n').length - 1;

    const broken = m.teamai(['doctor'], app);
    expect(broken).toContain('✖ Delivered team resources are kept out of git');
    expect(broken).toContain(`Not listed in ${exclude}: .claude/skills/teamai. Run \`teamai pull\` to list them.`);
    expect(broken).toContain(`git still sees .claude/rules/team-rule.md: \`!/.claude/rules/team-rule.md\` (${path.join(app, '.gitignore')}:1) re-includes it. Remove that rule.`);
    expect(broken).toContain(`${exclude} line ${endLine} ends teamai's block with no start marker: delete it, then run \`teamai pull\`.`);
    expect(broken).toContain(`Stale lines in teamai's delivered git exclude block in ${exclude}: /gone.md. The next \`teamai pull\` drops them.`);

    // The pull lists the path again and drops the stale line; the rule and the stray marker are the member's to fix.
    // The pull says the re-included path itself, as a failed sync, so the post-pull check does not repeat it.
    const pulled = m.teamai(['pull'], app);
    expect(pulled.split('git still sees .claude/rules/team-rule.md: ')).toHaveLength(2);
    expect(pulled).toContain('re-includes it');
    expect(pulled).not.toContain('Stale lines');
    expect(pulled).not.toContain('Git exclude for delivered team resources:');
    expect(blockLines(exclude)).toContain('/.claude/skills/teamai/');
    expect(blockLines(exclude)).not.toContain('/gone.md');
    expect(status(m, app)).toEqual(['?? .claude/rules/team-rule.md', '?? .gitignore']);
  }, 120_000);

  it('asks git once per exclude file for what it still offers, and check-ignore only for those paths, however many paths it checks', () => {
    const m = member('batched');
    const app = m.project(path.join(caseDir('batched'), 'app'));
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = fs.mkdtempSync(path.join(sandbox, 'git-wrapper-'));
    const log = path.join(bin, 'calls.log');
    write(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    const counted = (): string[] => {
      fs.rmSync(log, { force: true });
      m.teamai(['doctor'], app, { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` });
      return read(log).split('\n').filter(Boolean);
    };
    const offered = (calls: string[]): string[] => calls.filter((c) => c.startsWith('--literal-pathspecs ls-files -z --others --exclude-standard '));
    const located = (calls: string[]): string[] => calls.filter((c) => c.startsWith('rev-parse --show-toplevel --show-prefix --git-path info/exclude'));

    const few = counted();
    expect(offered(few)).toHaveLength(1);
    expect(few.filter((c) => c.startsWith('check-ignore -v'))).toEqual([]);

    // More paths, in a directory doctor did not see before (the fe role's rules).
    m.teamCommit(Object.fromEntries(['api', 'ui', 'db'].flatMap((name) => [
      [`rules/fe/${name}.md`, rule(name)], [`rules/${name}-root.md`, rule(`${name} root`)], [`skills/fe/${name}-skill/SKILL.md`, skillMd(`${name}-skill`)],
    ])));
    m.teamai(['pull'], app);
    expect(fs.existsSync(path.join(app, '.claude/rules/fe/api.md'))).toBe(true);
    write(path.join(app, '.gitignore'), '!/.claude/rules/fe/api.md\n');
    const many = counted();
    expect(offered(many)).toHaveLength(1);
    expect(many.filter((c) => c.startsWith('check-ignore -v'))).toEqual(['check-ignore -v -- api.md']);
    expect(located(many)).toHaveLength(located(few).length);
  }, 120_000);

  it('pull --dry-run says what each block would list and drop, which the pull then does, and writes nothing', () => {
    const m = member('dry-run');
    const app = m.project(path.join(caseDir('dry-run'), 'app'));
    const exclude = excludeFileOf(m, app);
    m.teamCommit({ 'rules/team-rule.md': null, 'rules/new-rule.md': rule('New'), 'rules/other-rule.md': rule('Other'), 'skills/fe/new-skill/SKILL.md': skillMd('new-skill') });
    const before = read(exclude);

    const preview = m.teamai(['pull', '--dry-run'], app);
    const line = new RegExp(`\\[dry-run\\] Would list (\\d+) path\\(s\\) and drop (\\d+) in teamai's delivered git exclude block in ${exclude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(preview);
    expect(line, preview).not.toBeNull();
    expect(read(exclude)).toBe(before);
    expect(fs.readdirSync(path.dirname(exclude)).filter((f) => f.endsWith('.teamai-lock'))).toEqual([]);

    const listedBefore = blockLines(exclude);
    m.teamai(['pull'], app);
    const listedAfter = blockLines(exclude);
    expect(listedAfter).toHaveLength(Number(line![1]));
    expect(listedBefore.filter((l) => !listedAfter.includes(l))).toHaveLength(Number(line![2]));
    expect(Number(line![2])).toBe(1);
    expect(listedAfter).toEqual(expect.arrayContaining(['/.claude/rules/new-rule.md', '/.claude/rules/other-rule.md', '/.claude/skills/new-skill/']));

    // Off, the preview names the block a pull would remove, and leaves it.
    setOverride(m, false);
    const listed = read(exclude);
    expect(m.teamai(['pull', '--dry-run'], app)).toContain(`[dry-run] Would remove teamai's delivered git exclude block from ${exclude} (sharing.gitExclude is off)`);
    expect(read(exclude)).toBe(listed);

    // On again, in a repository without info/: the preview creates none.
    setOverride(m, true);
    fs.rmSync(path.dirname(exclude), { recursive: true });
    expect(m.teamai(['pull', '--dry-run'], app)).toMatch(new RegExp(`Would list \\d+ path\\(s\\) and drop 0 in teamai's delivered git exclude block in ${exclude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(fs.existsSync(path.dirname(exclude))).toBe(false);
  }, 120_000);

  it('notes, with pull\'s own line and without failing, a copy no longer delivered that pull keeps because the repository tracks it', () => {
    const m = member('kept-tracked');
    const app = m.project(path.join(caseDir('kept-tracked'), 'app'), { before: (dir) => write(path.join(dir, '.claude/skills/fe-skill/SKILL.md'), skillMd('fe-skill')) });
    m.teamai(['roles', 'set', 'be'], app);
    const skillDir = path.join(app, '.claude/skills/fe-skill');
    const kept = `Kept ${skillDir}: this repository tracks it, so teamai does not delete it. Run \`git rm -r ${skillDir}\` and commit if the repository no longer needs it.`;
    expect(m.teamai(['pull'], app)).toContain(kept);

    const doctor = m.teamai(['doctor'], app);
    expect(doctor).toContain(kept);
    expect(doctor).toContain('✔ Delivered team resources are kept out of git');
    expect(status(m, app)).toEqual([]);
  }, 120_000);

  it('notes, with pull\'s own line and without failing, a file pull keeps where the team removed a doc', () => {
    const m = member('kept-doc');
    m.teamCommit({ 'docs/guide.md': '# Guide\n', 'docs/other.md': '# Other\n' });
    const app = m.project(path.join(caseDir('kept-doc'), 'app'));
    const guide = path.join(app, '.teamai', 'docs', 'guide.md');
    write(guide, '# Guide\n\nMy notes.\n');
    m.teamCommit({ 'docs/guide.md': null });

    const kept = `Kept ${guide}: the team removed docs/guide.md, but this copy matches no team version of it. Delete it when you no longer need it.`;
    expect(m.teamai(['pull'], app)).toContain(kept);
    const doctor = m.teamai(['doctor'], app);
    expect(doctor).toContain(kept);
    expect(doctor).toContain('✔ Team docs delivered');
  }, 120_000);

  it('keeps a background pull\'s failure for the next interactive pull and doctor, until a sync succeeds; a busy lock is retried', async () => {
    const m = member('background');
    const app = m.project(path.join(caseDir('background'), 'app'));
    const exclude = excludeFileOf(m, app);
    m.teamCommit({ 'rules/new-rule.md': rule('New') });

    const release = holdLock(exclude);
    try {
      await m.sessionStart(app);
      expect(blockLines(exclude)).not.toContain('/.claude/rules/new-rule.md');
      const doctor = m.teamai(['doctor'], app);
      expect(doctor).toContain('✖ Last background pull could not keep teamai\'s git exclude blocks up to date');
      expect(doctor).toContain(`Could not update teamai's delivered git exclude block in ${exclude}: another teamai command held it past the wait.`);
      // Its own record, not the git hook's.
      expect(doctor).toContain('No git hook failure recorded');

      const pulled = m.teamai(['pull'], app);
      expect(pulled).toMatch(/A background pull \([^)]+\) could not keep teamai's git exclude blocks up to date: Could not update teamai's delivered git exclude block/);
      expect(pulled.match(/another teamai command held it past the wait/g)).toHaveLength(2);
      // Said by the pull already: the post-pull checks do not repeat it.
      expect(pulled).not.toContain('Last background pull could not keep');
    } finally {
      release();
    }

    const retried = m.teamai(['pull'], app);
    expect(retried).not.toContain('could not keep teamai\'s git exclude blocks');
    expect(blockLines(exclude)).toContain('/.claude/rules/new-rule.md');
    expect(m.teamai(['doctor'], app)).not.toContain('Last background pull');
  }, 120_000);

  it('reports a delivered path a rule re-includes as a failed sync, which a background pull keeps until a pull after the rule is gone', async () => {
    const m = member('reincluded');
    const app = m.project(path.join(caseDir('reincluded'), 'app'));
    write(path.join(app, '.gitignore'), '!/.claude/rules/team-rule.md\n');
    const seen = `git still sees .claude/rules/team-rule.md: \`!/.claude/rules/team-rule.md\` (${path.join(app, '.gitignore')}:1) re-includes it. Remove that rule.`;

    const pulled = m.teamai(['pull'], app);
    expect(pulled.split(seen)).toHaveLength(2);

    await m.sessionStart(app);
    const doctor = m.teamai(['doctor'], app);
    expect(doctor).toContain('✖ Last background pull could not keep teamai\'s git exclude blocks up to date');
    expect(doctor).toContain('✖ Delivered team resources are kept out of git');
    expect(doctor.split(seen)).toHaveLength(3);

    fs.rmSync(path.join(app, '.gitignore'));
    const fixed = m.teamai(['pull'], app);
    expect(fixed).toMatch(/A background pull \([^)]+\) could not keep teamai's git exclude blocks up to date: git still sees/);
    expect(fixed.split(seen)).toHaveLength(2);
    const after = m.teamai(['doctor'], app);
    expect(after).not.toContain('Last background pull');
    expect(after).toContain('✔ Delivered team resources are kept out of git');
  }, 120_000);

  it('keeps a background pull\'s notice of another checkout\'s file for doctor and the next interactive pull, which says it once', async () => {
    const m = member('notice');
    const root = caseDir('notice');
    const main = m.project(path.join(root, 'main'));
    const wt = await m.worktree(main, path.join(root, 'wt'));
    const membersRule = path.join(wt, '.claude/rules/new-rule.md');
    write(membersRule, '# Mine\n\nMy own rule.\n');
    m.teamCommit({ 'rules/new-rule.md': rule('New') });
    m.teamai(['pull'], wt);
    const left = `Left .claude/rules/new-rule.md visible to git in every checkout: ${membersRule} is not a copy teamai delivered there, and a git exclude line would hide it too.`;

    await m.sessionStart(main);
    const doctor = m.teamai(['doctor'], main);
    expect(doctor).toContain('✖ No other checkout\'s own file leaves a delivered path visible to git');
    expect(doctor).toMatch(new RegExp(`From a background pull \\([^)]+\\): ${left.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    const pulled = m.teamai(['pull'], main);
    expect(pulled.split(left)).toHaveLength(2);
    expect(m.teamai(['doctor'], main)).not.toContain('From a background pull');
    expect(status(m, main)).toEqual(['?? .claude/rules/new-rule.md']);
  }, 180_000);
});
