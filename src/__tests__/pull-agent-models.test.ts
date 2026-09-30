/**
 * Recorded agent models on the "Already synced" path (#830): pull records
 * the model and effort each agent copy received, and an ordinary pull with an
 * unchanged team revision redeploys the agents whose model it would now write
 * differently, such as a `model: strong` an older CLI copied literally.
 * Asserted through `pull`, on the files in tool dirs and the state it saves.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import matter from 'gray-matter';
import { parse as parseToml } from 'smol-toml';
import YAML from 'yaml';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    persist: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../source.js', () => ({ pullSources: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../hooks.js', () => ({
  injectHooksToAllTools: vi.fn().mockResolvedValue(undefined),
  reconcileTeamHooksForConfig: vi.fn().mockResolvedValue({ ok: true, defs: [] }),
}));
vi.mock('../mcp-reconcile.js', () => ({
  reconcileMcpForConfig: vi.fn().mockResolvedValue({ changes: [], wrote: false }),
}));
vi.mock('../team-push.js', () => ({ reportUsageToTeam: vi.fn().mockResolvedValue(true) }));
vi.mock('../usage-tracker.js', () => ({
  readUsageEvents: vi.fn().mockResolvedValue([]),
  truncateUsageAfterReport: vi.fn().mockResolvedValue(undefined),
  capUsageEvents: vi.fn().mockResolvedValue(undefined),
}));
// pull() takes a real lock file; parallel workers would race on it.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { pull } from '../pull.js';
import { detectProjectConfig, loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { log } from '../utils/logger.js';
import { renderForTool, serializeAgentYaml, type AgentSpec } from '../resources/agent-format.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

const STRONG = {
  aliases: {
    strong: {
      claude: { model: 'opus', effort: 'high' },
      codex: { model: 'gpt-6-sol', effort: 'high' },
    },
  },
};

const IMPLEMENTER: AgentSpec = {
  name: 'implementer',
  description: 'Implements a change',
  instructions: 'Make the change.',
  model: 'strong',
};

describe('pull: recorded agent models on an unchanged team revision', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-agent-models-')));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'agents'));
    await fse.ensureDir(path.join(homeDir, '.claude'));
    await fse.ensureDir(path.join(homeDir, '.codex'));
    vi.stubEnv('HOME', homeDir);
    vi.clearAllMocks();
    vi.mocked(detectProjectConfig).mockResolvedValue(null);

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { agents: '.claude/agents' },
        codex: { agents: '.codex/agents' },
      },
    } as TeamaiConfig;
    localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.com/test/repo.git' },
      username: 'member',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  const writeAliases = (aliases: unknown): Promise<void> => fse.outputFile(path.join(repoPath, 'models/aliases.yaml'), YAML.stringify(aliases));
  const writeAgent = (spec: AgentSpec): Promise<void> => fse.outputFile(path.join(repoPath, 'agents', `${spec.name}.yaml`), serializeAgentYaml(spec));
  const claudeFile = (name = 'implementer'): string => path.join(homeDir, '.claude', 'agents', `${name}.md`);
  const codexFile = (name = 'implementer'): string => path.join(homeDir, '.codex', 'agents', `${name}.toml`);
  const claudeModel = async (name?: string): Promise<Record<string, unknown>> => matter(await fse.readFile(claudeFile(name), 'utf-8')).data;
  const codexModel = async (name?: string): Promise<Record<string, unknown>> => parseToml(await fse.readFile(codexFile(name), 'utf-8'));
  const logged = (level: 'warn' | 'info' | 'success', pattern: RegExp): boolean => (
    vi.mocked(log[level]).mock.calls.some((args) => pattern.test(args.map(String).join(' ')))
  );
  const alreadySynced = (): boolean => logged('success', /Already synced at abc1234/);
  const homeRecord = async () => Object.values((await loadStateForScope(localConfig)).lastPullByWorkspace ?? {})[0];

  /** A first full pull, then a clean slate of log calls for the pull under test. */
  async function pullOnce(): Promise<void> {
    await pull({ silent: true });
    expect(alreadySynced()).toBe(false);
    vi.clearAllMocks();
  }

  /**
   * The state an older CLI leaves: `spec` copied to Claude with its `model`
   * as written, that copy's hash on record, and no agent models.
   */
  async function writtenByOlderCli(spec: AgentSpec): Promise<void> {
    const literal = renderForTool(spec, 'claude').content;
    await fse.writeFile(claudeFile(spec.name), literal);
    const state = await loadStateForScope(localConfig);
    const record = Object.values(state.lastPullByWorkspace ?? {})[0]!;
    record.delivered = { ...record.delivered, [claudeFile(spec.name)]: crypto.createHash('sha256').update(literal).digest('hex') };
    delete record.agentModels;
    await saveStateForScope(state, localConfig);
  }

  it('records what each tool received on a full pull', async () => {
    await writeAliases(STRONG);
    await writeAgent(IMPLEMENTER);
    await pullOnce();

    expect((await homeRecord())?.agentModels).toEqual({
      implementer: {
        claude: { step: 'team', model: 'opus', effort: 'high' },
        codex: { step: 'team', model: 'gpt-6-sol', effort: 'high' },
      },
    });
  });

  it('rewrites nothing when every agent\'s model matches its record', async () => {
    await writeAliases(STRONG);
    await writeAgent(IMPLEMENTER);
    await writeAgent({ ...IMPLEMENTER, name: 'plain', model: 'sonnet' });
    await pullOnce();
    const before = await Promise.all([claudeFile(), codexFile(), claudeFile('plain')].map((file) => fse.stat(file)));

    await pull({ silent: true });

    expect(alreadySynced()).toBe(true);
    expect(logged('success', /Updated the model/)).toBe(false);
    const after = await Promise.all([claudeFile(), codexFile(), claudeFile('plain')].map((file) => fse.stat(file)));
    expect(after.map((stat) => stat.mtimeMs)).toEqual(before.map((stat) => stat.mtimeMs));
  });

  it('fixes a model an older CLI wrote literally, with no record, on an ordinary pull', async () => {
    await writeAliases(STRONG);
    await writeAgent(IMPLEMENTER);
    await pullOnce();
    await writtenByOlderCli(IMPLEMENTER);
    expect(await claudeModel()).toMatchObject({ model: 'strong' });

    await pull({ silent: true });

    expect(alreadySynced()).toBe(true);
    expect(await claudeModel()).toMatchObject({ model: 'opus', effort: 'high' });
    expect(logged('success', /Updated the model of 1 agent\(s\): implementer/)).toBe(true);
    expect((await homeRecord())?.agentModels?.['implementer']?.['claude']).toEqual({ step: 'team', model: 'opus', effort: 'high' });

    // Recorded now, so the next pull leaves it alone.
    vi.clearAllMocks();
    await pull({ silent: true });
    expect(logged('success', /Updated the model/)).toBe(false);
  });

  it('does not rewrite an agent without an alias for want of a record', async () => {
    const plain = { ...IMPLEMENTER, name: 'plain', model: 'sonnet' };
    await writeAgent(plain);
    await pullOnce();
    await writtenByOlderCli(plain);
    const before = await fse.stat(claudeFile('plain'));

    await pull({ silent: true });

    expect(alreadySynced()).toBe(true);
    expect(logged('success', /Updated the model/)).toBe(false);
    expect((await fse.stat(claudeFile('plain'))).mtimeMs).toBe(before.mtimeMs);
  });

  it('redeploys an agent whose resolution changed since its record', async () => {
    await writeAliases(STRONG);
    await writeAgent(IMPLEMENTER);
    await pullOnce();
    // The aliases change while the recorded revision does not, as a local
    // alias file or a switched tool will.
    await writeAliases({ aliases: { strong: { claude: 'fable', codex: STRONG.aliases.strong.codex } } });

    await pull({ silent: true });

    expect(alreadySynced()).toBe(true);
    const claude = await claudeModel();
    expect(claude).toMatchObject({ model: 'fable' });
    expect(claude).not.toHaveProperty('effort');
    expect(await codexModel()).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'high' });
    expect((await homeRecord())?.agentModels?.['implementer']?.['claude']).toEqual({ step: 'team', model: 'fable' });
  });

  it('keeps a copy the member changed, and its record', async () => {
    await writeAliases(STRONG);
    await writeAgent(IMPLEMENTER);
    await pullOnce();
    const edited = `${await fse.readFile(claudeFile(), 'utf-8')}\nMy own note.\n`;
    await fse.writeFile(claudeFile(), edited);
    await writeAliases({ aliases: { strong: { claude: 'fable', codex: 'gpt-6-luna' } } });

    await pull({ silent: true });

    expect(alreadySynced()).toBe(true);
    expect(await fse.readFile(claudeFile(), 'utf-8')).toBe(edited);
    expect(logged('warn', /Kept .*implementer\.md: you changed it/)).toBe(true);
    expect(await codexModel()).toMatchObject({ model: 'gpt-6-luna' });
    const recorded = (await homeRecord())?.agentModels?.['implementer'];
    expect(recorded?.['claude']).toEqual({ step: 'team', model: 'opus', effort: 'high' });
    expect(recorded?.['codex']).toEqual({ step: 'team', model: 'gpt-6-luna' });
  });

  describe('local override', () => {
    const writeLocal = (text: string): Promise<void> => fse.outputFile(path.join(homeDir, '.teamai/models/aliases.yaml'), text);

    it('applies an edited override on an ordinary pull, and ~ or default sends the tool to its default', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await pullOnce();
      await writeLocal('aliases:\n  strong:\n    codex: { model: gpt-6-astra, effort: low }\n');

      await pull({ silent: true });

      expect(alreadySynced()).toBe(true);
      expect(await codexModel()).toMatchObject({ model: 'gpt-6-astra', model_reasoning_effort: 'low' });
      expect(await claudeModel()).toMatchObject({ model: 'opus', effort: 'high' });
      expect((await homeRecord())?.agentModels?.['implementer']?.['codex']).toEqual({ step: 'local', model: 'gpt-6-astra', effort: 'low' });

      vi.clearAllMocks();
      await writeLocal('aliases:\n  strong:\n    codex: default\n');
      await pull({ silent: true });

      expect(alreadySynced()).toBe(true);
      const codex = await codexModel();
      expect(codex).toHaveProperty('name', 'implementer');
      expect(codex).not.toHaveProperty('model');
      expect(codex).not.toHaveProperty('model_reasoning_effort');
      expect((await homeRecord())?.agentModels?.['implementer']?.['codex']).toEqual({ step: 'local' });
    });

    it('says a kept copy\'s deployed version changed without blaming the team', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await pullOnce();
      await fse.writeFile(claudeFile(), `${await fse.readFile(claudeFile(), 'utf-8')}\nMy own note.\n`);
      await writeLocal('aliases:\n  strong:\n    claude: sonnet\n');

      await pull({ silent: true });

      expect(logged('warn', /Kept .*implementer\.md: you changed it, and the version teamai would deploy there \(agents\/implementer\.yaml\) has changed since/)).toBe(true);
      expect(logged('warn', /team version/)).toBe(false);
    });

    it('applies in a project checkout too', async () => {
      await writeAliases(STRONG);
      await writeAgent(IMPLEMENTER);
      await writeLocal('aliases:\n  strong:\n    claude: sonnet\n');
      const projectRoot = path.join(tmpDir, 'project');
      await fse.ensureDir(path.join(projectRoot, '.git'));
      await fse.ensureDir(path.join(projectRoot, '.claude'));
      vi.mocked(detectProjectConfig).mockResolvedValue({ ...localConfig, scope: 'project', projectRoot });

      await pull({ silent: true });

      const projectCopy = path.join(projectRoot, '.claude', 'agents', 'implementer.md');
      expect(matter(await fse.readFile(projectCopy, 'utf-8')).data).toMatchObject({ model: 'sonnet' });
    });
  });

  it('warns when a model resolved by an alias at the last pull is now written literally', async () => {
    await writeAliases({ aliases: { reviewer: { claude: { model: 'opus', effort: 'max' } } } });
    await writeAgent({ ...IMPLEMENTER, model: 'reviewer' });
    await pullOnce();
    expect(await claudeModel()).toMatchObject({ model: 'opus' });
    await writeAliases({ aliases: {} });

    await pull({ silent: true });

    expect(alreadySynced()).toBe(true);
    expect(await claudeModel()).toMatchObject({ model: 'reviewer' });
    expect(logged('warn', /agents\/implementer\.yaml sets model: reviewer, which is no longer a model alias.*claude received "opus" at the last pull/)).toBe(true);
  });

  it('keeps separate records for the user scope and a project checkout', async () => {
    await writeAliases(STRONG);
    await writeAgent(IMPLEMENTER);
    await pullOnce();

    const projectRoot = path.join(tmpDir, 'project');
    await fse.ensureDir(path.join(projectRoot, '.git'));
    await fse.ensureDir(path.join(projectRoot, '.claude'));
    const projectConfig: LocalConfig = { ...localConfig, scope: 'project', projectRoot };
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    await pull({ silent: true });
    const projectCopy = path.join(projectRoot, '.claude', 'agents', 'implementer.md');
    expect(matter(await fse.readFile(projectCopy, 'utf-8')).data).toMatchObject({ model: 'opus' });
    const projectRecord = Object.values((await loadStateForScope(projectConfig)).lastPullByWorkspace ?? {})[0];
    expect(projectRecord?.agentModels?.['implementer']?.['claude']).toEqual({ step: 'team', model: 'opus', effort: 'high' });

    // The project checkout's copy goes back to an older CLI's; the user
    // scope's record is untouched, and the project pull fixes only its own.
    const literal = renderForTool(IMPLEMENTER, 'claude').content;
    await fse.writeFile(projectCopy, literal);
    const projectState = await loadStateForScope(projectConfig);
    const record = Object.values(projectState.lastPullByWorkspace ?? {})[0]!;
    record.delivered = { ...record.delivered, [projectCopy]: crypto.createHash('sha256').update(literal).digest('hex') };
    delete record.agentModels;
    await saveStateForScope(projectState, projectConfig);
    const userCopyBefore = await fse.stat(claudeFile());
    vi.clearAllMocks();

    await pull({ silent: true });

    expect(alreadySynced()).toBe(true);
    expect(matter(await fse.readFile(projectCopy, 'utf-8')).data).toMatchObject({ model: 'opus', effort: 'high' });
    expect((await fse.stat(claudeFile())).mtimeMs).toBe(userCopyBefore.mtimeMs);
    expect((await homeRecord())?.agentModels?.['implementer']?.['claude']).toEqual({ step: 'team', model: 'opus', effort: 'high' });
  });
});
