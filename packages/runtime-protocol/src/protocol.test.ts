import { describe, expect, it } from 'vitest';
import { boundedStdout, fitReason, PromptLeaseSchema, RuntimeMessageSchema, RuntimeRequestSchema, UNAVAILABLE_REASON_MAX } from './protocol.js';

describe('a reason a runtime gives in init\'s unavailable', () => {
  it('stays as it is when it fits', () => {
    expect(fitReason('acme-claude is not in the image: add it, or run the step with --driver local.')).toBe('acme-claude is not in the image: add it, or run the step with --driver local.');
  });

  it('is cut to the most init\'s reply holds, ending with an ellipsis, so the reply still parses', () => {
    const fitted = fitReason(`${'x'.repeat(UNAVAILABLE_REASON_MAX)}tail`);

    expect(fitted).toHaveLength(UNAVAILABLE_REASON_MAX);
    expect(fitted.endsWith('…')).toBe(true);
    expect(RuntimeMessageSchema.safeParse({ type: 'init', ok: true, can: {}, unavailable: { claude: fitted } }).success).toBe(true);
  });
});


describe('the stdout an exited carries', () => {
  const CUT = '[teamai: only the last 64 KiB of stdout follow]\n';

  it('is the whole stdout up to 64 KiB', () => {
    const stdout = 'x'.repeat(65_536);

    expect(boundedStdout(stdout)).toBe(stdout);
  });

  it('is the last 64 KiB after a marker past that', () => {
    expect(boundedStdout(`early${'x'.repeat(65_536)}`)).toBe(`${CUT}${'x'.repeat(65_536)}`);
  });

  it('never starts with half a character the cut split', () => {
    expect(boundedStdout(`\u{1F600}${'x'.repeat(65_535)}`)).toBe(`${CUT}${'x'.repeat(65_535)}`);
  });
});

describe('a prompt that continues an earlier conversation', () => {
  const lease = { step: 'fix', tool: 'claude', prompt: 'Fix it.', result: '/w/result.json', permissions: 'approval-required', interactive: false } as const;

  it('names the place and the op of the prompt whose conversation it continues', () => {
    expect(PromptLeaseSchema.parse({ ...lease, continue: { handle: 't3-r1-a1', op: 'op-0123abcd' } })).toEqual({ ...lease, continue: { handle: 't3-r1-a1', op: 'op-0123abcd' } });
  });

  it('refuses a key the conversation it continues does not have, naming it', () => {
    const parsed = PromptLeaseSchema.safeParse({ ...lease, continue: { handle: 't3-r1-a1', op: 'op-0123abcd', thread: 'th-1' } });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([expect.objectContaining({ code: 'unrecognized_keys', keys: ['thread'], path: ['continue'] })]);
  });
});

describe('a runtime that wakes fleet members', () => {
  const OP = 'op-0123abcd';

  it('says so in its init reply', () => {
    expect(RuntimeMessageSchema.safeParse({ type: 'init', ok: true, can: {}, prompt: true, wake: true }).success).toBe(true);
  });

  it('reads a wake request as teamai writes it', () => {
    const wake = { type: 'wake', op: OP, pool: 'gpu', repository: 'https://example.com/acme/app.git', message: 'teamai workflow resume --pool gpu --next', title: 'Fleet member for gpu' };

    expect(RuntimeRequestSchema.parse(JSON.parse(JSON.stringify(wake)))).toEqual(wake);
  });

  it('answers a wake with where it launched the member', () => {
    expect(RuntimeMessageSchema.safeParse({ op: OP, event: 'woken', where: 'studio-mac', display: { label: 'Fleet member for gpu', url: 't3://thread/th-1' } }).success).toBe(true);
    expect(RuntimeMessageSchema.safeParse({ op: OP, event: 'woken' }).success).toBe(false);
  });
});
