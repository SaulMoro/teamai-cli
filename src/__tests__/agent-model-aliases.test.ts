/**
 * Model aliases on pull (#830): an agent with `model: strong` receives, in
 * each tool, the model and effort the team maps for that tool in
 * `models/aliases.yaml`, and no model field where the team maps none.
 * Asserted through the agents handler, on the files it leaves in tool dirs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
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
import { ModelProfileSchema, resolveProfile, type ModelAgent } from '../models/profile.js';
import { switchModelProfile } from '../models/switch.js';
import type { AgentModelRecords, LocalConfig, TeamaiConfig } from '../types.js';

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

  /** Rewrite `tool`'s deployed copy of `name`: `edit` changes its fields in place. */
  async function editDeployed(tool: ToolName, name: string, edit: (fields: Record<string, unknown>) => void, body?: string): Promise<void> {
    const dir = path.join(homeDir, `.${tool}/agents`);
    const toml = path.join(dir, `${name}.toml`);
    if (await fse.pathExists(toml)) {
      const fields = { ...parseToml(await fse.readFile(toml, 'utf-8')) } as Record<string, unknown>;
      edit(fields);
      if (body !== undefined) fields['developer_instructions'] = body;
      await fse.writeFile(toml, stringifyToml(fields));
      return;
    }
    const md = path.join(dir, `${name}.md`);
    const parsed = matter(await fse.readFile(md, 'utf-8'));
    const fields = { ...parsed.data };
    edit(fields);
    await fse.writeFile(md, matter.stringify(body ?? parsed.content, fields));
  }

  const scan = (tools: readonly ToolName[]): Promise<AgentResourceItem[]> => handler.scanLocalForPush(teamConfigFor(tools), localConfig);

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

  describe('tools switched to a model profile', () => {
    beforeEach(async () => {
      // The switch finds each tool's live settings through these.
      for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG']) vi.stubEnv(key, '');
      vi.stubEnv('XDG_CONFIG_HOME', path.join(homeDir, '.config'));
    });

    /** `teamai models switch` for `agents`, to a gateway that serves every protocol. */
    async function switchTo(agents: ModelAgent[]): Promise<void> {
      for (const agent of agents) await fse.ensureDir(agent === 'opencode' ? path.join(homeDir, '.config/opencode') : path.join(homeDir, `.${agent}`));
      const profile = ModelProfileSchema.parse({
        id: 'gateway',
        name: 'Gateway',
        base_url: 'https://gateway.example.test',
        api_key: '${API_KEY}',
        model_groups: [{ protocols: ['anthropic', 'openai-responses', 'openai-chat-completions'], models: ['claude-opus-4-8', 'gpt-gateway'] }],
      });
      const resolved = resolveProfile({ source: 'team', profile, team: 'another-team' }, {
        'team:gateway@https://gateway.example.test': { API_KEY: { value: 'secret' } },
      });
      const results = await switchModelProfile(resolved, agents);
      expect(results.map((result) => result.status)).toEqual(agents.map(() => 'switched'));
    }

    const EVERY_TOOL_STRONG = {
      aliases: {
        strong: {
          claude: [{ model: 'opus', effort: 'high' }],
          codex: { model: 'gpt-6-sol', effort: 'high' },
          opencode: { model: 'anthropic/claude-opus-5-5', effort: 'high' },
          codebuddy: { model: 'gpt-6-sol', effort: 'high' },
          workbuddy: 'gpt-6-sol',
        },
      },
    };

    it('gives OpenCode, CodeBuddy and WorkBuddy no model and no effort', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await switchTo(['opencode', 'codebuddy', 'workbuddy']);
      const files = await pullTo(['opencode', 'codebuddy', 'workbuddy'], makeSpec({ model: 'strong' }));
      for (const tool of ['opencode', 'codebuddy', 'workbuddy']) {
        expect(files[tool]).toHaveProperty('description', 'Implements a change');
        for (const field of ['model', 'effort', 'variant']) expect(files[tool]).not.toHaveProperty(field);
      }
    });

    it('keeps Claude\'s sonnet and haiku from the local entry, and drops any other model', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await switchTo(['claude']);
      const localFile = path.join(homeDir, '.teamai/models/aliases.yaml');
      for (const model of ['sonnet', 'haiku']) {
        await fse.outputFile(localFile, YAML.stringify({ aliases: { strong: { claude: { model, effort: 'low' } } } }));
        const claude = (await pullTo(['claude'], makeSpec({ model: 'strong' })))['claude'];
        expect(claude).toMatchObject({ model });
        expect(claude).not.toHaveProperty('effort');
      }
      await fse.outputFile(localFile, YAML.stringify({ aliases: { strong: { claude: 'claude-opus-4-8' } } }));
      expect((await pullTo(['claude'], makeSpec({ model: 'strong' })))['claude']).not.toHaveProperty('model');
    });

    it('keeps the member\'s opt-out an opt-out', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await fse.outputFile(path.join(homeDir, '.teamai/models/aliases.yaml'), 'aliases:\n  strong:\n    claude: ~\n');
      await switchTo(['claude']);
      const claude = (await pullTo(['claude'], makeSpec({ model: 'strong' })))['claude'];
      expect(claude).toHaveProperty('name', 'implementer');
      expect(claude).not.toHaveProperty('model');
    });

    it('never treats a variant as switched', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await switchTo(['claude', 'codex']);
      const files = await pullTo(['claude-internal', 'tclaude', 'codex-internal', 'tcodex'], makeSpec({ model: 'strong' }));
      for (const tool of ['claude-internal', 'tclaude']) expect(files[tool]).toMatchObject({ model: 'opus', effort: 'high' });
      for (const tool of ['codex-internal', 'tcodex']) expect(files[tool]).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'high' });
    });

    it('leaves an extras model and a literal model as written', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await switchTo(['codex']);
      expect((await pullTo(['codex'], makeSpec({ model: 'strong', tool_extras: { codex: { model: 'gpt-pinned' } } })))['codex'])
        .toMatchObject({ model: 'gpt-pinned' });
      expect((await pullTo(['codex'], makeSpec({ model: 'gpt-literal' })))['codex']).toMatchObject({ model: 'gpt-literal' });
    });

    it('points push drift on a switched tool at models restore', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await switchTo(['codex']);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['codex'], spec);
      await editDeployed('codex', spec.name, (fields) => { fields['model'] = 'gpt-5'; });

      const [candidate] = await scan(['codex']);
      expect(candidate.mergedSpec).toBeUndefined();
      expect(candidate.skipReason).toContain('but model: strong gives codex no model, because codex is switched to a model profile.');
      expect(candidate.skipReason).toContain('Run `teamai models restore --agent codex` to take codex off the profile, or switch it to another one.');
    });

    it('holds alias agents in the tool whose switch state cannot be read, and only there', async () => {
      await writeAliases(EVERY_TOOL_STRONG);
      await switchTo(['codex']);
      await fse.writeFile(path.join(homeDir, '.codex/config.toml'), 'model = [unterminated\n');
      const files = await pullTo(['claude', 'codex'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toMatchObject({ model: 'opus', effort: 'high' });
      expect(files['codex']).toEqual({});
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining(
        'Held implementer.yaml for codex: Cannot tell whether a tool is switched to a model profile: Cannot parse Codex config.toml',
      ));
    });

    it('holds alias agents in every switchable tool, in one warning, while the switch records cannot be read', async () => {
      await writeAliases({ aliases: { strong: { ...EVERY_TOOL_STRONG.aliases.strong, cursor: 'claude-opus-5' } } });
      await fse.outputFile(path.join(homeDir, '.teamai/models/managed.json'), '{broken');
      const files = await pullTo(['claude', 'codex', 'cursor'], makeSpec({ model: 'strong' }));
      expect(files['claude']).toEqual({});
      expect(files['codex']).toEqual({});
      expect(files['cursor']).toMatchObject({ model: 'claude-opus-5' });
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining(
        'Held implementer.yaml for claude, codex: Cannot tell whether a tool is switched to a model profile: Cannot parse model ownership manifest',
      ));
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

    /** What the last pull recorded for this checkout's agent copies. */
    async function recordModels(agentModels: AgentModelRecords): Promise<void> {
      const state = await loadStateForScope(localConfig);
      state.lastPullByWorkspace = { [await checkoutKey(homeDir)]: { rev: 'abc1234', targets: ['claude', 'codex'], agentModels } };
      await saveStateForScope(state, localConfig);
    }

    it.each([
      ['claude', { claude: { model: 'opus', effort: 'high' } }, 'color', 'blue'],
      ['codex', { codex: { model: 'gpt-6-sol', effort: 'high' } }, 'sandbox_mode', 'read-only'],
      ['opencode', { opencode: { model: 'anthropic/claude-opus-5-5', effort: 'max' } }, 'temperature', 0.2],
      ['codebuddy', { codebuddy: { model: 'glm-5', effort: 'high' } }, 'color', 'blue'],
      ['qoder-cn', { qoder: { model: 'performance', effort: 'high' } }, 'color', 'blue'],
    ] as const)('proposes only the unrelated extras key added to %s, not the alias effort', async (tool, mapping, key, value) => {
      await writeAliases({ aliases: { strong: mapping } });
      const spec = makeSpec({ model: 'strong' });
      await pullTo([tool], spec);
      await editDeployed(tool, spec.name, (fields) => { fields[key] = value; });

      const [candidate, ...rest] = await scan([tool]);
      expect(rest).toEqual([]);
      expect(candidate.skipReason).toBeUndefined();
      const { tool_extras: extras, ...root } = candidate.mergedSpec!;
      expect(root).toEqual(spec);
      // OpenCode's reverse also carries the `mode: subagent` teamai renders (pre-existing).
      const { mode: _mode, ...own } = extras?.[tool] ?? {};
      expect(Object.keys(extras ?? {})).toEqual([tool]);
      expect(own).toEqual({ [key]: value });
    });

    it('does not read an effort the base tool\'s extras set as removed from tclaude', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong', tool_extras: { claude: { effort: 'low', color: 'blue' } } });
      await pullTo(['tclaude'], spec);
      await editDeployed('tclaude', spec.name, (fields) => { fields['memory'] = 'user'; });

      const [candidate] = await scan(['tclaude']);
      expect(candidate.skipReason).toBeUndefined();
      expect(candidate.mergedSpec?.tool_extras).toEqual({ claude: { effort: 'low', color: 'blue' }, tclaude: { memory: 'user' } });
    });

    it('does not report a copy written with the recorded resolution after the team changed the alias', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['claude', 'codex'], spec);
      await recordModels({ implementer: {
        claude: { step: 'team', model: 'opus', effort: 'high' },
        codex: { step: 'team', model: 'gpt-6-sol', effort: 'high' },
      } });
      await writeAliases({ aliases: { strong: { claude: 'fable', codex: { model: 'gpt-6-astra', effort: 'xhigh' } } } });
      expect(await scan(['claude', 'codex'])).toEqual([]);
      // What push's kept-copy warning compares with: the copy as recorded, not the new resolution.
      const item = { name: spec.name, type: 'agents' as const, sourcePath: path.join(repoPath, 'agents/implementer.yaml'), relativePath: 'agents/implementer.yaml' };
      const targets = await handler.recordedDeliveryTargets(teamConfigFor(['claude', 'codex']), localConfig, item);
      expect(targets.map((target) => target.tool)).toEqual(['claude', 'codex']);
      for (const target of targets) expect(target.content).toBe(await fse.readFile(target.dest, 'utf-8'));

      await editDeployed('codex', spec.name, () => {}, 'Edited instructions.');
      const [candidate] = await scan(['claude', 'codex']);
      expect(candidate.modelDrift).toBeUndefined();
      expect(candidate.mergedSpec).toEqual({ ...spec, instructions: 'Edited instructions.' });
    });

    it('never proposes a concrete model over an alias, and reports a copy unlike the current mapping as drift without a record', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['claude'], spec);
      await writeAliases({ aliases: { strong: { claude: 'fable' } } });

      const [candidate] = await scan(['claude']);
      expect(candidate.mergedSpec).toBeUndefined();
      expect(candidate.skipReason).toContain('its claude copy');
      expect(candidate.skipReason).toContain('sets model "opus" and effort "high", but model: strong gives claude model "fable" from');
    });

    it('pushes edits made in two tools while one of them changed the model by hand', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['claude', 'codex'], spec);
      await editDeployed('claude', spec.name, (fields) => { fields['model'] = 'sonnet'; }, 'Edited instructions.');
      await editDeployed('codex', spec.name, () => {}, 'Edited instructions.');

      const [candidate] = await scan(['claude', 'codex']);
      expect(candidate.skipReason).toBeUndefined();
      expect(candidate.mergedSpec).toEqual({ ...spec, instructions: 'Edited instructions.' });
      expect(candidate.modelDrift).toEqual([expect.stringContaining('its claude copy')]);
    });

    it('reports a hand-set model and effort as drift, pointing at the member\'s override and the team file', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['codex'], spec);
      await editDeployed('codex', spec.name, (fields) => {
        fields['model'] = 'gpt-5';
        fields['model_reasoning_effort'] = 'low';
      });

      const [candidate] = await scan(['codex']);
      expect(candidate.mergedSpec).toBeUndefined();
      const localFile = path.join(homeDir, '.teamai/models/aliases.yaml');
      expect(candidate.skipReason).toBe(
        `its codex copy (${path.join(homeDir, '.codex/agents/implementer.toml')}) sets model "gpt-5" and model_reasoning_effort "low", `
        + 'but model: strong gives codex model "gpt-6-sol" and model_reasoning_effort "high" from the team\'s models/aliases.yaml. '
        + 'Push never writes a concrete model over a model alias, so this change stays on this machine. '
        + `To use it on this machine, map strong.codex in ${localFile}; for the whole team, change strong.codex in models/aliases.yaml.`,
      );
    });

    it('pushes instructions and unrelated extras while the effort drifted, without pinning it', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['claude'], spec);
      await editDeployed('claude', spec.name, (fields) => {
        fields['effort'] = 'max';
        fields['color'] = 'blue';
      }, 'Edited instructions.');

      const [candidate] = await scan(['claude']);
      expect(candidate.mergedSpec).toEqual({ ...spec, instructions: 'Edited instructions.', tool_extras: { claude: { color: 'blue' } } });
      expect(candidate.modelDrift).toEqual([expect.stringContaining('sets model "opus" and effort "max"')]);
    });

    it('points drift from the member\'s override at the override file', async () => {
      await writeAliases(STRONG);
      const localFile = path.join(homeDir, '.teamai/models/aliases.yaml');
      await fse.outputFile(localFile, YAML.stringify({ aliases: { strong: { codex: 'gpt-6-astra' } } }));
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['codex'], spec);
      await editDeployed('codex', spec.name, (fields) => { fields['model'] = 'gpt-5'; });

      const [candidate] = await scan(['codex']);
      expect(candidate.skipReason).toContain(`gives codex model "gpt-6-astra" from your ${localFile}.`);
      expect(candidate.skipReason).toContain(`To use it, change strong.codex in ${localFile}.`);
    });

    it.each([['strong', 'fast'], ['opus', 'strong']])('adopts model: %s -> %s written in a deployed file', async (from, to) => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: from });
      await pullTo(['claude', 'codex'], spec);
      await editDeployed('claude', spec.name, (fields) => { fields['model'] = to; });

      const [candidate] = await scan(['claude', 'codex']);
      expect(candidate.skipReason).toBeUndefined();
      expect(candidate.modelDrift).toBeUndefined();
      expect(candidate.mergedSpec).toEqual({ ...spec, model: to });
    });

    it('pushes a new native agent\'s literal model', async () => {
      await writeAliases(STRONG);
      await fse.outputFile(path.join(homeDir, '.claude/agents/fresh.md'),
        matter.stringify('Do it.', { name: 'fresh', description: 'New', model: 'opus', effort: 'high' }));

      const [candidate] = await scan(['claude']);
      expect(candidate.status).toBe('new');
      expect(candidate.mergedSpec).toMatchObject({ model: 'opus', tool_extras: { claude: { effort: 'high' } } });
    });

    it('skips an alias agent with a reason while the aliases file cannot be read', async () => {
      await writeAliases(STRONG);
      const spec = makeSpec({ model: 'strong' });
      await pullTo(['claude'], spec);
      await editDeployed('claude', spec.name, () => {}, 'Edited instructions.');
      await writeAliases('aliases: [broken');

      const [candidate] = await scan(['claude']);
      expect(candidate.mergedSpec).toBeUndefined();
      expect(candidate.skipReason).toContain('its model cannot be resolved: Invalid model aliases YAML at models/aliases.yaml');
    });
  });
});
