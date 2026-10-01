import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real-CLI coverage for #945: a pull writes the instruction blocks (culture,
// claudemd, recall) only where an installed tool reads them, and strips the
// blocks an earlier pull left in a target no installed tool uses anymore.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

const CULTURE_START = '<!-- [teamai:culture:start] -->';
const CULTURE_END = '<!-- [teamai:culture:end] -->';
const CLAUDEMD_START = '<!-- [teamai:claudemd:start] -->';
const CLAUDEMD_END = '<!-- [teamai:claudemd:end] -->';
const RECALL_START = '<!-- [teamai:recall-rules:start] -->';

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

/** A user-scope sandbox HOME with the given tool directories installed. */
function makeUserSandbox(toolDirs: string[]): { sandbox: string; home: string } {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
  const home = path.join(sandbox, 'home');
  const remote = path.join(sandbox, 'team-remote');
  const localRepo = path.join(home, '.teamai', 'team-repo');

  fs.mkdirSync(path.join(remote, 'claudemd', 'common'), { recursive: true });
  fs.writeFileSync(
    path.join(remote, 'teamai.yaml'),
    ['team: issue-945-e2e', `repo: ${remote}`, 'provider: git', 'sharing:', '  recall:', '    enabled: true'].join('\n'),
  );
  fs.writeFileSync(path.join(remote, 'culture.md'), '---\ncompany:\n  name: Acme\n---\n\nBe kind.\n');
  fs.writeFileSync(path.join(remote, 'claudemd', 'common', 'note.md'), 'Shared team instructions.\n');
  git(['init', '-q'], remote);
  git(['add', '-A'], remote);
  git(['commit', '-q', '-m', 'fixture'], remote);

  fs.mkdirSync(home, { recursive: true });
  git(['clone', '-q', remote, localRepo], sandbox);
  for (const dir of toolDirs) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.teamai', 'config.yaml'),
    [
      'repo:',
      `  localPath: ${localRepo}`,
      `  remote: ${remote}`,
      'username: ci-user',
      'updatePolicy: auto',
      'scope: user',
      'recallEnabled: true',
    ].join('\n'),
  );
  return { sandbox, home };
}

const PROJECT_AGENTS_MD = '# Project\n\nAuthored project instructions.\n';

/**
 * A team whose roles select different `claudemd/` namespaces, and a project
 * repo with an authored, committed AGENTS.md (#945).
 */
function makeTeamAndProject(sandbox: string): { remote: string; projectOrigin: string } {
  const seed = path.join(sandbox, 'team-seed');
  const remote = path.join(sandbox, 'team.git');
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.writeFileSync(path.join(seed, rel), text);
  };
  write('teamai.yaml', ['team: issue-945-project-e2e', `repo: ${remote}`, 'provider: git', 'sharing:', '  recall:', '    enabled: true', ''].join('\n'));
  write('culture.md', '---\ncompany:\n  name: Acme\n---\n\nBe kind.\n');
  write('claudemd/common.md', 'COMMON-SENTINEL shared by every role.\n');
  write('claudemd/development/dev.md', 'DEVELOPMENT-SENTINEL for developers.\n');
  write('claudemd/product/product.md', 'PRODUCT-SENTINEL for product.\n');
  write('manifest/roles.yaml', [
    'version: 1',
    'roles:',
    '  - id: developer',
    '    description: Developer',
    '    resources:',
    '      knowledge: [development]',
    '      skills: []',
    '  - id: product',
    '    description: Product',
    '    resources:',
    '      knowledge: [product]',
    '      skills: []',
    '',
  ].join('\n'));
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  git(['clone', '-q', '--bare', seed, remote], sandbox);

  const projectSeed = path.join(sandbox, 'project-seed');
  const projectOrigin = path.join(sandbox, 'project.git');
  fs.mkdirSync(projectSeed, { recursive: true });
  fs.writeFileSync(path.join(projectSeed, 'AGENTS.md'), PROJECT_AGENTS_MD);
  fs.writeFileSync(path.join(projectSeed, 'app.txt'), 'v1\n');
  git(['init', '-q', '-b', 'main'], projectSeed);
  git(['add', '-A'], projectSeed);
  git(['commit', '-q', '-m', 'project'], projectSeed);
  git(['clone', '-q', '--bare', projectSeed, projectOrigin], sandbox);
  return { remote, projectOrigin };
}

