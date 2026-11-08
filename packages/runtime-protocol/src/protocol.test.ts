import { describe, expect, it } from 'vitest';
import { fitReason, RuntimeMessageSchema, UNAVAILABLE_REASON_MAX } from './protocol.js';

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

