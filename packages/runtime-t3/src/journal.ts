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

/** The T3 thread a prompt launched: what reconnecting to it and showing it need. */
const ThreadSchema = z.object({
  threadId: z.string().min(1),
  title: z.string(),
  link: z.string(),
  model: z.string(),
  tool: z.string(),
  launchedAt: z.number(),
});

export type ThreadRecord = z.infer<typeof ThreadSchema>;

const PlaceSchema = z.object({
  handle: RuntimeHandleSchema,
  run: z.string(),
  attempt: z.string(),
  projectId: z.string(),
  projectTitle: z.string(),
  /** Each operation of the handle, as `reattach` reports it. */
  ops: z.record(z.string(), OpStateSchema),
  /** The thread of each prompt that launched one. */
  threads: z.record(z.string(), ThreadSchema),
});

export type PlaceRecord = z.infer<typeof PlaceSchema>;

export interface Journal {
  read(handle: string): PlaceRecord | undefined;
  write(place: PlaceRecord): void;
  remove(handle: string): void;
}

export function journal(dir: string): Journal {
  const file = (handle: string) => path.join(dir, `${encodeURIComponent(handle)}.json`);

  return {
    read(handle) {
      try {
        return PlaceSchema.parse(JSON.parse(fs.readFileSync(file(handle), 'utf8')));
      } catch {
        return undefined;
      }
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
