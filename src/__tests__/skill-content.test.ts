import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
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
  type PackagedSkill,
  type PackagedSkillRoots,
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

/** Resolve or fail the test, so the assertions below need no non-null operator. */
async function mustResolve(name: string, roots: PackagedSkillRoots): Promise<PackagedSkill> {
  const skill = await resolvePackagedSkill(name, roots);
  if (!skill) throw new Error(`fixture skill not found: ${name}`);
  return skill;
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

  it('serves nothing when only the deployed stub is packaged', async () => {
    writeSkill(roots.deployRoot, 'teamai', '# hub\n');

    // A package without skill-data is broken, not a fallback to serving stubs:
    // `skill get` reports it and says to reinstall.
    expect(await listServableSkills(roots)).toEqual([]);
  });

  it('keeps the deployed stub reachable by its exact name', async () => {
    writeSkill(roots.deployRoot, 'teamai', '# stub\n');
    writeSkill(roots.dataRoot, 'core', '# core\n');

    const stub = await resolvePackagedSkill('teamai', roots);
    expect(stub?.dir).toBe(path.join(roots.deployRoot, 'teamai'));
    expect(stub?.deployed).toBe(true);
  });

  it('resolves legacy directory names as aliases', async () => {
    writeSkill(roots.dataRoot, 'core', '# core\n');
    writeSkill(roots.dataRoot, 'wiki', '# wiki\n');
    writeSkill(roots.dataRoot, 'share', '# share\n');

    for (const alias of ['wiki', 'codebase', 'team-wiki-codebase']) {
      expect((await resolvePackagedSkill(alias, roots))?.name, alias).toBe('wiki');
    }
    for (const alias of ['share', 'learning', 'learnings', 'teamai-share-learnings']) {
      expect((await resolvePackagedSkill(alias, roots))?.name, alias).toBe('share');
    }
    expect((await resolvePackagedSkill('default', roots))?.name).toBe('core');
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

    const skill = await mustResolve('core', roots);
    expect(await renderSkill(skill)).toBe(body);
  });

  it('appends references/ then templates/, recursively, sorted by relative path', async () => {
    writeSkill(roots.dataRoot, 'wiki', '# wiki\n', {
      'references/methodology/phase1.md': 'phase one\n',
      'references/methodology/phase0.md': 'phase zero\n',
      'references/agents/kb.md': 'kb agent\n',
      'templates/report.md': 'report\n',
    });

    const skill = await mustResolve('wiki', roots);
    const out = await renderSkill(skill, { full: true });

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

    const skill = await mustResolve('wiki', roots);
    const out = await renderSkill(skill, { full: true });

    expect(out).not.toContain(SKILL_DIR_PLACEHOLDER);
    expect(out).toContain(`python3 ${skill.dir}/scripts/scan_repo.py`);
    expect(out).toContain(`see ${skill.dir}/scripts/`);
  });

  it('adds a trailing newline to files that lack one', async () => {
    writeSkill(roots.dataRoot, 'core', '# core');
    const skill = await mustResolve('core', roots);
    expect(await renderSkill(skill)).toBe('# core\n');
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

  it('prints a shipped skill byte for byte, bar the resolved {SKILL_DIR}', async () => {
    const [first] = await listServableSkills();
    await skillGet([first.name]);

    const raw = fs.readFileSync(path.join(first.dir, 'SKILL.md'), 'utf8');
    expect(process.exitCode).toBeUndefined();
    expect(stderr).toBe('');
    expect(stdout).toBe(raw.split(SKILL_DIR_PLACEHOLDER).join(first.dir));
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
    expect(stdout).toBe(await renderSkill(first));
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

describe('the shipped skill-data content', () => {
  it('names every skill after its directory, and declares allowed-tools', async () => {
    for (const skill of await listServableSkills()) {
      const text = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8');
      // A frontmatter name that disagrees with the directory makes the skill
      // undiscoverable for the agent and unresolvable for `skill get`.
      expect(text, skill.name).toMatch(new RegExp(`^name: ${skill.name}$`, 'm'));
      // Content loaded as text inherits no permissions, so each skill declares
      // the commands it tells the agent to run.
      expect(text, skill.name).toMatch(/^allowed-tools: .*Bash\(teamai:\*\)/m);
    }
  });

  it('keeps the deployed stub declaring its own name and tools', () => {
    const stub = fs.readFileSync(path.join(ROOT, 'skills/teamai/SKILL.md'), 'utf8');
    expect(stub).toMatch(/^name: teamai$/m);
    expect(stub).toMatch(/^allowed-tools: Bash\(teamai:\*\), Bash\(npx teamai-cli:\*\)$/m);
  });
});

describe('npm package contents', () => {
  // The whole design fails silently when skill-data/ is missing from
  // package.json "files": every test above still passes against the repo, and
  // `skill get` serves nothing at all once installed from the registry.
  it('ships both the deployed stub and the served content', () => {
    const packed = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = (JSON.parse(packed) as Array<{ files: Array<{ path: string }> }>)[0]
      .files.map((f) => f.path);

    expect(files).toContain('skills/teamai/SKILL.md');
    for (const skill of ['core', 'share', 'wiki']) {
      expect(files.some((f) => f.startsWith(`skill-data/${skill}/`)), skill).toBe(true);
    }
    expect(files).toContain('skill-data/wiki/scripts/scan_repo.py');
  }, 60_000);
});
