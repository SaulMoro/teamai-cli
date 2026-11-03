import { NONE, UNKNOWN_READS, type DescriptorIds, type ToolDescriptor } from '@teamai/tool-core/definition';
import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import type { StoredSessionPlatform } from './session-flow/adapters/platform-facts.js';
import type { TokenFormatId } from './token-usage/index.js';
import type { LaunchAdapterId } from './tool-launch/adapters.js';

/** What a shipped tool's descriptor names: only built-in tools, and rows the app's launch, session and token tables declare. */
type ShippedIds = DescriptorIds & { readonly tool: ToolId; readonly launch: LaunchAdapterId; readonly platform: StoredSessionPlatform; readonly tokens: TokenFormatId };

/** A built-in tool's descriptor: each id it names resolves to a row teamai has. */
export type ShippedDescriptor = ToolDescriptor<ShippedIds>;

/**
 * Every built-in tool. Adding a tool starts here: `TOOLS` then needs its entry, and the type
 * check lists every other table that must decide it. Custom tools in a team's `toolPaths` stay plain strings.
 */
export const TOOL_IDS = [
  'claude',
  'codex',
  'codex-internal',
  'claude-internal',
  'tclaude',
  'tcodex',
  'cursor',
  'copilot',
  'joycode',
  'qoder',
  'qoder-cn',
  'kiro',
  'trae',
  'trae-cn',
  'zcode',
  'omp',
  'pi',
  'codebuddy',
  'openclaw',
  'hermes',
  'dsh',
  'workbuddy',
  'opencode',
  'muse',
  'agy',
] as const;

/** A built-in tool (`TOOL_IDS`). */
export type ToolId = (typeof TOOL_IDS)[number];

/**
 * What teamai knows about each built-in tool.
 *
 * `calls` lists only a dedicated skill tool; a read of a SKILL.md path is not
 * one. `promptForm` is how a prompt that loads a skill with no tool call reaches
 * the prompt-submit hook: Codex's `$name` as typed, or the leading
 * `<skill name location>` block Pi expands `/skill:name` into first.
 * `'unknown'` credits no tool call or read. Evidence per call:
 * - verified: a recorded run of the tool, or its own loader run on teamai's output
 * - source: the tool's source or shipped bundle
 * - docs: the tool's documentation
 * - assumed: teamai's own code or the issue matrix only
 */
