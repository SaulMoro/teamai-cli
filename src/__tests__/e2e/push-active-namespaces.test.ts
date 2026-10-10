/**
 * Where `teamai push` sends a project scope's resources, through the built CLI
 * and a local bare team repo. Destinations are read from the branch that
 * reached the remote, not from CLI output alone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
let sandbox: string;
let project: string;
let origin: string;
let env: NodeJS.ProcessEnv;

function git(args: string[], cwd = sandbox): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: project, env, encoding: 'utf8', timeout: 60_000,
  });
  if (result.error) throw result.error;
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`;
}

function setConfig(patch: Record<string, unknown>): void {
  const file = path.join(project, '.teamai', 'config.yaml');
  writeFile(file, YAML.stringify({ ...YAML.parse(fs.readFileSync(file, 'utf8')), ...patch }));
}

function recordDeliveredCopies(entries: Record<string, string>): void {
  const file = path.join(project, '.teamai', 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    lastPullByWorkspace: Record<string, { delivered?: Record<string, string> }>;
  };
  const record = Object.values(state.lastPullByWorkspace)[0];
  if (!record) throw new Error('project delivery record is missing');
  record.delivered = { ...record.delivered, ...entries };
  writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Commit a file (null: its removal) straight onto the remote's default branch, as a teammate would. */
function commitOnTeam(relPath: string, content: string | null): void {
  const teammate = fs.mkdtempSync(path.join(sandbox, 'teammate-'));
  git(['clone', '-q', origin, teammate]);
  if (content === null) git(['rm', '-rq', relPath], teammate);
  else writeFile(path.join(teammate, relPath), content);
  git(['add', '.'], teammate);
  git(['commit', '-qm', `teammate: ${relPath}`], teammate);
  git(['push', '-q', 'origin', 'main'], teammate);
}

/** Merge one teammate change to the default branch, preserving its merge diff. */
function mergeOnTeam(relPath: string, content: string | null): void {
  const teammate = fs.mkdtempSync(path.join(sandbox, 'teammate-merge-'));
  git(['clone', '-q', origin, teammate]);
  git(['switch', '-q', '-c', 'teammate-change'], teammate);
  if (content === null) git(['rm', '-rq', relPath], teammate);
  else writeFile(path.join(teammate, relPath), content);
  git(['add', '.'], teammate);
  git(['commit', '-qm', `teammate: ${relPath}`], teammate);
  git(['switch', '-q', 'main'], teammate);
  git(['merge', '-q', '--no-ff', '-m', `merge teammate: ${relPath}`, 'teammate-change'], teammate);
  git(['push', '-q', 'origin', 'main'], teammate);
}

/** Every file on the push branches the remote received, newest branch last. */
function pushedFiles(): string[] {
  const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'], origin)
    .split('\n').filter(Boolean);
  return branches.flatMap((branch) => git(['diff', '--name-only', 'main', branch], origin).split('\n').filter(Boolean));
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-push-active-ns-'));
  const home = path.join(sandbox, 'home');
  const seed = path.join(sandbox, 'seed');
  project = path.join(sandbox, 'project');
  origin = path.join(sandbox, 'origin.git');
  const clone = path.join(project, '.teamai', 'team-repo');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  env = {
    ...process.env,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'member', GIT_AUTHOR_EMAIL: 'member@example.invalid',
    GIT_COMMITTER_NAME: 'member', GIT_COMMITTER_EMAIL: 'member@example.invalid',
    GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0', TEAMAI_NONINTERACTIVE: '1',
  };
  writeFile(path.join(seed, 'teamai.yaml'), YAML.stringify({
    team: 'push-active-ns', repo: origin, provider: 'git', usageReport: false,
  }));
  writeFile(path.join(seed, 'manifest', 'projects.yaml'), YAML.stringify({
    version: 1,
    projects: [
      { id: 'svc-a', resources: { skills: ['svc-a', 'payments'], knowledge: ['svc-a'], learnings: ['svc-a'] } },
      { id: 'svc-b', resources: { skills: ['svc-b', 'payments'], knowledge: ['svc-b'], learnings: ['svc-b'] } },
      { id: 'platform', resources: { skills: ['platform'], knowledge: ['platform'], learnings: ['platform'] } },
    ],
  }));
  for (const [ns, name] of [['svc-a', 'a-skill'], ['svc-b', 'b-skill'], ['payments', 'pay-skill'], ['platform', 'plat-skill']]) {
    writeFile(path.join(seed, 'skills', ns, name, 'SKILL.md'), skillMd(name));
  }
  writeFile(path.join(seed, 'rules', 'svc-a', 'a-rule.md'), '# a rule\n');
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '.'], seed);
  git(['commit', '-qm', 'fixture'], seed);
  git(['clone', '-q', '--bare', seed, origin]);
  git(['clone', '-q', origin, clone]);
  writeFile(path.join(project, '.teamai', 'config.yaml'), YAML.stringify({
    repo: { localPath: clone, remote: origin, kind: 'git' },
    username: 'member', scope: 'project', projectRoot: project,
    updatePolicy: 'skip', additionalRoles: [], projects: ['svc-a'], enabledAgents: ['claude'],
  }));
  const pulled = run(['pull']);
  expect(pulled.code, pulled.output).toBe(0);
});

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

