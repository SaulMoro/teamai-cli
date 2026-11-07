import { describe, expect, it } from 'vitest';
import { isUsageLimitText } from './protocol.js';

describe('a tool\'s own text for a spent usage limit', () => {
  it.each([
    'You\'ve hit your limit · resets 3pm (Europe/Madrid)',
    '5-hour limit reached ∙ resets 2pm',
    'Claude AI usage limit reached|1762531200',
    'You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 2 days 1 hour 40 minutes.',
  ])('is a usage limit: %s', (text) => {
    expect(isUsageLimitText(text)).toBe(true);
  });

  it.each([
    'Context limit reached: the conversation is too long.',
    'Rate limit reached for requests per minute.',
    'The reply says you\'ve hit your limit, which is not the tool stopping.',
  ])('is not a usage limit: %s', (text) => {
    expect(isUsageLimitText(text)).toBe(false);
  });
});
