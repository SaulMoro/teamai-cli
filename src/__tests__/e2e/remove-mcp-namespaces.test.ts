import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── `teamai remove mcp` across namespace files (#707) ─────────────────
//
// A server name can be defined in mcp/mcp.yaml and in any mcp/<ns>/mcp.yaml,
// and each file reaches different members. `remove mcp <name>` follows push's
// convention: the root file when it defines the name, else the one namespace
// file that does; --role / --project pick a namespace, and are required only
// when several namespace files (and not the root) define it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

interface RunResult {
  code: number | null;
  output: string;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

function runCLI(args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output: out }));
  });
}

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

function write(root: string, relativePath: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(root, relativePath), content);
}

const server = (name: string, url: string): string => `  - name: ${name}\n    transport: http\n    url: ${url}\n`;

describe('teamai remove mcp across namespace files (e2e, #707)', () => {
  let sandbox: string;
  let homeDir: string;
  let clone: string;
  let remote: string;
  let env: Record<string, string>;

  /** The file as the pushed removal branch has it. */
  const onBranch = (file: string): string => {
    const branch = git("for-each-ref --format='%(refname:short)' refs/heads/teamai", remote).trim();
    expect(branch).toMatch(/^teamai\/push\//);
    return git(`show ${branch}:${file}`, remote);
  };

  beforeEach(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-remove-mcp-ns-e2e-'));
    homeDir = path.join(sandbox, 'home');
    clone = path.join(homeDir, '.teamai', 'team-repo');
    remote = path.join(sandbox, 'remote.git');

    const seed = path.join(sandbox, 'seed');
    write(seed, 'teamai.yaml', [
      'team: e2e-team',
      'repo: https://example.com/e2e.git',
      'provider: git',
      'usageReport: false',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '',
    ].join('\n'));
    write(seed, 'manifest/projects.yaml', 'version: 1\nprojects:\n  - id: checkout\n    resources: { mcp: [checkout] }\n  - id: billing\n    resources: { mcp: [billing] }\n');
    write(seed, 'mcp/mcp.yaml', `servers:\n${server('db', 'https://db.example.com')}${server('shared', 'https://shared.example.com')}`);
    write(seed, 'mcp/checkout/mcp.yaml', `servers:\n${server('db', 'https://checkout-db.example.com')}${server('orders', 'https://orders.example.com')}`);
    write(seed, 'mcp/billing/mcp.yaml', `servers:\n${server('orders', 'https://billing-orders.example.com')}${server('invoices', 'https://invoices.example.com')}`);
    git('init -q -b main', seed);
    git('add -A', seed);
    git('commit -q -m fixture', seed);
    git(`init -q --bare ${remote}`, sandbox);
    git(`remote add origin ${remote}`, seed);
    git('push -q origin main', seed);

    fs.mkdirSync(path.join(homeDir, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    git(`clone -q -b main ${remote} ${clone}`, sandbox);
    write(homeDir, '.teamai/config.yaml', [
      'repo:',
      `  localPath: ${clone}`,
      '  remote: https://example.com/e2e.git',
      'username: e2e',
      'updatePolicy: skip',
      'scope: user',
      '',
    ].join('\n'));

    env = { HOME: homeDir, ...GIT_ENV };
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('removes the name from the root file by default, and leaves the namespace override', async () => {
    const result = await runCLI(['remove', 'mcp', 'db', '--force'], env, homeDir);

    expect(result.code, result.output).toBe(0);
    expect(onBranch('mcp/mcp.yaml')).not.toContain('https://db.example.com');
    expect(onBranch('mcp/mcp.yaml')).toContain('shared');
    expect(onBranch('mcp/checkout/mcp.yaml')).toContain('checkout-db.example.com');
  });

  it('asks for --role or --project when several namespace files and not the root define the name', async () => {
    const result = await runCLI(['remove', 'mcp', 'orders', '--force'], env, homeDir);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('mcp/billing/mcp.yaml, mcp/checkout/mcp.yaml');
    expect(result.output).toContain('Nothing was removed.');
    expect(git("for-each-ref refs/heads/teamai", remote).trim()).toBe('');
  });

  it('removes the name from the namespace file --project names, and leaves the root one', async () => {
    const result = await runCLI(['remove', 'mcp', 'db', '--project', 'checkout', '--force'], env, homeDir);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('db is checkout/db');
    expect(onBranch('mcp/checkout/mcp.yaml')).not.toContain('checkout-db.example.com');
    expect(onBranch('mcp/checkout/mcp.yaml')).toContain('orders');
    expect(onBranch('mcp/mcp.yaml')).toContain('https://db.example.com');
  });

  /** Commit `content` as `file` on the remote's main, and bring the clone up to it. */
  const publish = (file: string, content: string): void => {
    const other = path.join(sandbox, 'other');
    git(`clone -q -b main ${remote} ${other}`, sandbox);
    write(other, file, content);
    git('commit -qam break', other);
    git('push -q origin main', other);
    git('pull -q', clone);
  };

  it('removes nothing by bare name while the root file does not parse', async () => {
    publish('mcp/mcp.yaml', 'servers:\n  - name: db\n    transport: [\n');

    const result = await runCLI(['remove', 'mcp', 'db', '--force'], env, homeDir);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('mcp/mcp.yaml');
    expect(result.output).toContain('Nothing was removed.');
    expect(git("for-each-ref refs/heads/teamai", remote).trim()).toBe('');
  });

  it('removes nothing by bare name while a namespace file that may define it does not parse', async () => {
    publish('mcp/billing/mcp.yaml', 'servers:\n  - name: orders\n    transport: [\n');

    const result = await runCLI(['remove', 'mcp', 'orders', '--force'], env, homeDir);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('mcp/billing/mcp.yaml');
    expect(result.output).toContain('Nothing was removed.');
    expect(git("for-each-ref refs/heads/teamai", remote).trim()).toBe('');
  });

  it('says the file --project names does not parse, not that the name is missing', async () => {
    publish('mcp/checkout/mcp.yaml', 'servers:\n  - name: db\n    transport: [\n');

    const result = await runCLI(['remove', 'mcp', 'db', '--project', 'checkout', '--force'], env, homeDir);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('mcp/checkout/mcp.yaml does not parse, so "db" cannot be found in it');
    expect(result.output).not.toContain('Not found');
    expect(result.output).toContain('Nothing was removed.');
    expect(git("for-each-ref refs/heads/teamai", remote).trim()).toBe('');
  });

  it('finds a name defined in one namespace file alone without a flag', async () => {
    const result = await runCLI(['remove', 'mcp', 'invoices', '--force'], env, homeDir);

    expect(result.code, result.output).toBe(0);
    expect(onBranch('mcp/billing/mcp.yaml')).not.toContain('invoices');
    expect(onBranch('mcp/billing/mcp.yaml')).toContain('billing-orders.example.com');
  });
});
