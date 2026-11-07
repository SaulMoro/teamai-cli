import { describe, expect, it } from 'vitest';
import { fitReason, isUsageLimitText, RuntimeMessageSchema, SIGN_IN_VARIABLES, UNAVAILABLE_REASON_MAX } from './protocol.js';

describe('a tool\'s own text for a spent usage limit', () => {
  it.each([
    'You\'ve hit your limit · resets 3pm (Europe/Madrid)',
    '5-hour limit reached ∙ resets 2pm',
    'Claude AI usage limit reached|1762531200',
    'You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 2 days 1 hour 40 minutes.',
    'API Error: Request rejected (429) · This request would exceed your account\'s rate limit. Please try again later.',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit."}}',
    'exceeded retry limit, last status: 429 Too Many Requests, request id: req_1',
    'Rate limit reached for requests per minute.',
  ])('is a usage limit: %s', (text) => {
    expect(isUsageLimitText(text)).toBe(true);
  });

  it.each([
    'Context limit reached: the conversation is too long.',
    'API Error: 401 Invalid bearer token',
    'The reply says you\'ve hit your limit, which is not the tool stopping.',
  ])('is not a usage limit: %s', (text) => {
    expect(isUsageLimitText(text)).toBe(false);
  });
});

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

describe('the sign-in variables of a tool', () => {
  it('name the gateway Claude reads, as a base URL and the token it signs in to it with', () => {
    expect(SIGN_IN_VARIABLES.claude.gateway).toEqual({ url: 'ANTHROPIC_BASE_URL', token: 'ANTHROPIC_AUTH_TOKEN' });
  });
});
