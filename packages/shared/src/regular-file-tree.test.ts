import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyRegularTree, moveRegularTree } from './regular-file.js';

// The copy and move cases that hold on every platform, Windows included (WINDOWS_TESTS): no link, mode or FIFO. Those
// are in regular-file.test.ts.

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-regular-tree-'));
  dirs.push(dir);

  return dir;
}

/** Whether the scratch filesystem finds a name spelled in another case, as macOS and Windows do by default. */
function ignoresCase(): boolean {
  const dir = scratch();
  fs.mkdirSync(path.join(dir, 'Case'));

  return fs.existsSync(path.join(dir, 'case'));
}

describe('copying a folder on any platform', () => {
  it('copies a folder with nested folders and each file\'s bytes, over what the destination held, and leaves out what the filter refuses', async () => {
    const dir = scratch();
    const from = path.join(dir, 'skill');
    const to = path.join(dir, 'out', 'skill');
    fs.mkdirSync(path.join(from, 'scripts', 'cache'), { recursive: true });
    fs.mkdirSync(path.join(from, 'references', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(from, 'SKILL.md'), '# skill\n');
    fs.writeFileSync(path.join(from, 'scripts', 'run.ps1'), 'Write-Output hi\n');
    fs.writeFileSync(path.join(from, 'references', 'deep', 'notes.md'), 'notes\n');
    fs.writeFileSync(path.join(from, 'scripts', 'cache', 'big.bin'), 'x');
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, 'SKILL.md'), 'old and longer\n');

    await copyRegularTree(from, to, { filter: (source) => path.basename(source) !== 'cache' });

    expect(fs.readFileSync(path.join(to, 'SKILL.md'), 'utf8')).toBe('# skill\n');
    expect(fs.readFileSync(path.join(to, 'scripts', 'run.ps1'), 'utf8')).toBe('Write-Output hi\n');
    expect(fs.readFileSync(path.join(to, 'references', 'deep', 'notes.md'), 'utf8')).toBe('notes\n');
    expect(fs.existsSync(path.join(to, 'scripts', 'cache'))).toBe(false);
  });

  it('copies a single file into a folder it creates', async () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'a.md'), 'a\n');

    await copyRegularTree(path.join(dir, 'a.md'), path.join(dir, 'x', 'y', 'a.md'));

    expect(fs.readFileSync(path.join(dir, 'x', 'y', 'a.md'), 'utf8')).toBe('a\n');
  });

  it('fails on a file already at the destination, or keeps it, when asked to, and leaves it as it was', async () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'a.md'), 'new\n');
    fs.writeFileSync(path.join(dir, 'b.md'), 'kept\n');

    await expect(copyRegularTree(path.join(dir, 'a.md'), path.join(dir, 'b.md'), { existing: 'fail' })).rejects.toMatchObject({ code: 'EEXIST' });
    await copyRegularTree(path.join(dir, 'a.md'), path.join(dir, 'b.md'), { existing: 'keep' });
    expect(fs.readFileSync(path.join(dir, 'b.md'), 'utf8')).toBe('kept\n');
  });

  it.runIf(ignoresCase())('refuses to copy a folder onto itself or into itself spelled in another case, where the filesystem ignores case, and keeps the source', async () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, 'Docs'));
    fs.writeFileSync(path.join(dir, 'Docs', 'a.md'), 'a\n');

    await expect(copyRegularTree(path.join(dir, 'Docs'), path.join(dir, 'docs'))).rejects.toThrow('inside');
    await expect(copyRegularTree(path.join(dir, 'Docs', 'a.md'), path.join(dir, 'docs', 'A.md'))).rejects.toThrow('inside');
    await expect(copyRegularTree(path.join(dir, 'Docs'), path.join(dir, 'docs', 'sub'))).rejects.toThrow('inside');
    expect(fs.readdirSync(path.join(dir, 'Docs'))).toEqual(['a.md']);
    expect(fs.readFileSync(path.join(dir, 'Docs', 'a.md'), 'utf8')).toBe('a\n');
  });
});

describe('moving a folder teamai staged, on any platform', () => {
  it('renames a folder into a parent it creates, and fails on one already at the destination, leaving both as they were', async () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, 'queue'));
    fs.writeFileSync(path.join(dir, 'queue', 'a.md'), 'a\n');
    fs.mkdirSync(path.join(dir, 'taken'));

    await moveRegularTree(path.join(dir, 'queue'), path.join(dir, 'aside', 'queue'));

    expect(fs.existsSync(path.join(dir, 'queue'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'aside', 'queue', 'a.md'), 'utf8')).toBe('a\n');
    await expect(moveRegularTree(path.join(dir, 'aside', 'queue'), path.join(dir, 'taken'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readdirSync(path.join(dir, 'taken'))).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'aside', 'queue', 'a.md'), 'utf8')).toBe('a\n');
  });

  it('copies through the regular-file copy across filesystems, then removes the source', async () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, 'queue'));
    fs.writeFileSync(path.join(dir, 'queue', 'a.md'), 'a\n');
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }));

    await moveRegularTree(path.join(dir, 'queue'), path.join(dir, 'aside'));

    expect(fs.existsSync(path.join(dir, 'queue'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'aside', 'a.md'), 'utf8')).toBe('a\n');
  });

  it('retries a rename Windows refuses for a moment, as while a scanner holds a file, instead of failing at once', async () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, 'queue'));
    fs.writeFileSync(path.join(dir, 'queue', 'a.md'), 'a\n');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }));

    await moveRegularTree(path.join(dir, 'queue'), path.join(dir, 'aside'));

    expect(fs.readFileSync(path.join(dir, 'aside', 'a.md'), 'utf8')).toBe('a\n');
  });
});
