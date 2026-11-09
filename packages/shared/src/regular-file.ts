import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

// ─── Reading a file that someone else may have replaced ───
//
//  A step writes where teamai later reads: its result file, its evidence, its copy, its tool home and transcripts. A
//  FIFO planted at such a path blocks a plain read's open until a writer comes, past any deadline, and holds one of
//  libuv's few workers meanwhile (a synchronous read stalls the whole process). So the file is opened without blocking,
//  and the handle's own type is checked before a byte is read: no other process can swap the path between the check
//  and the read, as it can between a stat of the path and an open of it.
//

/** Opening for reading without waiting: a FIFO opens at once. Windows has no flag, and no FIFO a path opens. */
const NONBLOCKING_READ = process.platform === 'win32' ? fs.constants.O_RDONLY : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;

/** What stands at a path in place of a regular file, as an error names it. */
export type NotRegularFileKind = 'a pipe' | 'a directory' | 'a device' | 'a socket' | 'a special file';

function kindOf(stats: fs.Stats): NotRegularFileKind {
  if (stats.isFIFO()) return 'a pipe';

  if (stats.isDirectory()) return 'a directory';

  if (stats.isCharacterDevice() || stats.isBlockDevice()) return 'a device';

  if (stats.isSocket()) return 'a socket';

  return 'a special file';
}

/** A path that holds something other than a regular file, which is never read. */
export class NotRegularFileError extends Error {
  override name = 'NotRegularFileError';
  /** What is there instead, such as `a pipe`. */
  readonly kind: NotRegularFileKind;

  constructor(readonly file: string, stats: fs.Stats) {
    const kind = kindOf(stats);
    super(`${file} is ${kind}, not a regular file, so teamai does not read it`);
    this.kind = kind;
  }
}

/** The open handle of `file`, a regular file; a missing file rejects with its own error, anything else with `NotRegularFileError`. */
export async function openRegularFile(file: string): Promise<FileHandle> {
  const handle = await fs.promises.open(file, NONBLOCKING_READ);

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) throw new NotRegularFileError(file, stats);

    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** The contents of `file`, which must be a regular file, as `openRegularFile` checks. */
export async function readRegularFile(file: string): Promise<Buffer>;
export async function readRegularFile(file: string, encoding: BufferEncoding): Promise<string>;
export async function readRegularFile(file: string, encoding?: BufferEncoding): Promise<string | Buffer> {
  const handle = await openRegularFile(file);

  try {
    return encoding === undefined ? await handle.readFile() : await handle.readFile({ encoding });
  } finally {
    await handle.close();
  }
}

/**
 * The descriptor of `file`, a regular file, for a synchronous contract that cannot wait: the same check as
 * `openRegularFile`. Reading a regular file ends at its end, so only the open could block, and it does not here.
 */
export function openRegularFileSync(file: string): number {
  const fd = fs.openSync(file, NONBLOCKING_READ);

  try {
    const stats = fs.fstatSync(fd);

    if (!stats.isFile()) throw new NotRegularFileError(file, stats);

    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/** `readRegularFile` for a synchronous contract, through `openRegularFileSync`. */
export function readRegularFileSync(file: string): Buffer;
export function readRegularFileSync(file: string, encoding: BufferEncoding): string;
export function readRegularFileSync(file: string, encoding?: BufferEncoding): string | Buffer {
  const fd = openRegularFileSync(file);

  try {
    return encoding === undefined ? fs.readFileSync(fd) : fs.readFileSync(fd, encoding);
  } finally {
    fs.closeSync(fd);
  }
}
