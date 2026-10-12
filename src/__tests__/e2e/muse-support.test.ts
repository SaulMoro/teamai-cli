import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Muse Code support ──────────────────────────────────────────────────────
//
// End-to-end leg for Muse Code delivery, run through the ACTUAL compiled CLI
// against a local bare team repo. Every expected path below is where Muse Code
// 1.4.6 reads its resources, observed with the real binary: user skills in
// ~/.config/muse/skills.
//
// The remote is a synthetic HTTPS URL bridged to a local bare repo through
// git's url.<base>.insteadOf — the same no-network setup as
// trae-support-904.test.ts.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/muse.git';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface RunResult {
  code: number | null;
  output: string;
}

function git(args: string[], cwd: string, home?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...(home ? { HOME: home, USERPROFILE: home } : {}) },
  }).trim();
}

function runCLI(args: string[], cwd: string, home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        ...GIT_ENV,
        HOME: home,
        USERPROFILE: home,
        FORCE_COLOR: '0',
        TEAMAI_NONINTERACTIVE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('Muse Code resource delivery', () => {
  let sandbox: string;
  let remote: string;

  /** A scratch HOME whose git bridges the fake team URL to the local bare repo. */
  function makeHome(name: string): string {
    const home = path.join(sandbox, name);
    fs.mkdirSync(home, { recursive: true });
    git(['config', '--global', `url.${remote}.insteadOf`, FAKE_URL], sandbox, home);
    return home;
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-muse-e2e-'));
    const seed = path.join(sandbox, 'seed');
    remote = path.join(sandbox, 'team.git');

    fs.mkdirSync(path.join(seed, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: muse-e2e',
      `repo: ${FAKE_URL}`,
      'provider: git',
      'reviewers: []',
      '',
    ].join('\n'));
    fs.writeFileSync(
      path.join(seed, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Muse fixture skill\n---\n\n# demo\n',
    );

    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('delivers team skills and the teamai skill to ~/.config/muse/skills in user scope', async () => {
    const workDir = path.join(sandbox, 'user-work');
    fs.mkdirSync(workDir, { recursive: true });
    const home = makeHome('home-user');
    // The Muse installer creates its config root on install.
    fs.mkdirSync(path.join(home, '.config', 'muse'), { recursive: true });

    const result = await runCLI(
      ['init', FAKE_URL, '--scope', 'user', '--role', 'dev', '--agent', 'muse', '--force'],
      workDir,
      home,
    );
    expect(result.code, result.output).toBe(0);

    const skills = path.join(home, '.config', 'muse', 'skills');
    expect(fs.readFileSync(path.join(skills, 'demo', 'SKILL.md'), 'utf8')).toContain('Muse fixture skill');
    expect(fs.existsSync(path.join(skills, 'teamai', 'SKILL.md'))).toBe(true);
  }, 90_000);

  it('does not take a Codex-only machine for a Muse Code install', async () => {
    const workDir = path.join(sandbox, 'codex-work');
    fs.mkdirSync(workDir, { recursive: true });
    const home = makeHome('home-codex');
    // Codex users have ~/.agents (its shared skills root) and ~/.config.
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config'), { recursive: true });

    const result = await runCLI(['init', FAKE_URL, '--scope', 'user', '--role', 'dev', '--force'], workDir, home);
    expect(result.code, result.output).toBe(0);

    expect(fs.existsSync(path.join(home, '.config', 'muse'))).toBe(false);
  }, 90_000);
});