describe('push an edit of a skill pull kept after a project switch (#1020)', () => {
  it('pushes two tool edits to their distinct delivered destinations', () => {
    const svcB = `${skillMd('a-skill')}\nThe svc-b version.\n`;
    commitOnTeam('skills/svc-b/a-skill/SKILL.md', svcB);
    commitOnTeam('teamai.yaml', [
      'team: push-active-ns',
      `repo: ${origin}`,
      'provider: git',
      'usageReport: false',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '  codex:',
      '    skills: .codex/skills',
      '',
    ].join('\n'));
    git(['pull', '-q', 'origin', 'main'], path.join(project, '.teamai', 'team-repo'));
    const codexSkill = path.join(project, '.codex', 'skills', 'a-skill');
    writeFile(path.join(codexSkill, 'SKILL.md'), `${svcB}\nCodex edit.\n`);
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nClaude edit.\n');
    recordDeliveredCopies({ [path.join(codexSkill, 'SKILL.md')]: contentHash(svcB) });
    setConfig({ enabledAgents: ['claude', 'codex'] });
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);

    const pushed = run(['push', '--all']);

    expect(pushedFiles(), pushed.output).toEqual(expect.arrayContaining([
      'skills/svc-a/a-skill/SKILL.md', 'skills/svc-b/a-skill/SKILL.md',
    ]));
  });

  it('resolves a legacy delivered duplicate against every namespace, not only the first', () => {
    commitOnTeam('skills/z-archive/a-skill/SKILL.md', `${skillMd('a-skill')}\nDelivered from z-archive.\n`);
    commitOnTeam('manifest/projects.yaml', null);
    setConfig({ projects: [], primaryRole: undefined });

    const pulled = run(['pull']);
    expect(pulled.code, pulled.output).toBe(0);
    const localSkill = path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md');
    expect(fs.readFileSync(localSkill, 'utf8')).toContain('Delivered from z-archive.');
    fs.appendFileSync(localSkill, '\nEdited after the legacy pull.\n');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('to:   skills/z-archive/a-skill');
    expect(pushedFiles()).toContain('skills/z-archive/a-skill/SKILL.md');
    expect(pushedFiles()).not.toContain('skills/svc-a/a-skill/SKILL.md');

    commitOnTeam('skills/a-archive/member-owned/SKILL.md', skillMd('member-owned'));
    commitOnTeam('skills/z-archive/member-owned/SKILL.md', skillMd('member-owned'));
    writeFile(path.join(project, '.claude', 'skills', 'member-owned', 'SKILL.md'), skillMd('member-owned'));
    const unrecorded = run(['push', '--all']);

    expect(unrecorded.output).toContain('no delivery record proves which one this copy came from');
    expect(pushedFiles()).not.toContain('skills/a-archive/member-owned/SKILL.md');
    expect(pushedFiles()).not.toContain('skills/z-archive/member-owned/SKILL.md');
  });

  it('offers the edit with --all and sends it back to the namespace it came from', () => {
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    const pulled = run(['pull']);
    expect(pulled.output).toContain('Kept skill "a-skill"');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('to:   skills/svc-a/a-skill');
    expect(pushedFiles()).toContain('skills/svc-a/a-skill/SKILL.md');
  });

  it('sends the edit to its namespace, not to a shared-root skill of the same name', () => {
    commitOnTeam('skills/a-skill/SKILL.md', `${skillMd('a-skill')}\nThe shared catalog version.\n`);
    expect(run(['pull']).code).toBe(0);
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('to:   skills/svc-a/a-skill');
    expect(pushedFiles()).toContain('skills/svc-a/a-skill/SKILL.md');
    expect(pushedFiles()).not.toContain('skills/a-skill/SKILL.md');
  });

  it('pushes nothing for an unedited copy whose team skill changed since teamai delivered it', () => {
    commitOnTeam('skills/svc-a/a-skill/SKILL.md', `${skillMd('a-skill')}\nA teammate's update.\n`);
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('No new or modified resources to push');
    expect(pushedFiles()).toEqual([]);
  });

  it('sends an edit to its namespace when both it and a shared-root skill changed since delivery', () => {
    commitOnTeam('skills/a-skill/SKILL.md', `${skillMd('a-skill')}\nThe shared catalog version.\n`);
    expect(run(['pull']).code).toBe(0);
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);
    commitOnTeam('skills/svc-a/a-skill/SKILL.md', `${skillMd('a-skill')}\nA teammate's update.\n`);

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('to:   skills/svc-a/a-skill');
    expect(pushedFiles()).not.toContain('skills/a-skill/SKILL.md');
  });

  it('says once that pull kept the edited skill', () => {
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);

    const pulled = run(['pull']);

    expect(pulled.output.match(/Kept skill "a-skill"/g), pulled.output).toHaveLength(1);
  });

  it('sends the edit to the inactive namespace it came from, not the active one holding the same name', () => {
    commitOnTeam('skills/svc-a/dup-skill/SKILL.md', `${skillMd('dup-skill')}\nThe svc-a version.\n`);
    commitOnTeam('skills/svc-b/dup-skill/SKILL.md', `${skillMd('dup-skill')}\nThe svc-b version.\n`);
    expect(run(['pull']).code).toBe(0);
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'dup-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).output).toContain('Kept');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('to:   skills/svc-a/dup-skill');
    expect(pushedFiles()).toContain('skills/svc-a/dup-skill/SKILL.md');
    expect(pushedFiles()).not.toContain('skills/svc-b/dup-skill/SKILL.md');
  });

  it.each([
    ['in an inactive namespace', 'skills/platform/a-skill'],
    ['at the shared root', 'skills/a-skill'],
    ['in an active namespace', 'skills/svc-b/a-skill'],
  ])('leaves an unrelated skill %s alone when the one the edit came from was deleted', (_where, unrelated) => {
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    commitOnTeam('skills/svc-a/a-skill', null);
    commitOnTeam(`${unrelated}/SKILL.md`, `${skillMd('a-skill')}\nAn unrelated skill.\n`);
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain(`Skipped a-skill: teamai delivered this copy, but its record matches no version of ${unrelated}`);
    expect(pushedFiles()).toEqual([]);
  });

  it('opens its own PR instead of replacing an open one for another namespace\'s skill of the same name', () => {
    commitOnTeam('skills/svc-a/dup-skill/SKILL.md', `${skillMd('dup-skill')}\nThe svc-a version.\n`);
    commitOnTeam('skills/svc-b/dup-skill/SKILL.md', `${skillMd('dup-skill')}\nThe svc-b version.\n`);
    const local = path.join(project, '.claude', 'skills', 'dup-skill');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);
    fs.appendFileSync(path.join(local, 'SKILL.md'), '\nEdited while on svc-b.\n');
    run(['push', '--all']);
    const [svcBBranch] = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'], origin).split('\n');
    fs.rmSync(local, { recursive: true });
    expect(run(['projects', 'set', 'svc-a']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);
    fs.appendFileSync(path.join(local, 'SKILL.md'), '\nEdited while on svc-a.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).output).toContain('Kept');
    // Push branch names carry a one-second timestamp; a second push in the same second reuses the name.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('awaiting review at skills/svc-b/dup-skill');
    expect(pushed.output).toContain('separate PR');
    expect(pushed.output).not.toContain('awaiting review: ');
    expect(git(['show', `${svcBBranch}:skills/svc-b/dup-skill/SKILL.md`], origin)).toContain('Edited while on svc-b.');
    expect(pushedFiles()).toContain('skills/svc-a/dup-skill/SKILL.md');
  });

  it('names both namespaces and pushes nothing when two inactive namespaces hold the name', () => {
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    commitOnTeam('skills/svc-b/a-skill/SKILL.md', skillMd('a-skill'));
    expect(run(['projects', 'set', 'platform']).code).toBe(0);
    expect(run(['pull']).output).toContain('Kept skill "a-skill"');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('Skipped a-skill');
    expect(pushed.output).toContain('skills/svc-a/a-skill and skills/svc-b/a-skill');
    expect(pushedFiles()).toEqual([]);
  });

  it.each([
    { flag: ['--project', 'svc-b'], rule: 'rules/svc-b/new-rule.md' },
    { flag: ['--role', 'platform'], rule: 'rules/platform/new-rule.md' },
  ])('keeps the edit\'s namespace when $flag places new resources', ({ flag, rule }) => {
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);
    writeFile(path.join(project, '.claude', 'rules', 'new-rule.md'), '# new rule\n');

    const pushed = run(['push', '--all', ...flag]);

    expect(pushedFiles(), pushed.output).toEqual(expect.arrayContaining(['skills/svc-a/a-skill/SKILL.md', rule]));
    expect(pushedFiles().filter((file) => file.endsWith('a-skill/SKILL.md'))).toEqual(['skills/svc-a/a-skill/SKILL.md']);
  });

  it('says nothing about an unedited copy two inactive namespaces hold', () => {
    commitOnTeam('skills/svc-b/a-skill/SKILL.md', skillMd('a-skill'));
    expect(run(['projects', 'set', 'platform']).code).toBe(0);

    const pushed = run(['push', '--all']);

    expect(pushed.output).not.toContain('Skipped a-skill');
    expect(pushedFiles()).toEqual([]);
  });

  it('leaves out a member\'s own skill that only shares its name with an inactive namespace', () => {
    writeFile(path.join(project, '.claude', 'skills', 'b-skill', 'SKILL.md'), skillMd('b-skill') + '\nMy own.\n');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('No new or modified resources to push');
    expect(pushedFiles()).toEqual([]);
  });

  it.each([
    { label: '--role', flags: (_skillPath: string) => ['--role', 'platform'] },
    { label: '--project', flags: (_skillPath: string) => ['--project', 'platform'] },
    { label: '--skill with --role', flags: (skillPath: string) => ['--skill', skillPath, '--role', 'platform'] },
    { label: '--skill with --project', flags: (skillPath: string) => ['--skill', skillPath, '--project', 'platform'] },
  ])('does not route an ambiguous delivered origin with $label', ({ flags }) => {
    const skillPath = path.join(project, '.claude', 'skills', 'a-skill');
    fs.appendFileSync(path.join(skillPath, 'SKILL.md'), '\nEdited after delivery.\n');
    commitOnTeam('skills/svc-b/a-skill/SKILL.md', skillMd('a-skill'));

    const pushed = run(['push', '--all', ...flags(skillPath)]);

    expect(pushed.output).toContain('Skipped a-skill');
    expect(pushed.output).toContain('copy it under a new name and push that');
    expect(pushedFiles()).toEqual([]);
  });
});

