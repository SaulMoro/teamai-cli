import { describeLocateMatrix, type MatrixRow } from './helpers/locate-matrix.js';

const ROWS: readonly MatrixRow[] = [
  {
    tool: 'claude', scope: 'user',
    writes: [{ at: '~/.claude/CLAUDE.md', owned: false, header: null }],
    existingDirs: ['~/.claude'], installed: { probe: '~/.claude', met: true },
    reads: [{ at: '~/.claude/CLAUDE.md', when: 'always' }],
    source: 'Claude Code docs: user memory in ~/.claude/CLAUDE.md',
  },
  {
    tool: 'claude', scope: 'project',
    writes: [{ at: '<root>/.claude/rules/teamai-context.md', owned: true, header: null }],
    existingDirs: ['<root>/.claude'], installed: { probe: '<root>/.claude', met: true },
    reads: [{ at: '<root>/.claude/rules', when: 'workspaceUnder' }],
    retired: [{ at: '<root>/.claude/CLAUDE.md', was: 'default' }],
    source: "Claude Code loads every .claude/rules file; CLAUDE.local.md would stop Claude's native AGENTS.md load (#945)",
  },
  {
    tool: 'copilot', scope: 'project', install: { gitExclude: true },
    writes: [{ at: '<root>/.github/instructions/teamai-context.instructions.md', owned: true, header: 'apply-to-all' }],
    existingDirs: ['~/.copilot'], installed: { probe: '~/.copilot', met: true },
    reads: [
      { at: '<root>/.github/copilot-instructions.md', when: 'workspaceUnder' },
      { at: '<root>/.github/instructions', when: 'workspaceUnder' },
    ],
    retired: [{ at: '<root>/.github/copilot-instructions.md', was: 'git-exclude' }],
    source: 'Copilot inlines a .github/instructions file in every request only for the applyTo "**" glob (#915)',
  },
  {
    tool: 'zcode', scope: 'project',
    channel: { via: 'session-hook', probe: 'zcode-session-start', limit: 32768 },
    existingDirs: ['~/.zcode'], installed: { probe: '~/.zcode', met: true },
    source: 'ZCode 3.16.2 source: its CLI runs only user-level hooks; hooks.maxOutputBytes defaults to 32768',
  },
  {
    tool: 'openclaw', scope: 'user',
    writes: [{ at: '~/.openclaw/workspace/AGENTS.md', owned: false }],
    existingDirs: ['~/.openclaw/workspace'], installed: { probe: '~/.openclaw/workspace', met: true },
    readableConfig: { file: '~/.openclaw/openclaw.json', met: true },
    reads: 'unknown',
    source: 'OpenClaw agents/workspace-default-path.ts, as src/openclaw-home.ts records it: <state>/workspace',
  },
  {
    tool: 'hermes', scope: 'user', platforms: ['darwin', 'linux'],
    writes: ['~/.hermes/SOUL.md'],
    existingDirs: ['~/.hermes'], installed: { probe: '~/.hermes', met: true },
    reads: [{ at: '~/.hermes/SOUL.md', when: 'always' }],
    retired: [{ at: '~/AGENTS.md', was: 'default' }],
    source: 'hermes-agent prompt_builder: SOUL.md from HERMES_HOME; earlier releases wrote ~/AGENTS.md',
  },
  {
    tool: 'qoder', scope: 'user',
    channel: 'none',
    existingDirs: ['~/.qoder'], installed: { probe: '~/.qoder', met: true },
    source: 'Qoder takes the blocks from no file teamai writes',
  },
];

describeLocateMatrix('blocks', ROWS);
