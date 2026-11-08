import type { OpId, OpState, RuntimeMessage } from '@teamai/runtime-protocol';

/** How an operation ended: any state it retains but `running`. */
export type OpEnd = Exclude<OpState, { state: 'running' }>;

/**
 * Every line a runtime writes goes through its ledger, which counts each operation's ends, so the request loop never
 * writes a second end for a request whose handler already wrote one and then threw.
 */
export interface OpLedger {
  /** Writes `message`, counting it when it ends its operation. */
  write(message: RuntimeMessage): void;
  /** Writes the one event teamai reads as how `ended`'s operation ended. */
  end(ended: OpEnd): void;
  /** How many ends of `op` this process wrote: a repeated op is answered with its end again. */
  endsOf(op: OpId): number;
}

/** The events that end an operation: an open's `ready` or `failed`, an exec's or prompt's outcome. */
const ENDS: ReadonlySet<string> = new Set(['ready', 'exited', 'finished', 'cancelled', 'failed']);

/** The line that says how `ended`'s operation ended. */
function endLine(ended: OpEnd): RuntimeMessage {
  const { op } = ended;

  switch (ended.state) {
    case 'finished':
      return {
        op, event: 'finished', session: ended.session, result: ended.result,
        ...(ended.usage && { usage: ended.usage }), ...(ended.confined && { confined: ended.confined }), ...(ended.resumed !== undefined && { resumed: ended.resumed }),
      };
    case 'cancelled':
      return { op, event: 'cancelled' };
    case 'failed':
      return { op, event: 'failed', failure: ended.failure };
    case 'exited':
      return { op, event: 'exited', code: ended.code, stdout: ended.stdout };
    default: {
      const unhandled: never = ended;

      return unhandled;
    }
  }
}

/** A ledger over `write`, the runtime's stdout. */
export function opLedger(write: (message: RuntimeMessage) => void): OpLedger {
  const ends = new Map<OpId, number>();

  const counted = (message: RuntimeMessage): void => {
    if ('op' in message && 'event' in message && message.op !== undefined && ENDS.has(message.event)) ends.set(message.op, (ends.get(message.op) ?? 0) + 1);
    write(message);
  };

  return {
    write: counted,
    end: (ended) => counted(endLine(ended)),
    endsOf: (op) => ends.get(op) ?? 0,
  };
}