describe('push --skill sends a skill to the team skill it came from', () => {
  it('does not fall back to another tool when the requested delivered copy has no proven origin', () => {
    const requested = path.join(project, '.claude', 'skills', 'a-skill');
    fs.appendFileSync(path.join(requested, 'SKILL.md'), '\nEdited before the old origin was replaced.\n');
    commitOnTeam('skills/svc-a/a-skill', null);
    commitOnTeam('skills/svc-a/a-skill/SKILL.md', `${skillMd('a-skill')}\nAn unrelated recreated skill.\n`);
    expect(run(['pull']).output).toContain('Kept ');
    commitOnTeam('teamai.yaml', [
      'team: push-active-ns',
      `repo: ${origin}`,
      'provider: git',
      'usageReport: false',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '  codex:',
      '    skills: .codex/skills',
      '',
    ].join('\n'));
    writeFile(path.join(project, '.codex', 'skills', 'a-skill', 'SKILL.md'), `${skillMd('a-skill')}\nAnother tool's pushable copy.\n`);

    const pushed = run(['push', '--all', '--skill', requested]);

    expect(pushed.output).toContain(`Skipped a-skill at ${requested}: teamai delivered this copy`);
    expect(pushed.output).toContain('record matches no version of skills/svc-a/a-skill');
    expect(pushedFiles()).toEqual([]);
  });

  it('leaves another namespace\'s skill of the same name untouched', () => {
    commitOnTeam('skills/archive/a-skill/SKILL.md', `${skillMd('a-skill')}\nThe archived version.\n`);
    expect(run(['pull']).code).toBe(0);

    const pushed = run(['push', '--all', '--skill', path.join(project, '.claude', 'skills', 'a-skill')]);

    expect(pushed.output).toContain('to:   skills/svc-a/a-skill');
    expect(pushedFiles()).not.toContain('skills/archive/a-skill/SKILL.md');
  });

  it('keeps an inactive delivered skill at its origin with --role', () => {
    commitOnTeam('skills/svc-a/a-skill/SKILL.md', `${skillMd('a-skill')}\nThe svc-a version.\n`);
    expect(run(['pull']).code).toBe(0);
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited after svc-a became inactive.\n');
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).output).toContain('Kept skill "a-skill"');
    writeFile(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), `${skillMd('a-skill')}\nThe svc-a version.\n`);
    writeFile(path.join(project, '.claude', 'skills', 'a-skill', 'CONTRIBUTORS'), 'testuser\n');

    const pushed = run(['push', '--all', '--skill', path.join(project, '.claude', 'skills', 'a-skill'), '--role', 'platform']);

    expect(pushed.output).toContain('to:   skills/svc-a/a-skill');
    expect(pushedFiles()).toContain('skills/svc-a/a-skill/CONTRIBUTORS');
    expect(pushedFiles()).not.toContain('skills/platform/a-skill/SKILL.md');
  });

  it('asks for --role instead of guessing when several namespaces hold a name it never delivered', () => {
    commitOnTeam('skills/archive/x-skill/SKILL.md', skillMd('x-skill'));
    commitOnTeam('skills/svc-b/x-skill/SKILL.md', skillMd('x-skill'));
    writeFile(path.join(project, '.claude', 'skills', 'x-skill', 'SKILL.md'), `${skillMd('x-skill')}\nMy own.\n`);

    const guessed = run(['push', '--all', '--skill', path.join(project, '.claude', 'skills', 'x-skill')]);

    expect(guessed.code).toBe(2);
    expect(guessed.output).toContain('no record of delivering this copy from skills/archive/x-skill or skills/svc-b/x-skill');
    expect(pushedFiles()).toEqual([]);

    const named = run(['push', '--all', '--skill', path.join(project, '.claude', 'skills', 'x-skill'), '--role', 'platform']);

    expect(pushedFiles(), named.output).toEqual(expect.arrayContaining(['skills/platform/x-skill/SKILL.md']));
  });
});

