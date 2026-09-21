import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SKILL_DIR_PLACEHOLDER,
  listServableSkills,
  packagedSkillRoots,
  renderSkill,
  resolvePackagedSkill,
  skillCatalog,
  skillGet,
  skillPath,
} from '../skill-content.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Build a throwaway package layout: <tmp>/skills and <tmp>/skill-data. */
function makeRoots(): { tmp: string; deployRoot: string; dataRoot: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-content-'));
  return {
    tmp,
    deployRoot: path.join(tmp, 'skills'),
    dataRoot: path.join(tmp, 'skill-data'),
  };
}

function writeSkill(root: string, name: string, body: string, files: Record<string, string> = {}): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

describe('packaged skill discovery', () => {
  let roots: ReturnType<typeof makeRoots>;

  beforeEach(() => {
    roots = makeRoots();
  });

  afterEach(() => {
    fs.rmSync(roots.tmp, { recursive: true, force: true });
  });

  it('serves skill-data/ when it exists', async () => {
    writeSkill(roots.deployRoot, 'teamai', '# stub\n');
    writeSkill(roots.dataRoot, 'core', '# core\n');
    writeSkill(roots.dataRoot, 'wiki', '# wiki\n');

    const servable = await listServableSkills(roots);
    expect(servable.map((s) => s.name)).toEqual(['core', 'wiki']);
    expect(servable.every((s) => s.deployed)).toBe(false);
  });

  it('falls back to skills/ before the content moves', async () => {
    writeSkill(roots.deployRoot, 'teamai', '# hub\n');

    const servable = await listServableSkills(roots);
    expect(servable.map((s) => s.name)).toEqual(['teamai']);
    expect(servable[0].deployed).toBe(true);
  });

  it('keeps the deployed stub reachable by its exact name', async () => {
    writeSkill(roots.deployRoot, 'teamai', '# stub\n');
    writeSkill(roots.dataRoot, 'core', '# core\n');

    const stub = await resolvePackagedSkill('teamai', roots);
    expect(stub?.dir).toBe(path.join(roots.deployRoot, 'teamai'));
    expect(stub?.deployed).toBe(true);
  });

  it('resolves legacy directory names as aliases', async () => {
    writeSkill(roots.dataRoot, 'team-wiki-codebase', '# wiki\n');
    writeSkill(roots.dataRoot, 'teamai-share-learnings', '# share\n');

    for (const alias of ['wiki', 'codebase']) {
      expect((await resolvePackagedSkill(alias, roots))?.name).toBe('team-wiki-codebase');
    }
    for (const alias of ['share', 'learning', 'learnings']) {
      expect((await resolvePackagedSkill(alias, roots))?.name).toBe('teamai-share-learnings');
    }
    expect(await resolvePackagedSkill('nope', roots)).toBeNull();
  });

  it('ignores directories without SKILL.md and dotfiles', async () => {
    fs.mkdirSync(path.join(roots.dataRoot, 'empty'), { recursive: true });
    fs.mkdirSync(path.join(roots.dataRoot, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(roots.dataRoot, '.hidden', 'SKILL.md'), '# no\n');
    writeSkill(roots.dataRoot, 'core', '# core\n');

    expect((await listServableSkills(roots)).map((s) => s.name)).toEqual(['core']);
  });
});

describe('renderSkill', () => {
  let roots: ReturnType<typeof makeRoots>;

  beforeEach(() => {
    roots = makeRoots();
  });

  afterEach(() => {
    fs.rmSync(roots.tmp, { recursive: true, force: true });
  });

  it('prints SKILL.md unchanged, frontmatter included', async () => {
    const body = '---\nname: core\ndescription: d\n---\n\n# core\n\nbody text\n';
    writeSkill(roots.dataRoot, 'core', body);

    const skill = await resolvePackagedSkill('core', roots);
    expect(await renderSkill(skill!)).toBe(body);
  });

  it('appends references/ then templates/, recursively, sorted by relative path', async () => {
    writeSkill(roots.dataRoot, 'wiki', '# wiki\n', {
      'references/methodology/phase1.md': 'phase one\n',
      'references/methodology/phase0.md': 'phase zero\n',
      'references/agents/kb.md': 'kb agent\n',
      'templates/report.md': 'report\n',
    });

    const skill = await resolvePackagedSkill('wiki', roots);
    const out = await renderSkill(skill!, { full: true });

    expect(out).toBe(
      '# wiki\n' +
        '\n--- references/agents/kb.md ---\n\nkb agent\n' +
        '\n--- references/methodology/phase0.md ---\n\nphase zero\n' +
        '\n--- references/methodology/phase1.md ---\n\nphase one\n' +
        '\n--- templates/report.md ---\n\nreport\n',
    );
  });

  it('resolves {SKILL_DIR} to the packaged directory, in the body and in references', async () => {
    writeSkill(roots.dataRoot, 'wiki', `run python3 ${SKILL_DIR_PLACEHOLDER}/scripts/scan_repo.py\n`, {
      'references/howto.md': `see ${SKILL_DIR_PLACEHOLDER}/scripts/\n`,
    });

    const skill = await resolvePackagedSkill('wiki', roots);
    const out = await renderSkill(skill!, { full: true });

    expect(out).not.toContain(SKILL_DIR_PLACEHOLDER);
    expect(out).toContain(`python3 ${skill!.dir}/scripts/scan_repo.py`);
    expect(out).toContain(`see ${skill!.dir}/scripts/`);
  });

  it('adds a trailing newline to files that lack one', async () => {
    writeSkill(roots.dataRoot, 'core', '# core');
    const skill = await resolvePackagedSkill('core', roots);
    expect(await renderSkill(skill!)).toBe('# core\n');
  });
});

describe('skillCatalog', () => {
  it('reports name, description and path for each served skill', async () => {
    const roots = makeRoots();
    try {
      writeSkill(roots.dataRoot, 'core', '---\nname: core\ndescription: Daily sync\n---\n\n# core\n');
      const catalog = await skillCatalog(roots);
      expect(catalog).toEqual([
        { name: 'core', description: 'Daily sync', path: path.join(roots.dataRoot, 'core'), deployed: false },
      ]);
    } finally {
      fs.rmSync(roots.tmp, { recursive: true, force: true });
    }
  });
});

describe('teamai skill get / path against the shipped package', () => {
  let stdout: string;
  let stderr: string;
  const restore: Array<() => void> = [];

  beforeEach(() => {
    stdout = '';
    stderr = '';
    process.exitCode = undefined;

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout += args.join(' ') + '\n';
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr += args.join(' ') + '\n';
    });
    restore.push(() => writeSpy.mockRestore(), () => logSpy.mockRestore(), () => errorSpy.mockRestore());
  });

  afterEach(() => {
    while (restore.length > 0) restore.pop()?.();
    process.exitCode = undefined;
  });

  it('resolves its roots inside the package', () => {
    const roots = packagedSkillRoots();
    expect(roots.deployRoot).toBe(path.join(ROOT, 'skills'));
    expect(roots.dataRoot).toBe(path.join(ROOT, 'skill-data'));
  });

  it('prints a shipped skill byte for byte', async () => {
    const [first] = await listServableSkills();
    await skillGet([first.name]);

    expect(process.exitCode).toBeUndefined();
    expect(stderr).toBe('');
    expect(stdout).toBe(fs.readFileSync(path.join(first.dir, 'SKILL.md'), 'utf8'));
  });

  it('fails on an unknown name without writing to stdout', async () => {
    await skillGet(['no-such-skill']);

    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Skill not found: no-such-skill');
    expect(stderr).toContain('Available:');
  });

  it('warns about an unknown flag and still serves the skill', async () => {
    const [first] = await listServableSkills();
    await skillGet(['--bogus', first.name]);

    expect(process.exitCode).toBeUndefined();
    expect(stderr).toContain('Unknown flag ignored: --bogus');
    expect(stdout).toBe(fs.readFileSync(path.join(first.dir, 'SKILL.md'), 'utf8'));
  });

  it('fails when no name is left after dropping flags', async () => {
    await skillGet(['--full']);

    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('No skill name provided');
  });

  it('separates multiple skills and serves them all with --all', async () => {
    const servable = await listServableSkills();
    await skillGet([], { all: true });

    const expected = (await Promise.all(servable.map((skill) => renderSkill(skill)))).join('\n---\n\n');
    expect(process.exitCode).toBeUndefined();
    expect(stdout).toBe(expected);
  });

  it('prints the packaged directory, and the roots when no name is given', async () => {
    const [first] = await listServableSkills();
    await skillPath(first.name);
    expect(stdout.trim()).toBe(first.dir);
    expect(fs.existsSync(path.join(stdout.trim(), 'SKILL.md'))).toBe(true);

    stdout = '';
    await skillPath();
    expect(stdout.trim().split('\n')).toContain(path.join(ROOT, 'skills'));
  });

  it('fails on an unknown name for path too', async () => {
    await skillPath('no-such-skill');
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Skill not found: no-such-skill');
  });
});
