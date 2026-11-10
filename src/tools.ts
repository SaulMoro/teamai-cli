import type { DescriptorIds, ToolDescriptor } from '@teamai/tool-core/definition';
import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import type { StoredSessionPlatform } from './session-flow/adapters/platform-facts.js';
import type { TokenFormatId } from './token-usage/index.js';
import type { LaunchAdapterId } from './launch-registry.js';

/** What a shipped tool's descriptor names: only built-in tools, and rows the app's launch, session and token tables declare. */
type ShippedIds = DescriptorIds & { readonly tool: ToolId; readonly launch: LaunchAdapterId; readonly platform: StoredSessionPlatform; readonly tokens: TokenFormatId };

/** A built-in tool's descriptor: each id it names resolves to a row teamai has. */
export type ShippedDescriptor = ToolDescriptor<ShippedIds>;

/**
 * Every built-in tool. Adding a tool starts here and in its family package (`packages/tool-<family>/`): `TOOLS` then
 * needs its `BUILT_IN_TOOLS` reference, and the type check lists every other table that must decide it. Custom tools in a team's `toolPaths` stay plain strings.
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
  cursor: BUILT_IN_TOOLS.cursor.tools.cursor,
  copilot: BUILT_IN_TOOLS.copilot.tools.copilot,
  joycode: BUILT_IN_TOOLS.joycode.tools.joycode,
  qoder: BUILT_IN_TOOLS.qoder.tools.qoder,
  'qoder-cn': BUILT_IN_TOOLS.qoder.tools['qoder-cn'],
  kiro: BUILT_IN_TOOLS.kiro.tools.kiro,
  trae: BUILT_IN_TOOLS.trae.tools.trae,
  'trae-cn': BUILT_IN_TOOLS.trae.tools['trae-cn'],
  zcode: BUILT_IN_TOOLS.zcode.tools.zcode,
  omp: BUILT_IN_TOOLS.pi.tools.omp,
  pi: BUILT_IN_TOOLS.pi.tools.pi,
  codebuddy: BUILT_IN_TOOLS.codebuddy.tools.codebuddy,
  openclaw: BUILT_IN_TOOLS.openclaw.tools.openclaw,
  hermes: BUILT_IN_TOOLS.hermes.tools.hermes,
  dsh: BUILT_IN_TOOLS.dsh.tools.dsh,
  workbuddy: BUILT_IN_TOOLS.codebuddy.tools.workbuddy,
  opencode: BUILT_IN_TOOLS.opencode.tools.opencode,
  muse: BUILT_IN_TOOLS.muse.tools.muse,
  agy: BUILT_IN_TOOLS.agy.tools.agy,
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
