import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { OpIdSchema, OpStateSchema, type OpId } from '@teamai/runtime-protocol';

// ─── The journal ─────────────────────────────────────────
//
//  What this runtime keeps across its own restarts, in a directory on the host:
//
//    places/<handle>.json   the attempt a handle opened and its sandbox id
//    ops/<op>.json          an exec: its handle, the runtime process running it, and once it ended, its outcome
//    ops/<op>.cancel        teamai cancelled it, written before the sandbox is stopped
//
//  A runtime outlives its stdin while an exec runs, so an exec that ends while teamai is down still records its
//  outcome; a runtime started again answers a repeated id and a reattach from these files. Each is written to a
//  temporary path and renamed into place. `close` removes a handle's files.
//

const [, exited, , cancelled, failed] = OpStateSchema.options;

/** How an exec ended, as this runtime retains it until `close`: an exec's end state, without its op. */
const OutcomeSchema = z.discriminatedUnion('state', [exited.omit({ op: true }), cancelled.omit({ op: true }), failed.omit({ op: true })]);

export type Outcome = z.infer<typeof OutcomeSchema>;

const ExecRecordSchema = z.object({ handle: z.string(), runner: z.number().int(), outcome: OutcomeSchema.optional() });

/** An exec: its handle, the pid of the runtime process running it, and its outcome once it ended. */
export type ExecRecord = z.infer<typeof ExecRecordSchema>;

const PlaceRecordSchema = z.object({
  run: z.string(),
  attempt: z.string(),
  /** The sandbox id, once created. A place is recorded before its sandbox, so a runtime that dies between finds it by its labels. */
  id: z.string().optional(),
});

export type PlaceRecord = z.infer<typeof PlaceRecordSchema>;

/** A record, or undefined when there is none. A record that cannot be read or parsed is an error, never taken as absent. */
function read<T>(file: string, schema: z.ZodType<T>): T | undefined {
  let text: string;

  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }

  return schema.parse(JSON.parse(text));
}

function write(file: string, value: PlaceRecord | ExecRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function journal(root: string) {
  const placeFile = (handle: string): string => path.join(root, 'places', `${encodeURIComponent(handle)}.json`);
  const opFile = (op: string): string => path.join(root, 'ops', `${op}.json`);
  const cancelFile = (op: string): string => path.join(root, 'ops', `${op}.cancel`);

  const opsOf = (handle: string): Array<{ op: OpId; record: ExecRecord }> => {
    const dir = path.join(root, 'ops');
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];

    return names.sort().flatMap((name) => {
      const op = OpIdSchema.safeParse(name.replace(/\.json$/, ''));
      const record = name.endsWith('.json') && op.success ? read(path.join(dir, name), ExecRecordSchema) : undefined;

      return op.success && record?.handle === handle ? [{ op: op.data, record }] : [];
    });
  };

  return {
    place: (handle: string): PlaceRecord | undefined => read(placeFile(handle), PlaceRecordSchema),
    savePlace: (handle: string, place: PlaceRecord): void => write(placeFile(handle), place),
    exec: (op: OpId): ExecRecord | undefined => read(opFile(op), ExecRecordSchema),
    saveExec: (op: OpId, record: ExecRecord): void => write(opFile(op), record),
    opsOf,
    cancel: (op: OpId): void => {
      fs.mkdirSync(path.dirname(cancelFile(op)), { recursive: true });
      fs.writeFileSync(cancelFile(op), '');
    },
    isCancelled: (op: OpId): boolean => fs.existsSync(cancelFile(op)),
    /** Removes everything kept for `handle`. */
    forget(handle: string): void {
      for (const { op } of opsOf(handle)) {
        fs.rmSync(opFile(op), { force: true });
        fs.rmSync(cancelFile(op), { force: true });
      }

      fs.rmSync(placeFile(handle), { force: true });
    },
  };
}

export type Journal = ReturnType<typeof journal>;