interface ProjectMember {
  home: string;
  projectRoot: string;
}

/**
 * One member's checkout of the project, in project scope, with their role and
 * the given tool directories installed under the project root.
 */
function makeProjectMember(
  sandbox: string,
  fixture: { remote: string; projectOrigin: string },
  name: string,
  role: string,
  toolDirs: string[],
): ProjectMember {
  const home = path.join(sandbox, `${name}-home`);
  const projectRoot = path.join(sandbox, `${name}-project`);
  fs.mkdirSync(home, { recursive: true });
  git(['clone', '-q', fixture.projectOrigin, projectRoot], sandbox);
  const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');
  git(['clone', '-q', fixture.remote, teamRepo], sandbox);
  for (const dir of toolDirs) fs.mkdirSync(path.join(projectRoot, dir), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
    'repo:',
    `  localPath: ${teamRepo}`,
    `  remote: ${fixture.remote}`,
    `username: ${name}`,
    'updatePolicy: auto',
    'scope: project',
    `projectRoot: ${projectRoot}`,
    `primaryRole: ${role}`,
    'additionalRoles: []',
    'recallEnabled: true',
    '',
  ].join('\n'));
  return { home, projectRoot };
}

const pullAs = (member: ProjectMember, args: string[] = []): Promise<RunResult> =>
  runCLI(['pull', '--force', ...args], { HOME: member.home }, member.projectRoot);

