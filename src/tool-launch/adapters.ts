import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import { readClaudeResult, type LaunchAdapter } from '@teamai/tool-core/launch';

/** How teamai launches each family of tools headless. A tool picks its adapter with the `launch` facet in `TOOLS`. */
// oxlint-disable-next-line teamai/tool-facts -- keyed by launch adapter id, which this table defines; a tool picks one with TOOLS.launch
export const LAUNCH_ADAPTERS = {
  claude: BUILT_IN_TOOLS.claude.launch.claude,
  codex: BUILT_IN_TOOLS.codex.launch.codex,
  opencode: BUILT_IN_TOOLS.opencode.launch.opencode,
  codebuddy: BUILT_IN_TOOLS.codebuddy.launch.codebuddy,
  openclaw: BUILT_IN_TOOLS.openclaw.launch.openclaw,
  cursor: {
    executable: 'cursor-agent',
    // Ask mode answers without editing.
    call: { evidence: 'docs', prompt: 'stdin', args: () => ['-p', '--output-format', 'json', '--mode', 'ask', '--trust'], read: readClaudeResult },
    confined: { evidence: 'docs', env: ['CURSOR_API_KEY', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR'], access: 'full' },
  },
  copilot: BUILT_IN_TOOLS.copilot.launch.copilot,
  pi: BUILT_IN_TOOLS.pi.launch.pi,
  omp: BUILT_IN_TOOLS.pi.launch.omp,
  muse: BUILT_IN_TOOLS.muse.launch.muse,
  qoder: BUILT_IN_TOOLS.qoder.launch.qoder,
  kiro: BUILT_IN_TOOLS.kiro.launch.kiro,
  hermes: BUILT_IN_TOOLS.hermes.launch.hermes,
  agy: BUILT_IN_TOOLS.agy.launch.agy,
} as const satisfies Record<string, LaunchAdapter>;

export type LaunchAdapterId = keyof typeof LAUNCH_ADAPTERS;
