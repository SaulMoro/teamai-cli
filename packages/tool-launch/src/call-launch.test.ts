import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import { callLaunch, type HeadlessStarter } from './call-launch.js';

const claude = { name: 'claude', family: 'claude', call: BUILT_IN_TOOLS.claude.launch.claude.call, executable: '/usr/bin/claude' } as const;
const codex = { name: 'codex', family: 'codex', call: BUILT_IN_TOOLS.codex.launch.codex.call, executable: '/usr/bin/codex' } as const;

/** A fake process that prints `stdout` and exits with `code`, or, when `code` is undefined, runs until it is stopped. */
function fakeProcess(stdout: string, code: number | undefined, onStart: (stdin: string) => Promise<void> = async () => {}): HeadlessStarter {
  return ({ stdin, onOutput }) => {
    let exit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => { exit = resolve; });

    void onStart(stdin).then(() => {
      if (stdout) onOutput(stdout, 'stdout');

      if (code !== undefined) exit(code);
    });

    return { exited, stop: async () => { exit(143); } };
  };
}

describe('callLaunch', () => {
  it('runs Claude\'s call profile with the prompt on stdin and reads its result record', async () => {
    let argv: string[] = [];
    let given = '';
    const record = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Looks good.', session_id: 's-1', usage: { input_tokens: 12, output_tokens: 3 } });

    const end = await callLaunch({ tool: claude, prompt: 'Review it.', timeoutMs: 10_000, start: (args) => { argv = args; return fakeProcess(`${record}\n`, 0, async (stdin) => { given = stdin; }); } });

    expect(argv).toEqual(['-p', '--output-format', 'json']);
    expect(given).toBe('Review it.');
    expect(end).toEqual({ ok: true, text: 'Looks good.', session: 's-1', tokens: { input: 12, output: 3 } });
  });

  it('reads Codex\'s answer from the last-message file its argv names', async () => {
    let argv: string[] = [];

    const end = await callLaunch({
      tool: codex, prompt: 'Review it.', timeoutMs: 10_000,
      start: (args) => {
        argv = args;
        const file = args[args.indexOf('-o') + 1] ?? '';

        return fakeProcess('', 0, async () => { await fs.writeFile(file, 'Looks good.'); });
      },
    });

    expect(argv.slice(0, 4)).toEqual(['exec', '--json', '--skip-git-repo-check', '-o']);
    expect(argv.slice(-1)).toEqual(['-']);
    expect(end).toEqual({ ok: true, text: 'Looks good.' });
  });

  it('continues a session with the arguments after the profile\'s own', async () => {
    let argv: string[] = [];
    const record = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed.' });

    await callLaunch({ tool: claude, prompt: 'Again.', session: 's-1', timeoutMs: 10_000, start: (args) => { argv = args; return fakeProcess(`${record}\n`, 0); } });

    expect(argv).toEqual(['-p', '--output-format', 'json', '--resume', 's-1']);
  });

  it('ends stopped at its timeout, naming the limit, when the tool runs past it', async () => {
    const end = await callLaunch({ tool: claude, prompt: 'Review it.', timeoutMs: 20, start: () => fakeProcess('', undefined) });

    expect(end).toEqual({ ok: false, code: 'call_failed', stopped: 'timeout', message: 'AI call timed out after 0s (tool: claude)' });
  });

  it('fails usage_limited, in the tool\'s words, when the tool says it hit its usage limit', async () => {
    const record = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'You\'ve hit your limit · resets 3pm (Europe/Madrid)' });

    const end = await callLaunch({ tool: claude, prompt: 'Review it.', timeoutMs: 10_000, start: () => fakeProcess(`${record}\n`, 1) });

    expect(end).toEqual({ ok: false, code: 'usage_limited', message: 'claude hit its usage limit: You\'ve hit your limit · resets 3pm (Europe/Madrid)' });
  });
});
