import fs from 'node:fs';
import path from 'node:path';
import { OpStateSchema, RuntimeHandleSchema } from '@teamai/runtime-protocol';
import { z } from 'zod';
import { STEP_MODES } from './t3.js';

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
   * The runtime saw the thread's run, and the work it delegated, settle, or a stop it asked for take effect. Until then
   * the thread is the runtime's to stop, whatever ended its op and whichever runtime process launched it: close stops it
   * first, and keeps the place, and a judge's copy, while T3 will not; nothing settles it before then.
   */
  ended: z.object({
    /** How asking T3 to settle the thread went, once the runtime asked; it asks once. */
    settlement: z.enum(['settled', 'failed']).optional(),
  }).optional(),
});

export type ThreadRecord = z.infer<typeof ThreadSchema>;

/**
 * A launch T3 has not answered yet, journaled before it is sent: the thread it may have launched is found again by
 * repeating it, since T3 answers a repeated clientRequestId (the op) with the thread it launched for it.
 */
const LaunchSchema = z.object({
  title: z.string(),
  modelSelection: z.object({ instanceId: z.string(), model: z.string(), options: z.array(z.object({ id: z.string(), value: z.string() })).optional() }),
  runtimeMode: z.enum(STEP_MODES),
  tool: z.string(),
  launchedAt: z.number(),
  /** A step's: the worktree its thread runs on. A judge's thread runs in a scratch folder of T3's own. */
  worktreePath: z.string().optional(),
});

export type LaunchRecord = z.infer<typeof LaunchSchema>;

const placeFields = {
  handle: RuntimeHandleSchema,
  run: z.string(),
  attempt: z.string(),
  /** Each operation of the handle, as `reattach` reports it. */
  ops: z.record(z.string(), OpStateSchema),
  /** The thread of each prompt that launched one. */
  threads: z.record(z.string(), ThreadSchema),
  /** The launch of each prompt T3 has not answered yet. */
  launches: z.record(z.string(), LaunchSchema),
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
