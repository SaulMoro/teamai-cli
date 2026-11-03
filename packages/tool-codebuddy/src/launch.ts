import { readClaudeResult, type LaunchAdapter } from '@teamai/tool-core/launch';


/** How teamai launches the CodeBuddy CLI headless; WorkBuddy has no launch profile. */
export const launch = {
  codebuddy: {
    call: { evidence: 'docs', prompt: 'stdin', args: () => ['-p', '--output-format', 'json'], read: readClaudeResult },
    // Claude's flags and stream, without --effort. Its unattended mode is codebuddy.ai/docs/cli/permission-modes.
    step: { evidence: 'docs', unattended: { args: ['--permission-mode', 'bypassPermissions'], evidence: 'docs' } },
    // CodeBuddy lists about 70 tools whatever `--tools` says.
    confined: { evidence: 'docs', env: ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_CONFIG_DIR'], homeEnv: 'CODEBUDDY_CONFIG_DIR', access: 'full' },
  },
} as const satisfies Record<string, LaunchAdapter>;
