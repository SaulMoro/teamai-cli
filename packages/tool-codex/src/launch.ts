import { z } from 'zod';
import { answered, failed, jsonLines, type CallOutput, type CallReading, type LaunchAdapter } from '@teamai/tool-core/launch';
import { readToolMetadata } from '@teamai/tool-core/stdout';

const CodexError = z.union([
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }) }),
]);

/** Codex writes its last message to the `-o` file, and prints its events, the turn's usage included, as JSON lines. */
function readCodexExec({ stdout, lastMessage }: CallOutput): CallReading {
  const text = lastMessage?.trim();

  if (!text) {
    const error = jsonLines(stdout).flatMap((line) => {
      const parsed = CodexError.safeParse(line);

      return parsed.success ? [parsed.data] : [];
    }).at(-1);

    return failed(error?.type === 'error' ? error.message : error?.error.message);
  }

  return answered(text, readToolMetadata(stdout)?.tokens);
}

/** How teamai launches Codex and its variants headless; each variant starts its own command. */
export const launch = {
  codex: {
    signIn: { variables: ['OPENAI_API_KEY', 'CODEX_API_KEY'] },
    call: { evidence: 'verified', prompt: 'stdin', args: ({ lastMessageFile }) => ['exec', '--json', '--skip-git-repo-check', '-o', lastMessageFile, '-'], read: readCodexExec },
    // `codex exec --help` of codex-cli 0.165.0: "Intended solely for running in environments that are externally sandboxed".
    step: { evidence: 'verified', unattended: { args: ['--dangerously-bypass-approvals-and-sandbox'], evidence: 'docs' } },
    // Codex also signs in with CODEX_API_KEY ("run codex login or set CODEX_API_KEY").
    confined: { evidence: 'verified', env: ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY'], homeEnv: 'CODEX_HOME', verified: /^codex-cli 0\.163\.0$/, access: 'read' },
  },
} as const satisfies Record<string, LaunchAdapter>;
