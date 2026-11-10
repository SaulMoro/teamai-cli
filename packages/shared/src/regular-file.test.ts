import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendRegularFile, copyRegularFile, copyRegularTree, NotRegularFileError, openRegularFile, openRegularFileForWrite, readRegularFile, readRegularFileSync, writeRegularFile } from './regular-file.js';

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

  it('copies a regular file over another with its bytes and its mode, as a plain copy does, and refuses a FIFO to copy', async () => {
    const dir = scratch();
    const from = path.join(dir, 'hook.sh');
    const to = path.join(dir, 'copy.sh');
    fs.writeFileSync(from, Buffer.from([0x89, 0x50, 0x0a]), { mode: 0o755 });
    fs.writeFileSync(to, 'old and longer\n', { mode: 0o600 });
    const at = fifo();

    await copyRegularFile(from, to);

    expect(fs.readFileSync(to).equals(Buffer.from([0x89, 0x50, 0x0a]))).toBe(true);
    expect(fs.statSync(to).mode & 0o777).toBe(0o755);
    expect(await settledSoon(at, () => copyRegularFile(at, to))).toMatchObject({ rejected: { kind: 'a pipe' } });
  });

  it('refuses a FIFO another process holds open for reading, which a plain open would write into', async () => {
    const at = fifo();
    readers.push(spawn('sh', ['-c', 'exec 3<>"$1"; sleep 10', 'sh', at], { stdio: 'ignore' }));
    await new Promise((resolve) => { setTimeout(resolve, 200); });

    await expect(openRegularFileForWrite(at, { append: true })).rejects.toMatchObject({ kind: 'a pipe' });
  });
});

describe.skipIf(process.platform === 'win32')('copying a folder a step may have planted something in', () => {
  it('copies a folder with each file\'s bytes and mode, keeps links as links, and leaves out what the filter refuses', async () => {
    const dir = scratch();
    const from = path.join(dir, 'skill');
    const to = path.join(dir, 'out', 'skill');
    fs.mkdirSync(path.join(from, 'scripts', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(from, 'SKILL.md'), '# skill\n');
    fs.writeFileSync(path.join(from, 'scripts', 'run.sh'), 'echo hi\n', { mode: 0o755 });
    fs.writeFileSync(path.join(from, 'scripts', 'cache', 'big.bin'), 'x');
    fs.symlinkSync('SKILL.md', path.join(from, 'README.md'));
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, 'SKILL.md'), 'old and longer\n');
    fs.writeFileSync(path.join(dir, 'outside.md'), 'outside\n');
    fs.symlinkSync(path.join(dir, 'outside.md'), path.join(to, 'README.md'));

    await copyRegularTree(from, to, { filter: (source) => path.basename(source) !== 'cache' });

    expect(fs.readFileSync(path.join(to, 'SKILL.md'), 'utf8')).toBe('# skill\n');
    expect(fs.statSync(path.join(to, 'scripts', 'run.sh')).mode & 0o777).toBe(0o755);
    expect(fs.readlinkSync(path.join(to, 'README.md'))).toBe('SKILL.md');
    expect(fs.readFileSync(path.join(dir, 'outside.md'), 'utf8')).toBe('outside\n');
    expect(fs.existsSync(path.join(to, 'scripts', 'cache'))).toBe(false);
  });

  it('copies a single file into a folder it creates', async () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'a.md'), 'a\n');

    await copyRegularTree(path.join(dir, 'a.md'), path.join(dir, 'x', 'y', 'a.md'));

    expect(fs.readFileSync(path.join(dir, 'x', 'y', 'a.md'), 'utf8')).toBe('a\n');
  });

  it('refuses a FIFO inside the folder at once, instead of copying it or waiting on it', async () => {
    const dir = scratch();
    const from = path.join(dir, 'skill');
    fs.mkdirSync(from);
    fs.writeFileSync(path.join(from, 'SKILL.md'), '# skill\n');
    const at = path.join(from, 'notes.md');
    execFileSync('mkfifo', [at]);

    const settled = await settledSoon(at, () => copyRegularTree(from, path.join(dir, 'out')));

    expect(settled).toEqual({ rejected: expect.any(NotRegularFileError) });
    expect(settled).toMatchObject({ rejected: { kind: 'a pipe', message: `${at} is a pipe, not a regular file, so teamai does not read it` } });
  });

  it('refuses a device, which a plain copy reads as a file', async () => {
    const dir = scratch();

    await expect(copyRegularTree('/dev/null', path.join(dir, 'null'))).rejects.toMatchObject({ kind: 'a device' });
    expect(fs.existsSync(path.join(dir, 'null'))).toBe(false);
  });

  it('fails on a file already at the destination, or keeps it, when asked to, and leaves it as it was', async () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'a.md'), 'new\n');
    fs.writeFileSync(path.join(dir, 'b.md'), 'kept\n');

    await expect(copyRegularTree(path.join(dir, 'a.md'), path.join(dir, 'b.md'), { existing: 'fail' })).rejects.toMatchObject({ code: 'EEXIST' });
    await copyRegularTree(path.join(dir, 'a.md'), path.join(dir, 'b.md'), { existing: 'keep' });
    expect(fs.readFileSync(path.join(dir, 'b.md'), 'utf8')).toBe('kept\n');
  });
});
