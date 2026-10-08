import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CLAUDE_HOOK_OTHER_HOST_SKIP } from '../../hooks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'dist', 'index.js');

function runCLI(cwd: string, home: string, action = 'inject'): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, 'hooks', action], {
      cwd,
      env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('issue #373 project hook isolation (real CLI)', () => {
  let sandbox: string;
  let home: string;
  let projectA: string;
  let projectB: string;
  let worktreeA: string;

  type Settings = { hooks: { SessionStart?: Array<unknown>; Stop: Array<{ description?: string; hooks: Array<{ command: string }> }> } };
  const expectedCommand = (file: string, command: string): string =>
    file.includes('.claude') ? `${CLAUDE_HOOK_OTHER_HOST_SKIP}${command}` : command;
  const readSettings = (file: string): Settings => JSON.parse(fs.readFileSync(file, 'utf8')) as Settings;
  const mainFiles = (project: string): string[] => [
    path.join(project, '.claude', 'settings.local.json'),
    path.join(project, '.codex', 'hooks.json'),
  ];

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error('Run npm run build before e2e tests');
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-373-e2e-'));
    home = path.join(sandbox, 'home');
    projectA = path.join(sandbox, 'project-a');
    projectB = path.join(sandbox, 'project-b');
    worktreeA = path.join(sandbox, 'worktree-a');
    for (const tool of ['.claude', '.codex', '.codebuddy']) {
      fs.mkdirSync(path.join(home, tool), { recursive: true });
    }
    for (const project of [projectA, projectB]) {
      fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(project, '.teamai', 'team-repo', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(project, '.teamai', 'config.yaml'), [
        'repo:',
        `  localPath: ${path.join(project, '.teamai', 'team-repo')}`,
        '  remote: https://example.test/team.git',
        'username: e2e',
        'scope: project',
        'codexTrustEnabled: false',
        `projectRoot: ${project}`,
      ].join('\n') + '\n');
    }
    fs.writeFileSync(path.join(projectA, '.teamai', 'team-repo', 'teamai.yaml'), [
      'team: e2e-team', 'repo: https://example.test/team.git',
      'toolPaths:', '  claude:', '    settings: .claude/settings.json',
      '  codex:', '    settings: .codex/hooks.json',
      '  codebuddy:', '    settings: .codebuddy/settings.json',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(projectB, '.teamai', 'team-repo', 'teamai.yaml'), [
      'team: e2e-team', 'repo: https://example.test/team.git',
      'toolPaths:', '  claude:', '    settings: .claude/settings.json',
      '  codex:', '    settings: .codex/hooks.json',
      '  codebuddy:', '    settings: .codebuddy/settings.json',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(projectA, '.teamai', 'team-repo', 'hooks', 'hooks.yaml'), [
      'hooks:', '  - id: a', '    description: project a', '    event: Stop', '    command: echo A',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(projectB, '.teamai', 'team-repo', 'hooks', 'hooks.yaml'), [
      'hooks:', '  - id: b', '    description: project b', '    event: Stop', '    command: echo B',
    ].join('\n') + '\n');
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'TeamAI CI', GIT_AUTHOR_EMAIL: 'ci@teamai.test',
      GIT_COMMITTER_NAME: 'TeamAI CI', GIT_COMMITTER_EMAIL: 'ci@teamai.test',
    };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectA, env: gitEnv });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'fixture'], { cwd: projectA, env: gitEnv });
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'worktree-a', worktreeA], { cwd: projectA, env: gitEnv });
    // Both legacy configs point at the same team repo; git resolves their main checkout.
    fs.mkdirSync(path.join(worktreeA, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(worktreeA, '.teamai', 'config.yaml'),
      fs.readFileSync(path.join(projectA, '.teamai', 'config.yaml'), 'utf8')
        .replace(`projectRoot: ${projectA}`, `projectRoot: ${worktreeA}`));
  });

  afterAll(() => { if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true }); });

  it('injects both projects, gates execution by cwd, and removes only the caller project', async () => {
    const a = await runCLI(projectA, home);
    const b = await runCLI(projectB, home);
    expect(a.code, a.output).toBe(0);
    expect(b.code, b.output).toBe(0);

    for (const [project, command] of [[projectA, 'echo A'], [projectB, 'echo B']]) {
      for (const file of mainFiles(project)) {
        const settings = readSettings(file);
        expect(settings.hooks.Stop.map((entry) => entry.hooks[0].command)).toEqual([expectedCommand(file, command)]);
        expect(settings.hooks.SessionStart).toBeUndefined();
      }
    }
    for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
      const settings = readSettings(path.join(home, file));
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(settings.hooks.Stop.map((entry) => entry.hooks[0].command).join('\n')).not.toMatch(/echo [AB]/);
    }

    // CodeBuddy still shares HOME and gates each project's team hooks by cwd.
    const settingsPath = path.join(home, '.codebuddy', 'settings.json');
    const team = readSettings(settingsPath).hooks.Stop.filter((entry) => entry.description?.startsWith('[teamai:hook:'));
    expect(team).toHaveLength(2);
    const commandA = team.find((entry) => entry.hooks[0].command.includes('echo A'))!.hooks[0].command;
    const commandB = team.find((entry) => entry.hooks[0].command.includes('echo B'))!.hooks[0].command;
    expect(commandA).toContain('$PWD');
    expect(commandB).toContain('$PWD');
    expect(execFileSync('sh', ['-c', commandA], { cwd: projectA, encoding: 'utf8' })).toBe('A\n');
    expect(execFileSync('sh', ['-c', commandA], { cwd: projectB, encoding: 'utf8' })).toBe('');
    expect(execFileSync('sh', ['-c', commandB], { cwd: projectB, encoding: 'utf8' })).toBe('B\n');
    expect(execFileSync('sh', ['-c', commandB], { cwd: projectA, encoding: 'utf8' })).toBe('');
    expect(JSON.parse(fs.readFileSync(path.join(home, '.teamai', 'managed-hooks.json'), 'utf8')).codebuddy).toHaveLength(2);

    const removed = await runCLI(projectA, home, 'remove');
    expect(removed.code, removed.output).toBe(0);
    for (const file of mainFiles(projectA)) expect(readSettings(file).hooks.Stop ?? []).toEqual([]);
    for (const file of mainFiles(projectB)) {
      expect(readSettings(file).hooks.Stop.map((entry) => entry.hooks[0].command)).toEqual([expectedCommand(file, 'echo B')]);
    }
    const remaining = readSettings(settingsPath).hooks.Stop.filter((entry) => entry.description?.startsWith('[teamai:hook:'));
    expect(remaining.map((entry) => entry.hooks[0].command)).toEqual([commandB]);
    expect(JSON.parse(fs.readFileSync(path.join(home, '.teamai', 'managed-hooks.json'), 'utf8')).codebuddy).toHaveLength(1);
    for (const project of [projectA, projectB]) {
      expect(fs.existsSync(path.join(project, '.codebuddy', 'settings.json'))).toBe(false);
    }
  });

  it('shares one ungated Claude/Codex team-hook file in the main checkout with a linked worktree', async () => {
    const main = await runCLI(projectA, home);
    expect(main.code, main.output).toBe(0);
    const before = mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'));

    const linked = await runCLI(worktreeA, home);
    expect(linked.code, linked.output).toBe(0);
    expect(mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'))).toEqual(before);
    for (const file of mainFiles(worktreeA)) expect(fs.existsSync(file)).toBe(false);
    for (const file of mainFiles(projectA)) {
      const [command] = readSettings(file).hooks.Stop.map((entry) => entry.hooks[0].command);
      expect(command).toBe(expectedCommand(file, 'echo A'));
      expect(command).not.toContain('$PWD');
      expect(execFileSync('sh', ['-c', command], { cwd: worktreeA, encoding: 'utf8' })).toBe('A\n');
      if (file.includes('.claude')) {
        // The main-checkout layout preserves #950's other-host check without a cwd gate.
        const cursorFile = path.join(home, '.cursor', 'hooks.json');
        const env = { ...process.env, HOME: home, CURSOR_VERSION: 'test', CURSOR_PROJECT_DIR: '', COPILOT_PROJECT_DIR: '' };
        fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
        fs.writeFileSync(cursorFile, JSON.stringify({ hooks: { stop: [{ command: 'teamai hook-dispatch stop --tool cursor' }] } }));
        expect(execFileSync('sh', ['-c', command], { cwd: worktreeA, env, encoding: 'utf8' })).toBe('');
        fs.rmSync(cursorFile);
        expect(execFileSync('sh', ['-c', command], { cwd: worktreeA, env, encoding: 'utf8' })).toBe('A\n');
      }
    }
  });

  it('removes the duplicate team hooks an older CLI appended from a linked worktree', async () => {
    const single = mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'));
    // v0.22.0 recorded the worktree's copy in the worktree's own data home and
    // appended a second entry to each main-checkout file.
    const ownership = JSON.parse(fs.readFileSync(path.join(projectA, '.teamai', 'managed-main-checkout-hooks.json'), 'utf8'));
    ownership.codex[0].codexEntryIndex = 1;
    fs.writeFileSync(path.join(worktreeA, '.teamai', 'managed-main-checkout-hooks.json'), JSON.stringify(ownership));
    for (const file of mainFiles(projectA)) {
      const settings = readSettings(file);
      settings.hooks.Stop.push(settings.hooks.Stop[0]);
      fs.writeFileSync(file, JSON.stringify(settings, null, 2));
    }

    const linked = await runCLI(worktreeA, home);
    expect(linked.code, linked.output).toBe(0);
    expect(mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'))).toEqual(single);
    const main = await runCLI(projectA, home);
    expect(main.code, main.output).toBe(0);
    expect(mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'))).toEqual(single);
  });

  it('keeps the main checkout team hooks when a linked worktree removes its own', async () => {
    const shared = mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'));
    const removed = await runCLI(worktreeA, home, 'remove');
    expect(removed.code, removed.output).toBe(0);
    expect(mainFiles(projectA).map((file) => fs.readFileSync(file, 'utf8'))).toEqual(shared);
  });
});
