import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stepUsage } from './step-usage.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function transcript(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-usage-'));
  dirs.push(dir);
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));

  return file;
}

const FIRST_TURN = '2026-11-13T10:00:00.000Z';
const SECOND_TURN = '2026-11-13T10:05:00.000Z';

function claudeRequest(id: string, timestamp: string | undefined, usage: { input: number; output: number; cacheRead: number; cacheCreation: number }): object {
  return {
    type: 'assistant', sessionId: 'session-1', ...(timestamp !== undefined && { timestamp }),
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheCreation } },
  };
}

function codexRecord(timestamp: string, responseId: string, usage: { input: number; cached: number; output: number }, thread: { input: number; cached: number; output: number }): object {
  const counted = ({ input, cached, output }: typeof usage) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });

  return { timestamp, type: 'token_usage_record', payload: { thread_id: 'session-1', session_id: 'session-1', response_id: responseId, usage: counted(usage), thread_token_usage: counted(thread) } };
}

const twoClaudeTurns = () => transcript([
  claudeRequest('msg_1', FIRST_TURN, { input: 4, output: 300, cacheRead: 10_000, cacheCreation: 9_000 }),
  claudeRequest('msg_2', FIRST_TURN, { input: 2, output: 100, cacheRead: 12_000, cacheCreation: 500 }),
  claudeRequest('msg_3', SECOND_TURN, { input: 3, output: 50, cacheRead: 20_000, cacheCreation: 700 }),
]);

describe('stepUsage', () => {
  it('reports every request of the session of a step that started it, as Claude Code reports its own usage', async () => {
    expect(await stepUsage({ format: 'claude-jsonl', transcriptPath: twoClaudeTurns(), sessionId: 'session-1' })).toEqual({ input: 9, output: 450, cachedInput: 42_000 });
  });

  it('reports only the requests at or after a turn was sent, not those of the earlier steps in the same session', async () => {
    expect(await stepUsage({ format: 'claude-jsonl', transcriptPath: twoClaudeTurns(), sessionId: 'session-1', turnSentAt: Date.parse(SECOND_TURN) })).toEqual({ input: 3, output: 50, cachedInput: 20_000 });
  });

  it('reports a Codex session as Codex reports its own usage, counting cached input inside input', async () => {
    const rollout = transcript([
      { timestamp: FIRST_TURN, type: 'session_meta', payload: { id: 'session-1', cwd: '/work' } },
      { timestamp: FIRST_TURN, type: 'turn_context', payload: { turn_id: 'turn-1', cwd: '/work', model: 'gpt-6.1-sol' } },
      codexRecord(FIRST_TURN, 'resp_1', { input: 1_200, cached: 1_000, output: 40 }, { input: 1_200, cached: 1_000, output: 40 }),
    ]);

    expect(await stepUsage({ format: 'codex-rollout', transcriptPath: rollout, sessionId: 'session-1' })).toEqual({ input: 1_200, output: 40, cachedInput: 1_000 });
  });

  it.each([
    ['the transcript is missing', () => path.join(os.tmpdir(), 'teamai-step-usage-missing', 'session.jsonl'), undefined],
    ['no request falls in the turn', twoClaudeTurns, Date.parse('2026-11-13T11:00:00.000Z')],
    ['a request records no time that would place it in or out of the turn', () => transcript([claudeRequest('msg_1', undefined, { input: 4, output: 300, cacheRead: 0, cacheCreation: 0 }), claudeRequest('msg_2', SECOND_TURN, { input: 3, output: 50, cacheRead: 0, cacheCreation: 0 })]), Date.parse(SECOND_TURN)],
  ])('reports no usage, never zero, when %s', async (_case, file, turnSentAt) => {
    expect(await stepUsage({ format: 'claude-jsonl', transcriptPath: file(), sessionId: 'session-1', ...(turnSentAt !== undefined && { turnSentAt }) })).toBeUndefined();
  });
});
