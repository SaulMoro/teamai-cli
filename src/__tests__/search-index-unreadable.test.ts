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
 * Only files the build was given and could not read keep the previous index
 * (#1006).
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

  it('keeps the previous index when it can read none of the files it was given', async () => {
    const dirs = await writeSkills(7);
    await buildIndex({ skills: { kind: 'dirs', dirs }, indexPath });
    for (const dir of dirs) await fse.remove(path.join(dir, 'SKILL.md'));

    await buildIndex({ skills: { kind: 'dirs', dirs }, indexPath });

    expect((await loadIndex(indexPath))?.entries).toHaveLength(7);
    expect(warnings()).toEqual([
      expect.stringMatching(/^Search index not rebuilt: none of the 7 files it indexes could be read \(.*zqx-skill-1[\\/]SKILL\.md: ENOENT, .*, and 4 more\)\. Recall keeps the previous index/),
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
      `Search index left out 1 file(s) it could not read (${path.join(docsDir, 'gone.md')}: ENOENT). Fix them and run \`teamai pull\` to index them.`,
    ]);
  });
});
