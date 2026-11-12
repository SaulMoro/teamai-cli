import { describe, expect, it } from 'vitest';
import { cheapestListed, sbxInWorld } from './doctor.js';

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

describe('sbx in a world', () => {
  const RUN = '20261112T113044-479be0';

  it("is not signed in from a world's own HOME until a maintainer signs in there, and says the command", () => {
    expect(sbxInWorld(RUN, { code: 1, why: 'try: sbx login' })).toEqual({
      good: false,
      text: `sandbox sbx: installed, not signed in in this world; sign in with \`npm run -s verify -- sh ${RUN} sbx login\`. Claims on it are UNVERIFIABLE until then`,
    });
  });

  it('is signed in once its list answers, and unverifiable when the list fails for another reason', () => {
    expect(sbxInWorld(RUN, { code: 0, why: '' })).toEqual({ good: true, text: 'sandbox sbx: signed in in this world' });
    expect(sbxInWorld(RUN, { code: 1, why: 'error: daemon not reachable' })).toEqual({ good: false, text: 'sandbox sbx: `sbx ls` failed in this world (error: daemon not reachable): claims on it are UNVERIFIABLE here' });
  });
});
