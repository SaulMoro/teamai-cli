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
    toolPaths: Object.fromEntries(tools.map((tool) => [tool, { agents: `.${tool}/agents` }])),
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
    const md = path.join(dir, `${name}.md`);
    if (await fse.pathExists(md)) return matter(await fse.readFile(md, 'utf-8')).data as Record<string, unknown>;
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

  describe('push', () => {
    it('does not report a pulled alias agent as edited', async () => {
      await writeAliases(STRONG);
      await pullTo(['claude', 'codex', 'tclaude'], makeSpec({ model: 'strong' }));
      expect(await handler.scanLocalForPush(teamConfigFor(['claude', 'codex', 'tclaude']), localConfig)).toEqual([]);
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
