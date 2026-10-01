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
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-945-e2e-'));
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
});