describe('push --skill refuses a copy its record does not tie to a team skill', () => {
  const selectors = [
    { label: 'without flags', flags: (_skillPath: string) => [] as string[] },
    { label: 'with --role', flags: (_skillPath: string) => ['--role', 'platform'] },
    { label: 'with --project', flags: (_skillPath: string) => ['--project', 'platform'] },
    { label: 'with --skill', flags: (skillPath: string) => ['--skill', skillPath] },
    { label: 'with --skill and --role', flags: (skillPath: string) => ['--skill', skillPath, '--role', 'platform'] },
    { label: 'with --skill and --project', flags: (skillPath: string) => ['--skill', skillPath, '--project', 'platform'] },
  ];
  const unprovenOrigins = (['deleted', 'recreated', 'ambiguous'] as const).flatMap((state) =>
    selectors.map((selector) => ({ state, ...selector })));

  it('asks for --role for a copy it never delivered whose name only an inactive namespace holds', () => {
    writeFile(path.join(project, '.claude', 'skills', 'b-skill', 'SKILL.md'), `${skillMd('b-skill')}\nMy own.\n`);

    const pushed = run(['push', '--all', '--skill', path.join(project, '.claude', 'skills', 'b-skill')]);

    expect(pushed.code, pushed.output).toBe(2);
    expect(pushed.output).toContain('no record of delivering this copy from skills/svc-b/b-skill');
    expect(pushedFiles()).toEqual([]);
  });

  it('does not overwrite a skill recreated after a merge deletion', () => {
    const skillPath = path.join(project, '.claude', 'skills', 'a-skill');
    fs.appendFileSync(path.join(skillPath, 'SKILL.md'), '\nMember edit after delivery.\n');
    mergeOnTeam('skills/svc-a/a-skill', null);
    expect(run(['pull']).code).toBe(0);
    mergeOnTeam('skills/svc-a/a-skill/SKILL.md', `${skillMd('a-skill')}\nUnrelated recreated skill.\n`);
    expect(run(['pull']).code).toBe(0);

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('Skipped a-skill');
    expect(pushed.output).toContain('its record matches no version of skills/svc-a/a-skill');
    expect(pushed.output).toContain('copy it under a new name and push that');
    expect(pushedFiles()).toEqual([]);
    expect(git(['show', 'main:skills/svc-a/a-skill/SKILL.md'], origin)).toContain('Unrelated recreated skill.');
  });

  it.each(unprovenOrigins)('does not route a $state delivered origin $label', ({ state, flags }) => {
    const skillPath = path.join(project, '.claude', 'skills', 'a-skill');
    fs.appendFileSync(path.join(skillPath, 'SKILL.md'), '\nEdited after delivery.\n');
    if (state === 'deleted' || state === 'recreated') commitOnTeam('skills/svc-a/a-skill', null);
    if (state === 'recreated') {
      commitOnTeam('skills/svc-a/a-skill/SKILL.md', `${skillMd('a-skill')}\nUnrelated recreated skill.\n`);
    }
    if (state === 'ambiguous') commitOnTeam('skills/svc-b/a-skill/SKILL.md', skillMd('a-skill'));

    const pushed = run(['push', '--all', ...flags(skillPath)]);

    expect(pushed.output).toContain('Skipped a-skill');
    expect(pushed.output).toContain('copy it under a new name and push that');
    expect(pushedFiles()).toEqual([]);
  });
});

