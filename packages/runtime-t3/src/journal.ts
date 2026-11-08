import fs from 'node:fs';
import path from 'node:path';
import { OpStateSchema, RuntimeHandleSchema, type OpState } from '@teamai/runtime-protocol';
import { recordStore } from '@teamai/runtime-kit/journal';
import { z } from 'zod';
import { STEP_MODES } from './t3.js';

// ─── What the runtime keeps of each opened place, across its own restarts ───
//
//  One record per handle under the runtime's state directory, and one per operation of it, each written whole through
//  a rename, so a runtime killed mid-write leaves the previous record. teamai reattaches a handle after it restarts;
//  the records say which T3 thread each prompt launched, so the runtime reconnects to it instead of launching another.
//

/** The T3 thread a prompt launched: what reconnecting to it, showing it and settling it need. */
const ThreadSchema = z.object({
  threadId: z.string().min(1),
  title: z.string(),
  model: z.string(),
  tool: z.string(),
  /** The provider instance it runs on, whose tool home holds its session. Absent from a record before it was kept. */
  instanceId: z.string().optional(),
  launchedAt: z.number(),
  /** A judge's: the read-only copy of its directory, in the thread's own scratch folder, which close removes. */
  copy: z.string().optional(),
  /**
   * The runtime saw the thread's run, and the work it delegated, settle, or a stop it asked for take effect. Until then
   * the thread is the runtime's to stop, whatever ended its op and whichever runtime process launched it: close stops it
   * first, and keeps the place, and a judge's copy, while T3 will not; nothing settles it before then.
   */
  ended: z.object({
    /**
     * How asking T3 to settle the thread went, once the runtime asked; it asks once. `skipped`: it never asks, since T3
     * would run the project's settle script in the step's folder.
     */
    settlement: z.enum(['settled', 'failed', 'skipped']).optional(),
  }).optional(),
});

export type ThreadRecord = z.infer<typeof ThreadSchema>;

/**
 * A launch T3 has not answered yet, journaled before it is sent: the thread it may have launched is found again by
 * repeating it, since T3 answers a repeated clientRequestId (the op) with the thread it launched for it.
 */
const LaunchSchema = z.object({
  title: z.string(),
  /** None: T3 picks the member's default model, as it does for a thread the member starts. */
  modelSelection: z.object({ instanceId: z.string(), model: z.string(), options: z.array(z.object({ id: z.string(), value: z.union([z.string(), z.boolean()]) })).optional() }).optional(),
  runtimeMode: z.enum(STEP_MODES),
  tool: z.string(),
  launchedAt: z.number(),
  /** A step's on an existing worktree: the worktree its thread runs on. A judge's thread runs in a scratch folder of T3's own. */
  worktreePath: z.string().optional(),
  /** Which T3 Code sign-in sent it: T3 answers a repeat with the thread it launched only under that same sign-in. */
  signIn: z.string(),
});

export type LaunchRecord = z.infer<typeof LaunchSchema>;

const placeFields = {
  handle: RuntimeHandleSchema,
  run: z.string(),
  attempt: z.string(),
};

/**
 * An attempt's folder in a T3 project, or a confined prompt's place, which has no view of the host. Its threads bind
 * the folder as a worktree of the project, or as the project's own folder (`root`): a checkout, a clone, or a worktree
 * T3 would otherwise run the project's setup script in. `settleScript`: the script T3 runs when one of them is settled.
 * Strict, so a record that still holds its operations, as a place's record once did, is unreadable, not read without them.
 */
const PlaceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('worktree'), ...placeFields, projectId: z.string(), projectTitle: z.string(),
    binding: z.enum(['existing_worktree', 'root']).default('existing_worktree'), settleScript: z.string().optional(),
    /** The project whose T3 settings the step's threads follow: the checkout's, when the threads run on one teamai added. */
    settingsProjectId: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal('confined'), ...placeFields }),
]);

/**
 * One operation of a place, in a record of its own: how it stands, as `reattach` reports it, the thread it launched,
 * and its launch while T3 has not answered it. Two runtime processes that write different operations never lose each
 * other's write.
 */
const OpRecordSchema = z.object({ state: OpStateSchema, thread: ThreadSchema.optional(), launch: LaunchSchema.optional() });

export type OpRecord = z.infer<typeof OpRecordSchema>;

/** A place with its operations: each one's state, the thread of each prompt that launched one, and each unanswered launch. */
export type PlaceRecord = z.infer<typeof PlaceSchema> & {
  ops: Record<string, OpState>;
  threads: Record<string, ThreadRecord>;
  launches: Record<string, LaunchRecord>;
};

