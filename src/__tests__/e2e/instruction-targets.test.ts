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

function runCLI(args: string[], env: Record<string, string>, cwd: string, stdin = ''): Promise<RunResult & { stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let output = '';
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.stdin.end(stdin);
    child.on('close', (code) => resolve({ code, output, stdout }));
  });
}

/** The context `teamai hook-dispatch instructions` hands an extension for a session in `cwd`. */
async function sessionInstructions(tool: string, home: string, cwd: string): Promise<string> {
  const result = await runCLI(['hook-dispatch', 'instructions', '--tool', tool], { HOME: home }, cwd, JSON.stringify({ cwd }));
  expect(result.code, result.output).toBe(0);
  if (!result.stdout.trim()) return '';
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

/** A user-scope sandbox HOME with the given tool directories installed. */
function makeUserSandbox(toolDirs: string[], options: { rule?: boolean } = {}): { sandbox: string; home: string } {
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
  if (options.rule) {
    fs.mkdirSync(path.join(remote, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'rules', 'style.md'), 'RULE-SENTINEL: keep functions small.\n');
  }
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

/**
 * Where a member's project config and team clone live once the first pull has
 * moved them out of the project's `.teamai/` into the per-project data home.
 */
function memberData(member: ProjectMember): { config: string; teamRepo: string } {
  const projects = path.join(member.home, '.teamai', 'projects');
  const [dir] = fs.readdirSync(projects);
  return { config: path.join(projects, dir, 'config.yaml'), teamRepo: path.join(projects, dir, 'team-repo') };
}

const pullAs = (member: ProjectMember, args: string[] = [], env: Record<string, string> = {}): Promise<RunResult> =>
  runCLI(['pull', '--force', ...args], { HOME: member.home, ...env }, member.projectRoot);

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

  it('gives Hermes its user blocks in $HERMES_HOME/SOUL.md beside the rules block, and moves them out of ~/AGENTS.md', async () => {
    const { sandbox, home } = makeUserSandbox(['.claude'], { rule: true });
    sandboxes.push(sandbox);
    const hermesHome = path.join(sandbox, 'hermes-home');
    fs.mkdirSync(hermesHome, { recursive: true });
    const soul = path.join(hermesHome, 'SOUL.md');
    fs.writeFileSync(soul, '# Persona\n');
    const agentsMd = path.join(home, 'AGENTS.md');
    fs.writeFileSync(agentsMd, `${CULTURE_START}\nold culture\n${CULTURE_END}\n`);

    const result = await runCLI(['pull'], { HOME: home, HERMES_HOME: hermesHome }, sandbox);
    expect(result.code, result.output).toBe(0);

    const content = fs.readFileSync(soul, 'utf8');
    expect(content).toContain('# Persona');
    expect(content).toContain('<!-- [teamai:rules:start] -->');
    expect(content).toContain('RULE-SENTINEL');
    expect(content).toContain(CULTURE_START);
    expect(content).toContain(CLAUDEMD_START);
    expect(fs.existsSync(agentsMd)).toBe(false);

    // A second pull keeps both blocks, and a project pull leaves the user blocks alone.
    const again = await runCLI(['pull', '--force'], { HOME: home, HERMES_HOME: hermesHome }, sandbox);
    expect(again.code, again.output).toBe(0);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills']);
    const projectPull = await runCLI(['pull', '--force'], { HOME: member.home, HERMES_HOME: hermesHome }, member.projectRoot);
    expect(projectPull.code, projectPull.output).toBe(0);
    const after = fs.readFileSync(soul, 'utf8');
    expect(after).toContain(CULTURE_START);
    expect(after).toContain('Shared team instructions.');
    expect(after).not.toContain('DEVELOPMENT-SENTINEL');
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

  it('gives Oh My Pi its project blocks through the extension, its user blocks in RULES.md, and frees both context files', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const fixture = makeTeamAndProject(sandbox);
    const developer = makeProjectMember(sandbox, fixture, 'dev', 'developer', ['.omp/skills']);
    const product = makeProjectMember(sandbox, fixture, 'pm', 'product', ['.omp/skills']);
    const legacy = path.join(developer.projectRoot, '.omp', 'AGENTS.md');
    fs.writeFileSync(legacy, `${CLAUDEMD_START}\nold selection\n${CLAUDEMD_END}\n`);
    for (const member of [developer, product]) {
      fs.mkdirSync(path.join(member.home, '.omp'), { recursive: true });
      const result = await pullAs(member);
      expect(result.code, result.output).toBe(0);
    }

    expect(fs.existsSync(legacy)).toBe(false);
    const sub = path.join(developer.projectRoot, 'src');
    fs.mkdirSync(sub, { recursive: true });
    const devContext = await sessionInstructions('omp', developer.home, sub);
    expect(devContext).toContain('DEVELOPMENT-SENTINEL');
    expect(devContext).not.toContain('PRODUCT-SENTINEL');
    expect(devContext).toContain('Acme');
    expect(devContext).toContain('teamai-recall');
    const pmContext = await sessionInstructions('omp', product.home, product.projectRoot);
    expect(pmContext).toContain('PRODUCT-SENTINEL');
    expect(pmContext).not.toContain('DEVELOPMENT-SENTINEL');
    expect(await sessionInstructions('claude', developer.home, developer.projectRoot)).toBe('');
    for (const member of [developer, product]) {
      expect(fs.readFileSync(path.join(member.projectRoot, 'AGENTS.md'), 'utf8')).toBe(PROJECT_AGENTS_MD);
    }

    const user = makeUserSandbox(['.omp']);
    sandboxes.push(user.sandbox);
    const userContextFile = path.join(user.home, '.omp', 'agent', 'AGENTS.md');
    fs.mkdirSync(path.dirname(userContextFile), { recursive: true });
    fs.writeFileSync(userContextFile, `${CULTURE_START}\nold culture\n${CULTURE_END}\n`);
    const userPull = await runCLI(['pull'], { HOME: user.home }, user.sandbox);
    expect(userPull.code, userPull.output).toBe(0);
    expect(fs.readFileSync(path.join(user.home, '.omp', 'agent', 'RULES.md'), 'utf8')).toContain(CLAUDEMD_START);
    expect(fs.existsSync(userContextFile)).toBe(false);
    expect(await sessionInstructions('omp', user.home, user.sandbox)).toBe('');
  });

  it('gives Pi its project blocks through the extension and stops writing the project AGENTS.md', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'pm', 'product', ['.pi/skills']);
    const agentsMd = path.join(member.projectRoot, 'AGENTS.md');
    fs.writeFileSync(agentsMd, `${PROJECT_AGENTS_MD}\n${CLAUDEMD_START}\nanother member's selection\n${CLAUDEMD_END}\n`);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);

    expect(fs.readFileSync(agentsMd, 'utf8')).toBe(PROJECT_AGENTS_MD);
    const context = await sessionInstructions('pi', member.home, member.projectRoot);
    expect(context).toContain('PRODUCT-SENTINEL');
    expect(context).not.toContain('DEVELOPMENT-SENTINEL');
    expect(context).toContain('Acme');
  });

  it('gives Hermes its project blocks through its plugin and frees the project AGENTS.md', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', []);
    const hermesHome = path.join(sandbox, 'hermes-home');
    fs.mkdirSync(hermesHome, { recursive: true });
    const agentsMd = path.join(member.projectRoot, 'AGENTS.md');
    fs.writeFileSync(agentsMd, `${PROJECT_AGENTS_MD}\n${CULTURE_START}\nold culture\n${CULTURE_END}\n`);

    const result = await pullAs(member, [], { HERMES_HOME: hermesHome });
    expect(result.code, result.output).toBe(0);

    expect(fs.readFileSync(agentsMd, 'utf8')).toBe(PROJECT_AGENTS_MD);
    expect(fs.readFileSync(path.join(hermesHome, 'plugins', 'teamai-instructions', '__init__.py'), 'utf8'))
      .toContain('register_system_prompt_section');
    expect(fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8')).toMatch(/plugins:\n\s+enabled:\n\s+- teamai-instructions/);
    const sub = path.join(member.projectRoot, 'docs');
    fs.mkdirSync(sub, { recursive: true });
    const run = await runCLI(['hook-dispatch', 'instructions', '--tool', 'hermes'], { HOME: member.home, HERMES_HOME: hermesHome }, sub, JSON.stringify({ cwd: sub }));
    const context = JSON.parse(run.stdout).hookSpecificOutput.additionalContext as string;
    expect(context).toContain('DEVELOPMENT-SENTINEL');
    expect(context).not.toContain('PRODUCT-SENTINEL');
    expect(context).not.toContain('teamai-recall');
  });

  it('says Hermes cannot load project instructions over its 4,000-character section, without cutting them or using AGENTS.md', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', []);
    const teamRepo = path.join(member.projectRoot, '.teamai', 'team-repo');
    fs.writeFileSync(path.join(teamRepo, 'claudemd', 'development', 'long.md'), `${'Long developer guidance. '.repeat(200)}\n`);
    const hermesHome = path.join(sandbox, 'hermes-home');
    fs.mkdirSync(hermesHome, { recursive: true });

    const result = await pullAs(member, [], { HERMES_HOME: hermesHome });
    expect(result.code, result.output).toBe(0);

    expect(result.output).toMatch(/hermes cannot load this project's team instructions: they are \d+ characters, over the 4000-character limit/);
    expect(fs.readFileSync(path.join(member.projectRoot, 'AGENTS.md'), 'utf8')).toBe(PROJECT_AGENTS_MD);
  });

  it('gives OpenCode its project blocks in .opencode/teamai-context.md, registered in .opencode/opencode.json', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.opencode/skills']);
    const config = path.join(member.projectRoot, '.opencode', 'opencode.json');
    fs.writeFileSync(config, JSON.stringify({ instructions: ['docs/style.md'], theme: 'dark' }, null, 2));

    for (let i = 0; i < 2; i++) {
      const result = await pullAs(member);
      expect(result.code, result.output).toBe(0);
    }

    expect(fs.readFileSync(path.join(member.projectRoot, '.opencode', 'teamai-context.md'), 'utf8')).toContain('DEVELOPMENT-SENTINEL');
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({ instructions: ['docs/style.md', '.opencode/teamai-context.md'], theme: 'dark' });
    expect(fs.existsSync(path.join(member.projectRoot, 'opencode.json'))).toBe(false);
    expect(fs.readFileSync(path.join(member.projectRoot, 'AGENTS.md'), 'utf8')).toBe(PROJECT_AGENTS_MD);

    const uninstall = await runCLI(['uninstall', '--agent', 'opencode', '--force'], { HOME: member.home }, member.projectRoot);
    expect(uninstall.code, uninstall.output).toBe(0);
    expect(fs.existsSync(path.join(member.projectRoot, '.opencode', 'teamai-context.md'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({ instructions: ['docs/style.md'], theme: 'dark' });
  });

  it('gives OpenCode its user blocks in its config dir, registered with an absolute path, and adds no copy beside its Claude fallback', async () => {
    const own = makeUserSandbox(['.config/opencode']);
    sandboxes.push(own.sandbox);
    const ocDir = path.join(own.home, '.config', 'opencode');
    fs.writeFileSync(path.join(ocDir, 'AGENTS.md'), '# My OpenCode notes\n');
    fs.writeFileSync(path.join(ocDir, 'opencode.json'), JSON.stringify({ instructions: ['~/notes.md'] }));
    const result = await runCLI(['pull'], { HOME: own.home }, own.sandbox);
    expect(result.code, result.output).toBe(0);
    const contextFile = path.join(ocDir, 'teamai-context.md');
    expect(fs.readFileSync(contextFile, 'utf8')).toContain(CLAUDEMD_START);
    expect(JSON.parse(fs.readFileSync(path.join(ocDir, 'opencode.json'), 'utf8')).instructions).toEqual(['~/notes.md', contextFile]);
    expect(fs.readFileSync(path.join(ocDir, 'AGENTS.md'), 'utf8')).toBe('# My OpenCode notes\n');

    // No native user AGENTS.md: OpenCode falls back to ~/.claude/CLAUDE.md, which already holds the blocks.
    const fallback = makeUserSandbox(['.config/opencode', '.claude']);
    sandboxes.push(fallback.sandbox);
    const viaClaude = await runCLI(['pull'], { HOME: fallback.home }, fallback.sandbox);
    expect(viaClaude.code, viaClaude.output).toBe(0);
    expect(fs.readFileSync(path.join(fallback.home, '.claude', 'CLAUDE.md'), 'utf8')).toContain(CLAUDEMD_START);
    expect(fs.existsSync(path.join(fallback.home, '.config', 'opencode', 'teamai-context.md'))).toBe(false);
    expect(viaClaude.output).toContain('OpenCode reads the team instructions from');
    const recall = await runCLI(['recall', 'enable'], { HOME: fallback.home }, fallback.sandbox);
    expect(recall.code, recall.output).toBe(0);
    expect(fs.existsSync(path.join(fallback.home, '.config', 'opencode', 'teamai-context.md'))).toBe(false);
  });

  it('has doctor report what keeps a tool from loading its instructions, not just whether a file was written', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.opencode/skills']);
    const pulled = await pullAs(member);
    expect(pulled.code, pulled.output).toBe(0);
    const doctor = async (): Promise<Map<string, { ok: boolean; fix?: string }>> => {
      const run = await runCLI(['doctor', '--json'], { HOME: member.home }, member.projectRoot);
      const report = JSON.parse(run.stdout) as { checks: Array<{ name: string; ok: boolean; fix?: string }> };
      return new Map(report.checks.map((c) => [c.name, c]));
    };

    const healthy = await doctor();
    expect(healthy.get('Team instructions are current for opencode')?.ok).toBe(true);
    expect(healthy.get('Team instructions are listed in opencode instructions')?.ok).toBe(true);
    expect(healthy.get('No team instruction blocks are left in files no tool loads them from')?.ok).toBe(true);

    fs.writeFileSync(path.join(member.projectRoot, '.opencode', 'opencode.json'), '{}\n');
    fs.appendFileSync(path.join(member.projectRoot, 'AGENTS.md'), `\n${CLAUDEMD_START}\nold\n${CLAUDEMD_END}\n`);
    const broken = await doctor();
    expect(broken.get('Team instructions are listed in opencode instructions')).toMatchObject({ ok: false });
    expect(broken.get('Team instructions are listed in opencode instructions')?.fix).toContain('.opencode/teamai-context.md');
    expect(broken.get('No team instruction blocks are left in files no tool loads them from')).toMatchObject({ ok: false });
    expect(broken.get('No team instruction blocks are left in files no tool loads them from')?.fix).toContain('AGENTS.md');
  });

  const ALL_FILE_TOOLS = ['.claude/skills', '.cursor/skills', '.codebuddy/skills', '.workbuddy/skills', '.opencode/skills', '.omp/skills', '.pi/skills'];

  it('keeps the shared AGENTS.md byte-identical for two roles with every tool installed, across role and content changes', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const fixture = makeTeamAndProject(sandbox);
    const developer = makeProjectMember(sandbox, fixture, 'dev', 'developer', ALL_FILE_TOOLS);
    const product = makeProjectMember(sandbox, fixture, 'pm', 'product', ALL_FILE_TOOLS);
    const agentsMd = (m: ProjectMember) => fs.readFileSync(path.join(m.projectRoot, 'AGENTS.md'), 'utf8');
    const generated = (m: ProjectMember) => fs.readFileSync(path.join(m.projectRoot, '.claude', 'rules', 'teamai-context.md'), 'utf8');

    for (const member of [developer, product]) {
      const result = await pullAs(member);
      expect(result.code, result.output).toBe(0);
      expect(agentsMd(member)).toBe(PROJECT_AGENTS_MD);
    }
    expect(generated(developer)).not.toBe(generated(product));

    // The developer changes role, and the team edits a claudemd file.
    const { config, teamRepo } = memberData(developer);
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('primaryRole: developer', 'primaryRole: product'));
    fs.writeFileSync(path.join(teamRepo, 'claudemd', 'common.md'), 'COMMON-SENTINEL, revised.\n');
    const again = await pullAs(developer);
    expect(again.code, again.output).toBe(0);
    expect(agentsMd(developer)).toBe(PROJECT_AGENTS_MD);
    expect(generated(developer)).toContain('PRODUCT-SENTINEL');
    expect(generated(developer)).not.toContain('DEVELOPMENT-SENTINEL');
    expect(generated(developer)).toContain('revised');
  });

  it('leaves an existing task diff and the staged diff unchanged when generated targets are excluded', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ALL_FILE_TOOLS);
    const root = member.projectRoot;
    // The team's own choice, made by the test, never by teamai.
    const exclude = path.join(root, '.git', 'info', 'exclude');
    fs.appendFileSync(exclude, ['.teamai/', '.teamai.bak/', '.claude/', '.cursor/', '.codebuddy/', '.workbuddy/', '.opencode/', '.omp/', '.pi/', ''].join('\n'));
    const first = await pullAs(member);
    expect(first.code, first.output).toBe(0);

    fs.writeFileSync(path.join(root, 'app.txt'), 'v2 staged\n');
    git(['add', 'app.txt'], root);
    fs.writeFileSync(path.join(root, 'app.txt'), 'v3 unstaged\n');
    const snapshot = () => ({
      diff: execFileSync('git', ['diff'], { cwd: root, encoding: 'utf8' }),
      staged: execFileSync('git', ['diff', '--cached'], { cwd: root, encoding: 'utf8' }),
      status: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
      index: fs.readFileSync(path.join(root, '.git', 'index')).toString('base64'),
      exclude: fs.readFileSync(exclude, 'utf8'),
    });
    const before = snapshot();

    fs.writeFileSync(path.join(memberData(member).teamRepo, 'claudemd', 'common.md'), 'COMMON-SENTINEL, updated instructions.\n');
    const update = await pullAs(member);
    expect(update.code, update.output).toBe(0);

    expect(fs.readFileSync(path.join(root, '.claude', 'rules', 'teamai-context.md'), 'utf8')).toContain('updated instructions');
    expect(snapshot()).toEqual(before);
  });

  it('removes the generated content when recall is disabled, a source is deleted, or a namespace is left', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills', '.omp/skills']);
    fs.mkdirSync(path.join(member.home, '.omp'), { recursive: true });
    const context = () => fs.readFileSync(path.join(member.projectRoot, '.claude', 'rules', 'teamai-context.md'), 'utf8');
    expect((await pullAs(member)).code).toBe(0);
    expect(context()).toContain(RECALL_START);
    expect(await sessionInstructions('omp', member.home, member.projectRoot)).toContain('teamai-recall');

    const disable = await runCLI(['recall', 'disable'], { HOME: member.home }, member.projectRoot);
    expect(disable.code, disable.output).toBe(0);
    expect(context()).not.toContain(RECALL_START);
    expect(await sessionInstructions('omp', member.home, member.projectRoot)).not.toContain('teamai-recall');

    const { config, teamRepo } = memberData(member);
    fs.rmSync(path.join(teamRepo, 'claudemd', 'common.md'));
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('primaryRole: developer', 'primaryRole: product'));
    expect((await pullAs(member)).code).toBe(0);
    expect(context()).not.toContain('COMMON-SENTINEL');
    expect(context()).not.toContain('DEVELOPMENT-SENTINEL');
    const omp = await sessionInstructions('omp', member.home, member.projectRoot);
    expect(omp).not.toContain('COMMON-SENTINEL');
    expect(omp).not.toContain('DEVELOPMENT-SENTINEL');
    expect(omp).toContain('PRODUCT-SENTINEL');
  });

  it('leaves a tracked Copilot file alone for a member without Copilot', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-')));
    sandboxes.push(sandbox);
    const member = makeProjectMember(sandbox, makeTeamAndProject(sandbox), 'dev', 'developer', ['.claude/skills']);
    const copilot = path.join(member.projectRoot, '.github', 'copilot-instructions.md');
    fs.mkdirSync(path.dirname(copilot), { recursive: true });
    // A teammate with Copilot committed their selection; this member has no Copilot.
    fs.writeFileSync(copilot, `# Copilot notes\n\n${CLAUDEMD_START}\nthe teammate's selection\n${CLAUDEMD_END}\n`);
    git(['add', '.github/copilot-instructions.md'], member.projectRoot);
    git(['commit', '-q', '-m', 'copilot instructions'], member.projectRoot);

    const result = await pullAs(member);
    expect(result.code, result.output).toBe(0);

    expect(execFileSync('git', ['status', '--porcelain', '--', '.github', 'AGENTS.md'], { cwd: member.projectRoot, encoding: 'utf8' })).toBe('');
  });
});
