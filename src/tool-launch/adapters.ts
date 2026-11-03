import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import { answered, failed, readClaudeResult, type CallOutput, type CallReading, type LaunchAdapter } from '@teamai/tool-core/launch';
import { agyRun } from '@teamai/tool-core/stdout';

/** agy's stream-json output ends with a `result` event: the response on SUCCESS, else the error, and the turn's usage. */
function readAgyStream({ stdout }: CallOutput): CallReading {
  const { result, tokens } = agyRun(stdout);

  if (!result) return { ok: false };
  const text = result.response?.trim();

  if (result.status !== 'SUCCESS' || !text) return failed(result.error || undefined);

  return answered(text, tokens);
}

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
  // agy reads stdin only as stream-json user events. `--print=` is print mode with the prompt left to them; a bare
  // `-p` would take the next flag as its prompt.
  agy: {
    // `agy --help` of 1.4.10.
    step: { evidence: 'verified', unattended: { args: ['--dangerously-skip-permissions'], evidence: 'docs' } },
    // Plan mode with the sandbox reads files but runs no shell and writes nothing in the workspace (agy 1.4.10).
    confined: { evidence: 'verified', env: ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL'], access: 'read' },
    call: {
      evidence: 'verified',
      prompt: 'stdin',
      stdinOf: (prompt) => `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`,
      args: () => ['--input-format=stream-json', '--output-format=stream-json', '--print='],
      read: readAgyStream,
    },
  },
} as const satisfies Record<string, LaunchAdapter>;

export type LaunchAdapterId = keyof typeof LAUNCH_ADAPTERS;
