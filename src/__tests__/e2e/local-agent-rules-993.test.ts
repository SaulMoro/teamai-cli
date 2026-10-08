import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real-CLI coverage for #993: the local agent of an HTTP-mode team removes the
// rule copy it installed, whose resource cache has no history and whose pull
// keeps no record, and keeps a member's file at that path.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

function runCLI(args: string[], env: Record<string, string>, cwd: string, stdin = ''): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.stdin.end(stdin);
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('local-agent rules (#993)', () => {
  const sandboxes: string[] = [];
  beforeAll(() => {
    if (!fs.existsSync(CLI)) execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
  });
  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('uninstall_rule removes the copy the local agent installed and keeps a member\'s file at that path', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-993-local-agent-rules-')));
    sandboxes.push(sandbox);
    const home = path.join(sandbox, 'home');
    const project = path.join(sandbox, 'project');
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    // Holds each detached worker's output open until it exits, so a run's close joins the sync it spawned.
    const workers = path.join(sandbox, 'workers');
    fs.mkdirSync(workers);
    const preload = path.join(sandbox, 'capture-workers.cjs');
    fs.writeFileSync(preload, [
      "const fs = require('node:fs');",
      "const cp = require('node:child_process');",
      `const workers = ${JSON.stringify(workers)};`,
      'const spawn = cp.spawn;',
      'cp.spawn = (command, args, options) => {',
      "  if (options?.detached) options = { ...options, stdio: [Array.isArray(options.stdio) ? options.stdio[0] : 'ignore', 'inherit', 'inherit'] };",
      '  const child = spawn(command, args, options);',
      "  if (options?.detached && child.pid) fs.writeFileSync(workers + '/' + child.pid + '.started', '');",
      '  return child;',
      '};',
      "require('node:module').syncBuiltinESMExports();",
      "process.on('exit', () => fs.writeFileSync(workers + '/' + process.pid + '.done', ''));",
    ].join('\n'));

    let endpoint = '';
    let phase: 'install' | 'uninstall' = 'install';
    const acks: Array<{ status: string }> = [];
    const rule = (id: number, action: string, slug: string) => ({
      id, type: `${action}_rule`, handle_type: 'rule', slug, version: '1',
      scope: 'workspace', workspace_path: project, download_url: `${endpoint}/${slug}.md`,
    });
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        if (request.url?.endsWith('.md')) {
          response.end(`# ${path.basename(request.url, '.md')}\n\nTeam rule body.\n`);
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        if (request.url?.endsWith('/commands/ack')) acks.push(JSON.parse(body));
        if (!request.url?.endsWith('/local-agent/sync')) {
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        const cmds = phase === 'install'
          ? [rule(1, 'install', 'team-style'), rule(2, 'install', 'mine')]
          : [rule(3, 'uninstall', 'team-style'), rule(4, 'uninstall', 'mine')];
        response.end(JSON.stringify({ ok: true, cmds }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const env = { HOME: home, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
    const sessionStart = () => runCLI(['hook-dispatch', 'session-start', '--tool', 'claude'], env, project,
      JSON.stringify({ cwd: project, session_id: `993-${phase}`, hook_event_name: 'SessionStart', source: 'startup' }));
    try {
      const agentDir = path.join(home, '.teamai', 'local-agent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify({ endpoint, token: 'fixture-token',
        localAgentId: 'fixture', createdAt: '2026-01-01T00:00:00.000Z', workspaceBindings: {},
      }));
      const teamStyle = path.join(project, '.claude', 'rules', 'team-style.md');
      const mine = path.join(project, '.claude', 'rules', 'mine.md');

      const installed = await sessionStart();
      expect(installed.code, installed.output).toBe(0);
      expect(acks.map((ack) => ack.status), installed.output).toEqual(['success', 'success']);
      expect(fs.readFileSync(teamStyle, 'utf8')).toContain('Team rule body.');
      // The member replaces one copy with a file of their own.
      fs.writeFileSync(mine, '# Mine\n\nMy own rule.\n');

      phase = 'uninstall';
      const uninstalled = await sessionStart();
      expect(uninstalled.code, uninstalled.output).toBe(0);
      expect(acks.slice(2).map((ack) => ack.status), uninstalled.output).toEqual(['success', 'success']);
      expect(fs.existsSync(teamStyle)).toBe(false);
      expect(fs.readFileSync(mine, 'utf8')).toBe('# Mine\n\nMy own rule.\n');
      for (const file of fs.readdirSync(workers).filter((name) => name.endsWith('.started'))) {
        expect(fs.existsSync(path.join(workers, file.replace('.started', '.done'))), `Worker ${file} must exit before fixture cleanup`).toBe(true);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
