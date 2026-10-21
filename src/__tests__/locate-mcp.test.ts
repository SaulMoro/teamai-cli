import { describeLocateMatrix, type MatrixRow } from './helpers/locate-matrix.js';

const CLAUDE_PROJECT_READS = [
  { at: '<root>/.mcp.json', key: ['mcpServers'], when: 'workspaceUnder' },
  { at: '~/.claude.json', key: ['mcpServers'], projectKey: '<root>', when: 'workspaceUnder' },
] as const;
const CODEBUDDY_SOURCE = 'CodeBuddy engine 2.168.0: the first of .codebuddy/.mcp.json, .codebuddy/mcp.json, $CODEBUDDY_CONFIG_DIR/.codebuddy.json that exists, never merged (#993)';

const ROWS: readonly MatrixRow[] = [
  {
    tool: 'claude', scope: 'user',
    writes: [{ at: '~/.claude.json', key: ['mcpServers'] }],
    existingDirs: ['~/.claude'], installed: { probe: '~/.claude', met: true },
    reads: [{ at: '~/.claude.json', key: ['mcpServers'], when: 'always' }],
    source: 'Claude Code docs: user servers in ~/.claude.json',
  },
  {
    tool: 'claude', scope: 'project',
    writes: [{ at: '<root>/.mcp.json', key: ['mcpServers'] }],
    existingDirs: ['<root>/.claude'], installed: { probe: '<root>/.claude', met: true },
    reads: CLAUDE_PROJECT_READS,
    retired: [{ at: '~/.claude.json', was: 'other-scope' }],
    source: 'Claude Code docs: project servers in <root>/.mcp.json, local ones under projects[<git root>] of ~/.claude.json',
  },
  {
    tool: 'claude', scope: 'project', install: { gitExclude: true },
    writes: [{ at: '~/.claude.json', key: ['mcpServers'], projectKey: '<root>' }],
    existingDirs: ['<root>/.claude'], installed: { probe: '<root>/.claude', met: true },
    reads: CLAUDE_PROJECT_READS,
    retired: [{ at: '<root>/.mcp.json', was: 'other-scope' }],
    source: 'sharing.gitExclude keeps team servers out of the working tree, in the local scope (#915)',
  },
  {
    tool: 'claude', scope: 'project', install: { gitExclude: true, self: true },
    writes: [{ at: '<root>/.mcp.json', key: ['mcpServers'] }],
    existingDirs: ['<root>/.claude'], installed: { probe: '<root>/.claude', met: true },
    reads: CLAUDE_PROJECT_READS,
    retired: [{ at: '~/.claude.json', was: 'other-scope' }],
    source: "Claude Code files every worktree under one key, so one worktree's pull would undo another's in a self team (#915)",
  },
  {
    tool: 'claude', scope: 'project', install: { gitExclude: true },
    writes: [{ at: '<root>/.mcp.json', key: ['mcpServers'] }],
    existingDirs: ['<root>/.claude', '~/.config/muse'], installed: { probe: '<root>/.claude', met: true },
    reads: CLAUDE_PROJECT_READS,
    retired: [{ at: '~/.claude.json', was: 'other-scope' }],
    source: "Muse reads claude's <root>/.mcp.json and has no local scope, so the file stays while Muse is installed (#915)",
  },
  {
    tool: 'claude', scope: 'project', install: { gitExclude: true },
    texts: [
      { at: '<root>/.git', text: 'gitdir: ../main/.git/worktrees/proj\n' },
      { at: '<root>/../main/.git/worktrees/proj/commondir', text: '../..\n' },
    ],
    writes: [{ at: '~/.claude.json', key: ['mcpServers'], projectKey: '<root>/../main' }],
    existingDirs: ['<root>/.claude', '<root>/../main/.git'], installed: { probe: '<root>/.claude', met: true },
    reads: [
      { at: '<root>/.mcp.json', key: ['mcpServers'], when: 'workspaceUnder' },
      { at: '~/.claude.json', key: ['mcpServers'], projectKey: '<root>/../main', when: 'workspaceUnder' },
    ],
    retired: [{ at: '<root>/.mcp.json', was: 'other-scope' }],
    source: 'Claude Code 2.1 files a linked worktree under its common git directory without the trailing .git (#915)',
  },
  {
    tool: 'codebuddy', scope: 'user',
    writes: [{ at: '~/.codebuddy/mcp.json', key: ['mcpServers'] }],
    existingDirs: ['~/.codebuddy', '~/.codebuddy/mcp.json'], installed: { probe: '~/.codebuddy', met: true },
    reads: [
      { at: '~/.codebuddy/.mcp.json', key: ['mcpServers'], shadowedBy: '~/.codebuddy/mcp.json', when: 'always' },
      { at: '~/.codebuddy/mcp.json', key: ['mcpServers'], when: 'always' },
      { at: '~/.codebuddy.json', key: ['mcpServers'], shadowedBy: '~/.codebuddy/mcp.json', when: 'always' },
    ],
    retired: [{ at: '~/.codebuddy/.mcp.json', was: 'lookup' }, { at: '~/.codebuddy.json', was: 'lookup' }],
    source: CODEBUDDY_SOURCE,
  },
  {
    tool: 'codebuddy', scope: 'user', env: { CODEBUDDY_CONFIG_DIR: '/cb' },
    writes: [{ at: '/cb/.codebuddy.json', key: ['mcpServers'] }],
    existingDirs: ['~/.codebuddy', '/cb/.codebuddy.json'], installed: { probe: '~/.codebuddy', met: true },
    reads: [
      { at: '~/.codebuddy/.mcp.json', key: ['mcpServers'], shadowedBy: '/cb/.codebuddy.json', when: 'always' },
      { at: '~/.codebuddy/mcp.json', key: ['mcpServers'], shadowedBy: '/cb/.codebuddy.json', when: 'always' },
      { at: '/cb/.codebuddy.json', key: ['mcpServers'], when: 'always' },
    ],
    retired: [{ at: '~/.codebuddy/.mcp.json', was: 'lookup' }, { at: '~/.codebuddy/mcp.json', was: 'lookup' }],
    source: `${CODEBUDDY_SOURCE}; CODEBUDDY_CONFIG_DIR moves only .codebuddy.json`,
  },
  {
    tool: 'codex', scope: 'project',
    writes: [{ at: '<root>/.codex/config.toml', key: ['mcp_servers'] }],
    existingDirs: ['<root>/.codex'], installed: { probe: '<root>/.codex', met: true },
    reads: [{ at: '<root>/.codex/config.toml', key: ['mcp_servers'], when: 'workspaceUnder' }],
    readGates: [{ kind: 'codex-project-trust', config: '~/.codex/config.toml', checkout: '<root>' }],
    source: 'Codex reads the project MCP config only in a trusted project (#954)',
  },
  {
    tool: 'muse', scope: 'project',
    writes: [{ at: '<root>/.mcp.json', key: ['mcpServers'] }],
    writtenBy: 'claude',
    existingDirs: ['~/.config/muse'], installed: { probe: '~/.config/muse', met: true },
    reads: [{ at: '<root>/.mcp.json', key: ['mcpServers'], when: 'workspaceUnder' }],
    source: "muse-bin 1.4.11: Muse reads <root>/.mcp.json, the file the claude target writes",
  },
  {
    tool: 'opencode', scope: 'project',
    writes: [{ at: '<root>/opencode.json', key: ['mcp'] }],
    alternate: { at: '<root>/.opencode/teamai-mcp.json', key: ['mcp'] },
    existingDirs: ['<root>/.opencode'], installed: { probe: '<root>/.opencode', met: true },
    reads: [
      { at: '<root>/opencode.json', key: ['mcp'], when: 'workspaceUnder' },
      { at: '<root>/.opencode/teamai-mcp.json', key: ['mcp'], when: 'workspaceUnder' },
    ],
    source: "OpenCode V1 reads <root>/opencode.json; V2 takes teamai's own file through the plugin (#915)",
  },
  {
    tool: 'claude-internal', scope: 'user',
    channel: 'unknown',
    existingDirs: [], installed: { probe: '~/.claude-internal', met: false },
    source: 'Where an internal build reads MCP servers is not established',
  },
];

describeLocateMatrix('mcp', ROWS);
