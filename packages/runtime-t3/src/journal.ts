import fs from 'node:fs';
import path from 'node:path';
import { OpStateSchema, RuntimeHandleSchema } from '@teamai/runtime-protocol';
import { z } from 'zod';

// ─── What the runtime keeps of each opened place, across its own restarts ───
//
//  One file per handle under the runtime's state directory, written whole through a rename, so a runtime killed
//  mid-write leaves the previous record. teamai reattaches a handle after it restarts; the record says which T3
//  thread each prompt launched, so the runtime reconnects to it instead of launching another.
//

/** The T3 thread a prompt launched: what reconnecting to it, showing it and settling it need. */
const ThreadSchema = z.object({
  threadId: z.string().min(1),
  title: z.string(),
  model: z.string(),
  tool: z.string(),
  launchedAt: z.number(),
  /** A judge's: the read-only copy of its directory, in the thread's own scratch folder, which close removes. */
  copy: z.string().optional(),
  /**
   * The op ended while T3 may still run the thread: teamai could not stop it, or lost track of it. close stops it first,
   * and keeps the place, and a judge's copy, while T3 will not; nothing settles it before then.
   */
  mayStillRun: z.boolean().optional(),
  /** How asking T3 to settle the thread went, once the runtime asked; it asks once. */
  settlement: z.enum(['settled', 'failed']).optional(),
});

export type ThreadRecord = z.infer<typeof ThreadSchema>;

const placeFields = {
  handle: RuntimeHandleSchema,
  run: z.string(),
  attempt: z.string(),
  /** Each operation of the handle, as `reattach` reports it. */
  ops: z.record(z.string(), OpStateSchema),
  /** The thread of each prompt that launched one. */
  threads: z.record(z.string(), ThreadSchema),
};

/** An attempt's worktree in a T3 project, or a confined prompt's place, which has no view of the host. */
const PlaceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('worktree'), ...placeFields, projectId: z.string(), projectTitle: z.string() }),
  z.object({ kind: z.literal('confined'), ...placeFields }),
]);

export type PlaceRecord = z.infer<typeof PlaceSchema>;

export interface Journal {
  read(handle: string): PlaceRecord | undefined;
  /** The place whose operations include `op`: a restarted runtime is asked to cancel an op before it reattaches. */
  placeOf(op: string): PlaceRecord | undefined;
  write(place: PlaceRecord): void;
  remove(handle: string): void;
}

export function journal(dir: string): Journal {
  const file = (handle: string) => path.join(dir, `${encodeURIComponent(handle)}.json`);

  const read = (handle: string): PlaceRecord | undefined => {
    try {
      return PlaceSchema.parse(JSON.parse(fs.readFileSync(file(handle), 'utf8')));
    } catch {
      return undefined;
    }
  };

  return {
    read,
    placeOf(op) {
      const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')) : [];

      return names.map((name) => read(decodeURIComponent(name.slice(0, -'.json'.length)))).find((place) => place?.ops[op] !== undefined);
    },
    write(place) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = `${file(place.handle)}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(place), { mode: 0o600 });
      fs.renameSync(temp, file(place.handle));
    },
    remove: (handle) => fs.rmSync(file(handle), { force: true }),
  };
}
