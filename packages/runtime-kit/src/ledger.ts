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
  /**
   * Ends `ended`'s op with its true outcome once `keep` journaled it. An end `keep` cannot journal is answered all the
   * same, since the op did end that way and teamai keeps it as soon as it reads it: this process remembers it
   * (`unkept`) until the op runs here again or its place closes, and says so in a notice about the op.
   */
  settle(ended: OpEnd, keep: () => void): void;
  /** The end of `op` this process answered and could not journal, which stands in for its record's. */
  unkept(op: OpId): OpEnd | undefined;
  /** Forgets `op`'s unkept end: it runs here again, or its place closed. */
  forget(op: OpId): void;
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

/** A ledger over `write`, the stdout of the runtime `name`, as its messages name it (`t3` in "Runtime t3 …"). */
export function opLedger({ name, write }: { name: string; write: (message: RuntimeMessage) => void }): OpLedger {
  const ends = new Map<OpId, number>();
  const unkept = new Map<OpId, OpEnd>();

  const counted = (message: RuntimeMessage): void => {
    if ('op' in message && 'event' in message && message.op !== undefined && ENDS.has(message.event)) ends.set(message.op, (ends.get(message.op) ?? 0) + 1);
    write(message);
  };

  return {
    write: counted,
    end: (ended) => counted(endLine(ended)),
    endsOf: (op) => ends.get(op) ?? 0,
    settle(ended, keep) {
      try {
        keep();
        unkept.delete(ended.op);
      } catch (error) {
        unkept.set(ended.op, ended);
        counted({ event: 'notice', op: ended.op, message: `Runtime ${name} could not record how ${ended.op} ended (${error instanceof Error ? error.message : String(error)}), so only this runtime process remembers that end, until the place closes.` });
      }

      counted(endLine(ended));
    },
    unkept: (op) => unkept.get(op),
    forget: (op) => { unkept.delete(op); },
  };
}