/**
 * A place's record: none once it was removed, or one that is there but cannot be read, which is not the same. An
 * unreadable one names its place when the journal knows it.
 */
export type PlaceRead = { kind: 'found'; place: PlaceRecord } | { kind: 'missing' } | { kind: 'unreadable'; file: string; why: string; handle?: string };

/** The keys of `store`, kept in `dir`, or why that folder cannot be listed. */
function keysIn(store: { keys(): string[] }, dir: string): { kind: 'listed'; keys: string[] } | { kind: 'unreadable'; file: string; why: string } {
  try {
    return { kind: 'listed', keys: store.keys() };
  } catch (error) {
    return { kind: 'unreadable', file: dir, why: error instanceof Error ? error.message : String(error) };
  }
}

export interface Journal {
  read(handle: string): PlaceRead;
  /**
   * The place whose operations include `op`: a restarted runtime is asked to cancel an op before it reattaches. With
   * none, a record that cannot be read may hold it, so the answer is unreadable then, not missing.
   */
  placeOf(op: string): PlaceRead;
  /** Writes the place's own record, and a record for each operation it holds. */
  open(place: PlaceRecord): void;
  /**
   * Writes `op`'s record in the place `handle` as `change` makes it from the one there; `undefined` writes nothing. A
   * record there that cannot be read is never written over: that throws.
   */
  update(at: { handle: string; op: string }, change: (record: OpRecord | undefined) => OpRecord | undefined): void;
  remove(handle: string): void;
  /** The file that holds the place's record, which the person deletes once they stopped what it may still run. */
  file(handle: string): string;
}

/**
 * The places in `dir`, one `<handle>.json` each, with each place's operations in `<handle>/<op>.json` beside it, keyed by
 * the operation apart from the place.
 */
export function journal(dir: string): Journal {
  const places = recordStore(dir, PlaceSchema);
  const conversationsOf = (handle: string) => recordStore(path.join(dir, encodeURIComponent(handle)), OpRecordSchema);

  const read = (handle: string): PlaceRead => {
    const own = places.read(handle);

    if (own.kind === 'unreadable') return { ...own, handle };

    if (own.kind === 'missing') return own;
    const conversations = conversationsOf(handle);
    const place: PlaceRecord = { ...own.record, ops: {}, threads: {}, launches: {} };
    const listed = keysIn(conversations, path.join(dir, encodeURIComponent(handle)));

    if (listed.kind === 'unreadable') return { ...listed, handle };

    for (const op of listed.keys) {
      const found = conversations.read(op);

      if (found.kind === 'unreadable') return { ...found, handle };

      if (found.kind === 'missing') continue;
      const { state, thread, launch } = found.record;
      place.ops[op] = state;

      if (thread) place.threads[op] = thread;

      if (launch) place.launches[op] = launch;
    }

    return { kind: 'found', place };
  };

  return {
    read,
    placeOf(op) {
      let unreadable: PlaceRead = { kind: 'missing' };
      const listed = keysIn(places, dir);

      if (listed.kind === 'unreadable') return listed;

      for (const handle of listed.keys) {
        const found = read(handle);

        if (found.kind === 'found' && found.place.ops[op] !== undefined) return found;

        if (found.kind === 'unreadable' && unreadable.kind === 'missing') unreadable = found;
      }

      return unreadable;
    },
    open({ ops, threads, launches, ...own }) {
      places.write(own.handle, own);
      const conversations = conversationsOf(own.handle);

      for (const [op, state] of Object.entries(ops)) conversations.write(op, { state, ...(threads[op] && { thread: threads[op] }), ...(launches[op] && { launch: launches[op] }) });
    },
    update({ handle, op }, change) {
      const conversations = conversationsOf(handle);
      const found = conversations.read(op);

      if (found.kind === 'unreadable') throw new Error(`Runtime t3 cannot read its record of ${op}, ${found.file} (${found.why.replace(/\.$/, '')}), so it does not write over it.`);
      const next = change(found.kind === 'found' ? found.record : undefined);

      if (next !== undefined) conversations.write(op, next);
    },
    // The operations first: a place whose removal stopped halfway is still there, and a later close removes the rest.
    remove(handle) {
      fs.rmSync(path.join(dir, encodeURIComponent(handle)), { recursive: true, force: true });
      places.remove(handle);
    },
    file: places.file,
  };
}
