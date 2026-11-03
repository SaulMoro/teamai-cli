import { makeToolRegistry } from '@teamai/tool-core/registry';
import type { McpFormat } from './resources/mcp-format.js';
import type { RuleFormatId } from './resources/rule-format.js';
import type { SessionPlatform } from './session-flow/adapters/platform-facts.js';
import type { JsonSyntax } from './utils/json.js';
import { TOOLS, type AgentToolId, type HookFormat, type InstallGate, type RunTimeVia, type ToolDescriptor, type ToolId } from './tools.js';

/**
 * The one reader of the tool tables (`TOOLS`): every lookup of a tool id goes through here, so a new kind of
 * tool reaches every reader by changing what the registry is built from (teamai/tool-registry).
 */
const REGISTRY = makeToolRegistry(TOOLS);

/** Every built-in tool, in `TOOLS` order. */
export const TOOL_ORDER: readonly ToolId[] = REGISTRY.ids;

/** What teamai knows about `tool` (`TOOLS`), with each tool's literal facts. */
export type DescriptorOf<T extends ToolId> = (typeof TOOLS)[T];

export const descriptorOf: <T extends ToolId>(tool: T) => DescriptorOf<T> = REGISTRY.definitionOf;

export const isToolId: (value: string) => value is ToolId = REGISTRY.isToolId;

/** Whether releases before #1221 wrote `tool`'s hooks and MCP servers under its default home when the home moved (`Home.moves.defaultHomeLeftovers`). */
export function hasDefaultHomeLeftovers(tool: ToolId): boolean {
  const { home }: ToolDescriptor = descriptorOf(tool);

  return home.moves?.defaultHomeLeftovers === true;
}

/** The env variables that move `tool`'s home (`Home.moves.by`): a tool's own, and `XDG_CONFIG_HOME` for an XDG home. `LOCALAPPDATA` is not one: it is where Windows keeps a home that did not move. */
export function homeVariables(tool: ToolId): readonly string[] {
  const { home }: ToolDescriptor = descriptorOf(tool);

  return (home.moves?.by ?? []).flatMap((move): string[] => {
    switch (move.kind) {
      case 'env':
        return [move.name];
      case 'qoder-home':
        return ['QODER_CONFIG_DIR', 'QODER_CLI_HOME'];
      case 'qoder-cn-home':
        return ['QODERCN_CONFIG_DIR', 'QODERCN_CLI_HOME'];
      case 'xdg':
        return ['XDG_CONFIG_HOME'];
      case 'openclaw-state':
        return ['OPENCLAW_STATE_DIR', 'OPENCLAW_HOME', 'OPENCLAW_PROFILE'];
      case 'omp-agent':
        return ['OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR'];
      case 'hermes-home':
        return ['HERMES_HOME', 'HERMES_DATA_DIR_SUFFIX'];
      default: {
        const unhandled: never = move;

        return unhandled;
      }
    }
  });
}

/** Whether where `tool` takes skills follows each session's inputs (`ToolDescriptor.skillsFollowSession`). */
export function skillsFollowSession(tool: string): boolean {
  if (!isToolId(tool)) return false;
  const descriptor: ToolDescriptor = descriptorOf(tool);

  return descriptor.skillsFollowSession === true;
}

/** What says `tool` is installed beyond its configured paths, if anything (`InstallGate`). */
export function installGateOf(tool: ToolId): InstallGate | undefined {
  const descriptor: ToolDescriptor = descriptorOf(tool);

  return descriptor.installedBy;
}

/** The session platforms teamai reads for `tool`, first the one its launched sessions write; none for a custom tool id. */
export const sessionPlatformsOf: (tool: string) => readonly SessionPlatform[] = REGISTRY.sessionPlatformsOf;

/** The tool whose `sessions` lists `platform`, if one does. */
export const sessionPlatformOwner: (platform: string) => ToolId | undefined = REGISTRY.sessionPlatformOwner;

const CUSTOM_TOOL = {
  rules: { user: { channel: 'dir', format: 'verbatim', reads: 'unknown' }, project: { channel: 'dir', format: 'verbatim', reads: 'unknown' } },
  blocks: { user: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' }, project: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' } },
  agents: { user: 'none', project: 'none' },
  mcp: { user: 'none', project: 'none' },
  // A custom tool with a configured `settings` file takes Claude-shaped hooks there, as it always has.
  hooks: {
    user: { channel: 'settings', format: 'claude', reads: 'unknown' },
    self: { channel: 'settings', format: 'claude', reads: 'unknown' },
    subagentStop: false,
    stopReply: false,
    shell: 'system',
    teamHooks: 'home',
  },
} as const satisfies Pick<ToolDescriptor, 'rules' | 'blocks' | 'agents' | 'mcp' | 'hooks'>;