describe('push places a new resource by the active projects (#1021)', () => {
  it('puts a new rule in the active project\'s knowledge namespace', () => {
    writeFile(path.join(project, '.claude', 'rules', 'new-rule.md'), '# new rule\n');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('[rules] new-rule → rules/svc-a/new-rule.md');
    expect(pushedFiles()).toEqual(['rules/svc-a/new-rule.md']);
  });

  it('puts a new skill in the namespace of a project that declares one', () => {
    expect(run(['projects', 'set', 'platform']).code).toBe(0);
    writeFile(path.join(project, '.claude', 'skills', 'new-skill', 'SKILL.md'), skillMd('new-skill'));

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('[skills] new-skill → skills/platform/new-skill');
    expect(pushedFiles()).toContain('skills/platform/new-skill/SKILL.md');
  });

  it('offers only the active projects\' namespaces when they declare several', () => {
    writeFile(path.join(project, '.claude', 'skills', 'new-skill', 'SKILL.md'), skillMd('new-skill'));

    const pushed = run(['push', '--all']);

    expect(pushed.code).toBe(2);
    expect(pushed.output).toContain('Several skills namespaces could take new skills (svc-a, payments)');
    expect(pushedFiles()).toEqual([]);
  });

  it('offers the role\'s namespaces beside the active projects\'', () => {
    commitOnTeam('manifest/roles.yaml', YAML.stringify({
      version: 1,
      roles: [{ id: 'backend', description: '', resources: { knowledge: ['be-know'], skills: ['be-skills'] } }],
    }));
    setConfig({ primaryRole: 'backend' });
    expect(run(['pull']).code).toBe(0);
    writeFile(path.join(project, '.claude', 'rules', 'new-rule.md'), '# new rule\n');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('Several knowledge namespaces could take new rules (be-know, svc-a)');
    expect(pushedFiles()).toEqual([]);
  });

  it('stops instead of sharing with everyone when an active project is not in the manifest', () => {
    setConfig({ projects: ['retired'] });
    writeFile(path.join(project, '.claude', 'rules', 'new-rule.md'), '# new rule\n');

    const pushed = run(['push', '--all']);

    expect(pushed.code).toBe(2);
    expect(pushed.output).toContain('Unknown project "retired"');
    expect(pushedFiles()).toEqual([]);
  });

  it('stops instead of sharing with everyone when the projects manifest is gone', () => {
    commitOnTeam('manifest/projects.yaml', null);
    writeFile(path.join(project, '.claude', 'rules', 'new-rule.md'), '# new rule\n');

    const pushed = run(['push', '--all']);

    expect(pushed.code).toBe(2);
    expect(pushed.output).toContain('manifest/projects.yaml');
    expect(pushedFiles()).toEqual([]);
  });

  it('keeps a new rule at the shared root with no active project', () => {
    setConfig({ projects: [] });
    writeFile(path.join(project, '.claude', 'rules', 'new-rule.md'), '# new rule\n');

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('[rules] new-rule → rules/new-rule.md (shared with everyone: no namespace resolved)');
    expect(pushedFiles()).toEqual(['rules/new-rule.md']);
  });
});

