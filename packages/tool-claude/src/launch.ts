import { readClaudeResult, type LaunchAdapter } from '@teamai/tool-core/launch';

/** How teamai launches Claude Code and its variants headless; each variant starts its own command. */
export const launch = {
  claude: {
    signIn: { variables: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], alongside: ['ANTHROPIC_BASE_URL'], gateway: { url: 'ANTHROPIC_BASE_URL', token: 'ANTHROPIC_AUTH_TOKEN' } },
    call: {
      evidence: 'verified',
      prompt: 'stdin',
      args: () => ['-p', '--output-format', 'json'],
      read: readClaudeResult,
      // Claude Code 2.1.319 continued a `claude -p` session this way (2026-11-08).
      resume: { evidence: 'verified', args: (session) => ['--resume', session] },
      // `--output-format json` prints nothing until the call ends; stream-json prints each message, its last the same
      // result record (Claude Code 2.1.319, 2026-11-08).
      streams: { evidence: 'verified', args: () => ['-p', '--output-format', 'stream-json', '--verbose'] },
    },
    // Claude Code 2.1.312 ran a strict-sandbox benchmark trial in this mode (2026-10-30, `teamai benchmark run --sandbox`).
    step: { evidence: 'verified', unattended: { args: ['--permission-mode', 'bypassPermissions'], evidence: 'verified' } },
    confined: {
      evidence: 'verified',
      env: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'],
      homeEnv: 'CLAUDE_CONFIG_DIR',
      verified: /^2\.1\.308 \(Claude Code\)$/,
      access: 'read',
    },
  },
} as const satisfies Record<string, LaunchAdapter>;
