import { describe, expect, it } from 'vitest';
import { boundedStdout, fitReason, RuntimeMessageSchema, UNAVAILABLE_REASON_MAX } from './protocol.js';

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
