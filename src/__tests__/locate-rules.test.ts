import { describeLocateMatrix, type MatrixRow } from './helpers/locate-matrix.js';

const ROWS: readonly MatrixRow[] = [
  {
    tool: 'claude', scope: 'user',
    writes: ['~/.claude/rules'],
    existingDirs: ['~/.claude'], installed: { probe: '~/.claude', met: true },
    reads: [{ at: '~/.claude/rules', when: 'always' }],
    source: 'Claude Code docs: user rules in ~/.claude/rules',
  },
  {
    tool: 'cursor', scope: 'user',
    writes: ['~/.cursor/rules'],
    existingDirs: ['~/.cursor'], installed: { probe: '~/.cursor', met: true },
    reads: [{ at: '~/.cursor/rules', when: 'workspaceUnder', root: '~' }],
    broken: { 'root-outside-home': { reason: 'outside-workspace', issue: '#1197' } },
    source: 'Cursor reads <ancestor>/.cursor/rules walking up from the workspace (cursor-user-rules.ts)',
  },
  {
    tool: 'codex', scope: 'user',
    writes: [{ at: '~/.codex/AGENTS.md', owned: false, header: null }],
    existingDirs: ['~/.codex'], installed: { probe: '~/.codex', met: true },
    reads: [{ at: '~/.codex/AGENTS.md', when: 'always' }],
    source: 'Codex reads no rules directory; the team rules are a block in $CODEX_HOME/AGENTS.md (#946)',
  },
  {
    tool: 'codex', scope: 'project',
    channel: { via: 'session-hook', probe: 'codex-hooks', limit: null },
    existingDirs: ['~/.codex'], installed: { probe: '~/.codex', met: true },
    source: "Codex runs teamai's user-level SessionStart hook in every project (#938)",
  },
  {
    tool: 'opencode', scope: 'user', env: { XDG_CONFIG_HOME: '/xdg' },
    writes: ['/xdg/opencode/rules'],
    activation: { at: '/xdg/opencode/opencode.json', key: ['instructions'] },
    existingDirs: ['/xdg/opencode'], installed: { probe: '/xdg/opencode', met: true },
    reads: [{ at: '/xdg/opencode/rules', when: 'always' }],
    source: 'opencode v2.1.1 Global.Path; OpenCode scans no rules directory, the instructions glob in its config file loads it',
  },
  {
    tool: 'omp', scope: 'project',
    writes: ['<root>/.omp/rules'],
    existingDirs: ['<root>/.omp'], installed: { probe: '<root>/.omp', met: true },
    reads: [{ at: '<root>/.omp/rules', when: 'cwdOnly' }],
    broken: { 'project-subdir': { reason: 'cwd-only', issue: '#1221' } },
    source: 'OMP loads project rules from <cwd>/.omp/rules only',
  },
  {
    tool: 'workbuddy', scope: 'project',
    writes: ['<root>/.codebuddy/rules'],
    existingDirs: ['<root>/.workbuddy'], installed: { probe: '<root>/.workbuddy', met: true },
    reads: 'unknown',
    source: "WorkBuddy runs CodeBuddy's engine and reads a project's .codebuddy/rules, shared with CodeBuddy (#946)",
  },
  {
    tool: 'hermes', scope: 'project', platforms: ['darwin', 'linux'],
    channel: 'none',
    existingDirs: ['~/.hermes'], installed: { probe: '~/.hermes', met: true },
    source: 'Hermes reads the project AGENTS.md itself; teamai writes no project rules for it (#946)',
  },
];

describeLocateMatrix('rules', ROWS);
