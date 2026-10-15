import { describe, expect, it } from 'vitest';
import { parseStepPath } from '../workflow/step-path.js';

describe('workflow step paths', () => {
  it.each([
    ['build', [{ id: 'build' }]],
    ['ship.check.classify', [{ id: 'ship' }, { id: 'check' }, { id: 'classify' }]],
    ['build[0]', [{ id: 'build', index: 0 }]],
    ['a.b[2].c', [{ id: 'a' }, { id: 'b', index: 2 }, { id: 'c' }]],
    ['review-v2_x.fan[12]', [{ id: 'review-v2_x' }, { id: 'fan', index: 12 }]],
  ])('parses %s', (path, segments) => {
    expect(parseStepPath(path)).toEqual(segments);
  });

  it.each(['b[x]', 'b[]', 'b[01]', 'b[-1]', 'b[1]x', 'b[1][2]'])('reads %s as a step id with no item index', (path) => {
    expect(parseStepPath(path)).toEqual([{ id: path }]);
  });
});
