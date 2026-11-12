import { describe, expect, it } from 'vitest';
import { handleOf, placeKeyOfHandle } from './provider.js';

describe('placeKeyOfHandle', () => {
  it.each([
    { run: 'r0123abcd', attempt: 'a0123abcd' },
    { run: 'r0123abcd4567ef89', attempt: 'affffffff' },
  ])('finds the place of the handle teamai made for run $run, attempt $attempt', (key) => {
    expect(placeKeyOfHandle(handleOf(key))).toEqual(key);
  });

  it.each([
    'my-sandbox',
    'teamai-r0123abcd',
    'teamai-r0123abcd-a0123abcd-proxy',
    'teamai-r0123abcd-a0123abcd-net',
    'teamai-0123456789abcdef-r0123abcd-a0123abcd',
    'other-r0123abcd-a0123abcd',
    'teamai-r0123ABCD-a0123abcd',
    'teamai-r0123abc-a0123abcd',
  ])('finds no place in %s, a name handleOf did not make', (name) => {
    expect(placeKeyOfHandle(name)).toBeUndefined();
  });
});
