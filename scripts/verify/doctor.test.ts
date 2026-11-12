import { describe, expect, it } from 'vitest';
import { cheapestListed } from './doctor.js';

describe("a tool's cheapest model", () => {
  it("is the cheapest by teamai's own prices among those this login lists, never a hidden one or one teamai has no price for", () => {
    const catalog = JSON.stringify({ models: [
      { slug: 'gpt-6-sol', visibility: 'list' },
      { slug: 'gpt-6-luna', visibility: 'list' },
      { slug: 'gpt-5-6-luna', visibility: 'list' },
      { slug: 'nano-preview', visibility: 'hide' },
      { slug: 'unpriced-model', visibility: 'list' },
    ] });

    expect(cheapestListed(catalog)).toBe('gpt-6-luna');
  });

  it('is unknown when the catalog cannot be read', () => {
    expect(cheapestListed('not json')).toBeUndefined();
    expect(cheapestListed(JSON.stringify({ models: [{ slug: 'unpriced-model', visibility: 'list' }] }))).toBeUndefined();
  });
});
