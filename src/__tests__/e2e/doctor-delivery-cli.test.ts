import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

interface CheckResult { name: string; ok: boolean; fix?: string }
interface DoctorReport { ok: boolean; checks: CheckResult[] }

/**
 * The delivery checks through the real built CLI (#624): a team repo that ships
 * one of every per-tool resource, a HOME where nothing was delivered, and the
 * same HOME once each file is in place.
 */
describe('teamai doctor delivery checks (e2e)', () => {
  let sandbox: string;
  let home: string;
  let repo: string;

  function runDoctor(): DoctorReport {
    const result = spawnSync(process.execPath, [CLI, 'doctor', '--json'], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, SHELL: '/bin/bash', FORCE_COLOR: '0' },
      encoding: 'utf8',
    });
    return JSON.parse(result.stdout) as DoctorReport;
  }

  function check(report: DoctorReport, name: string): CheckResult {
    const found = report.checks.find((c) => c.name === name);
    if (!found) throw new Error(`no check named ${name} in: ${report.checks.map((c) => c.name).join(', ')}`);
    return found;
  }

  function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error('Run npm run build before the E2E test.');

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-delivery-e2e-'));
    home = path.join(sandbox, 'home');
    repo = path.join(sandbox, 'team-repo');

    const toolDirs = [
      '.claude/skills', '.claude/rules', '.claude/agents',
      '.cursor/rules',
      '.codex/agents',
      '.codebuddy/rules', '.codebuddy/agents',
      '.config/opencode/rules',
      '.teamai',
    ];
    for (const dir of toolDirs) fs.mkdirSync(path.join(home, dir), { recursive: true });

    write(path.join(repo, 'teamai.yaml'), [
      'team: e2e',
      'repo: team/repo',
      'provider: git',
      'toolPaths:',
      '  claude:',
      '    settings: .claude/settings.json',
      '    skills: .claude/skills',
      '    rules: .claude/rules',
      '    agents: .claude/agents',
      '    mcp: .claude.json',
      '  cursor:',
      '    rules: .cursor/rules',
      '  codex:',
      '    agents: .codex/agents',
      '  codebuddy:',
      '    rules: .codebuddy/rules',
      '    agents: .codebuddy/agents',
      '  opencode:',
      '    rules: .opencode/rules',
      '    userScope:',
      '      rules: .config/opencode/rules',
    ].join('\n'));

    write(path.join(repo, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: d\n---\n');
    write(path.join(repo, 'rules', 'coding-style.md'), 'Coding style body\n');
    write(path.join(repo, 'agents', 'reviewer.yaml'), 'name: reviewer\ndescription: reviews\ninstructions: |\n  Review.\n');
    write(path.join(repo, 'mcp', 'mcp.yaml'), [
      'servers:',
      '  - name: jira',
      '    transport: stdio',
      '    command: jira-server',
      '    env:',
      '      TOKEN: "${JIRA_PASSWORD}"',
    ].join('\n'));
    // Deliberately the shorthand form #662 is about.
    write(path.join(repo, 'env', 'env.yaml'), 'JIRA_PASSWORD: "s3cret"\n');

    write(path.join(home, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${JSON.stringify(repo)}`,
      '  remote: https://example.invalid/team/repo.git',
      '  kind: git',
      'username: e2e-user',
      'updatePolicy: skip',
      'scope: user',
      'enabledAgents:',
      '  - claude',
      '  - cursor',
      '  - codex',
      '  - codebuddy',
      '  - opencode',
    ].join('\n'));
    write(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'teamai hook-dispatch' }] }] } }),
    );
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('names every resource that never reached its tool', () => {
    const report = runDoctor();

    expect(report.ok).toBe(false);
    expect(check(report, 'Skills delivered to claude').ok).toBe(false);
    expect(check(report, 'Rules delivered to claude').fix).toContain('coding-style');
    expect(check(report, 'Rules delivered to cursor').fix).toContain('.cursor/rules');
    expect(check(report, 'Agents delivered to codex').fix).toContain('reviewer');
    expect(check(report, 'Rules delivered to codebuddy').ok).toBe(false);
    expect(check(report, 'Agents delivered to codebuddy').ok).toBe(false);
    // OpenCode's user scope reads a different prefix than its project paths.
    expect(check(report, 'Rules delivered to opencode').fix).toContain('.config/opencode/rules');
  });

  it('names the variable an MCP server was skipped for, and points at env.yaml', () => {
    const mcp = check(runDoctor(), 'MCP servers delivered to claude');

    expect(mcp.ok).toBe(false);
    expect(mcp.fix).toContain('JIRA_PASSWORD');
    expect(mcp.fix).toContain('variables:');
  });

  it('reports the shorthand env.yaml that parses to no variables at all', () => {
    const env = check(runDoctor(), 'Env variables injected in shell profile');

    expect(env.ok).toBe(false);
    expect(env.fix).toContain('declares no variables');
  });

  it('passes every check once each file is where its tool reads it', () => {
    write(path.join(home, '.claude/skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: d\n---\n');
    write(path.join(home, '.claude/rules/coding-style.md'), 'Coding style body\n');
    write(path.join(home, '.cursor/rules/coding-style.mdc'), '---\nalwaysApply: true\n---\n\nCoding style body\n');
    write(path.join(home, '.claude/agents/reviewer.md'), 'rendered');
    write(path.join(home, '.codex/agents/reviewer.toml'), 'rendered');
    write(path.join(home, '.codebuddy/rules/coding-style.md'), 'Coding style body\n');
    write(path.join(home, '.codebuddy/agents/reviewer.md'), 'rendered');
    write(path.join(home, '.config/opencode/rules/coding-style.md'), 'Coding style body\n');
    // The entry teamai renders for claude, placeholder resolved — the check
    // compares the value, so a hand-shaped entry of the same name is not it.
    write(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { jira: { type: 'stdio', command: 'jira-server', env: { TOKEN: 's3cret' } } },
    }));
    write(path.join(repo, 'env', 'env.yaml'), 'variables:\n  - key: JIRA_PASSWORD\n    value: "s3cret"\n');
    write(path.join(home, '.teamai', 'env.sh'), "export JIRA_PASSWORD='s3cret'\n");
    // The machine-local KEY=VALUE backup the env channel writes beside env.sh;
    // it is what the MCP placeholder resolution reads.
    write(path.join(home, '.teamai', 'env'), 'JIRA_PASSWORD=s3cret\n');
    const envSh = path.join(home, '.teamai', 'env.sh');
    write(path.join(home, '.bashrc'), [
      '# [teamai:env:start]',
      `[ -f ${envSh} ] && source ${envSh}`,
      '# [teamai:env:end]',
    ].join('\n'));

    const report = runDoctor();
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);

    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('reports a server of your own holding a team name, which a pull will not overwrite', () => {
    write(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { jira: { type: 'stdio', command: 'my-own-jira' } },
    }));

    const mcp = check(runDoctor(), 'MCP servers delivered to claude');

    expect(mcp.ok).toBe(false);
    expect(mcp.fix).toContain("not the team's definition: jira");
    expect(mcp.fix).toContain('--force');
  });

  it('reports an env.sh left on the value env.yaml replaced', () => {
    write(path.join(home, '.teamai', 'env.sh'), "export JIRA_PASSWORD='rotated-away'\n");

    const env = check(runDoctor(), 'Env variables injected in shell profile');

    expect(env.ok).toBe(false);
    expect(env.fix).toContain('JIRA_PASSWORD');
    expect(env.fix).toContain('stale value');
  });
});
