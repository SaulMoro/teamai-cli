import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = path.join(root, 'dist', 'index.js');

function runCLI(args: string[], env: Record<string, string>, cwd: string, stdin = ''): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, env: { ...process.env, FORCE_COLOR: '0', ...env }, windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stdin.end(stdin);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('update check during uninstall (real CLI)', () => {
  const sandboxes: string[] = [];
  beforeAll(() => {
    if (!fs.existsSync(cli)) throw new Error(`CLI binary not found at ${cli}. Run "npm run build" first.`);
  });
  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('a Stop hook whose registry query outlives an uninstall does not recreate ~/.teamai', async () => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-update-uninstall-')));
    sandboxes.push(sandbox);
    const home = path.join(sandbox, 'home');
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'state.json'), '{"lastUpdateCheck":null,"availableUpdate":null}\n');

    let queried!: () => void;
    const query = new Promise<void>((resolve) => { queried = resolve; });
    let reply!: () => void;
    const gate = new Promise<void>((resolve) => { reply = resolve; });
    const registry = http.createServer(async (req, res) => {
      if (!req.url?.includes('teamai-cli')) {
        res.statusCode = 404;
        res.end();
        return;
      }
      queried();
      await gate;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        name: 'teamai-cli',
        'dist-tags': { latest: '99.0.0' },
        versions: { '99.0.0': { name: 'teamai-cli', version: '99.0.0' } },
      }));
    });
    await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
    const env = {
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      TEAMAI_NPM_REGISTRY: `http://127.0.0.1:${(registry.address() as { port: number }).port}`,
      npm_config_cache: path.join(sandbox, 'npm-cache'),
    };
    try {
      const hook = runCLI(['hook-dispatch', 'stop', '--tool', 'workbuddy', '--bg-only'], env, sandbox,
        JSON.stringify({ cwd: sandbox, hook_event_name: 'Stop', session_id: 'update-uninstall' }));
      await query;
      const uninstalled = await runCLI(['uninstall', '--force'], env, sandbox);
      expect(uninstalled.code, uninstalled.output).toBe(0);
      expect(fs.existsSync(path.join(home, '.teamai')), uninstalled.output).toBe(false);
      reply();
      const synced = await hook;
      expect(synced.code, synced.output).toBe(0);
      expect(synced.output).not.toContain('Version check failed');
      expect(fs.existsSync(path.join(home, '.teamai')), synced.output).toBe(false);
    } finally {
      reply();
      await new Promise<void>((resolve, reject) => registry.close((err) => err ? reject(err) : resolve()));
    }
  });
});
