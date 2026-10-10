/**
 * Where `teamai push` sends a project scope's resources, through the built CLI
 * and a local bare team repo. Destinations are read from the branch that
 * reached the remote, not from CLI output alone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
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

  it('leaves an unrelated skill alone when the one the edit came from was deleted', () => {
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    commitOnTeam('skills/svc-a/a-skill', null);
    commitOnTeam('skills/platform/a-skill/SKILL.md', `${skillMd('a-skill')}\nAn unrelated skill.\n`);
    expect(run(['projects', 'set', 'svc-b']).code).toBe(0);
    expect(run(['pull']).code).toBe(0);

    const pushed = run(['push', '--all']);

    expect(pushed.output).toContain('Skipped a-skill');
    expect(pushedFiles()).toEqual([]);
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
});

describe('push --skill sends a skill to the team skill it came from', () => {
  it('leaves another namespace\'s skill of the same name untouched', () => {
    commitOnTeam('skills/archive/a-skill/SKILL.md', `${skillMd('a-skill')}\nThe archived version.\n`);
    expect(run(['pull']).code).toBe(0);

    const pushed = run(['push', '--all', '--skill', path.join(project, '.claude', 'skills', 'a-skill')]);

    expect(pushed.output).toContain('to:   skills/svc-a/a-skill');
    expect(pushedFiles()).not.toContain('skills/archive/a-skill/SKILL.md');
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
  it('asks for --role when the only team skill of the name is not the one it delivered', () => {
    fs.appendFileSync(path.join(project, '.claude', 'skills', 'a-skill', 'SKILL.md'), '\nEdited while on svc-a.\n');
    commitOnTeam('skills/svc-a/a-skill', null);
    commitOnTeam('skills/platform/a-skill/SKILL.md', `${skillMd('a-skill')}\nAn unrelated skill.\n`);

    const pushed = run(['push', '--all', '--skill', path.join(project, '.claude', 'skills', 'a-skill')]);

    expect(pushed.code).toBe(2);
    expect(pushed.output).toContain('Pass --role <ns>');
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