export const TOOLS = {
  claude: BUILT_IN_TOOLS.claude.tools.claude,
  codex: BUILT_IN_TOOLS.codex.tools.codex,
  'codex-internal': BUILT_IN_TOOLS.codex.tools['codex-internal'],
  'claude-internal': BUILT_IN_TOOLS.claude.tools['claude-internal'],
  tclaude: BUILT_IN_TOOLS.claude.tools.tclaude,
  tcodex: BUILT_IN_TOOLS.codex.tools.tcodex,
  // Cursor reads `<ancestor>/.cursor/rules` walking up from the workspace (cursor-user-rules.ts).
  cursor: {
    home: { dir: '.cursor' },
    skillLoad: { calls: [] },
    skills: UNKNOWN_READS,
    rules: {
      user: { channel: 'dir', format: 'cursor-mdc', reads: [{ base: 'home', path: '.cursor/rules', when: 'workspaceUnderHome', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'cursor-mdc', reads: [{ base: 'project', path: '.cursor/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: {
      user: {
        channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.mdc', owned: true, header: 'always-apply' },
        // The Cursor CLI reads no ~/.cursor/agents (#1218).
        noRecallAgent: true,
        reads: [{ base: 'home', path: '.cursor/rules', when: 'workspaceUnderHome', evidence: 'verified' }],
      },
      project: {
        channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.mdc', owned: true, header: 'always-apply' },
        reads: [{ base: 'project', path: '.cursor/rules', when: 'workspaceUnder', evidence: 'verified' }],
      },
    },
    agents: {
      // The IDE reads it; the CLI does not (#1218), which doctor's wording names.
      user: { reads: [{ base: 'home', path: '.cursor/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.cursor/agents', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    mcp: {
      user: { format: 'cursor', reads: [{ base: 'home', path: '.cursor/mcp.json', evidence: 'source' }] },
      // The Cursor CLI (2026.10.21, verified) loads a project server only once it is approved; the IDE's approvals are not traced.
      project: { judgedTeamaiOnly: true, format: 'cursor', reads: [{ base: 'project', path: '.cursor/mcp.json', when: 'workspaceUnder', evidence: 'source' }], readGates: ['cursor-mcp-approval'] },
    },
    hooks: { user: { channel: 'settings', format: 'cursor', reads: [{ base: 'home', path: '.cursor/hooks.json', evidence: 'source' }] }, self: { channel: 'settings', format: 'cursor', reads: [{ base: 'project', path: '.cursor/hooks.json', when: 'workspaceUnder', evidence: 'source' }] }, subagentStop: false, stopReply: true, shell: 'system', teamHooks: 'home' },
    sessions: ['cursor'],
    launch: 'cursor',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: false,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'none',
    features: {
      env: '?',
      workflows: { cell: '+s', note: 'Cursor IDE: —' },
      unattended: '?',
      recall: { cell: '✗v', note: 'Cursor IDE: ✓v' },
      stats: { cell: '✓v', note: 'Cursor IDE: ✓t' },
      tokens: { cell: '+d', note: 'usage is in the Cursor account dashboard only' },
      aiBackend: '✓d',
      votesJudge: '+s',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: { cell: '+t', note: 'teamai refuses agent hooks in the Cursor hook format' },
    },
  },
  copilot: {
    home: { dir: '.copilot', moves: { by: [{ kind: 'env', name: 'COPILOT_HOME', evidence: 'verified' }] } },
    skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] },
    skills: {
      user: [{ base: 'home', path: '.copilot/skills', evidence: 'verified' }],
      project: [{ base: 'project', path: '.github/skills', when: 'workspaceUnder', evidence: 'verified' }],
    },
    rules: {
      user: { channel: 'dir', format: 'copilot-instructions', reads: [{ base: 'home', path: '.copilot/instructions', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'copilot-instructions', reads: [{ base: 'project', path: '.github/instructions', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'claudemd' }, reads: [{ base: 'home', path: '.copilot/copilot-instructions.md', evidence: 'verified' }] },
      // Copilot inlines a `.github/instructions` file in every request only for the `applyTo: "**"` glob (#915).
      project: {
        channel: 'file', file: { in: 'claudemd' },
        gitExcluded: { in: 'rules-dir', name: 'teamai-context.instructions.md', owned: true, header: 'apply-to-all' },
        reads: [
          { base: 'project', path: '.github/copilot-instructions.md', when: 'workspaceUnder', evidence: 'verified' },
          { base: 'project', path: '.github/instructions', when: 'workspaceUnder', evidence: 'verified' },
        ],
      },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.copilot/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.github/agents', when: 'workspaceUnder', evidence: 'source' }] },
    },
    mcp: {
      user: { format: 'copilot', reads: [{ base: 'home', path: '.copilot/mcp-config.json', evidence: 'verified' }] },
      project: { judgedTeamaiOnly: true, format: 'copilot', reads: [{ base: 'project', path: '.github/mcp.json', when: 'workspaceUnder', evidence: 'verified' }], readGates: ['copilot-folder-trust'] },
    },
    hooks: {
      user: { channel: 'settings', format: 'copilot', reads: [{ base: 'home', path: '.copilot/hooks/teamai.json', evidence: 'source' }] },
      // Copilot 1.0.105 runs repo hooks only in a trusted folder (verified with `copilot -p`).
      self: { channel: 'settings', format: 'copilot', reads: [{ base: 'project', path: '.github/hooks/teamai.json', when: 'workspaceUnder', evidence: 'source' }], readGates: ['copilot-folder-trust'] },
      workspace: { channel: 'settings', format: 'copilot', reads: [{ base: 'project', path: '.github/hooks/teamai.json', when: 'workspaceUnder', evidence: 'source' }], readGates: ['copilot-folder-trust'] },
      subagentStop: false,
      stopReply: true,
      shell: 'system',
      teamHooks: 'home',
    },
    sessions: 'none',
    launch: 'copilot',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'copilot-shutdown',
    features: {
      env: '?',
      workflows: '+s',
      unattended: '?',
      recall: '✓v',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      tokens: { cell: '✓t', note: 'one request per model from the session.shutdown totals, priced without long-prompt rates; not run' },
      aiBackend: '✓d',
      votesJudge: '?',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: '—t',
    },
  },
  joycode: BUILT_IN_TOOLS.joycode.tools.joycode,
  qoder: BUILT_IN_TOOLS.qoder.tools.qoder,
  'qoder-cn': BUILT_IN_TOOLS.qoder.tools['qoder-cn'],
  kiro: {
    home: { dir: '.kiro' },
    skillLoad: 'unknown',
    skills: UNKNOWN_READS,
    rules: {
      user: { channel: 'dir', format: 'kiro-steering', reads: [{ base: 'home', path: '.kiro/steering', evidence: 'docs' }] },
      project: { channel: 'dir', format: 'kiro-steering', reads: [{ base: 'project', path: '.kiro/steering', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'inclusion-always' }, reads: [{ base: 'home', path: '.kiro/steering', evidence: 'docs' }] },
      project: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'inclusion-always' }, reads: [{ base: 'project', path: '.kiro/steering', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.kiro/agents', evidence: 'docs' }] },
      project: { reads: [{ base: 'project', path: '.kiro/agents', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    mcp: {
      user: { format: 'claude', reads: [{ base: 'home', path: '.kiro/settings/mcp.json', evidence: 'docs' }] },
      project: { judgedTeamaiOnly: true, format: 'claude', reads: [{ base: 'project', path: '.kiro/settings/mcp.json', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    // Kiro CLI V3 loads every hook file in ~/.kiro/hooks, whatever agent runs (#1341).
    hooks: { user: { channel: 'adapter', adapter: 'kiro-hooks', evidence: 'docs' }, self: 'user', subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home' },
    // Kiro CLI docs: sessions under ~/.kiro, moved by KIRO_HOME.
    sessions: 'none',
    launch: 'kiro',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'none',
    features: {
      env: '?',
      workflows: '?',
      unattended: '?',
      recall: '◐d',
      stats: '?',
      tokens: '?',
      aiBackend: '✓d',
      votesJudge: '?',
      sessionJudge: { cell: '✓d', note: 'a subagent works in its own context window, without the conversation; not run' },
      agentHooks: { cell: '✓d', note: 'runs from teamai\'s team-hook bridge, which can block a tool call; Kiro\'s hook docs' },
    },
  },
  // Trae keeps user MCP servers in its app-support directory, which teamai does not write.
  trae: {
    home: { dir: '.trae' },
    skillLoad: 'unknown',
    skills: UNKNOWN_READS,
    installedBy: 'home-edition',
    rules: {
      user: { channel: 'dir', format: 'trae', reads: 'unknown' },
      project: { channel: 'dir', format: 'trae', reads: [{ base: 'project', path: '.trae/rules', when: 'workspaceUnder', evidence: 'assumed' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'always-apply' }, reads: [{ base: 'home', path: '.trae/user_rules', evidence: 'docs' }] },
      project: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'always-apply' }, reads: [{ base: 'project', path: '.trae/rules', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    // Trae loads `.trae/agents` only while its Beta "Enable Subagents Directory" switch is on, a setting teamai cannot read.
    agents: {
      // Its docs give ~/.trae-cn/agents, a copy of Trae CN's page; nothing shows ~/.trae/agents.
      user: 'unknown',
      project: { reads: [{ base: 'project', path: '.trae/agents', when: 'cwdOnly', evidence: 'source' }] },
    },
    mcp: {
      user: 'none',
      project: { judgedTeamaiOnly: true, format: 'claude', reads: [{ base: 'project', path: '.trae/mcp.json', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    hooks: { user: 'unknown', self: 'unknown', subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home' },
    // Trae docs: chat history in the IDE's ModularData database, which no variable moves.
    sessions: 'none',
    launch: 'none',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'none',
    features: {
      env: '?',
      workflows: '?',
      unattended: '?',
      recall: '?',
      stats: '?',
      tokens: '?',
      aiBackend: '?',
      votesJudge: '?',
      sessionJudge: { cell: '✓s', note: 'the Task tool starts a fresh subagent; no session variable, so the session names its tool with --tools; not run' },
      agentHooks: '?',
    },
  },
  'trae-cn': {
    home: { dir: '.trae-cn' },
    skillLoad: 'unknown',
    skills: UNKNOWN_READS,
    installedBy: 'home-edition',
    rules: {
      user: { channel: 'dir', format: 'trae', reads: 'unknown' },
      project: { channel: 'dir', format: 'trae', reads: [{ base: 'project', path: '.trae/rules', when: 'workspaceUnder', evidence: 'assumed' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'always-apply' }, reads: [{ base: 'home', path: '.trae-cn/user_rules', evidence: 'docs' }] },
      project: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'always-apply' }, reads: [{ base: 'project', path: '.trae/rules', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    // Trae CN loads them only while its Beta "Enable Subagents Directory" switch is on (on by default, its docs say).
    agents: {
      user: { reads: [{ base: 'home', path: '.trae-cn/agents', evidence: 'docs' }] },
      project: { reads: [{ base: 'project', path: '.trae/agents', when: 'cwdOnly', evidence: 'source' }] },
    },
    mcp: {
      user: 'none',
      project: { judgedTeamaiOnly: true, format: 'claude', reads: [{ base: 'project', path: '.trae/mcp.json', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    hooks: { user: 'unknown', self: 'unknown', subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home' },
    // Trae CN docs: the same database under Trae CN's application data.
    sessions: 'none',
    launch: 'none',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'none',
    features: {
      env: '?',
      workflows: '?',
      unattended: '?',
      recall: '?',
      stats: '?',
      tokens: '?',
      aiBackend: '?',
      votesJudge: '?',
      sessionJudge: { cell: '✓s', note: 'the Task tool starts a fresh subagent; no session variable, so the session names its tool with --tools; not run' },
      agentHooks: '?',
    },
  },
  // ZCode 3.16.2 source; 3.15.1 not certified. Its CLI runs only user-level hooks, and reads servers under `mcp.servers` of its own config files.
  zcode: {
    home: { dir: '.zcode' },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }] },
    skills: UNKNOWN_READS,
    rules: {
      user: { channel: 'inline', label: 'ZCode AGENTS.md' },
      project: { channel: 'session-hook', probe: 'zcode-session-start', evidence: 'source' },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'home', path: '.zcode/AGENTS.md' }, reads: [{ base: 'home', path: '.zcode/AGENTS.md', evidence: 'source' }] },
      // hooks.maxOutputBytes defaults to 32768 (zcode.z.ai docs); ZCode drops a longer hook output whole.
      project: { channel: 'session-hook', probe: 'zcode-session-start', limit: 32768, evidence: 'source' },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.zcode/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.zcode/agents', when: 'cwdOnly', evidence: 'source' }] },
    },
    mcp: {
      user: { format: 'claude', key: ['mcp', 'servers'], reads: [{ base: 'home', path: '.zcode/cli/config.json', evidence: 'source' }] },
      project: { judgedTeamaiOnly: true, format: 'claude', key: ['mcp', 'servers'], reads: [{ base: 'project', path: '.zcode/config.json', when: 'workspaceUnder', evidence: 'source' }] },
      retired: { user: ['.agents/mcp.json'] },
    },
    hooks: { user: { channel: 'settings', format: 'zcode', reads: [{ base: 'home', path: '.zcode/cli/config.json', evidence: 'source' }] }, self: 'user', subagentStop: false, stopReply: true, shell: 'system', teamHooks: 'home' },
    sessions: 'none',
    launch: 'none',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: true,
    legacyAgentMd: false,
    tokens: 'unknown',
    features: {
      env: '✓t',
      workflows: '+s',
      unattended: '?',
      recall: '✓s',
      stats: '✓s',
      tokens: '?',
      aiBackend: '+s',
      votesJudge: { cell: '✓t', note: '#1374 judges the reply in its Stop payload; not rerun' },
      sessionJudge: { cell: '✓d', note: 'the built-in general-purpose subagent works in its own context; not run' },
      agentHooks: { cell: '+t', note: 'refused until teamai writes the hooks.events shape (#1224)' },
    },
  },
  omp: BUILT_IN_TOOLS.pi.tools.omp,
  pi: BUILT_IN_TOOLS.pi.tools.pi,
  // Model switching follows the same recorded home for models.json.
  // CODEBUDDY_CONFIG_DIR replaces ~/.codebuddy, and ~/.codebuddy.json moves into it.
  // Two hosts share this home: the IDE sends the tool name `skill`
  // (src/utils/tool-names.ts), while the VSCode plugin's own skill tool is
  // `use_skill` (#1516). A manual slash command lands as `@command://name`
  // rather than `/name`, so the prompt form is that.
  codebuddy: {
    home: { dir: '.codebuddy', moves: { by: [{ kind: 'env', name: 'CODEBUDDY_CONFIG_DIR', evidence: 'verified' }], defaultHomeLeftovers: true } },
    skillLoad: {
      calls: [{ name: 'Skill', evidence: 'verified' }, { name: 'skill', evidence: 'assumed' }, { name: 'use_skill', evidence: 'source' }],
      // The plugin lands a manual slash command as `@command://name` (#1516);
      // the generic `/name` counts too, for a build that sends that.
      promptForm: ['/name', 'command-uri'],
    },
    skills: { user: [{ base: 'home', path: '.codebuddy/skills', evidence: 'verified' }], project: 'unknown' },
    rules: {
      user: { channel: 'dir', format: 'codebuddy', reads: [{ base: 'home', path: '.codebuddy/rules', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'codebuddy', reads: [{ base: 'project', path: '.codebuddy/rules', when: 'cwdOnly', evidence: 'source' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'claudemd' }, reads: [{ base: 'home', path: '.codebuddy/CODEBUDDY.md', evidence: 'source' }] },
      // WorkBuddy's project entry names the same file: one copy.
      project: {
        channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', dir: '.codebuddy/rules', owned: true, header: 'always-apply' },
        reads: [{ base: 'project', path: '.codebuddy/rules', when: 'cwdOnly', evidence: 'source' }],
      },
      retired: { project: ['.codebuddy/CODEBUDDY.md'] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.codebuddy/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.codebuddy/agents', when: 'cwdOnly', evidence: 'source' }] },
    },
    mcp: {
      user: {
        format: 'buddy',
        reads: [{ base: 'home', firstOf: ['.codebuddy/.mcp.json', '.codebuddy/mcp.json', { in: 'codebuddy-config-dir', path: '.codebuddy.json' }], evidence: 'source' }],
      },
      project: {
        judgedTeamaiOnly: false,
        format: 'buddy',
        localScope: { file: { in: 'codebuddy-config-dir', path: '.codebuddy.json' }, key: 'realpath' },
        reads: [{ base: 'project', firstOf: ['.mcp.json', 'mcp.json'], when: 'cwdOnly', evidence: 'source' }],
        // CodeBuddy Code 2.179.1 starts a .mcp.json server only once it is approved, in `codebuddy -p` too.
        readGates: ['codebuddy-mcp-approval'],
      },
    },
    // CodeBuddy Code 2.179.1 (`-p`) runs the hooks of the project's settings.json and settings.local.json, merged.
    hooks: { user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.codebuddy/settings.json', evidence: 'source' }] }, self: { channel: 'settings', format: 'claude', reads: [{ base: 'project', path: '.codebuddy/settings.json', when: 'cwdOnly', evidence: 'source' }, { base: 'project', path: '.codebuddy/settings.local.json', when: 'cwdOnly', evidence: 'verified' }] }, subagentStop: true, stopReply: false, shell: 'bundled', teamHooks: 'home' },
    sessions: ['codebuddy'],
    launch: 'codebuddy',
    autoCompact: 'buddy',
    skillAllowedTools: true,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: true,
    tokens: 'codebuddy',
    features: {
      env: '?',
      workflows: '✓d',
      unattended: '✓d',
      recall: '✓s',
      stats: '✓v',
      tokens: '✓t',
      aiBackend: '✓d',
      votesJudge: '+v',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: '✓s',
    },
  },
  // Hermes (`skill_view`) and OpenClaw (`skills_read`) have skill tools, but teamai installs no post-tool-use hook for them yet.
  // OpenClaw's skills sit in its workspace.
  openclaw: {
    home: {
      dir: '.openclaw',
      // docs.openclaw.ai/help/environment; OPENCLAW_STATE_DIR and OPENCLAW_PROFILE also in src/config/paths.ts at 884a96d1.
      moves: { by: [{ kind: 'openclaw-state', evidence: 'docs' }] },
    },
    skillLoad: 'unknown',
    skills: UNKNOWN_READS,
    skillsFollowSession: true,
    rules: { user: { channel: 'inline', label: 'OpenClaw workspace AGENTS.md' }, project: 'none' },
    blocks: {
      user: { channel: 'file', file: { in: 'openclaw-workspace', name: 'AGENTS.md' }, reads: 'unknown' },
      // OpenClaw's only project file is the shared AGENTS.md; it reads no project .openclaw/workspace (#946).
      project: 'none',
      retired: { project: ['.openclaw/workspace/AGENTS.md'] },
    },
    agents: NONE,
    mcp: NONE,
    hooks: { user: { channel: 'adapter', adapter: 'openclaw-hook', evidence: 'verified', readGates: ['openclaw-hooks-enabled', 'openclaw-plugins-enabled'] }, self: 'user', subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home' },
    // OpenClaw 2026.10: rows in ~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite, moved by OPENCLAW_STATE_DIR.
    sessions: 'none',
    launch: 'openclaw',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'none',
    features: {
      env: '◐d',
      workflows: '+d',
      unattended: '?',
      recall: '✓s',
      stats: '+s',
      tokens: { cell: '+s', note: 'no Stop hook reaches the dashboard' },
      aiBackend: '✓d',
      votesJudge: '—t',
      sessionJudge: { cell: '◐s', note: 'sessions_spawn with isolated context, in the coding and messaging tool profiles; a tool policy can remove it; not run' },
      agentHooks: { cell: '✓s', note: 'runs from teamai\'s team-hook bridge, which can block a tool call; OpenClaw\'s plugin source' },
    },
  },
  // hermes_constants.py and hermes_cli/main.py at 68134629 (the same rules at 7e9eb8d9). Hermes reads its home in either scope.
  // Out of teamai's sight: another process's -p/--profile flag, and the supervised, desktop SSH and s6 gateway starts that skip active_profile.
  hermes: {
    home: { dir: '.hermes', moves: { by: [{ kind: 'hermes-home', evidence: 'source' }] } },
    skillLoad: 'unknown',
    skills: {
      user: [{ base: 'home', path: '.hermes/skills', evidence: 'source' }],
      project: [{ base: 'home', path: '.hermes/skills', evidence: 'source' }],
    },
    rules: { user: { channel: 'inline', label: 'Hermes SOUL.md' }, project: 'none' },
    blocks: {
      user: { channel: 'file', file: { in: 'home', path: '.hermes/SOUL.md' }, reads: [{ base: 'home', path: '.hermes/SOUL.md', evidence: 'source' }] },
      // Hermes reads the project's AGENTS.md itself; teamai's plugin adds the blocks as a system prompt section.
      project: { channel: 'plugin', probe: 'hermes-plugin', limit: 4000, evidence: 'source' },
      retired: { user: ['AGENTS.md'], project: ['AGENTS.md'] },
    },
    agents: NONE,
    mcp: NONE,
    hooks: { user: { channel: 'adapter', adapter: 'hermes-plugin', evidence: 'verified' }, self: 'user', subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home' },
    sessions: ['hermes'],
    launch: 'hermes',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: true,
    legacyAgentMd: false,
    tokens: 'none',
    features: {
      env: '◐s',
      workflows: '+s',
      unattended: '?',
      recall: '✓v',
      stats: '+s',
      tokens: { cell: '+s', note: 'no Stop hook reaches the dashboard' },
      aiBackend: '✓s',
      votesJudge: '—t',
      sessionJudge: { cell: '✓s', note: 'delegate_task starts a child agent with a fresh conversation; not run' },
      agentHooks: { cell: '✓s', note: 'runs from teamai\'s team-hook bridge, which can block a tool call; Hermes\'s shell-hook source' },
    },
  },
  dsh: {
    home: { dir: '.dsh', moves: { by: [{ kind: 'env', name: 'DSH_HOME', evidence: 'source' }] } },
    skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] },
    skills: { user: [{ base: 'home', path: '.dsh/skills', evidence: 'verified' }], project: 'unknown' },
    rules: {
      user: { channel: 'inline', label: 'DeepSeek Harness AGENTS.md' },
      project: { channel: 'session-hook', probe: 'dsh-session-start', evidence: 'source' },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'home', path: '.dsh/AGENTS.md' }, reads: [{ base: 'home', path: '.dsh/AGENTS.md', evidence: 'source' }] },
      project: { channel: 'session-hook', probe: 'dsh-session-start', evidence: 'source' },
    },
    agents: NONE,
    mcp: NONE,
    hooks: { user: { channel: 'adapter', adapter: 'dsh-hooks', evidence: 'source' }, self: 'user', subagentStop: false, stopReply: true, shell: 'system', teamHooks: 'home' },
    sessions: 'none',
    launch: 'none',
    autoCompact: 'dsh',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'none',
    features: {
      env: '✗s',
      workflows: '+s',
      unattended: '?',
      recall: '✓s',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      tokens: { cell: '+s', note: 'zstd session files need a newer Node than 20' },
      aiBackend: '+s',
      votesJudge: '?',
      sessionJudge: { cell: '◐s', note: 'the subagent tool with the fresh spawn backend, not fork; the minimal preset leaves it out; not run' },
      agentHooks: '—t',
    },
  },
  // CodeBuddy engine 2.168.0; the WorkBuddy launcher's binding of ~/.workbuddy is not certified.
  workbuddy: {
    home: { dir: '.workbuddy' },
    installedBy: 'own-root',
    skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }, { name: 'skill', evidence: 'assumed' }] },
    skills: UNKNOWN_READS,
    rules: {
      user: { channel: 'dir', format: 'codebuddy', reads: [{ base: 'home', path: '.workbuddy/rules', evidence: 'assumed' }] },
      project: { channel: 'dir', format: 'codebuddy', reads: 'unknown' },
    },
    blocks: {
      user: {
        channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'always-apply' },
        reads: [{ base: 'home', path: '.workbuddy/rules', evidence: 'assumed' }],
      },
      // CodeBuddy's engine reads the project's .codebuddy/rules, so WorkBuddy shares CodeBuddy's copy there.
      project: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', dir: '.codebuddy/rules', owned: true, header: 'always-apply' }, reads: 'unknown' },
      retired: { user: ['AGENTS.md'], project: ['AGENTS.md'] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.workbuddy/agents', evidence: 'assumed' }] },
      project: { reads: [{ base: 'project', path: '.workbuddy/agents', when: 'cwdOnly', evidence: 'assumed' }] },
    },
    mcp: {
      user: {
        format: 'buddy',
        reads: [{ base: 'home', firstOf: ['.workbuddy/.mcp.json', '.workbuddy/mcp.json', { in: 'codebuddy-config-dir', path: '.codebuddy.json' }], evidence: 'source' }],
      },
      project: {
        judgedTeamaiOnly: true,
        format: 'buddy',
        localScope: { file: { in: 'codebuddy-config-dir', path: '.codebuddy.json' }, key: 'realpath' },
        reads: [{ base: 'project', firstOf: ['.mcp.json', 'mcp.json'], when: 'cwdOnly', evidence: 'source' }],
      },
      retired: { project: ['.workbuddy/mcp.json'] },
    },
    hooks: { user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.workbuddy/settings.json', evidence: 'assumed' }] }, self: { channel: 'settings', format: 'claude', reads: 'unknown' }, subagentStop: false, stopReply: false, shell: 'bundled', teamHooks: 'home' },
    sessions: ['workbuddy'],
    launch: 'codebuddy',
    autoCompact: 'buddy',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'codebuddy',
    features: {
      env: '?',
      workflows: '✓t',
      unattended: '✓t',
      recall: '✓t',
      stats: '?',
      tokens: '✓t',
      aiBackend: '✓t',
      votesJudge: '?',
      sessionJudge: { cell: '✓t', note: 'CodeBuddy\'s engine, whose session judges its skill-driven run; not run' },
      agentHooks: '?',
    },
  },
  // opencode v2.1.1 Global.Path: OPENCODE_CONFIG_DIR, else (XDG_CONFIG_HOME || ~/.config)/opencode.
  opencode: {
    home: {
      dir: '.config/opencode',
      moves: { by: [{ kind: 'env', name: 'OPENCODE_CONFIG_DIR', evidence: 'source' }, { kind: 'xdg', child: 'opencode', evidence: 'source' }], defaultHomeLeftovers: true },
    },
    skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] },
    skills: {
      user: [{ base: 'home', path: '.config/opencode/skills', evidence: 'verified' }, { base: 'home', path: '.claude/skills', evidence: 'verified' }],
      project: [
        { base: 'project', path: '.opencode/skills', when: 'workspaceUnder', evidence: 'verified' },
        { base: 'project', path: '.claude/skills', when: 'workspaceUnder', evidence: 'verified' },
      ],
    },
    // OpenCode scans no rules directory: the `instructions` glob in its config file loads it.
    rules: {
      user: {
        channel: 'dir', format: 'verbatim', activation: { key: 'instructions', in: 'mcp-file' },
        reads: [{ base: 'home', path: '.config/opencode/rules', evidence: 'verified' }],
      },
      project: {
        channel: 'dir', format: 'verbatim', activation: { key: 'instructions', in: 'project', path: '.opencode/opencode.json' },
        reads: [{ base: 'project', path: '.opencode/rules', when: 'workspaceUnder', evidence: 'verified' }],
      },
    },
    blocks: {
      user: {
        channel: 'file', file: { in: 'home', path: '.config/opencode/teamai-context.md', owned: true }, activation: { key: 'instructions', in: 'mcp-file' },
        reads: [{ base: 'home', path: '.config/opencode/teamai-context.md', evidence: 'verified' }],
      },
      project: {
        channel: 'file', file: { in: 'project', path: '.opencode/teamai-context.md', owned: true },
        activation: { key: 'instructions', in: 'project', path: '.opencode/opencode.json' },
        reads: [{ base: 'project', path: '.opencode/teamai-context.md', when: 'workspaceUnder', evidence: 'verified' }],
      },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.config/opencode/agents', evidence: 'verified' }] },
      project: { reads: [{ base: 'project', path: '.opencode/agents', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    mcp: {
      user: { format: 'opencode', reads: [{ base: 'home', path: '.config/opencode/opencode.json', evidence: 'verified' }] },
      project: {
        judgedTeamaiOnly: true,
        format: 'opencode', alternate: { path: '.opencode/teamai-mcp.json', when: 'opencode-v2-plugin' },
        reads: [
          { base: 'project', path: 'opencode.json', when: 'workspaceUnder', evidence: 'verified' },
          { base: 'project', path: '.opencode/teamai-mcp.json', when: 'workspaceUnder', evidence: 'verified' },
        ],
      },
    },
    hooks: { user: { channel: 'adapter', adapter: 'opencode-plugin', evidence: 'source' }, self: 'user', subagentStop: false, stopReply: true, shell: 'system', teamHooks: 'home' },
    sessions: ['opencode'],
    launch: 'opencode',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: true,
    legacyAgentMd: false,
    tokens: 'opencode-db',
    features: {
      env: '?',
      workflows: '✓t',
      unattended: '✓d',
      recall: '✓v',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      tokens: '✓v',
      aiBackend: '✓v',
      votesJudge: '?',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: { cell: '✓v', note: 'runs from teamai\'s team-hook bridge, which can block a tool call; OpenCode 1.18.23 ran a team hook through it' },
    },
  },
  // muse-bin 1.4.11: $XDG_CONFIG_HOME/muse, else ~/.config/muse; with XDG_CONFIG_HOME set, ~/.config/muse is never read.
  muse: {
    home: { dir: '.config/muse', moves: { by: [{ kind: 'xdg', child: 'muse', evidence: 'source' }], defaultHomeLeftovers: true } },
    installedBy: 'home',
    skillLoad: { calls: [{ name: 'read_skill', evidence: 'verified' }] },
    skills: {
      user: [
        { base: 'home', path: '.config/muse/skills', evidence: 'verified' },
        { base: 'home', path: '.agents/skills', evidence: 'verified' },
        { base: 'home', path: '.claude/skills', evidence: 'verified' },
      ],
      project: [{ base: 'project', path: '.agents/skills', when: 'workspaceUnder', evidence: 'verified' }],
      readGates: ['muse-workspace-trust'],
    },
    rules: {
      user: { channel: 'inline', label: 'Muse Code AGENTS.md' },
      project: { channel: 'session-hook', probe: 'muse-session-start', evidence: 'verified' },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'home', path: '.config/muse/AGENTS.md' }, reads: [{ base: 'home', path: '.config/muse/AGENTS.md', evidence: 'verified' }] },
      project: { channel: 'session-hook', probe: 'muse-session-start', evidence: 'verified' },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.config/muse/agents', evidence: 'source' }] },
      project: { reads: 'unknown' },
    },
    mcp: {
      user: { format: 'muse', reads: [{ base: 'home', path: '.config/muse/settings.json', evidence: 'source' }] },
      project: { judgedTeamaiOnly: true, format: 'muse', writtenBy: 'claude', reads: [{ base: 'project', path: '.mcp.json', when: 'workspaceUnder', evidence: 'source' }], readGates: ['muse-workspace-trust'] },
    },
    // Muse takes Codex's hook shape: it drops a group carrying any key but `matcher` and `hooks`, so Claude's described groups never reach it.
    hooks: { user: { channel: 'settings', format: 'codex', reads: [{ base: 'home', path: '.config/muse/settings.json', evidence: 'verified' }] }, self: { channel: 'settings', format: 'codex', reads: [{ base: 'project', path: '.muse/hooks.json', when: 'workspaceUnder', evidence: 'verified' }], readGates: ['muse-workspace-trust'] }, subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home' },
    // muse-bin 1.4.14: sessions under $XDG_DATA_HOME/muse/sessions, ~/.local/share when unset.
    sessions: ['muse'],
    launch: 'muse',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'muse-session',
    features: {
      env: '✓t',
      workflows: '+v',
      unattended: '?',
      recall: '✓t',
      stats: '✓v',
      tokens: '✓t',
      aiBackend: '✓v',
      votesJudge: { cell: '✓t', note: '#1374 judges the reply in its Stop payload; not rerun' },
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: { cell: '✓t', note: '#1224 writes them to settings.json; not rerun' },
    },
  },
  // agy 1.4.8 runs: ~/.gemini/config holds the user customizations, <root>/.agents a project's.
  agy: {
    home: { dir: '.gemini/config' },
    installedBy: 'home',
    // A skill loads as a read of its SKILL.md (`view_file` or `read_file`).
    skillLoad: { calls: [] },
    skills: {
      user: [{ base: 'home', path: '.gemini/config/skills', evidence: 'verified' }, { base: 'home', path: '.agents/skills', evidence: 'verified' }],
      project: [{ base: 'project', path: '.agents/skills', when: 'workspaceUnder', evidence: 'verified' }],
    },
    rules: {
      user: { channel: 'dir', format: 'agy', reads: [{ base: 'home', path: '.gemini/config/rules', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'agy', reads: [{ base: 'project', path: '.agents/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'trigger-always-on' }, reads: [{ base: 'home', path: '.gemini/config/rules', evidence: 'verified' }] },
      project: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'trigger-always-on' }, reads: [{ base: 'project', path: '.agents/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.gemini/config/agents', evidence: 'verified' }] },
      project: { reads: [{ base: 'project', path: '.agents/agents', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    mcp: {
      user: { format: 'agy', reads: [{ base: 'home', path: '.gemini/config/mcp_config.json', evidence: 'verified' }] },
      project: { judgedTeamaiOnly: true, format: 'agy', reads: [{ base: 'project', path: '.agents/plugins/teamai/mcp_config.json', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    hooks: { user: { channel: 'adapter', adapter: 'agy-hooks', evidence: 'verified' }, self: 'user', subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home' },
    sessions: ['agy'],
    launch: 'agy',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'agy-transcript',
    features: {
      env: { cell: '✓v', note: 'agy 1.4.8 run_command inherits the environment agy starts in' },
      workflows: '✓v',
      unattended: '✓d',
      recall: '✓v',
      stats: '✓v',
      tokens: { cell: '◐v', note: 'agy 1.4.10 session read 2026-10-31; it names no model, so its tokens show unpriced' },
      aiBackend: '✓v',
      votesJudge: { cell: '✗v', note: 'agy 1.4.8 PostToolUse carries no tool output, so a teamai recall run never reaches the recall log' },
      sessionJudge: { cell: '✓t', note: 'invoke_subagent starts a fresh conversation that gets only its prompt (agy 1.4.8); no session variable, so the session names its tool with --tools; not run' },
      agentHooks: { cell: '✓t', note: 'runs from teamai\'s team-hook bridge, which can block a tool call; the dispatcher hands it a Claude payload' },
    },
  },
} as const satisfies Record<ToolId, ShippedDescriptor>;

type Entry<T extends ToolId> = (typeof TOOLS)[T];

/** A tool whose user rules are `inline` and that has no user blocks file to hold them. `never` while every tool has one. */
export type InlineRulesWithoutBlocksFile = {
  [T in ToolId]: Entry<T>['rules']['user'] extends { readonly channel: 'inline' }
    ? (Entry<T>['blocks']['user'] extends { readonly channel: 'file' } ? never : T) : never
}[ToolId];

/** A tool whose two scopes name different MCP formats. `never` while each tool has one (`mcpFormatOf`). */
export type ToolsWithTwoMcpFormats = {
  [T in ToolId]: Entry<T>['mcp']['user'] extends { readonly format: infer U }
    ? (Entry<T>['mcp']['project'] extends { readonly format: infer P } ? ([U] extends [P] ? ([P] extends [U] ? never : T) : T) : never)
    : never
}[ToolId];

/** Tools teamai renders agents for in either scope: what `renderForTool` takes. */
export type AgentToolId = {
  [T in ToolId]: Entry<T>['agents'] extends { readonly user: 'none' | 'unknown'; readonly project: 'none' | 'unknown' } ? never : T
}[ToolId];
