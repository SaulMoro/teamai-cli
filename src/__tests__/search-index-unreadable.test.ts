import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import { log } from '../utils/logger.js';
import { buildIndex, loadIndex } from '../utils/search-index.js';

/**
 * The index follows what the member receives, however much smaller that is.
 * Only files the build was given and could not read keep their previous
 * entries (#1006).
 */
describe('buildIndex when the indexed set shrinks (#1006)', () => {
  let tmpDir: string;
  let indexPath: string;
  const warnings = (): string[] => vi.mocked(log.warn).mock.calls.map(([message]) => String(message));

  const writeSkills = async (count: number): Promise<string[]> => {
    const dirs: string[] = [];
    for (let i = 1; i <= count; i++) {
      const dir = path.join(tmpDir, 'skills', 'ns', `zqx-skill-${i}`);
      await fse.outputFile(path.join(dir, 'SKILL.md'), `---\nname: zqx-skill-${i}\ndescription: zqx skill ${i}\n---\nbody`);
      dirs.push(dir);
    }
    return dirs;
  };

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-index-unreadable-'));
    indexPath = path.join(tmpDir, 'search-index.json');
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('writes an empty index when the member no longer receives anything', async () => {
    await buildIndex({ skills: { kind: 'dirs', dirs: await writeSkills(7) }, indexPath });
    expect((await loadIndex(indexPath))?.entries).toHaveLength(7);

    await buildIndex({ skills: { kind: 'dirs', dirs: [] }, indexPath });

    expect((await loadIndex(indexPath))?.entries).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it('keeps the previous entries of the files it was given and could not read', async () => {
    const dirs = await writeSkills(7);
    await buildIndex({ skills: { kind: 'dirs', dirs }, indexPath });
    for (const dir of dirs) await fse.remove(path.join(dir, 'SKILL.md'));

    await buildIndex({ skills: { kind: 'dirs', dirs }, indexPath });

    expect((await loadIndex(indexPath))?.entries).toHaveLength(7);
    expect(warnings()).toEqual([
      expect.stringMatching(/^Search index could not read 7 file\(s\) \(.*zqx-skill-1[\\/]SKILL\.md: ENOENT, .*, and 4 more\); recall keeps what the previous index held for them\./),
    ]);
  });

  it('writes what it could read and names the files it could not', async () => {
    const docsDir = path.join(tmpDir, 'docs');
    await fse.outputFile(path.join(docsDir, 'a.md'), '---\ntitle: a\n---\nbody');
    await fse.outputFile(path.join(docsDir, 'b.md'), '---\ntitle: b\n---\nbody');
    await buildIndex({ skills: { kind: 'dirs', dirs: await writeSkills(7) }, indexPath });

    await buildIndex({ docsDir, docFiles: ['a.md', 'b.md', 'gone.md'], indexPath });

    expect((await loadIndex(indexPath))?.entries.map((entry) => entry.filename).sort()).toEqual(['a.md', 'b.md']);
    expect(warnings()).toEqual([
      `Search index could not read 1 file(s) (${path.join(docsDir, 'gone.md')}: ENOENT); recall keeps what the previous index held for them. `
        + 'Fix them and run `teamai pull` to index them again.',
    ]);
  });

  // Every combination of what a rebuild can be handed. The result is what it
  // read, the skills keep-indexed retains, and the previous entries of the files
  // it was given and could not read; nothing else of the previous index stays.
  // The previous index holds docs A (`a.md`) and B (`b.md`) and one skill; the
  // rebuild is given A, unreadable or not, and never B.
  const cases = [false, true].flatMap((keepIndexed) => [0, 1].flatMap((readable) =>
    [false, true].flatMap((unreadable) => [false, true].map((existing) => ({
      name: `keep-indexed=${keepIndexed} readable=${readable} a-unreadable=${unreadable} index=${existing}`
        + (!keepIndexed && readable === 0 && unreadable && existing ? ' (A unreadable, B no longer delivered)' : ''),
      keepIndexed, readable, unreadable, existing,
    })))));

  it.each(cases.map((row) => [row.name, row] as const))(
    '%s',
    async (_name, { keepIndexed, readable, unreadable, existing }) => {
      const docsDir = path.join(tmpDir, 'docs');
      if (existing) {
        await fse.outputFile(path.join(docsDir, 'a.md'), '---\ntitle: a\n---\nbody');
        await fse.outputFile(path.join(docsDir, 'b.md'), '---\ntitle: b\n---\nbody');
        await buildIndex({ docsDir, docFiles: ['a.md', 'b.md'], skills: { kind: 'dirs', dirs: await writeSkills(1) }, indexPath });
        await fse.remove(path.join(docsDir, 'b.md'));
      }
      if (unreadable) await fse.remove(path.join(docsDir, 'a.md'));
      else await fse.outputFile(path.join(docsDir, 'a.md'), '---\ntitle: a\n---\nbody');
      const docFiles = ['a.md'];
      for (let i = 0; i < readable; i++) {
        await fse.outputFile(path.join(docsDir, `read-${i}.md`), `---\ntitle: read ${i}\n---\nbody`);
        docFiles.push(`read-${i}.md`);
      }

      await buildIndex({
        docsDir,
        docFiles,
        skills: keepIndexed ? { kind: 'keep-indexed', reason: 'test' } : { kind: 'dirs', dirs: [] },
        indexPath,
      });

      const entries = (await loadIndex(indexPath))?.entries.map((entry) => `${entry.type}:${entry.filename}`).sort();
      const read = docFiles.filter((file) => file !== 'a.md' || !unreadable).map((file) => `docs:${file}`);
      const retainedSkills = keepIndexed && existing ? ['skills:zqx-skill-1.md'] : [];
      const unreadableKept = unreadable && existing ? ['docs:a.md'] : [];
      expect(entries).toEqual([...read, ...retainedSkills, ...unreadableKept].sort());
      expect(warnings()).toEqual(unreadable
        ? [expect.stringMatching(/^Search index could not read 1 file\(s\) \(.*a\.md: ENOENT\); recall keeps what the previous index held for them\./)]
        : []);
    },
  );
});
