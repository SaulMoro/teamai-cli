/**
 * Model aliases on pull (#830): an agent with `model: strong` receives, in
 * each tool, the model and effort the team maps for that tool in
 * `models/aliases.yaml`, and no model field where the team maps none.
 * Asserted through the agents handler, on the files it leaves in tool dirs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import matter from 'gray-matter';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../utils/logger.js', () => ({
  log: {
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
  })),
}));

import { AgentsHandler, type AgentResourceItem } from '../resources/agents.js';
import type { AgentSpec, ToolName } from '../resources/agent-format.js';
import { serializeAgentYaml } from '../resources/agent-format.js';
import { log } from '../utils/logger.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import { loadStateForScope, saveStateForScope } from '../config.js';
import { checkoutKey } from '../pull.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

const STRONG = {
  aliases: {
    strong: {
      claude: [{ model: 'opus', effort: 'high' }, { model: 'fable' }],
      codex: { model: 'gpt-6-sol', effort: 'high' },
    },
    fast: { claude: 'haiku', codex: 'gpt-6-luna' },
    reviewer: { claude: [{ model: 'opus', effort: 'max' }] },
  },
};

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    name: 'implementer',
    description: 'Implements a change',
    instructions: 'Make the change.',
    ...overrides,
  };
}

function teamConfigFor(tools: readonly ToolName[]): TeamaiConfig {
  return {
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
    // Copilot's user-scope base dir is ~/.copilot itself.
    toolPaths: Object.fromEntries(tools.map((tool) => [tool, { agents: tool === 'copilot' ? 'agents' : `.${tool}/agents` }])),
  } as TeamaiConfig;
}

describe('AgentsHandler pull: model aliases', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let handler: AgentsHandler;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-agent-aliases-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'agents'));
    vi.stubEnv('HOME', homeDir);
    vi.mocked(log.warn).mockClear();
    resetWarnOnce();
    handler = new AgentsHandler();
    localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.com' },
      username: 'testuser',
      additionalRoles: [],
      scope: 'user',
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  async function writeAliases(content: unknown): Promise<void> {
    await fse.outputFile(path.join(repoPath, 'models/aliases.yaml'), typeof content === 'string' ? content : YAML.stringify(content));
  }

  /** Pull one YAML agent to `tools` and return what each tool's file holds. */
  async function pullTo(tools: readonly ToolName[], spec: AgentSpec): Promise<Record<string, Record<string, unknown>>> {
    const yamlPath = path.join(repoPath, 'agents', `${spec.name}.yaml`);
    await fse.writeFile(yamlPath, serializeAgentYaml(spec));
    for (const tool of tools) await fse.ensureDir(path.join(homeDir, `.${tool}`));
    const config = teamConfigFor(tools);
    await handler.pullItem({ name: spec.name, type: 'agents', sourcePath: yamlPath, relativePath: `agents/${spec.name}.yaml` }, config, localConfig);
    return Object.fromEntries(await Promise.all(tools.map(async (tool) => [tool, await readDeployed(tool, spec.name)] as const)));
  }

  async function readDeployed(tool: ToolName, name: string): Promise<Record<string, unknown>> {
    const dir = path.join(homeDir, `.${tool}/agents`);
    const toml = path.join(dir, `${name}.toml`);
    if (await fse.pathExists(toml)) return parseToml(await fse.readFile(toml, 'utf-8')) as Record<string, unknown>;
    const json = path.join(dir, `${name}.json`);
    if (await fse.pathExists(json)) return JSON.parse(await fse.readFile(json, 'utf-8')) as Record<string, unknown>;
    for (const ext of ['.agent.md', '.md']) {
      const md = path.join(dir, `${name}${ext}`);
      if (await fse.pathExists(md)) return matter(await fse.readFile(md, 'utf-8')).data as Record<string, unknown>;
    }
    return {};
  }

  it('writes the team model and effort in each tool\'s own field', async () => {
    await writeAliases(STRONG);
    const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'strong' }));
    expect(files['claude']).toMatchObject({ model: 'opus', effort: 'high' });
    expect(files['codex']).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'high' });
    expect(files['codex']).not.toHaveProperty('effort');
  });

  it('writes no Codex effort when the mapping has none', async () => {
    await writeAliases(STRONG);
    const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'fast' }));
    expect(files['claude']).toMatchObject({ model: 'haiku' });
    expect(files['claude']).not.toHaveProperty('effort');
    expect(files['codex']).toMatchObject({ model: 'gpt-6-luna' });
    expect(files['codex']).not.toHaveProperty('model_reasoning_effort');
  });

  it('writes no model field for a tool the team does not map', async () => {
    await writeAliases(STRONG);
    const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'reviewer' }));
    expect(files['claude']).toMatchObject({ model: 'opus', effort: 'max' });
    expect(files['codex']).toHaveProperty('name', 'implementer');
    expect(files['codex']).not.toHaveProperty('model');
  });

  it('writes no model field for strong when the team has no aliases file', async () => {
    const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'strong' }));
    for (const tool of ['claude', 'codex']) {
      expect(files[tool]).toHaveProperty('name', 'implementer');
      expect(files[tool]).not.toHaveProperty('model');
    }
  });

  it.each([['a concrete model', 'opus', {}], ['a name the team does not define', 'reviewer', undefined]] as const)(
    'writes %s literally', async (_label, model, aliases) => {
      if (aliases) await writeAliases(STRONG);
      const files = await pullTo(['claude', 'codex'], makeSpec({ model }));
      expect(files['claude']).toMatchObject({ model });
      expect(files['claude']).not.toHaveProperty('effort');
      expect(files['codex']).toMatchObject({ model });
    },
  );

  it.each([
    ['claude-internal', { model: 'opus', effort: 'high' }],
    ['tclaude', { model: 'opus', effort: 'high' }],
    ['codex-internal', { model: 'gpt-6-sol', model_reasoning_effort: 'high' }],
    ['tcodex', { model: 'gpt-6-sol', model_reasoning_effort: 'high' }],
  ] as const)('%s inherits its base tool\'s entry', async (tool, expected) => {
    await writeAliases(STRONG);
    const files = await pullTo([tool], makeSpec({ model: 'strong' }));
    expect(files[tool]).toMatchObject(expected);
  });

  it('an exact tool key wins over the inherited one', async () => {
    await writeAliases({ aliases: { strong: { claude: { model: 'opus', effort: 'high' }, tclaude: 'sonnet', tcodex: { model: 'gpt-6-astra', effort: 'xhigh' } } } });
    const files = await pullTo(['tclaude', 'claude', 'tcodex'], makeSpec({ model: 'strong' }));
    expect(files['tclaude']).toMatchObject({ model: 'sonnet' });
    expect(files['tclaude']).not.toHaveProperty('effort');
    expect(files['claude']).toMatchObject({ model: 'opus', effort: 'high' });
    expect(files['tcodex']).toMatchObject({ model: 'gpt-6-astra', model_reasoning_effort: 'xhigh' });
  });

  it('writes OpenCode\'s effort as variant', async () => {
    await writeAliases({ aliases: { strong: { opencode: { model: 'anthropic/claude-opus-5-5', effort: 'max' } } } });
    const files = await pullTo(['opencode'], makeSpec({ model: 'strong' }));
    expect(files['opencode']).toMatchObject({ model: 'anthropic/claude-opus-5-5', variant: 'max' });
    expect(files['opencode']).not.toHaveProperty('effort');
  });

  it.each(['codebuddy', 'qoder', 'qoder-cn'] as const)('writes %s\'s effort as effort', async (tool) => {
    await writeAliases({ aliases: { strong: { [tool]: { model: 'performance', effort: 'xhigh' } } } });
    const files = await pullTo([tool], makeSpec({ model: 'strong' }));
    expect(files[tool]).toMatchObject({ model: 'performance', effort: 'xhigh' });
  });

  it('qoder-cn inherits the qoder entry, and its own key wins', async () => {
    await writeAliases({ aliases: {
      strong: { qoder: { model: 'performance', effort: 'high' } },
      fast: { qoder: 'lite', 'qoder-cn': { model: 'efficient', effort: 'low' } },
    } });
    expect((await pullTo(['qoder-cn'], makeSpec({ model: 'strong' })))['qoder-cn']).toMatchObject({ model: 'performance', effort: 'high' });
    expect((await pullTo(['qoder-cn'], makeSpec({ model: 'fast' })))['qoder-cn']).toMatchObject({ model: 'efficient', effort: 'low' });
  });

  it('qoder does not inherit the claude entry', async () => {
    await writeAliases(STRONG);
    const files = await pullTo(['qoder'], makeSpec({ model: 'strong' }));
    expect(files['qoder']).toHaveProperty('name', 'implementer');
    expect(files['qoder']).not.toHaveProperty('model');
  });

  it('writes Cursor\'s model as the team wrote it, bracket effort included', async () => {
    await writeAliases({ aliases: { strong: { cursor: 'claude-opus-5[effort=high]' } } });
    const files = await pullTo(['cursor'], makeSpec({ model: 'strong' }));
    expect(files['cursor']).toMatchObject({ model: 'claude-opus-5[effort=high]' });
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it('writes only the first Copilot entry, as one model string', async () => {
    await writeAliases({ aliases: { strong: { copilot: ['claude-opus-5', 'gpt-6-sol'] } } });
    const files = await pullTo(['copilot'], makeSpec({ model: 'strong' }));
    expect(files['copilot']).toMatchObject({ model: 'claude-opus-5' });
  });

  it.each(['cursor', 'copilot', 'kiro', 'workbuddy', 'joycode', 'zcode', 'omp'] as const)(
    'drops an effort mapped for %s with a warning and writes the model', async (tool) => {
      await writeAliases({ aliases: { strong: { [tool]: [{ model: 'claude-opus-5', effort: 'high' }, 'claude-sonnet-5'] } } });
      const files = await pullTo([tool], makeSpec({ model: 'strong' }));
      expect(files[tool]).toMatchObject({ model: 'claude-opus-5' });
      for (const field of ['effort', 'variant', 'model_reasoning_effort', 'reasoning-effort']) expect(files[tool]).not.toHaveProperty(field);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining(
        `alias "strong" sets an effort for ${tool}, but effort is not supported for ${tool} agent files, so ${tool} receives the model without it.`,
      ));
    },
  );

  it('suggests Cursor\'s bracket form for a dropped Cursor effort', async () => {
    await writeAliases({ aliases: { strong: { cursor: { model: 'claude-opus-5', effort: 'high' } } } });
    await pullTo(['cursor'], makeSpec({ model: 'strong' }));
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('"claude-opus-5[effort=high]"'));
  });

  it('warns about a dropped effort once per alias and tool in a pull', async () => {
    await writeAliases({ aliases: { strong: { kiro: { model: 'claude-opus-5', effort: 'high' } } } });
    await pullTo(['kiro'], makeSpec({ model: 'strong' }));
    await pullTo(['kiro'], makeSpec({ name: 'reviewer', model: 'strong' }));
    expect(vi.mocked(log.warn).mock.calls.filter(([message]) => String(message).includes('sets an effort for kiro'))).toHaveLength(1);
  });

  it('an extras model skips the alias, effort included', async () => {
    await writeAliases(STRONG);
    const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'strong', tool_extras: { claude: { model: 'sonnet' } } }));
    expect(files['claude']).toMatchObject({ model: 'sonnet' });
    expect(files['claude']).not.toHaveProperty('effort');
    expect(files['codex']).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'high' });
  });

  it('an extras effort without an extras model overrides the alias effort', async () => {
    await writeAliases(STRONG);
    const files = await pullTo(['claude', 'codex'], makeSpec({
      model: 'strong',
      tool_extras: { claude: { effort: 'low' }, codex: { model_reasoning_effort: 'medium' } },
    }));
    expect(files['claude']).toMatchObject({ model: 'opus', effort: 'low' });
    expect(files['codex']).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'medium' });
  });

  it('ignores a gateways key inside an alias', async () => {
    await writeAliases({ aliases: { strong: { claude: 'opus', gateways: { corp: { claude: 'gw-opus' } } } } });
    const files = await pullTo(['claude'], makeSpec({ model: 'strong' }));
    expect(files['claude']).toMatchObject({ model: 'opus' });
  });

  it('skips a YAML agent whose model is not a string', async () => {
    const yamlPath = path.join(repoPath, 'agents/implementer.yaml');
    await fse.writeFile(yamlPath, 'name: implementer\ndescription: d\ninstructions: i\nmodel: [opus, sonnet]\n');
    await fse.ensureDir(path.join(homeDir, '.claude'));
    await handler.pullItem({ name: 'implementer', type: 'agents', sourcePath: yamlPath, relativePath: 'agents/implementer.yaml' }, teamConfigFor(['claude']), localConfig);
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents/implementer.md'))).toBe(false);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('implementer.yaml field model must be a string'));
  });

  it('warns about an alias in a legacy .md agent and copies it as is', async () => {
    await writeAliases(STRONG);
    const mdPath = path.join(repoPath, 'agents/legacy.md');
    const content = '---\nname: legacy\ndescription: d\nmodel: reviewer\n---\nDo it.\n';
    await fse.writeFile(mdPath, content);
    await fse.ensureDir(path.join(homeDir, '.claude'));
    await handler.pullItem(
      { name: 'legacy', type: 'agents', sourcePath: mdPath, relativePath: 'agents/legacy.md', legacy: true } as AgentResourceItem,
      teamConfigFor(['claude']),
      localConfig,
    );
    expect(await fse.readFile(path.join(homeDir, '.claude/agents/legacy.md'), 'utf-8')).toBe(content);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('agents/legacy.md sets model: reviewer, a model alias'));
  });

  it('holds agents with a model while the aliases file is invalid', async () => {
    await writeAliases(STRONG);
    await pullTo(['claude'], makeSpec({ model: 'strong' }));
    const deployed = path.join(homeDir, '.claude/agents/implementer.md');
    const before = await fse.readFile(deployed, 'utf-8');

    await writeAliases({ aliases: { Strong: { claude: 'opus' } } });
    const files = await pullTo(['claude'], makeSpec({ model: 'strong', instructions: 'Changed.' }));
    expect(await fse.readFile(deployed, 'utf-8')).toBe(before);
    expect(files['claude']).toMatchObject({ model: 'opus' });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('Held implementer.yaml: Invalid model aliases file at models/aliases.yaml'));

    const never = await pullTo(['claude'], makeSpec({ name: 'never', model: 'opus' }));
    expect(never['claude']).toEqual({});
    const plain = await pullTo(['claude'], makeSpec({ name: 'plain' }));
    expect(plain['claude']).toHaveProperty('name', 'plain');
  });

  it('removes an inactive namespace agent written with the model its record names', async () => {
    await writeAliases(STRONG);
    const spec = makeSpec({ name: 'vr', model: 'strong' });
    const yamlPath = path.join(repoPath, 'agents', 'fe', 'vr.yaml');
    await fse.outputFile(yamlPath, serializeAgentYaml(spec));
    await fse.ensureDir(path.join(homeDir, '.claude'));
    const config = teamConfigFor(['claude']);
    await handler.pullItem({ name: 'vr', type: 'agents', sourcePath: yamlPath, relativePath: 'agents/fe/vr.yaml', namespace: 'fe' }, config, localConfig);
    const deployed = path.join(homeDir, '.claude/agents/vr.md');
    expect(matter(await fse.readFile(deployed, 'utf-8')).data).toMatchObject({ model: 'opus' });
    // What that pull recorded; the alias has changed since.
    const state = await loadStateForScope(localConfig);
    state.lastPullByWorkspace = { [await checkoutKey(homeDir)]: {
      rev: 'abc1234', targets: ['claude'], agentModels: { vr: { claude: { step: 'team', model: 'opus', effort: 'high' } } },
    } };
    await saveStateForScope(state, localConfig);
    await writeAliases({ aliases: { strong: { claude: 'fable' } } });

    await handler.cleanupInactiveNamespaces(config, localConfig, []);

    expect(await fse.pathExists(deployed)).toBe(false);
    expect(vi.mocked(log.warn).mock.calls.flat().join('\n')).not.toMatch(/Kept agent/);
  });

  describe('local override', () => {
    const localFile = (): string => path.join(homeDir, '.teamai/models/aliases.yaml');
    async function writeLocal(content: unknown): Promise<void> {
      await fse.outputFile(localFile(), typeof content === 'string' ? content : YAML.stringify(content));
    }

    it('replaces the whole team entry for that tool, effort included', async () => {
      await writeAliases(STRONG);
      await writeLocal({ aliases: { strong: { codex: 'gpt-6-astra' } } });
      const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'strong' }));
      expect(files['codex']).toMatchObject({ model: 'gpt-6-astra' });
      expect(files['codex']).not.toHaveProperty('model_reasoning_effort');
      expect(files['claude']).toMatchObject({ model: 'opus', effort: 'high' });
    });

    it('writes the local effort in the tool\'s own field', async () => {
      await writeAliases(STRONG);
      await writeLocal({ aliases: { strong: { codex: { model: 'gpt-6-astra', effort: 'xhigh' } } } });
      const files = await pullTo(['codex'], makeSpec({ model: 'strong' }));
      expect(files['codex']).toMatchObject({ model: 'gpt-6-astra', model_reasoning_effort: 'xhigh' });
    });

    it('sends a tool back to its default with ~ or default', async () => {
      await writeAliases(STRONG);
      await writeLocal('aliases:\n  strong:\n    claude: ~\n    codex: default\n');
      const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'strong' }));
      for (const tool of ['claude', 'codex']) {
        expect(files[tool]).toHaveProperty('name', 'implementer');
        expect(files[tool]).not.toHaveProperty('model');
      }
      expect(files['claude']).not.toHaveProperty('effort');
      expect(files['codex']).not.toHaveProperty('model_reasoning_effort');
    });

    it('maps strong without a team aliases file', async () => {
      await writeLocal({ aliases: { strong: { claude: { model: 'sonnet', effort: 'low' } } } });
      const files = await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toMatchObject({ model: 'sonnet', effort: 'low' });
    });

    it('does not make a name an alias the team does not define', async () => {
      await writeLocal({ aliases: { reviewer: { claude: 'opus', kiro: { model: 'claude-opus-5', effort: 'high' } } } });
      const files = await pullTo(['claude'], makeSpec({ model: 'reviewer' }));
      expect(files['claude']).toMatchObject({ model: 'reviewer' });
      expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
    });

    it('a local claude entry wins over the team\'s tclaude entry, and a local tclaude entry over it', async () => {
      await writeAliases({ aliases: { strong: { claude: 'opus', tclaude: 'opus-internal' } } });
      await writeLocal({ aliases: { strong: { claude: 'sonnet' } } });
      expect((await pullTo(['tclaude'], makeSpec({ model: 'strong' })))['tclaude']).toMatchObject({ model: 'sonnet' });
      await writeLocal({ aliases: { strong: { claude: 'sonnet', tclaude: 'haiku' } } });
      expect((await pullTo(['tclaude'], makeSpec({ model: 'strong' })))['tclaude']).toMatchObject({ model: 'haiku' });
    });

    it('an extras model wins over the local entry', async () => {
      await writeLocal({ aliases: { strong: { claude: 'sonnet' } } });
      const files = await pullTo(['claude'], makeSpec({ model: 'strong', tool_extras: { claude: { model: 'fable' } } }));
      expect(files['claude']).toMatchObject({ model: 'fable' });
    });

    it('holds agents with a model while the local file is invalid, naming it', async () => {
      await writeAliases(STRONG);
      await pullTo(['claude'], makeSpec({ model: 'strong' }));
      const deployed = path.join(homeDir, '.claude/agents/implementer.md');
      const before = await fse.readFile(deployed, 'utf-8');

      await writeLocal({ aliases: { strong: { claude: { effort: 'high' } } } });
      await pullTo(['claude'], makeSpec({ model: 'strong', instructions: 'Changed.' }));
      expect(await fse.readFile(deployed, 'utf-8')).toBe(before);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining(`Held implementer.yaml: Invalid model aliases file at ${localFile()}`));
    });

    it('warns about a dropped local effort naming the local file', async () => {
      await writeLocal({ aliases: { strong: { kiro: { model: 'claude-opus-5', effort: 'high' } } } });
      await pullTo(['kiro'], makeSpec({ model: 'strong' }));
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining(`${localFile()}: alias "strong" sets an effort for kiro`));
    });
  });

  describe('team file opt-out values', () => {
    it('passes default through as a model value', async () => {
      await writeAliases({ aliases: { strong: { codebuddy: 'default' } } });
      const files = await pullTo(['codebuddy'], makeSpec({ model: 'strong' }));
      expect(files['codebuddy']).toMatchObject({ model: 'default' });
    });

    it('rejects ~, holding agents with a model', async () => {
      await writeAliases('aliases:\n  strong:\n    claude: ~\n');
      const files = await pullTo(['claude'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toEqual({});
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining(
        'Held implementer.yaml: Invalid model aliases file at models/aliases.yaml: strong.claude: ~ is accepted only in a member\'s',
      ));
    });
  });

  describe('push', () => {
    it('does not report a pulled alias agent as edited', async () => {
      await writeAliases(STRONG);
      await pullTo(['claude', 'codex', 'tclaude'], makeSpec({ model: 'strong' }));
      expect(await handler.scanLocalForPush(teamConfigFor(['claude', 'codex', 'tclaude']), localConfig)).toEqual([]);
    });

    it('does not report a pulled alias agent with a variant or effort as edited', async () => {
      const tools = ['opencode', 'codebuddy', 'qoder-cn', 'kiro'] as const;
      await writeAliases({ aliases: { strong: {
        opencode: { model: 'anthropic/claude-opus-5-5', effort: 'max' },
        codebuddy: { model: 'glm-5', effort: 'high' },
        qoder: { model: 'performance', effort: 'high' },
        kiro: { model: 'claude-opus-5', effort: 'high' },
      } } });
      await pullTo(tools, makeSpec({ model: 'strong' }));
      expect(await handler.scanLocalForPush(teamConfigFor(tools), localConfig)).toEqual([]);
    });

    it('keeps model: strong when the instructions of an alias agent are edited', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['claude'], spec);
      const deployed = path.join(homeDir, '.claude/agents/implementer.md');
      const parsed = matter(await fse.readFile(deployed, 'utf-8'));
      await fse.writeFile(deployed, matter.stringify('Edited instructions.', parsed.data));

      const candidates = await handler.scanLocalForPush(teamConfigFor(['claude']), localConfig);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].mergedSpec).toEqual({ ...spec, instructions: 'Edited instructions.' });
    });
  });
});