describe('instruction block targets on real CLI pull (#945)', () => {
  const sandboxes: string[] = [];

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }
  });

  afterEach(() => {
    for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes no ~/AGENTS.md when only Claude is installed', async () => {
    const { sandbox, home } = makeUserSandbox(['.claude']);
    sandboxes.push(sandbox);

    const result = await runCLI(['pull'], { HOME: home }, sandbox);
    expect(result.code, result.output).toBe(0);

    const claudeMd = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain(CULTURE_START);
    expect(claudeMd).toContain(CLAUDEMD_START);
    expect(claudeMd).toContain(RECALL_START);
    expect(fs.existsSync(path.join(home, 'AGENTS.md'))).toBe(false);
  });

  it('writes ~/AGENTS.md while Hermes is installed and deletes it once no installed tool reads it', async () => {
    const { sandbox, home } = makeUserSandbox(['.claude', '.hermes']);
    sandboxes.push(sandbox);
    const agentsMd = path.join(home, 'AGENTS.md');

    const withHermes = await runCLI(['pull'], { HOME: home }, sandbox);
    expect(withHermes.code, withHermes.output).toBe(0);
    const written = fs.readFileSync(agentsMd, 'utf8');
    expect(written).toContain(CULTURE_START);
    expect(written).toContain(CLAUDEMD_START);

    fs.rmSync(path.join(home, '.hermes'), { recursive: true, force: true });
    const withoutHermes = await runCLI(['pull'], { HOME: home }, sandbox);
    expect(withoutHermes.code, withoutHermes.output).toBe(0);

    expect(fs.existsSync(agentsMd)).toBe(false);
    expect(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8')).toContain(CLAUDEMD_START);
  });

  it('keeps only the hand-written text of a ~/AGENTS.md no installed tool reads', async () => {
    const { sandbox, home } = makeUserSandbox(['.claude']);
    sandboxes.push(sandbox);
    const agentsMd = path.join(home, 'AGENTS.md');
    fs.writeFileSync(agentsMd, [
      '# My notes',
      '',
      CULTURE_START,
      'old culture',
      CULTURE_END,
      '',
      CLAUDEMD_START,
      'old shared instructions',
      CLAUDEMD_END,
      '',
    ].join('\n'));

    const result = await runCLI(['pull'], { HOME: home }, sandbox);
    expect(result.code, result.output).toBe(0);

    expect(fs.readFileSync(agentsMd, 'utf8')).toBe('# My notes\n');
  });

  it('leaves the project AGENTS.md alone when Hermes is not installed', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills']);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);

    expect(fs.readFileSync(path.join(member.projectRoot, 'AGENTS.md'), 'utf8')).toBe(PROJECT_AGENTS_MD);
  });

  it('reports the cleanup of an old AGENTS.md block in a dry run, then removes it and keeps the authored text', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills']);
    const agentsMd = path.join(member.projectRoot, 'AGENTS.md');
    const leftover = `${PROJECT_AGENTS_MD}\n${CLAUDEMD_START}\nanother member's selection\n${CLAUDEMD_END}\n`;
    fs.writeFileSync(agentsMd, leftover);

    const dryRun = await pullAs(member, ['--dry-run']);
    expect(dryRun.code, dryRun.output).toBe(0);
    expect(dryRun.output).toContain(`Would remove teamai instruction blocks from ${agentsMd}`);
    expect(fs.readFileSync(agentsMd, 'utf8')).toBe(leftover);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`Removed teamai instruction blocks from ${agentsMd}`);
    expect(fs.readFileSync(agentsMd, 'utf8')).toBe(PROJECT_AGENTS_MD);
  });

  it('does not rewrite an instruction file whose blocks are already current', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills']);

    const first = await pullAs(member);
    expect(first.code, first.output).toBe(0);
    const written = fs.readdirSync(member.projectRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.parentPath.includes(`${path.sep}.git`) && !entry.parentPath.includes('.teamai'))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter((file) => fs.readFileSync(file, 'utf8').includes(CLAUDEMD_START));
    expect(written.length).toBeGreaterThan(0);
    const mtimes = written.map((file) => fs.statSync(file).mtimeMs);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await pullAs(member);
    expect(second.code, second.output).toBe(0);
    expect(written.map((file) => fs.statSync(file).mtimeMs)).toEqual(mtimes);
  });

  it('gives two members of one project their own role selection without touching the shared AGENTS.md (Claude)', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const fixture = makeTeamAndProject(sandbox);
    const developer = makeProjectMember(sandbox, fixture, 'dev', 'developer', ['.claude/skills']);
    const product = makeProjectMember(sandbox, fixture, 'pm', 'product', ['.claude/skills']);
    const context = (member: ProjectMember): string =>
      fs.readFileSync(path.join(member.projectRoot, '.claude', 'rules', 'teamai-context.md'), 'utf8');

    for (const member of [developer, product, developer]) {
      const result = await pullAs(member);
      expect(result.code, result.output).toBe(0);
    }

    expect(context(developer)).toContain('COMMON-SENTINEL');
    expect(context(developer)).toContain('DEVELOPMENT-SENTINEL');
    expect(context(developer)).not.toContain('PRODUCT-SENTINEL');
    expect(context(developer)).toContain(CULTURE_START);
    expect(context(developer)).toContain(RECALL_START);
    expect(context(product)).toContain('COMMON-SENTINEL');
    expect(context(product)).toContain('PRODUCT-SENTINEL');
    expect(context(product)).not.toContain('DEVELOPMENT-SENTINEL');
    for (const member of [developer, product]) {
      expect(fs.readFileSync(path.join(member.projectRoot, 'AGENTS.md'), 'utf8')).toBe(PROJECT_AGENTS_MD);
      expect(fs.existsSync(path.join(member.projectRoot, '.claude', 'CLAUDE.md'))).toBe(false);
      expect(fs.existsSync(path.join(member.projectRoot, 'CLAUDE.local.md'))).toBe(false);
    }
  });

  it('moves Claude blocks an earlier release left in .claude/CLAUDE.md, keeping the authored text', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills']);
    const legacy = path.join(member.projectRoot, '.claude', 'CLAUDE.md');
    fs.writeFileSync(legacy, `# Team notes\n\n${CLAUDEMD_START}\nold selection\n${CLAUDEMD_END}\n`);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);

    expect(result.output).toContain(`Removed teamai instruction blocks from ${legacy}`);
    expect(fs.readFileSync(legacy, 'utf8')).toBe('# Team notes\n');
    expect(fs.readFileSync(path.join(member.projectRoot, '.claude', 'rules', 'teamai-context.md'), 'utf8')).toContain('DEVELOPMENT-SENTINEL');
  });

  it('gives Cursor an always-applied teamai-context.mdc in both scopes', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.cursor/skills']);
    const projectRule = path.join(member.projectRoot, '.cursor', 'rules', 'teamai-context.mdc');

    for (let i = 0; i < 2; i++) {
      const result = await pullAs(member);
      expect(result.code, result.output).toBe(0);
    }
    const rule = fs.readFileSync(projectRule, 'utf8');
    expect(rule.startsWith('---\nalwaysApply: true\n---\n\n')).toBe(true);
    expect(rule).toContain('DEVELOPMENT-SENTINEL');
    expect(rule).toContain(RECALL_START);
    expect(fs.readFileSync(path.join(member.projectRoot, 'AGENTS.md'), 'utf8')).toBe(PROJECT_AGENTS_MD);

    const user = makeUserSandbox(['.cursor']);
    sandboxes.push(user.sandbox);
    const userPull = await runCLI(['pull'], { HOME: user.home }, user.sandbox);
    expect(userPull.code, userPull.output).toBe(0);
    const userRule = fs.readFileSync(path.join(user.home, '.cursor', 'rules', 'teamai-context.mdc'), 'utf8');
    expect(userRule.startsWith('---\nalwaysApply: true\n---\n\n')).toBe(true);
    expect(userRule).toContain(CLAUDEMD_START);
    expect(fs.existsSync(path.join(user.home, 'AGENTS.md'))).toBe(false);
  });

  it('gives CodeBuddy and WorkBuddy one shared rule file and keeps it while either tool remains', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.codebuddy/skills', '.workbuddy/skills']);
    const rule = path.join(member.projectRoot, '.codebuddy', 'rules', 'teamai-context.md');
    const legacy = path.join(member.projectRoot, '.codebuddy', 'CODEBUDDY.md');
    const agentsMd = path.join(member.projectRoot, 'AGENTS.md');
    fs.writeFileSync(legacy, `# CodeBuddy notes\n\n${CLAUDEMD_START}\nold selection\n${CLAUDEMD_END}\n`);
    fs.writeFileSync(agentsMd, `${PROJECT_AGENTS_MD}\n${CULTURE_START}\nold culture\n${CULTURE_END}\n`);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);

    const content = fs.readFileSync(rule, 'utf8');
    expect(content.startsWith('---\nalwaysApply: true\n---\n\n')).toBe(true);
    expect(content).toContain('DEVELOPMENT-SENTINEL');
    expect(content.split(CLAUDEMD_START).length - 1).toBe(1);
    expect(fs.existsSync(path.join(member.projectRoot, '.workbuddy', 'rules', 'teamai-context.md'))).toBe(false);
    expect(fs.readFileSync(legacy, 'utf8')).toBe('# CodeBuddy notes\n');
    expect(fs.readFileSync(agentsMd, 'utf8')).toBe(PROJECT_AGENTS_MD);

    const uninstall = await runCLI(['uninstall', '--agent', 'workbuddy', '--force'], { HOME: member.home }, member.projectRoot);
    expect(uninstall.code, uninstall.output).toBe(0);
    expect(fs.readFileSync(rule, 'utf8')).toContain('DEVELOPMENT-SENTINEL');
  });

  it('gives WorkBuddy its user blocks in ~/.workbuddy/rules, not ~/AGENTS.md', async () => {
    const { sandbox, home } = makeUserSandbox(['.workbuddy']);
    sandboxes.push(sandbox);

    const result = await runCLI(['pull'], { HOME: home }, sandbox);
    expect(result.code, result.output).toBe(0);

    const rule = fs.readFileSync(path.join(home, '.workbuddy', 'rules', 'teamai-context.md'), 'utf8');
    expect(rule.startsWith('---\nalwaysApply: true\n---\n\n')).toBe(true);
    expect(rule).toContain(CLAUDEMD_START);
    expect(fs.existsSync(path.join(home, 'AGENTS.md'))).toBe(false);
  });
});
