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

import { buildMcpReadFileChecks, mcpTransportNotes } from '../doctor-delivery.js';
import type { DoctorContext } from '../doctor.js';
import { detectMcpFormat } from '../resources/mcp-format.js';
import { log } from '../utils/logger.js';
import { judgeTeamaiOnlyMcpConfigs, reconcileMcpForConfig } from '../mcp-reconcile.js';
import { entryHash, renderCodexBlock, renderJsonEntry } from '../resources/mcp-format.js';
import { managedMcpManifestKey, TeamaiConfigSchema, type LocalConfig, type McpServerDef, type TeamaiConfig } from '../types.js';

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

  it.each([['.mcp.json', false], ['mcp.json', false], ['.mcp.json', true]] as const)('writes WorkBuddy project servers to %s with gitExclude=%s and retires the old project file', async (name, gitExclude) => {
    const project = path.join(root, 'project');
    const api = renderJsonEntry('buddy', API);
    const old = path.join(project, '.workbuddy', 'mcp.json');
    await fse.outputJson(old, { mcpServers: { api, other: MINE } });
    await fse.outputJson(path.join(project, name), { mcpServers: { mine: MINE } });
    execFileSync('git', ['init', '-q', project]);
    const local: LocalConfig = { ...userConfig('workbuddy'), scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };
    const { loadMcpManifest, saveMcpManifest } = await import('../mcp-reconcile.js');
    const { manifestPath, manifest } = await loadMcpManifest(local, false);
    manifest['workbuddy:project'] = [{ name: 'api', hash: entryHash(api) }];
    await saveMcpManifest(local, manifestPath, manifest);

    await reconcileMcpForConfig(team({ gitExclude: { enabled: gitExclude } }), local);

    if (gitExclude) {
      expect((await fse.readJson(path.join(home, '.codebuddy.json'))).projects[project].mcpServers).toEqual({ api });
    } else {
      expect((await fse.readJson(path.join(project, name))).mcpServers).toEqual({ mine: MINE, api });
    }
    expect(await fse.readJson(old)).toEqual({ mcpServers: { other: MINE } });
    if (name === 'mcp.json') expect(await fse.pathExists(path.join(project, '.mcp.json'))).toBe(false);
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

  describe('ZCode, which reads mcp.servers in its own config files (ZCode 3.16.2 source; 3.15.1 not certified)', () => {
    it('writes the user servers to ~/.zcode/cli/config.json, keeping its other keys', async () => {
      const config = path.join(home, '.zcode', 'cli', 'config.json');
      await fse.outputJson(config, { hooks: { enabled: true }, mcp: { timeout: 5 } });

      await reconcileMcpForConfig(team(), userConfig('zcode'));

      expect(await fse.readJson(config)).toEqual({ hooks: { enabled: true }, mcp: { timeout: 5, servers: { api: renderJsonEntry('claude', API) } } });
      expect(await fse.pathExists(path.join(home, '.agents', 'mcp.json'))).toBe(false);
    });

    it('takes the servers an earlier pull wrote out of ~/.agents/mcp.json, and leaves the member\'s', async () => {
      const api = renderJsonEntry('claude', API);
      await fse.ensureDir(path.join(home, '.zcode', 'cli'));
      await fse.outputJson(path.join(home, '.agents', 'mcp.json'), { mcpServers: { api, mine: MINE } });
      await fse.outputJson(path.join(home, '.teamai', 'managed-mcp.json'), { zcode: [{ name: 'api', hash: entryHash(api) }] });

      await reconcileMcpForConfig(team(), userConfig('zcode'));

      expect((await fse.readJson(path.join(home, '.zcode', 'cli', 'config.json'))).mcp.servers).toEqual({ api });
      expect(await fse.readJson(path.join(home, '.agents', 'mcp.json'))).toEqual({ mcpServers: { mine: MINE } });
    });

    it('writes a project\'s servers to <project>/.zcode/config.json', async () => {
      const project = path.join(root, 'project');
      await fse.ensureDir(path.join(home, '.zcode'));
      await fse.outputJson(path.join(project, '.zcode', 'config.json'), { model: 'glm' });
      execFileSync('git', ['init', '-q', project]);
      const local: LocalConfig = { ...userConfig('zcode'), scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };

      await reconcileMcpForConfig(team(), local);

      expect(await fse.readJson(path.join(project, '.zcode', 'config.json'))).toEqual({ model: 'glm', mcp: { servers: { api: renderJsonEntry('claude', API) } } });
    });

    it('judges a project\'s .zcode/config.json holding nothing but teamai\'s servers teamai\'s alone, and one with other keys not', async () => {
      const project = path.join(root, 'project');
      await fse.ensureDir(path.join(project, '.zcode'));
      execFileSync('git', ['init', '-q', project]);
      const local: LocalConfig = { ...userConfig('zcode'), scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };
      const file = path.join(project, '.zcode', 'config.json');

      await reconcileMcpForConfig(team(), local);
      const alone = await judgeTeamaiOnlyMcpConfigs(team(), local);
      await fse.writeJson(file, { ...await fse.readJson(file), model: 'glm' });

      expect(alone).toEqual([{ file, teamaiOnly: true }]);
      expect(await judgeTeamaiOnlyMcpConfigs(team(), local)).toEqual([{ file, teamaiOnly: false }]);
    });
  });

  it('reads a recorded ZCode config through its nested key after the team changes its mapping', async () => {
    const project = path.join(root, 'project');
    const file = path.join(project, '.zcode', 'before.json');
    await fse.outputJson(file, { mcp: { servers: { api: renderJsonEntry('claude', API) } } });
    execFileSync('git', ['init', '-q', project]);
    const local: LocalConfig = { ...userConfig('zcode'), scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };
    const { trackResolvedMcpFiles } = await import('../mcp-resolved-files.js');
    const { recordedMcpTargets, installedMcpEntries } = await import('../mcp-reconcile.js');
    await trackResolvedMcpFiles(local, [{ tool: 'zcode', file }]);

    const group = (await recordedMcpTargets(local, [])).get(file);
    const target = group?.targets[0];
    if (target === undefined) throw new Error('missing recorded ZCode config');

    expect(await installedMcpEntries(target)).toEqual(new Map([['api', renderJsonEntry('claude', API)]]));
  });

  it('keeps a member\'s server in the moved CodeBuddy home that an earlier release\'s record, noting no file, does not own', async () => {
    const api = renderJsonEntry('buddy', API);
    const moved = path.join(root, 'moved');
    await fse.outputJson(path.join(home, '.codebuddy', 'mcp.json'), { mcpServers: { api } });
    await fse.outputJson(path.join(moved, 'mcp.json'), { mcpServers: { api: MINE } });
    await fse.outputJson(path.join(home, '.teamai', 'managed-mcp.json'), { codebuddy: [{ name: 'api', hash: entryHash(api) }] });
    await fse.outputFile(path.join(repo, 'mcp', 'mcp.yaml'), 'servers:\n  - name: api\n    transport: http\n    url: https://api.example.com/v2\n');
    vi.stubEnv('CODEBUDDY_CONFIG_DIR', moved);

    await reconcileMcpForConfig(team(), userConfig('codebuddy'));

    expect(await fse.readJson(path.join(moved, 'mcp.json'))).toEqual({ mcpServers: { api: MINE } });
  });

  it('lets uninstall remove CodeBuddy\'s unchanged local-scope servers from the .codebuddy.json it left when CODEBUDDY_CONFIG_DIR moves its home', async () => {
    const project = path.join(root, 'project');
    const before = path.join(home, '.codebuddy.json');
    await fse.ensureDir(path.join(project, '.codebuddy'));
    execFileSync('git', ['init', '-q', project]);
    const local: LocalConfig = { ...userConfig('codebuddy'), scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };
    await reconcileMcpForConfig(team({ gitExclude: { enabled: true } }), local);
    const written = await fse.readJson(before);
    written.projects[project].mcpServers.mine = MINE;
    await fse.outputJson(before, written);
    const moved = path.join(root, 'moved');
    await fse.ensureDir(moved);
    vi.stubEnv('CODEBUDDY_CONFIG_DIR', moved);

    await reconcileMcpForConfig(team(), local, { removeAll: true });

    expect((await fse.readJson(before)).projects[project].mcpServers).toEqual({ mine: MINE });
  });

  it('lets uninstall remove another checkout\'s CodeBuddy servers from the .codebuddy.json its record names after the home moves', async () => {
    const project = path.join(root, 'project');
    const sibling = path.join(root, 'sibling');
    const dataHome = path.join(root, 'data');
    const before = path.join(home, '.codebuddy.json');
    await fse.ensureDir(path.join(project, '.codebuddy'));
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-qm', 'fixture']);
    execFileSync('git', ['-C', project, 'worktree', 'add', '-q', '-b', 'sibling', sibling]);
    const api = renderJsonEntry('buddy', API);
    await fse.outputJson(before, { projects: { [project]: { mcpServers: { api } }, [sibling]: { mcpServers: { api, mine: MINE } } } });
    const record = { name: 'api', hash: entryHash(api), file: before };
    await fse.outputJson(path.join(dataHome, 'managed-local-mcp.json'), { [`codebuddy:local:${project}`]: [record], [`codebuddy:local:${sibling}`]: [record] });
    const moved = path.join(root, 'moved');
    await fse.ensureDir(moved);
    vi.stubEnv('CODEBUDDY_CONFIG_DIR', moved);
    const local: LocalConfig = { ...userConfig('codebuddy'), scope: 'project', projectRoot: project, dataHome };

    await reconcileMcpForConfig(team(), local, { removeAll: true });

    expect((await fse.readJson(before)).projects).toEqual({ [sibling]: { mcpServers: { mine: MINE } } });
  });

  it('uninstall removes a local scope from the file its record names when no team config remains', async () => {
    const dataHome = path.join(root, 'orphan');
    const file = path.join(home, '.claude-team', 'custom.json');
    const project = path.join(root, 'project');
    const api = renderJsonEntry('claude', API);
    await fse.outputJson(file, { projects: { [project]: { mcpServers: { api, mine: MINE } } } });
    await fse.outputJson(path.join(dataHome, 'managed-local-mcp.json'), { [`claude:local:${project}`]: [{ name: 'api', hash: entryHash(api), file }] });
    const { removeLocalScopeMcpServers } = await import('../mcp-reconcile.js');

    expect(await removeLocalScopeMcpServers(dataHome)).toEqual([]);
    expect((await fse.readJson(file)).projects[project].mcpServers).toEqual({ mine: MINE });
  });

  const context = (teamConfig: TeamaiConfig, localConfig: LocalConfig): DoctorContext => ({
    teamConfig, localConfig, toolPaths: teamConfig.toolPaths, hookToolPaths: {}, baseDir: home,
  });

  it('doctor rejects a mapped MCP file the tool does not read', async () => {
    await fse.ensureDir(path.join(home, '.cursor'));
    const config = team();
    config.toolPaths = { ...config.toolPaths, cursor: { ...config.toolPaths.cursor, mcp: '.cursor/unread.json' } };

    const check = (await buildMcpReadFileChecks(context(config, userConfig('cursor'))))
      .find((check) => check.name === 'cursor reads the MCP servers teamai writes');

    expect(check).toBeDefined();
    expect(await check?.check()).toBe(false);
    expect(check?.fix).toContain('toolPaths.cursor.mcp');
  });

  it('doctor reports the MCP file moved since the last write', async () => {
    const before = path.join(home, '.config', 'opencode', 'opencode.json');
    const entry = renderJsonEntry('opencode', API);
    await fse.outputJson(before, { mcp: { api: entry } });
    await fse.outputJson(path.join(home, '.teamai', 'managed-mcp.json'), { opencode: [{ name: 'api', hash: entryHash(entry), file: before }] });
    const xdg = path.join(root, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);

    const check = (await buildMcpReadFileChecks(context(team(), userConfig('opencode'))))
      .find((check) => check.name === 'opencode MCP servers are where the last write put them');

    expect(check).toBeDefined();
    expect(await check?.check()).toBe(false);
    expect(check?.fix).toContain(before);
  });

  it('doctor warns about ZCode desktop fallback servers the native file hides', async () => {
    await fse.ensureDir(path.join(home, '.zcode'));
    await fse.outputJson(path.join(home, '.agents', 'mcp.json'), { mcpServers: { mine: MINE, api: renderJsonEntry('claude', API) } });
    await fse.outputJson(path.join(home, '.teamai', 'managed-mcp.json'), { zcode: [{ name: 'api', hash: entryHash(renderJsonEntry('claude', API)) }] });

    expect(await mcpTransportNotes(context(team(), userConfig('zcode')))).toContain(
      '⚠ ZCode reads ~/.agents/mcp.json only while ~/.zcode/cli/config.json has no servers; move these servers there: mine',
    );
  });

  it.each(['claude-internal', 'codex-internal', 'tcodex'])('doctor notes %s has an unknown MCP channel', async (tool) => {
    await fse.ensureDir(path.join(home, `.${tool}`));

    expect(detectMcpFormat(tool)).toBeNull();
    expect(await mcpTransportNotes(context(team(), userConfig(tool)))).toContain(`${tool}'s MCP channel is unknown; teamai does not write its servers.`);
  });

  it('doctor notes cwd-only MCP and settings that still stay at the default home', async () => {
    const agentDir = path.join(root, 'pi-agent');
    await fse.ensureDir(agentDir);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    expect(await mcpTransportNotes(context(team(), userConfig('pi')))).toContain(
      `pi takes MCP servers from ${path.join(agentDir, 'mcp.json')}, but teamai still writes some of its other files under ${path.join(home, '.pi', 'agent')}.`,
    );
    const project = path.join(root, 'project');
    await fse.ensureDir(path.join(project, '.pi'));
    const local: LocalConfig = { ...userConfig('pi'), scope: 'project', projectRoot: project };
    expect(await mcpTransportNotes(context(team(), local))).toContain(`pi reads project MCP servers only from a session started in ${project}.`);
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

    // Uninstall takes teamai's unchanged servers out of the file each record names, whatever the tool now reads:
    // under an earlier home (an earlier release's record notes no file) or an earlier toolPaths mapping.
    const json = (tool: Parameters<typeof renderJsonEntry>[0], key: string) => ({
      format: 'JSON', render: (def: McpServerDef) => renderJsonEntry(tool, def),
      write: (entries: Record<string, unknown>) => JSON.stringify({ [key]: entries }),
      read: (text: string) => Object.keys(JSON.parse(text)[key]),
    });
    const toml = {
      format: 'TOML', render: (def: McpServerDef) => renderCodexBlock(def),
      write: (entries: Record<string, unknown>) => `model = "o3"\n\n${Object.values(entries).join('\n')}`,
      read: (text: string) => [...text.matchAll(/^\[mcp_servers\.([\w-]+)\]$/gm)].map(([, name]) => name),
    };
    const leftFiles = [
      { tool: 'opencode', scope: 'user', moves: 'OPENCODE_CONFIG_DIR', file: '.config/opencode/opencode.json', notesFile: false, ...json('opencode', 'mcp') },
      { tool: 'codex', scope: 'user', moves: 'toolRoots', file: '.codex/config.toml', notesFile: true, ...toml },
      { tool: 'opencode', scope: 'project', moves: 'mcpProject', file: 'opencode.json', notesFile: true, ...json('opencode', 'mcp') },
      { tool: 'claude', scope: 'project', moves: 'mcpProject', file: '.mcp.json', notesFile: true, ...json('claude', 'mcpServers') },
      { tool: 'codex', scope: 'project', moves: 'mcpProject', file: '.codex/config.toml', notesFile: true, ...toml },
    ] as const;
    // A file that no longer parses keeps teamai's servers, and so their records. A Codex config.toml always reads.
    const cases = leftFiles.flatMap((row) => [
      { ...row, outcome: 'removed' as const },
      ...row.format === 'JSON' ? [{ ...row, outcome: 'kept' as const }] : [],
    ]);

    it.each(cases)('lets uninstall take $tool\'s $scope servers ($format) out of the file its record names after $moves moves it: $outcome',
      async ({ tool, scope, moves, file, notesFile, render, write, read, outcome }) => {
        const { loadMcpManifest, saveMcpManifest } = await import('../mcp-reconcile.js');
        const api = render(API);
        const edited = render({ ...API, name: 'edited', url: 'https://edited.example.com/mcp' });
        const mine = render({ name: 'mine', transport: 'stdio', command: 'my-own-server' });
        const project = path.join(root, 'project');
        const before = path.join(scope === 'user' ? home : project, file);
        const contents = write({ api, edited, mine }) + (outcome === 'kept' ? '\n}' : '');
        await fse.outputFile(before, contents);
        let config = userConfig(tool);
        const teamConfig = team();
        if (scope === 'project') {
          execFileSync('git', ['init', '-q', project]);
          await fse.ensureDir(path.join(project, `.${tool}`));
          config = { ...config, scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };
          teamConfig.toolPaths = { ...teamConfig.toolPaths, [tool]: { ...teamConfig.toolPaths[tool], mcpProject: `config/${path.basename(file)}` } };
        } else {
          // A tool root stays under HOME.
          const moved = path.join(home, `.${tool}-work`);
          await fse.ensureDir(moved);
          if (moves === 'toolRoots') config.toolRoots = { [tool]: moved };
          else vi.stubEnv(moves, moved);
        }
        const noted = notesFile ? { file: before } : {};
        const records = [{ name: 'api', hash: entryHash(api), ...noted }, { name: 'edited', hash: entryHash(render({ ...API, name: 'edited' })), ...noted }];
        const key = managedMcpManifestKey(tool, scope === 'project');
        const saved = await loadMcpManifest(config, false);
        saved.manifest[key] = records;
        await saveMcpManifest(config, saved.manifestPath, saved.manifest);

        await reconcileMcpForConfig(teamConfig, config, { removeAll: true });

        const after = await fse.readFile(before, 'utf8');
        const left = (await loadMcpManifest(config, false)).manifest[key] ?? [];
        if (outcome === 'kept') {
          expect(after).toBe(contents);
          expect(left).toEqual(records.map((record) => expect.objectContaining(record)));
        } else {
          expect(read(after)).toEqual(['edited', 'mine']);
          expect(left).toEqual([]);
        }
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
