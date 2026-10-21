import { describeLocateMatrix, type MatrixRow } from './helpers/locate-matrix.js';

const ROWS: readonly MatrixRow[] = [
  {
    tool: 'claude', scope: 'user',
    writes: ['~/.claude/agents'],
    existingDirs: ['~/.claude'], installed: { probe: '~/.claude', met: true },
    reads: [{ at: '~/.claude/agents', when: 'always' }],
    source: 'Claude Code docs: user subagents in ~/.claude/agents',
  },
  {
    tool: 'codex', scope: 'project',
    writes: ['<root>/.codex/agents'],
    existingDirs: ['<root>/.codex'], installed: { probe: '<root>/.codex', met: true },
    reads: [{ at: '<root>/.codex/agents', when: 'workspaceUnder' }],
    readGates: [{ kind: 'codex-project-trust', config: '~/.codex/config.toml', checkout: '<root>' }],
    source: 'Codex reads project config only in a trusted project (#954)',
  },
  {
    tool: 'zcode', scope: 'project',
    writes: ['<root>/.zcode/agents'],
    existingDirs: ['<root>/.zcode'], installed: { probe: '<root>/.zcode', met: true },
    reads: [{ at: '<root>/.zcode/agents', when: 'cwdOnly' }],
    broken: { 'project-subdir': { reason: 'cwd-only', issue: '#1221' } },
    source: 'ZCode 3.16.2 source: <cwd>/.zcode/agents per workspace',
  },
  {
    tool: 'opencode', scope: 'user', env: { OPENCODE_CONFIG_DIR: '/ocd' },
    writes: ['/ocd/agents'],
    existingDirs: ['/ocd'], installed: { probe: '/ocd', met: true },
    reads: [{ at: '/ocd/agents', when: 'always' }],
    source: 'opencode v2.1.1 Global.Path: config = OPENCODE_CONFIG_DIR ?? (XDG_CONFIG_HOME || ~/.config)/opencode',
  },
  {
    tool: 'pi', scope: 'user',
    channel: 'none',
    existingDirs: ['~/.pi'], installed: { probe: '~/.pi', met: true },
    source: 'Pi has no subagents',
  },
  {
    tool: 'trae', scope: 'project',
    channel: 'unknown',
    existingDirs: [], installed: { probe: '~/.trae', met: false },
    source: 'Where Trae takes agents from is not established',
  },
];

describeLocateMatrix('agents', ROWS);
