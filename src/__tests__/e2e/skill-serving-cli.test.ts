import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

/**
 * The built CLI, run the way an agent runs it: through a shell, reading stdout.
 * The unit tests call the functions; this proves the packaged binary resolves
 * its own content and keeps stdout clean.
 */
describe('teamai skill get / path CLI (e2e)', () => {
  let home: string;

  function run(...args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' },
      encoding: 'utf8',
    });
  }

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-serving-e2e-'));
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('serves every skill it lists', () => {
    const listed = run('skill', 'list', '--json');
    expect(listed.status).toBe(0);

    const catalog = JSON.parse(listed.stdout) as { skills: Array<{ name: string; path: string }> };
    expect(catalog.skills.map((s) => s.name)).toEqual(['core', 'setup', 'share', 'wiki']);

    for (const skill of catalog.skills) {
      const got = run('skill', 'get', skill.name);
      expect(got.status, skill.name).toBe(0);
      expect(got.stderr, skill.name).toBe('');
      // Byte-identical to the packaged file, bar the resolved placeholder.
      const raw = fs.readFileSync(path.join(skill.path, 'SKILL.md'), 'utf8');
      expect(got.stdout, skill.name).toBe(raw.split('{SKILL_DIR}').join(skill.path));
      expect(got.stdout, skill.name).not.toContain('{SKILL_DIR}');
    }
  });

  it('serves every skill with --all and no name, and fails with neither', () => {
    const all = run('skill', 'get', '--all');
    expect(all.status, all.stderr).toBe(0);
    // No team config in this HOME, so the recall gate fails open and all four are served.
    expect(all.stdout.match(/^name: /gm)).toHaveLength(4);

    const none = run('skill', 'get');
    expect(none.status).toBe(1);
    expect(none.stdout).toBe('');
    expect(none.stderr).toContain('No skill name provided');
  });

  it('runs the wiki scripts from the directory it prints', () => {
    const printed = run('skill', 'path', 'wiki');
    expect(printed.status).toBe(0);

    const dir = printed.stdout.trim();
    for (const script of ['scan_repo.py', 'validate_kb.py']) {
      const scriptPath = path.join(dir, 'scripts', script);
      expect(fs.existsSync(scriptPath), scriptPath).toBe(true);

      const help = spawnSync('python3', [scriptPath, '--help'], { encoding: 'utf8' });
      // A machine without python3 cannot run them; the path is what we assert there.
      if (help.error) continue;
      expect(help.status, script).toBe(0);
      expect(help.stdout, script).toContain('usage:');
    }
  });

  it('keeps content on stdout and diagnostics on stderr', () => {
    const unknown = run('skill', 'get', 'no-such-skill');
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toContain('Skill not found: no-such-skill');

    const hallucinatedFlag = run('skill', 'get', 'core', '--not-a-flag');
    expect(hallucinatedFlag.status).toBe(0);
    expect(hallucinatedFlag.stderr).toContain('Unknown flag ignored: --not-a-flag');
    expect(hallucinatedFlag.stdout).toContain('name: core');

    const legacyName = run('skill', 'get', 'team-wiki-codebase');
    expect(legacyName.status).toBe(0);
    expect(legacyName.stdout).toContain('name: wiki');
  });

  it('appends the nested references with --full', () => {
    const full = run('skill', 'get', 'wiki', '--full');
    expect(full.status).toBe(0);

    const separators = full.stdout.split('\n').filter((line) => line.startsWith('--- '));
    expect(separators).toContain('--- references/methodology/phase0-collection.md ---');
    expect(separators).toContain('--- references/phases/phase0-init.md ---');
    // Sorted by relative path, references before templates.
    expect([...separators].sort()).toEqual(separators);
    expect(full.stdout.length).toBeGreaterThan(run('skill', 'get', 'wiki').stdout.length);
  });
});