describe('push stops when the active projects cannot be resolved', () => {
  const unresolved: [string, () => void, string][] = [
    ['the projects manifest is gone', () => commitOnTeam('manifest/projects.yaml', null), 'no manifest/projects.yaml'],
    ['an active project is not in the manifest', () => setConfig({ projects: ['svc-b', 'retired'] }), 'Unknown project "retired"'],
  ];
  const pushes: [string, () => string[]][] = [
    ['a new rule', () => {
      writeFile(path.join(project, '.claude', 'rules', 'new-rule.md'), '# new rule\n');
      return ['push', '--all'];
    }],
    ['a new skill named like another project\'s', () => {
      writeFile(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), `${skillMd('a-skill')}\nMy own.\n`);
      return ['push', '--all'];
    }],
    ['--skill on a skill named like another project\'s', () => {
      writeFile(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), `${skillMd('a-skill')}\nMy own.\n`);
      return ['push', '--all', '--skill', path.join(project, '.claude', 'skills', 'a-skill')];
    }],
    ['a new agent', () => {
      writeFile(path.join(project, '.claude', 'agents', 'new-agent.md'), '---\nname: new-agent\ndescription: new agent\n---\n\nHelp.\n');
      return ['push', '--all'];
    }],
  ];

  describe.each(unresolved)('when %s', (_state, breakProjects, reason) => {
    it.each(pushes)('pushes nothing for %s', (_resource, prepare) => {
      setConfig({ projects: ['svc-b'] });
      expect(run(['pull']).code).toBe(0);
      breakProjects();

      const pushed = run(prepare());

      expect(pushed.code, pushed.output).toBe(2);
      expect(pushed.output).toContain(reason);
      expect(pushedFiles()).toEqual([]);
    });

    it('sends an edit back to the project it came from under --role, and a new skill to the role', () => {
      setConfig({ projects: ['svc-b'] });
      expect(run(['pull']).code).toBe(0);
      breakProjects();
      fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
      writeFile(path.join(project, '.claude', 'skills', 'new-skill', 'SKILL.md'), skillMd('new-skill'));

      const pushed = run(['push', '--all', '--role', 'platform']);

      expect(pushedFiles(), pushed.output).toEqual(expect.arrayContaining([
        'skills/svc-a/a-skill/SKILL.md', 'skills/platform/new-skill/SKILL.md',
      ]));
      expect(pushedFiles()).not.toContain('skills/platform/a-skill/SKILL.md');
    });
  });
});
