import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

let tmp: string;
const realHome = process.env.HOME;

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(async () => ({ localConfig: config() })),
  detectProjectConfig: vi.fn(async () => null),
  loadLocalConfigForScope: vi.fn(async (scope: string) => (scope === 'user' ? config() : null)),
  loadTeamConfig: vi.fn(async () => null),
  autoDetectInit: vi.fn(async () => ({ localConfig: config() })),
}));

function config() {
  return {
    repo: { localPath: path.join(tmp, '.teamai', 'team-repo'), remote: 'r', kind: 'git' as const },
    username: 'alice',
    scope: 'user' as const,
    additionalRoles: [],
    projects: ['alpha'],
  };
}

const { recall } = await import('../recall.js');
const { loadTeamConfig } = await import('../config.js');
const { log } = await import('../utils/logger.js');

/**
 * A recall that has to rebuild the index must see the same learnings a pull
 * would have indexed: every root, and the active project namespaces. It used to
 * pick one directory and pass no namespaces at all, so half the knowledge base
 * disappeared with no error.
 */
describe('recall rebuilding a missing index', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-roots-'));
    process.env.HOME = tmp;
    const repo = path.join(tmp, '.teamai', 'team-repo');
    fs.mkdirSync(path.join(repo, 'learnings', 'alpha'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'learnings', 'shared-note.md'),
      '---\ntitle: shared note\n---\nretry budget for the gateway',
    );
    fs.writeFileSync(
      path.join(repo, 'learnings', 'alpha', 'project-note.md'),
      '---\ntitle: project note\n---\nretry budget for the gateway',
    );
    fs.mkdirSync(path.join(repo, 'manifest'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: alpha\n    name: Alpha\n    resources:\n      learnings: [alpha]\n',
    );
  });

  afterEach(() => {
    vi.mocked(loadTeamConfig).mockResolvedValue(null);
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('indexes the active project namespace, not only the shared root', async () => {
    await recall('retry budget', {});

    const index = JSON.parse(fs.readFileSync(path.join(tmp, '.teamai', 'search-index.json'), 'utf8'));
    const names = index.entries.map((e: { filename: string }) => e.filename);
    expect(names).toContain('shared-note.md');
    expect(names).toContain(path.join('alpha', 'project-note.md'));
  });

  it('indexes the skills pull delivers here, not every skill in the repo (#707)', async () => {
    const repo = path.join(tmp, '.teamai', 'team-repo');
    fs.writeFileSync(
      path.join(repo, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: alpha\n    name: Alpha\n    resources:\n      learnings: [alpha]\n      skills: [alpha-skills]\n'
        + '  - id: beta\n    name: Beta\n    resources:\n      skills: [beta-skills]\n',
    );
    const skill = (rel: string, name: string): void => {
      fs.mkdirSync(path.join(repo, 'skills', rel), { recursive: true });
      fs.writeFileSync(path.join(repo, 'skills', rel, 'SKILL.md'), `---\nname: ${name}\ndescription: retry budget ${name}\n---\nretry budget`);
    };
    skill('alpha-skills/gateway', 'gateway');
    skill('beta-skills/billing', 'billing');
    skill('untagged-root', 'untagged-root');
    vi.mocked(loadTeamConfig).mockResolvedValue({
      team: 't', description: '', repo: 'r', provider: 'git', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {},
    });

    await recall('retry budget', {});

    const index = JSON.parse(fs.readFileSync(path.join(tmp, '.teamai', 'search-index.json'), 'utf8'));
    const skills = index.entries
      .filter((e: { type: string }) => e.type === 'skills')
      .map((e: { filename: string }) => e.filename);
    expect(skills).toEqual(['gateway.md']);
  });

  it('indexes the docs pull delivers here: shared ones and the active namespace (#707)', async () => {
    const repo = path.join(tmp, '.teamai', 'team-repo');
    fs.writeFileSync(
      path.join(repo, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: alpha\n    name: Alpha\n    resources:\n      docs: [alpha]\n'
        + '  - id: beta\n    name: Beta\n    resources:\n      docs: [beta]\n',
    );
    const doc = (rel: string): void => {
      fs.mkdirSync(path.dirname(path.join(repo, 'docs', rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, 'docs', rel), '# retry budget\nretry budget for the gateway');
    };
    doc('shared.md');
    doc('runbooks/oncall.md');
    doc('alpha/gateway.md');
    doc('beta/billing.md');

    await recall('retry budget', {});

    const index = JSON.parse(fs.readFileSync(path.join(tmp, '.teamai', 'search-index.json'), 'utf8'));
    const docs = index.entries
      .filter((e: { type: string }) => e.type === 'docs')
      .map((e: { filename: string }) => e.filename)
      .sort();
    expect(docs).toEqual(['alpha/gateway.md', 'runbooks/oncall.md', 'shared.md']);
  });

  it('indexes the rules pull delivers here: a namespace rule in place of the root one it replaces (#707)', async () => {
    const repo = path.join(tmp, '.teamai', 'team-repo');
    fs.writeFileSync(
      path.join(repo, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: alpha\n    name: Alpha\n    resources:\n      knowledge: [alpha]\n'
        + '  - id: beta\n    name: Beta\n    resources:\n      knowledge: [beta]\n',
    );
    const rule = (rel: string): void => {
      fs.mkdirSync(path.dirname(path.join(repo, 'rules', rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, 'rules', rel), '# retry budget\nretry budget for the gateway');
    };
    rule('shared.md');
    rule('style.md');
    rule('alpha/style.md');
    rule('beta/billing.md');
    vi.mocked(loadTeamConfig).mockResolvedValue({
      team: 't', description: '', repo: 'r', provider: 'git', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {},
    });

    await recall('retry budget', {});

    const index = JSON.parse(fs.readFileSync(path.join(tmp, '.teamai', 'search-index.json'), 'utf8'));
    const rules = index.entries
      .filter((e: { type: string }) => e.type === 'rules')
      .map((e: { filename: string }) => e.filename)
      .sort();
    expect(rules).toEqual(['alpha/style.md', 'shared.md']);
  });
});

/**
 * A team manifest that cannot be read used to fail the whole rebuild: recall
 * found nothing and said "No learnings available. Run `teamai pull` first",
 * which pull does not fix (#823 item 12). Learnings do not depend on the
 * manifests, so they are indexed, and what is left out is named once.
 */
describe('recall rebuilding a missing index with a team manifest it cannot read (#823)', () => {
  const repo = (): string => path.join(tmp, '.teamai', 'team-repo');
  const indexPath = (): string => path.join(tmp, '.teamai', 'search-index.json');
  const indexed = (type: string): string[] => JSON.parse(fs.readFileSync(indexPath(), 'utf8')).entries
    .filter((e: { type: string }) => e.type === type)
    .map((e: { filename: string }) => e.filename)
    .sort();
  const warnings = (): string[] => vi.mocked(log.warn).mock.calls.map(([message]) => String(message));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-manifest-'));
    process.env.HOME = tmp;
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
    fs.mkdirSync(path.join(repo(), 'learnings', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(repo(), 'learnings', 'shared-note.md'), '---\ntitle: shared note\n---\nretry budget for the gateway');
    fs.writeFileSync(path.join(repo(), 'learnings', 'alpha', 'project-note.md'), '---\ntitle: project note\n---\nretry budget for the gateway');
    fs.mkdirSync(path.join(repo(), 'rules'), { recursive: true });
    fs.writeFileSync(path.join(repo(), 'rules', 'style.md'), '# retry budget\nretry budget for the gateway');
    fs.mkdirSync(path.join(repo(), 'manifest'), { recursive: true });
    fs.writeFileSync(
      path.join(repo(), 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: alpha\n    name: Alpha\n    resources:\n      learnings: [alpha]\n',
    );
    vi.mocked(loadTeamConfig).mockResolvedValue({
      team: 't', description: '', repo: 'r', provider: 'git', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {},
    });
  });

  afterEach(() => {
    vi.mocked(loadTeamConfig).mockResolvedValue(null);
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('indexes the learnings when roles.yaml does not parse, and says once what stays out', async () => {
    fs.writeFileSync(path.join(repo(), 'manifest', 'roles.yaml'), 'roles: [unclosed\n');

    await recall('retry budget', {});

    expect(indexed('learnings')).toEqual([path.join('alpha', 'project-note.md'), 'shared-note.md']);
    // An empty list, not a walk of every rule in the repo.
    expect(indexed('rules')).toEqual([]);
    expect(warnings().filter((m) => m.includes('Recall indexed learnings only'))).toEqual([
      expect.stringMatching(/Invalid roles manifest YAML[\s\S]*Docs, rules and skills stay out of recall/),
    ]);

    // The partial index is saved like any other: the next recall uses it quietly.
    vi.mocked(log.warn).mockClear();
    await recall('retry budget', {});
    expect(warnings()).toEqual([]);
  });

  it('indexes only the shared learnings when projects.yaml does not parse with a project active', async () => {
    fs.writeFileSync(path.join(repo(), 'manifest', 'projects.yaml'), 'projects: [unclosed\n');

    await recall('retry budget', {});

    expect(indexed('learnings')).toEqual(['shared-note.md']);
    expect(indexed('rules')).toEqual([]);
    // One warning for one broken file, though docs, rules and skills depend on it too.
    expect(warnings()).toEqual([
      expect.stringMatching(/Invalid projects manifest YAML[\s\S]*learnings of project alpha, and docs, rules and skills, stay out of recall/),
    ]);
  });

  it('names a skill collision when the index it rebuilds is an older format with no skills', async () => {
    fs.writeFileSync(
      path.join(repo(), 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: alpha\n    name: Alpha\n    resources:\n      learnings: [alpha]\n      skills: [a, b]\n',
    );
    for (const ns of ['a', 'b']) {
      fs.mkdirSync(path.join(repo(), 'skills', ns, 'foo'), { recursive: true });
      fs.writeFileSync(path.join(repo(), 'skills', ns, 'foo', 'SKILL.md'), `---\nname: foo\ndescription: retry budget ${ns}\n---\nretry budget`);
    }
    fs.writeFileSync(indexPath(), JSON.stringify({ version: 1, entries: [] }));

    await recall('retry budget', {});

    expect(warnings()).toContainEqual(expect.stringMatching(/Skills stay out of recall: Duplicate skill "foo"/));
  });

  it('names a skill collision when there is no index to keep its skills from', async () => {
    fs.writeFileSync(
      path.join(repo(), 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: alpha\n    name: Alpha\n    resources:\n      learnings: [alpha]\n      skills: [a, b]\n',
    );
    for (const ns of ['a', 'b']) {
      fs.mkdirSync(path.join(repo(), 'skills', ns, 'foo'), { recursive: true });
      fs.writeFileSync(path.join(repo(), 'skills', ns, 'foo', 'SKILL.md'), `---\nname: foo\ndescription: retry budget ${ns}\n---\nretry budget`);
    }

    await recall('retry budget', {});

    expect(indexed('learnings')).toEqual([path.join('alpha', 'project-note.md'), 'shared-note.md']);
    expect(warnings()).toContainEqual(expect.stringMatching(/Skills stay out of recall: Duplicate skill "foo"/));
  });

  it('names the cause when the build fails for another reason, not "No learnings available"', async () => {
    // The index path is a directory, so writing the index fails.
    fs.mkdirSync(indexPath(), { recursive: true });

    await recall('retry budget', {});

    expect(warnings()).toContainEqual(expect.stringMatching(/Recall could not build the user search index: .*EISDIR/));
    expect(vi.mocked(log.info).mock.calls.map(([message]) => String(message)))
      .not.toContainEqual(expect.stringContaining('No learnings available'));
  });
});
