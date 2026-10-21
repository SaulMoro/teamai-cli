import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(), persist: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() })),
}));

import { log } from '../utils/logger.js';
import { reconcileMcpForConfig } from '../mcp-reconcile.js';
import { entryHash, renderJsonEntry } from '../resources/mcp-format.js';
import { TeamaiConfigSchema, type LocalConfig, type McpServerDef, type TeamaiConfig } from '../types.js';

const API: McpServerDef = { name: 'api', transport: 'http', url: 'https://api.example.com/mcp' };
const MINE = { type: 'stdio', command: 'my-own-server' };

describe('pull writes MCP servers where each tool reads them (#1221)', () => {
  let root: string;
  let home: string;
  let repo: string;

  const userConfig = (tool: string): LocalConfig => ({
    repo: { localPath: repo, remote: 'fixture' }, username: 'tester', scope: 'user', enabledAgents: [tool], additionalRoles: [],
  });
  const team = (sharing: Record<string, unknown> = {}): TeamaiConfig =>
    TeamaiConfigSchema.parse({ team: 'fixture', repo: 'fixture', provider: 'git', sharing });

  beforeEach(async () => {
    root = fs.realpathSync(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-locate-')));
    home = path.join(root, 'home');
    repo = path.join(root, 'repo');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    for (const name of ['XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'CODEBUDDY_CONFIG_DIR']) vi.stubEnv(name, '');
    await fse.ensureDir(path.join(home, '.teamai'));
    await fse.outputFile(path.join(repo, 'mcp', 'mcp.yaml'), 'servers:\n  - name: api\n    transport: http\n    url: https://api.example.com/mcp\n');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  describe('WorkBuddy, which reads only the first of ~/.workbuddy/.mcp.json, ~/.workbuddy/mcp.json, ~/.codebuddy.json that exists', () => {
    it('writes the member\'s ~/.workbuddy/.mcp.json, not the ~/.workbuddy/mcp.json it hides', async () => {
      await fse.outputJson(path.join(home, '.workbuddy', '.mcp.json'), { mcpServers: { mine: MINE } });

      await reconcileMcpForConfig(team(), userConfig('workbuddy'));

      expect(await fse.readJson(path.join(home, '.workbuddy', '.mcp.json'))).toEqual({
        mcpServers: { mine: MINE, api: renderJsonEntry('buddy', API) },
      });
      expect(await fse.pathExists(path.join(home, '.workbuddy', 'mcp.json'))).toBe(false);
    });

    it('takes the servers an earlier pull wrote out of ~/.workbuddy/mcp.json once it writes ~/.workbuddy/.mcp.json', async () => {
      const api = renderJsonEntry('buddy', API);
      await fse.outputJson(path.join(home, '.workbuddy', '.mcp.json'), { mcpServers: { mine: MINE } });
      await fse.outputJson(path.join(home, '.workbuddy', 'mcp.json'), { mcpServers: { api, other: MINE } });
      await fse.outputJson(path.join(home, '.teamai', 'managed-mcp.json'), { workbuddy: [{ name: 'api', hash: entryHash(api) }] });

      await reconcileMcpForConfig(team(), userConfig('workbuddy'));

      expect((await fse.readJson(path.join(home, '.workbuddy', '.mcp.json'))).mcpServers).toEqual({ mine: MINE, api });
      expect(await fse.readJson(path.join(home, '.workbuddy', 'mcp.json'))).toEqual({ mcpServers: { other: MINE } });
    });
  });

  it('writes WorkBuddy\'s project servers to its local scope in .codebuddy.json while sharing.gitExclude is on', async () => {
    const project = path.join(root, 'project');
    await fse.ensureDir(path.join(project, '.workbuddy'));
    execFileSync('git', ['init', '-q', project]);
    const local: LocalConfig = { ...userConfig('workbuddy'), scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };

    await reconcileMcpForConfig(team({ gitExclude: { enabled: true } }), local);

    expect((await fse.readJson(path.join(home, '.codebuddy.json'))).projects[project].mcpServers).toEqual({ api: renderJsonEntry('buddy', API) });
    expect(await fse.pathExists(path.join(project, '.workbuddy', 'mcp.json'))).toBe(false);
  });

  it('writes Pi\'s user servers to the agent directory PI_CODING_AGENT_DIR names', async () => {
    const agentDir = path.join(root, 'pi-agent');
    await fse.ensureDir(agentDir);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

    await reconcileMcpForConfig(team(), userConfig('pi'));

    expect((await fse.readJson(path.join(agentDir, 'mcp.json'))).mcpServers).toEqual({ api: renderJsonEntry('pi', API) });
    expect(await fse.pathExists(path.join(home, '.pi', 'agent', 'mcp.json'))).toBe(false);
  });

  it.each([
    ['XDG_CONFIG_HOME', (dir: string) => path.join(dir, 'opencode')],
    ['OPENCODE_CONFIG_DIR', (dir: string) => dir],
  ])('writes OpenCode\'s user servers to the config directory %s moves it to', async (variable, configDir) => {
    const dir = path.join(root, 'moved');
    await fse.ensureDir(configDir(dir));
    vi.stubEnv(variable, dir);

    await reconcileMcpForConfig(team(), userConfig('opencode'));

    expect((await fse.readJson(path.join(configDir(dir), 'opencode.json'))).mcp).toEqual({ api: renderJsonEntry('opencode', API) });
    expect(await fse.pathExists(path.join(home, '.config', 'opencode', 'opencode.json'))).toBe(false);
  });

  describe('the file each server was written to, in its ownership record', () => {
    it('is recorded for every server a pull writes', async () => {
      await fse.ensureDir(path.join(home, '.cursor'));

      await reconcileMcpForConfig(team(), userConfig('cursor'));

      expect(await fse.readJson(path.join(home, '.teamai', 'managed-mcp.json'))).toEqual({
        cursor: [{ name: 'api', hash: entryHash(renderJsonEntry('cursor', API)), file: path.join(home, '.cursor', 'mcp.json') }],
      });
    });

    it('names once, and keeps, the servers an earlier release wrote to OpenCode\'s default home after XDG_CONFIG_HOME moves it', async () => {
      const api = renderJsonEntry('opencode', API);
      const before = path.join(home, '.config', 'opencode', 'opencode.json');
      await fse.outputJson(before, { mcp: { api } });
      await fse.outputJson(path.join(home, '.teamai', 'managed-mcp.json'), { opencode: [{ name: 'api', hash: entryHash(api) }] });
      const xdg = path.join(root, 'xdg');
      const now = path.join(xdg, 'opencode', 'opencode.json');
      await fse.ensureDir(path.dirname(now));
      vi.stubEnv('XDG_CONFIG_HOME', xdg);
      const left = `[user] opencode takes MCP servers from ${now} now, so teamai no longer updates its entries in ${before} (api). `
        + 'Remove them once no tool reads that file.';

      await reconcileMcpForConfig(team(), userConfig('opencode'));
      await reconcileMcpForConfig(team(), userConfig('opencode'));

      expect((await fse.readJson(now)).mcp).toEqual({ api });
      expect(await fse.readJson(before)).toEqual({ mcp: { api } });
      expect(vi.mocked(log.info).mock.calls.filter(([line]) => line === left)).toHaveLength(1);
    });
  });

  it('writes Muse\'s user servers to $XDG_CONFIG_HOME/muse/settings.json', async () => {
    const xdg = path.join(root, 'xdg');
    await fse.ensureDir(path.join(xdg, 'muse'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);

    await reconcileMcpForConfig(team(), userConfig('muse'));

    expect(await fse.readJson(path.join(xdg, 'muse', 'settings.json'))).toEqual({ schema_version: 1, mcpServers: { api: renderJsonEntry('muse', API) } });
    expect(await fse.pathExists(path.join(home, '.config', 'muse', 'settings.json'))).toBe(false);
  });
});
