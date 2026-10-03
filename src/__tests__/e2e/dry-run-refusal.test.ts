import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
  GIT_TERMINAL_PROMPT: '0',
};

/**
 * Every file under `dir` with a hash of its content; `.git` objects aside, and
 * the debug log, which every log.debug and log.error appends to, preview or not.
 */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'objects') walk(full);
      } else if (entry.name !== 'debug.log') {
        files[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(dir);
  return files;
}

// A command that does not honor --dry-run must refuse it, not run for real (#900).
describe('--dry-run on a command with no preview', () => {
  let sandbox: string;
  let home: string;

  function cli(args: string[], cwd = sandbox) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, TEAMAI_E2E_KEY: 'sk-e2e', FORCE_COLOR: '0' },
      encoding: 'utf8',
      input: '',
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  });

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dry-run-refusal-'));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('models remove --dry-run exits 1 and keeps the profile', () => {
    const added = cli(['models', 'add', 'gw', '--name', 'Gateway', '--protocol', 'anthropic', '--base-url', 'https://gw.example.test',
      '--model', 'm1', '--from-env', 'TEAMAI_E2E_KEY']);
    expect(added.output).toContain('Added local model profile');
    const before = snapshot(home);

    const removed = cli(['models', 'remove', 'gw', '--dry-run']);

    expect(removed.code, removed.output).toBe(1);
    expect(removed.output).toContain('teamai models remove has no --dry-run preview, nothing was run');
    expect(snapshot(home)).toEqual(before);
    expect(cli(['models', 'list']).output).toContain('local:gw');
  });

  it('refuses the flag-level cases with no preview and lets their siblings through', () => {
    const before = snapshot(home);

    const extract = cli(['codebase', '--extract', '--dry-run']);
    expect(extract.code, extract.output).toBe(1);
    expect(extract.output).toContain('teamai codebase --extract has no --dry-run preview, nothing was run');

    const http = cli(['init', '--http', 'https://teamai.example.test', '--token', 'k', '--dry-run']);
    expect(http.code, http.output).toBe(1);
    expect(http.output).toContain('teamai init --http has no --dry-run preview, nothing was run');

    const list = cli(['models', 'list', '--dry-run']);
    expect(list.code, list.output).toBe(0);
    expect(list.output).not.toContain('has no --dry-run preview');

    expect(snapshot(home)).toEqual(before);
  });

  // A fresh clone of a single-repo team carries `.teamai/teamai.yaml` with
  // `mode: self`: loading its config bootstraps the machine side (#852).
  it('init . --dry-run on a single-repo clone writes nothing', () => {
    const repo = path.join(sandbox, 'repo');
    fs.mkdirSync(path.join(repo, '.teamai'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: { ...process.env, ...GIT_ENV } });
    fs.writeFileSync(path.join(repo, '.teamai', 'teamai.yaml'),
      ['team: self-e2e', 'repo: local/self-e2e', 'provider: git', 'mode: self', ''].join('\n'));
    execFileSync('git', ['add', '-A'], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
    execFileSync('git', ['commit', '-qm', 'team'], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/self-e2e.git'], { cwd: repo });
    const repoBefore = snapshot(repo);
    const homeBefore = snapshot(home);

    for (const args of [['init', '.', '--dry-run'], ['init', '--self', '--dry-run']]) {
      const result = cli([...args, '--agent', 'claude', '--force'], repo);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('teamai init --self has no --dry-run preview, nothing was run');
    }

    expect(snapshot(repo)).toEqual(repoBefore);
    expect(snapshot(home)).toEqual(homeBefore);
  });

  it('bind-project --dry-run exits 1 and writes nothing', () => {
    const before = snapshot(home);
    const result = cli(['bind-project', '--skip', '--dry-run']);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('teamai bind-project has no --dry-run preview, nothing was run');
    expect(snapshot(home)).toEqual(before);
  });
});
