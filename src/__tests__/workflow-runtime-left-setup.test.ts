import { describe, expect, it } from 'vitest';
import { AttemptRuntimeRecordSchema, setupLeftElsewhere } from '../workflow/runtimes/attempt.js';

const recordOf = (fields: Record<string, unknown>) => AttemptRuntimeRecordSchema.parse({ runtime: 'sandbox', driver: 'teamai-sandbox', open: { op: 'op-0123456789ab', handle: 'h-1' }, ...fields });

describe('a setup a killed teamai left on a step runtime this driver does not run', () => {
  it('fails the attempt while that setup may still run there', () => {
    const left = recordOf({ phase: 'running', setup: { op: 'op-0123456789ac' } });

    expect(setupLeftElsewhere(left, 'a0123456', undefined)).toMatchObject({ message: expect.stringContaining('left running on step runtime "sandbox" of driver "teamai-sandbox"') });
  });

  it('leaves the attempt alone once that setup ended and its work was brought back', () => {
    const ended = recordOf({ phase: 'collected', setup: { op: 'op-0123456789ac' } });

    expect(setupLeftElsewhere(ended, 'a0123456', undefined)).toBeUndefined();
  });
});
