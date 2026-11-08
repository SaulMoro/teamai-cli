import { describe, expect, it } from 'vitest';
import { RuntimeMessageSchema, type OpId, type RuntimeMessage } from '@teamai/runtime-protocol';
import { opLedger, type OpEnd } from './ledger.js';

const OP = 'op-0123abcd' as OpId;

const FINISHED: OpEnd = { op: OP, state: 'finished', session: { tool: 'claude', id: 's-1' }, result: { output: { verdict: 'approve' } } };

function ledgerWritten() {
  const written: RuntimeMessage[] = [];

  return { written, ledger: opLedger({ name: 'fake', write: (message) => { written.push(RuntimeMessageSchema.parse(message)); } }) };
}

describe('an operation that ends', () => {
  it('is answered with its end once its record is kept, and nothing stands in for that record', () => {
    const { written, ledger } = ledgerWritten();
    const kept: OpEnd[] = [];

    ledger.settle(FINISHED, () => { kept.push(FINISHED); });

    expect(kept).toEqual([FINISHED]);
    expect(written).toEqual([{ op: OP, event: 'finished', session: { tool: 'claude', id: 's-1' }, result: { output: { verdict: 'approve' } } }]);
    expect(ledger.unkept(OP)).toBeUndefined();
    expect(ledger.endsOf(OP)).toBe(1);
  });

  it('is answered with its true end when its record cannot be kept, says so in a notice, and remembers that end until forgotten', () => {
    const { written, ledger } = ledgerWritten();

    ledger.settle(FINISHED, () => { throw new Error('EACCES: permission denied'); });

    expect(written).toEqual([
      { event: 'notice', op: OP, message: `Runtime fake could not record how ${OP} ended (EACCES: permission denied), so only this runtime process remembers that end, until the place closes.` },
      { op: OP, event: 'finished', session: { tool: 'claude', id: 's-1' }, result: { output: { verdict: 'approve' } } },
    ]);
    expect(ledger.unkept(OP)).toEqual(FINISHED);

    ledger.forget(OP);

    expect(ledger.unkept(OP)).toBeUndefined();
  });

  it('stops standing in for the record once a later end of the op is kept', () => {
    const { ledger } = ledgerWritten();

    ledger.settle(FINISHED, () => { throw new Error('read-only'); });
    ledger.settle({ op: OP, state: 'cancelled' }, () => {});

    expect(ledger.unkept(OP)).toBeUndefined();
  });
});
