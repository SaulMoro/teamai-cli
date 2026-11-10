import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendRegularFile, NotRegularFileError, openRegularFile, openRegularFileForWrite, readRegularFile, readRegularFileSync, writeRegularFile } from './regular-file.js';

const dirs: string[] = [];
const readers: ChildProcess[] = [];

afterEach(() => {
  for (const reader of readers.splice(0)) reader.kill();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-regular-file-'));
  dirs.push(dir);

  return dir;
}

/** A FIFO in a scratch folder: a step can leave one where teamai later reads a file it wrote. */
function fifo(): string {
  const at = path.join(scratch(), 'result.json');
  execFileSync('mkfifo', [at]);

  return at;
}

/**
 * What `read` settles to within two seconds, or `still waiting`. A read a FIFO still holds is let go by opening the FIFO
 * for writing and closing it, so a failing test leaves no stuck read behind.
 */
async function settledSoon<TValue>(at: string, read: () => Promise<TValue>): Promise<TValue | 'still waiting' | { rejected: unknown }> {
  const late = new Promise<'still waiting'>((resolve) => { setTimeout(() => resolve('still waiting'), 2_000).unref(); });
  const settled = await Promise.race([read().catch((error: unknown) => ({ rejected: error })), late]);

  if (settled === 'still waiting') fs.closeSync(fs.openSync(at, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));

  return settled;
}

describe.skipIf(process.platform === 'win32')('reading a file a step may have replaced', () => {
  it('reads a regular file as text or as bytes', async () => {
    const at = path.join(scratch(), 'result.json');
    fs.writeFileSync(at, '{"output":"é"}');

    expect(await readRegularFile(at, 'utf8')).toBe('{"output":"é"}');
    expect((await readRegularFile(at)).equals(Buffer.from('{"output":"é"}'))).toBe(true);
    expect(readRegularFileSync(at, 'utf8')).toBe('{"output":"é"}');
  });

  it('refuses a FIFO at once, saying what is there, instead of waiting for a writer', async () => {
    const at = fifo();

    const settled = await settledSoon(at, () => readRegularFile(at, 'utf8'));

    expect(settled).toEqual({ rejected: expect.objectContaining({ name: 'NotRegularFileError', message: expect.stringContaining(`${at} is a pipe, not a regular file`) }) });
  });

  it('refuses a FIFO opened as a handle, as a streaming read opens it', async () => {
    const at = fifo();

    expect(await settledSoon(at, () => openRegularFile(at))).toEqual({ rejected: expect.any(NotRegularFileError) });
  });

  it('refuses a FIFO in a synchronous read too, which would otherwise stall the whole process', () => {
    const at = fifo();

    expect(() => readRegularFileSync(at, 'utf8')).toThrow(NotRegularFileError);
  });

  it('refuses a directory and a device, and passes a missing file\'s own error on', async () => {
    const dir = scratch();

    await expect(readRegularFile(dir, 'utf8')).rejects.toThrow(`${dir} is a directory, not a regular file`);
    await expect(readRegularFile('/dev/zero')).rejects.toThrow('/dev/zero is a device, not a regular file');
    await expect(readRegularFile(path.join(dir, 'missing.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe.skipIf(process.platform === 'win32')('writing to a file a step may have replaced', () => {
  it('appends to a regular file, and creates a missing one', async () => {
    const file = path.join(scratch(), 'outcomes.jsonl');

    await appendRegularFile(file, 'one\n');
    await appendRegularFile(file, 'two\n');

    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\n');
  });

  it('empties a regular file opened to replace it', async () => {
    const file = path.join(scratch(), 'exclude');
    fs.writeFileSync(file, 'old and longer\n');
    const handle = await openRegularFileForWrite(file, { append: false });

    try {
      await handle.writeFile('new\n');
    } finally {
      await handle.close();
    }

    expect(fs.readFileSync(file, 'utf8')).toBe('new\n');
  });

  it('writes a whole file in place of what it held, creating a missing one with the mode it is given', async () => {
    const dir = scratch();
    const kept = path.join(dir, 'conflicts.json');
    fs.writeFileSync(kept, 'old and longer\n');
    const created = path.join(dir, 'credentials.json');

    await writeRegularFile(kept, '{}\n');
    await writeRegularFile(created, Buffer.from('secret'), { mode: 0o600 });

    expect(fs.readFileSync(kept, 'utf8')).toBe('{}\n');
    expect(fs.readFileSync(created, 'utf8')).toBe('secret');
    expect(fs.statSync(created).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO no one reads at once in a whole-file write too, as a plain write would wait for a reader', async () => {
    const at = fifo();

    expect(await settledSoon(at, () => writeRegularFile(at, '{}'))).toMatchObject({ rejected: { kind: 'a pipe' } });
  });

  it('refuses a FIFO no one reads at once, saying what is there, instead of waiting for a reader', async () => {
    const at = fifo();

    const settled = await settledSoon(at, () => appendRegularFile(at, 'line\n'));

    expect(settled).toEqual({ rejected: expect.any(NotRegularFileError) });
    expect(settled).toMatchObject({ rejected: { kind: 'a pipe', message: `${at} is a pipe, not a regular file, so teamai does not write it` } });
  });

  it('refuses a FIFO another process holds open for reading, which a plain open would write into', async () => {
    const at = fifo();
    readers.push(spawn('sh', ['-c', 'exec 3<>"$1"; sleep 10', 'sh', at], { stdio: 'ignore' }));
    await new Promise((resolve) => { setTimeout(resolve, 200); });

    await expect(openRegularFileForWrite(at, { append: true })).rejects.toMatchObject({ kind: 'a pipe' });
  });
});
