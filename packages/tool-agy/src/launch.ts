import { answered, failed, type CallOutput, type CallReading, type LaunchAdapter } from '@teamai/tool-core/launch';
import { agyRun } from '@teamai/tool-core/stdout';


/** agy's stream-json output ends with a `result` event: the response on SUCCESS, else the error, and the turn's usage. */
function readAgyStream({ stdout }: CallOutput): CallReading {
  const { result, tokens } = agyRun(stdout);

  if (!result) return { ok: false };
  const text = result.response?.trim();

  if (result.status !== 'SUCCESS' || !text) return failed(result.error || undefined);

  return answered(text, tokens);
}

/** How teamai launches agy headless. */
export const launch = {
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