/** The channels of `tool`: its descriptor's, or `CUSTOM_TOOL`'s for a custom tool id. */
export function channelsOf(tool: string): Pick<ToolDescriptor, 'rules' | 'blocks' | 'agents' | 'mcp' | 'hooks'> {
  return isToolId(tool) ? descriptorOf(tool) : CUSTOM_TOOL;
}

/**
 * The `settings.local.json` beside a tool's project hook settings, from the project root, when the tool
 * merges its hooks with theirs (Claude Code, CodeBuddy, Qoder): the member's own file in each checkout.
 */
export function selfLocalSettingsOf(tool: string): string | null {
  const self = channelsOf(tool).hooks.self;

  if (self === 'user' || self === 'none' || self === 'unknown' || self.reads === 'unknown') return null;

  return self.reads.find((read) => read.base === 'project' && read.path.endsWith('/settings.local.json'))?.path ?? null;
}

/** Whether teamai renders agents for `tool` in either scope (`AgentToolId`). */
export function isAgentToolId(tool: string): tool is AgentToolId {
  if (!isToolId(tool)) return false;
  const { agents }: ToolDescriptor = descriptorOf(tool);

  return [agents.user, agents.project].some((channel) => channel !== 'none' && channel !== 'unknown');
}

/** Every tool teamai renders agents for, in `TOOLS` order. */
export const AGENT_TOOLS: readonly AgentToolId[] = TOOL_ORDER.filter(isAgentToolId);

/** The format `tool`'s rule files take in either scope: its rules format, or the team `.md` verbatim. */
export function ruleFormatIdOf(tool: string): RuleFormatId | 'verbatim' {
  const { rules } = channelsOf(tool);

  for (const channel of [rules.user, rules.project]) {
    if (channel instanceof Object && channel.channel === 'dir') return channel.format;
  }

  return 'verbatim';
}

/** How a project's team rules reach `tool` at run time, if they do. */
export function runTimeRulesOf(tool: string): RunTimeVia | null {
  const { project } = channelsOf(tool).rules;

  if (!(project instanceof Object)) return null;

  switch (project.channel) {
    case 'dir':
      return null;
    case 'session-hook':
    case 'extension':
    case 'plugin':
      return project.channel;
    default: {
      const unhandled: never = project;

      return unhandled;
    }
  }
}

/** The format of `tool`'s hook settings file in either scope; null when it reads none (an adapter, `none` or `unknown`). A custom tool reads Claude's. */
export function hookSettingsFormatOf(tool: string): HookFormat | null {
  const { hooks } = channelsOf(tool);

  for (const channel of [hooks.user, hooks.self]) if (channel instanceof Object && channel.channel === 'settings') return channel.format;

  return null;
}

/** How `tool` parses its hook settings file: the syntax of its settings channel, else strict JSON. */
export function hookSyntaxOf(tool: string): JsonSyntax {
  const { hooks } = channelsOf(tool);

  for (const channel of [hooks.user, hooks.self]) if (channel instanceof Object && channel.channel === 'settings') return channel.syntax ?? 'json';

  return 'json';
}

/** How `tool` parses its MCP file in `scope`: that channel's syntax, else strict JSON. */
export function mcpSyntaxOf(tool: string, scope: 'user' | 'project'): JsonSyntax {
  const channel = channelsOf(tool).mcp[scope];

  return channel instanceof Object ? channel.syntax ?? 'json' : 'json';
}

/** The shape teamai reads and writes `tool`'s hook file in: its settings format, else Claude's, which the DeepSeek Harness adapter writes and an earlier release wrote for a tool that reads none. */
export function hookFormatOf(tool: string): HookFormat {
  return hookSettingsFormatOf(tool) ?? 'claude';
}

/** The format `tool`'s MCP servers take in either scope; null when it has an MCP channel in neither. */
export function mcpFormatOf(tool: string): McpFormat | null {
  const { mcp } = channelsOf(tool);

  for (const channel of [mcp.user, mcp.project]) if (channel instanceof Object) return channel.format;

  return null;
}
