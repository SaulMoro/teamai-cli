import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', () => ({
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  setStderrOnly: vi.fn(),
}));

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { buildChecks, resolveDoctorContext, type Check } from '../doctor.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * The rules half of the delivery check (#624). A rule changes both its filename
 * and its bytes per tool, so "it synced" and "the tool can read it" are two
 * different questions — and only the second one is the one that matters.
 */
describe('doctor — rules delivered on disk', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  const CLAUDE_RULES = '.claude/rules';
  const CURSOR_RULES = '.cursor/rules';

  async function writeTeamRule(name: string, frontmatter = ''): Promise<void> {
    const file = path.join(repoPath, 'rules', `${name}.md`);
    await fse.ensureDir(path.dirname(file));
    await fse.writeFile(file, `${frontmatter}Body of ${name}\n`);
  }

  /** A correctly delivered copy, the way pullItem leaves one. */
  async function deliverPlain(toolPath: string, name: string): Promise<void> {
    const file = path.join(homeDir, toolPath, `${name}.md`);
    await fse.ensureDir(path.dirname(file));
    await fse.writeFile(file, `Body of ${name}\n`);
  }

  async function deliverMdc(name: string, frontmatter = '---\nalwaysApply: true\n---\n\n'): Promise<void> {
    const file = path.join(homeDir, CURSOR_RULES, `${name}.mdc`);
    await fse.ensureDir(path.dirname(file));
    await fse.writeFile(file, `${frontmatter}Body of ${name}\n`);
  }

  async function checks(): Promise<Check[]> {
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    return buildChecks(ctx);
  }

  async function rulesCheck(tool: string): Promise<Check> {
    const check = (await checks()).find((c) => c.name === `Rules delivered to ${tool}`);
    if (!check) throw new Error(`no rules delivery check for ${tool}`);
    return check;
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rules-delivery-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);

    await writeTeamRule('coding-style');
    await writeTeamRule('reviews');
    await fse.ensureDir(path.join(homeDir, CLAUDE_RULES));
    await fse.ensureDir(path.join(homeDir, CURSOR_RULES));

    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
    };
    teamConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'git',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' },
        env: { injectShellProfile: false },
      },
      toolPaths: {
        claude: { rules: CLAUDE_RULES },
        cursor: { rules: CURSOR_RULES },
      },
    };

    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('passes when every desired rule reached both tools in its own format', async () => {
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');
    await deliverMdc('coding-style');
    await deliverMdc('reviews');

    expect(await (await rulesCheck('claude')).check()).toBe(true);
    expect(await (await rulesCheck('cursor')).check()).toBe(true);
  });

  it('fails for the tool whose .mdc copy is missing, and names its directory', async () => {
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');
    await deliverMdc('coding-style');

    const cursor = await rulesCheck('cursor');
    expect(await cursor.check()).toBe(false);
    expect(cursor.fix).toContain('not delivered: reviews');
    expect(cursor.fix).toContain(path.join(homeDir, CURSOR_RULES));

    // Per tool, independently: claude received both.
    expect(await (await rulesCheck('claude')).check()).toBe(true);
  });

  it('reports a .mdc that landed without the frontmatter Cursor reads', async () => {
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');
    await deliverMdc('coding-style');
    await deliverMdc('reviews', '');

    const cursor = await rulesCheck('cursor');
    expect(await cursor.check()).toBe(false);
    expect(cursor.fix).toContain('delivered from an older copy: reviews');
  });

  it('reports a .mdc whose globs no longer match the team rule', async () => {
    // The frontmatter fields are all present and `alwaysApply` is a legal
    // value, so checking that the keys exist calls this delivered. Cursor
    // applies it to `**/*.py` while the team rule says `**/*.ts`.
    await writeTeamRule('reviews', '---\npaths:\n  - "**/*.ts"\n---\n');
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');
    await deliverMdc('coding-style');
    await deliverMdc('reviews', '---\nglobs: "**/*.py"\nalwaysApply: false\n---\n\n');

    const cursor = await rulesCheck('cursor');
    expect(await cursor.check()).toBe(false);
    expect(cursor.fix).toContain('delivered from an older copy: reviews');
  });

  it('reports a .md copy whose body drifted from the team rule', async () => {
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    const drifted = path.join(homeDir, CLAUDE_RULES, 'reviews.md');
    await fse.ensureDir(path.dirname(drifted));
    await fse.writeFile(drifted, 'Something else entirely\n');
    await deliverMdc('coding-style');
    await deliverMdc('reviews');

    const claude = await rulesCheck('claude');
    expect(await claude.check()).toBe(false);
    expect(claude.fix).toContain('delivered from an older copy: reviews');
  });

  it('treats a plain .md rule as applicable without frontmatter', async () => {
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');

    expect(await (await rulesCheck('claude')).check()).toBe(true);
  });

  it('emits no check for a tool configured without a rules path', async () => {
    teamConfig.toolPaths = { claude: { rules: CLAUDE_RULES }, codex: { skills: '.codex/skills' } };
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');

    const names = (await checks()).map((c) => c.name);
    expect(names).toContain('Rules delivered to claude');
    expect(names).not.toContain('Rules delivered to codex');
  });

  it('emits no check for a tool the member disabled', async () => {
    localConfig.disabledAgents = ['cursor'];
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');

    const names = (await checks()).map((c) => c.name);
    expect(names).not.toContain('Rules delivered to cursor');
  });

  it('emits no check at all when the team repo ships no rules', async () => {
    await fse.remove(path.join(repoPath, 'rules'));

    const names = (await checks()).map((c) => c.name);
    expect(names.filter((n) => n.startsWith('Rules delivered to'))).toEqual([]);
  });

  it('resolves a namespaced rule to its nested destination', async () => {
    await writeTeamRule('frontend/scoped');
    await deliverPlain(CLAUDE_RULES, 'coding-style');
    await deliverPlain(CLAUDE_RULES, 'reviews');
    await deliverPlain(CLAUDE_RULES, 'frontend/scoped');
    await deliverMdc('coding-style');
    await deliverMdc('reviews');

    expect(await (await rulesCheck('claude')).check()).toBe(true);

    const cursor = await rulesCheck('cursor');
    expect(await cursor.check()).toBe(false);
    expect(cursor.fix).toContain('not delivered: frontend/scoped');
  });

  it('leaves the rules and agents checks out of the post-pull stage', async () => {
    await fse.ensureDir(path.join(repoPath, 'agents'));
    await fse.writeFile(
      path.join(repoPath, 'agents', 'reviewer.yaml'),
      'name: reviewer\ndescription: reviews\ninstructions: |\n  Review.\n',
    );
    teamConfig.toolPaths.claude = { rules: CLAUDE_RULES, agents: '.claude/agents' };
    await fse.ensureDir(path.join(homeDir, '.claude/agents'));

    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');

    const forDoctor = (await buildChecks(ctx, 'doctor')).map((c) => c.name);
    const forPull = (await buildChecks(ctx, 'pull')).map((c) => c.name);

    expect(forDoctor.filter((n) => !forPull.includes(n)).sort()).toEqual([
      'Agents delivered to claude',
      'Rules delivered to claude',
      'Rules delivered to cursor',
    ]);
    // Everything the pull stage keeps is also in the doctor stage.
    expect(forPull.filter((n) => !forDoctor.includes(n))).toEqual([]);
  });

  it('never writes to the tool directory it inspects', async () => {
    await deliverPlain(CLAUDE_RULES, 'coding-style');

    const before = (await fse.readdir(path.join(homeDir, CURSOR_RULES))).sort();
    await (await rulesCheck('cursor')).check();
    const after = (await fse.readdir(path.join(homeDir, CURSOR_RULES))).sort();

    expect(after).toEqual(before);
  });
});
