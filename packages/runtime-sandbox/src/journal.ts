import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { OpIdSchema, OpStateSchema, type OpId } from '@teamai/runtime-protocol';

// ─── The journal ─────────────────────────────────────────
//
//  What this runtime keeps across its own restarts, in a directory on the host:
//
//    places/<handle>.json   the attempt a handle opened and its sandbox id
//    places/<handle>/<op>   one empty file per op of the handle, so a handle's ops are found without reading another's
//    ops/<op>.json          an exec or a judge's prompt: its handle, the runtime process running it, and once it ended, its outcome
//    ops/<op>.cancel        teamai cancelled it, written before the sandbox is stopped
//
//  A runtime outlives its stdin while an exec runs, so an exec that ends while teamai is down still records its
//  outcome; a runtime started again answers a repeated id and a reattach from these files. Each is written to
//  `<record>.<pid>.tmp` and renamed into place. `close` removes a handle's files, a write a crash left unrenamed included.
//

const [, exited, finished, cancelled, failed] = OpStateSchema.options;

/** How an exec or a judge's prompt ended, as this runtime retains it until `close`: its end state, without its op. */
const OutcomeSchema = z.discriminatedUnion('state', [exited.omit({ op: true }), finished.omit({ op: true }), cancelled.omit({ op: true }), failed.omit({ op: true })]);

export type Outcome = z.infer<typeof OutcomeSchema>;

const ExecRecordSchema = z.object({ handle: z.string(), runner: z.number().int(), outcome: OutcomeSchema.optional() });

/** An exec: its handle, the pid of the runtime process running it, and its outcome once it ended. */
export type ExecRecord = z.infer<typeof ExecRecordSchema>;

const PlaceRecordSchema = z.object({
  run: z.string(),
  attempt: z.string(),
  /** The sandbox id, once created. A place is recorded before its sandbox, so a runtime that dies between finds it by its labels. */
  id: z.string().optional(),
  /** A judge's place, opened with no view: its sandbox is made when its prompt names the directory. */
  confined: z.literal(true).optional(),
});

export type PlaceRecord = z.infer<typeof PlaceRecordSchema>;

/**
 * A journal's id: the first 16 hex digits of a hash of its directory. It labels every container the journal owns and
 * starts the name of every sbx sandbox, so a provider takes it only from `journal().owner`, never any other string.
 */
const JournalIdSchema = z.string().regex(/^[0-9a-f]{16}$/).brand<'JournalId'>();

export type JournalId = z.infer<typeof JournalIdSchema>;

/**
 * A record, or undefined when there is none. A record that cannot be read or parsed is an error naming the file, never
 * taken as absent.
 */
function read<T>(file: string, schema: z.ZodType<T>): T | undefined {
  try {
    return schema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error(`Its record ${file} cannot be read (${error instanceof Error ? error.message : String(error)}), so the attempt's sandbox is kept until it can. Repair that file, then try again.`, { cause: error });
  }
}

function write(file: string, value: PlaceRecord | ExecRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function journal(root: string) {
  const placeFile = (handle: string): string => path.join(root, 'places', `${encodeURIComponent(handle)}.json`);
  const indexDir = (handle: string): string => path.join(root, 'places', encodeURIComponent(handle));
  const opFile = (op: string): string => path.join(root, 'ops', `${op}.json`);
  const cancelFile = (op: string): string => path.join(root, 'ops', `${op}.cancel`);

  /** The ops the handle's index names: only their records are read, so another attempt's damaged one never blocks it. */
  const indexed = (handle: string): OpId[] => {
    const dir = indexDir(handle);

    return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).sort().flatMap((name) => {
      const op = OpIdSchema.safeParse(name);

      return op.success ? [op.data] : [];
    });
  };

  /** The handle's ops with their records; a record of the handle that cannot be read fails, never taken as absent. */
  const opsOf = (handle: string): Array<{ op: OpId; record: ExecRecord }> => indexed(handle).flatMap((op) => {
    const record = read(opFile(op), ExecRecordSchema);

    return record?.handle === handle ? [{ op, record }] : [];
  });

  /** Removes `files`, and each one's `<file>.<pid>.tmp` a crash left before its rename. */
  const remove = (files: string[]): void => {
    for (const dir of new Set(files.map((file) => path.dirname(file)))) {
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const file = path.join(dir, name);

        if (files.includes(file.replace(/\.\d+\.tmp$/, ''))) fs.rmSync(file, { force: true });
      }
    }
  };

  return {
    /**
     * This journal's id, which labels every container it owns: stable across restarts, and another for another
     * directory, so two members or two homes on one engine never take each other's containers for their own.
     */
    owner: JournalIdSchema.parse(crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16)),
    place: (handle: string): PlaceRecord | undefined => read(placeFile(handle), PlaceRecordSchema),
    savePlace: (handle: string, place: PlaceRecord): void => write(placeFile(handle), place),
    exec: (op: OpId): ExecRecord | undefined => read(opFile(op), ExecRecordSchema),
    saveExec: (op: OpId, record: ExecRecord): void => {
      // Indexed before it is written, so no record of the handle is ever left out of its index.
      fs.mkdirSync(indexDir(record.handle), { recursive: true });
      fs.writeFileSync(path.join(indexDir(record.handle), op), '');
      write(opFile(op), record);
    },
    opsOf,
    cancel: (op: OpId): void => {
      fs.mkdirSync(path.dirname(cancelFile(op)), { recursive: true });
      fs.writeFileSync(cancelFile(op), '');
    },
    isCancelled: (op: OpId): boolean => fs.existsSync(cancelFile(op)),
    /** Removes everything kept for `handle`, its place last, so a close a crash interrupted is made again. */
    forget(handle: string): void {
      remove(indexed(handle).flatMap((op) => [opFile(op), cancelFile(op)]));
      fs.rmSync(indexDir(handle), { recursive: true, force: true });
      remove([placeFile(handle)]);
    },
  };
}

export type Journal = ReturnType<typeof journal>;
