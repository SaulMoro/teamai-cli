/**
 * Learnings an older `import --from-mr` (0.25.0 to 0.26.0-beta.3) wrote into the learnings
 * checkout and never committed (#823 item 7). They were recallable on this
 * machine, never reached the team, and in single-repo mode they keep git from
 * removing the old checkout. Publishing now moves them into the queue first.
 *
 * Real git, no mocks of the units under test, as in git-kind-learnings.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

import { getDataHome, SYNC_LOCK_FILENAME, type LocalConfig } from '../types.js';
import { learningsBranch } from '../utils/learnings-branch.js';
import { listPendingLearnings, savePendingLearning } from '../utils/pending-learnings.js';
import { publishLearningsMaintenance, publishQueuedLearnings } from '../utils/learnings-publish.js';
import { log } from '../utils/logger.js';
import { writeInstallConfig } from './helpers/install-config.js';

let tmp: string;
let originalHome: string;

beforeEach(() => {
  // Real path: git lists worktrees by it, and the warnings name those paths.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-import-remnants-')));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function configureGit(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.addConfig('user.email', 't@t.com');
  await git.addConfig('user.name', 't');
}

/** A team repo, a member's clone, and the learnings checkout a first publish created. */
async function setUp(): Promise<{ config: LocalConfig; origin: string; checkout: string }> {
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  const seedGit = simpleGit(seed);
  await seedGit.init(['--initial-branch=main']);
  await configureGit(seed);
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: acme\n');
  await seedGit.add(['.']);
  await seedGit.commit('init');
  const origin = path.join(tmp, 'origin.git');
  await simpleGit().clone(seed, origin, ['--bare']);
  const clone = path.join(tmp, 'team-repo');
  await simpleGit().clone(origin, clone);
  await configureGit(clone);

  const config: LocalConfig = {
    repo: { localPath: clone, remote: origin, kind: 'git' },
    username: 'alice',
    scope: 'user',
    additionalRoles: [],
  };
  writeInstallConfig(config);
  const checkout = await learningsBranch.ensure(config);
  await configureGit(checkout);
  return { config, origin, checkout };
}

async function publishedFiles(origin: string): Promise<string[]> {
  try {
    return (await simpleGit(origin).raw(['ls-tree', '-r', '--name-only', 'teamai-learnings'])).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function publishedContent(origin: string, file: string): Promise<string> {
  return simpleGit(origin).raw(['show', `teamai-learnings:${file}`]);
}

/** What an older import --from-mr wrote: `<date>-<title>.md` with the MR in its frontmatter. */
function remnant(mr = 'https://github.com/acme/app/pull/42', title = 'Quokka cache warmup before deploy'): string {
  return [
    '---',
    `title: "${title}"`,
    'author: dev',
    'date: 2026-09-20',
    'tags: [cache, deploy]',
    'confidence: 0.85',
    `source_mr: "${mr}"`,
    '---',
    '## Background',
    'The quokka cache is cold after each deploy.',
    '',
  ].join('\n');
}

function plant(checkout: string, relPath: string, content: string): string {
  const file = path.join(checkout, 'learnings', relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** What was warned from now on, one line per call. */
function watchWarnings(): () => string {
  const warn = vi.spyOn(log, 'warn');
  return () => warn.mock.calls.map((c) => String(c[0])).join('\n');
}

const QUEUED_NAME = /^learnings\/quokka-cache-warmup-before-deploy-\d{4}-\d{2}-\d{2}-[a-z0-9]+\.md$/;

describe('a learning an older import --from-mr left untracked in the learnings checkout (#823 item 7)', () => {
  it('is queued and published even when nothing else is queued, and leaves the checkout clean', async () => {
    const { config, origin, checkout } = await setUp();
    const file = plant(checkout, '2026-09-20-Quokka-cache-warmup-before-deploy.md', remnant());
    const warned = watchWarnings();

    const report = await publishQueuedLearnings(config, 'alice');

    const published = (await publishedFiles(origin)).filter((f) => QUEUED_NAME.test(f));
    expect(published, (await publishedFiles(origin)).join('\n')).toHaveLength(1);
    expect(await publishedContent(origin, published[0])).toBe(remnant());
    expect(report.published).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(false);
    expect(await simpleGit(checkout).raw(['status', '--porcelain'])).toBe('');
    expect(await listPendingLearnings(config)).toEqual([]);
    expect(warned()).toContain(`Queued 1 learning(s) an older teamai import --from-mr left unpublished: ${file}`);
  });

  it('is queued too when its title kept no character in the file name', async () => {
    const { config, origin, checkout } = await setUp();
    // A Cyrillic title: that import replaced every character, leaving `<date>-.md`.
    const file = plant(checkout, '2026-09-20-.md', remnant('https://github.com/acme/app/pull/5', 'Прогрев кэша'));

    await publishQueuedLearnings(config, 'alice');

    expect(fs.existsSync(file)).toBe(false);
    const published = (await publishedFiles(origin)).filter((f) => f.endsWith('.md'));
    expect(published).toHaveLength(1);
    expect(await publishedContent(origin, published[0])).toBe(remnant('https://github.com/acme/app/pull/5', 'Прогрев кэша'));
  });

  it('leaves every other file alone: tracked edits, subdirectories, and files without the date name or source_mr', async () => {
    const { config, origin, checkout } = await setUp();
    // A tracked learning the member edited by hand.
    await savePendingLearning(config, '2026-09-19-tracked.md', remnant('https://github.com/acme/app/pull/1', 'Tracked'));
    await publishQueuedLearnings(config, 'alice');
    const tracked = path.join(checkout, 'learnings', '2026-09-19-tracked.md');
    fs.appendFileSync(tracked, 'An edit nobody committed.\n');
    const kept = [
      plant(checkout, 'alpha/2026-09-20-in-a-namespace.md', remnant('https://github.com/acme/app/pull/2')),
      plant(checkout, '2026-09-20-no-merge-request.md', '---\ntitle: No MR\n---\nA draft.\n'),
      plant(checkout, 'notes-with-a-merge-request.md', remnant('https://github.com/acme/app/pull/3')),
    ];
    const before = await publishedFiles(origin);

    await publishQueuedLearnings(config, 'alice');

    expect(await publishedFiles(origin)).toEqual(before);
    for (const file of kept) expect(fs.existsSync(file), file).toBe(true);
    expect(fs.readFileSync(tracked, 'utf8')).toContain('An edit nobody committed.');
    expect(await listPendingLearnings(config)).toEqual([]);
  });

  it('is removed, not queued again, when the branch already has a learning from the same merge request', async () => {
    const { config, origin, checkout } = await setUp();
    // A later import of the same MR, published in a project namespace.
    await savePendingLearning(config, 'alpha/quokka-2026-09-21-aaa111.md', remnant('https://github.com/acme/app/pull/42', 'Quokka, reimported'));
    await publishQueuedLearnings(config, 'alice');
    const file = plant(checkout, '2026-09-20-Quokka-cache-warmup-before-deploy.md', remnant());
    const before = await publishedFiles(origin);
    const warned = watchWarnings();

    await publishQueuedLearnings(config, 'alice');

    expect(await publishedFiles(origin)).toEqual(before);
    expect(fs.existsSync(file)).toBe(false);
    expect(await listPendingLearnings(config)).toEqual([]);
    expect(warned()).toContain(file);
    expect(warned()).toContain('learnings/alpha/quokka-2026-09-21-aaa111.md');
  });

  it('is removed, not queued again, when a teammate published one from the same merge request that the checkout has not fetched yet (item 21)', async () => {
    const { config, origin, checkout } = await setUp();
    await savePendingLearning(config, 'first-2026-09-19-aaa000.md', '---\ntitle: First\n---\nFirst.\n');
    await publishQueuedLearnings(config, 'alice');
    // A teammate imports the same MR from their own clone. Neither this
    // checkout nor this clone's origin/teamai-learnings has seen it.
    const teammate = path.join(tmp, 'teammate');
    await simpleGit().clone(origin, teammate, ['--branch', 'teamai-learnings']);
    await configureGit(teammate);
    fs.mkdirSync(path.join(teammate, 'learnings', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(teammate, 'learnings', 'alpha', 'quokka-2026-09-21-ddd444.md'), remnant('https://github.com/acme/app/pull/42', 'Quokka, by a teammate'));
    await simpleGit(teammate).add(['.']);
    await simpleGit(teammate).commit('teammate');
    await simpleGit(teammate).push('origin', 'teamai-learnings');
    const file = plant(checkout, '2026-09-20-Quokka-cache-warmup-before-deploy.md', remnant());
    const before = await publishedFiles(origin);
    const warned = watchWarnings();

    await publishQueuedLearnings(config, 'alice');

    expect(await publishedFiles(origin)).toEqual(before);
    expect(fs.existsSync(file)).toBe(false);
    expect(await listPendingLearnings(config)).toEqual([]);
    expect(warned()).toContain('learnings/alpha/quokka-2026-09-21-ddd444.md');
  });

  it('is removed, and published once, when the queue already holds the same content', async () => {
    const { config, origin, checkout } = await setUp();
    await savePendingLearning(config, 'quokka-copy-2026-09-21-bbb222.md', remnant('https://github.com/acme/app/pull/77'));
    const file = plant(checkout, '2026-09-20-Quokka-cache-warmup-before-deploy.md', remnant('https://github.com/acme/app/pull/77'));

    await publishQueuedLearnings(config, 'alice');

    const published = (await publishedFiles(origin)).filter((f) => f.endsWith('.md'));
    expect(published).toEqual(['learnings/quokka-copy-2026-09-21-bbb222.md']);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('is left where it is while another command holds the sync lock, which would queue it twice', async () => {
    const { config, origin, checkout } = await setUp();
    const file = plant(checkout, '2026-09-20-Quokka-cache-warmup-before-deploy.md', remnant());
    const syncLock = path.join(getDataHome(config), SYNC_LOCK_FILENAME);
    fs.writeFileSync(syncLock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'a pull' }));

    await publishQueuedLearnings(config, 'alice');

    expect(fs.existsSync(file)).toBe(true);
    expect(await listPendingLearnings(config)).toEqual([]);
    expect((await publishedFiles(origin)).filter((f) => QUEUED_NAME.test(f))).toEqual([]);
  });

  it('is left where it is by a dry run', async () => {
    const { config, origin, checkout } = await setUp();
    const file = plant(checkout, '2026-09-20-Quokka-cache-warmup-before-deploy.md', remnant());

    await publishQueuedLearnings(config, 'alice', { dryRun: true });

    expect(fs.existsSync(file)).toBe(true);
    expect((await publishedFiles(origin)).filter((f) => QUEUED_NAME.test(f))).toEqual([]);
    expect(await listPendingLearnings(config)).toEqual([]);
  });
});

describe('a dry run (#823 item 20)', () => {
  it('publishes nothing from the queue and reports it as still queued', async () => {
    const { config, origin } = await setUp();
    await savePendingLearning(config, 'otter-2026-09-25-ccc333.md', '---\ntitle: Otter\n---\nOtters hold hands.\n');

    const report = await publishQueuedLearnings(config, 'alice', { dryRun: true });

    expect(report).toEqual({ published: [], remaining: 1 });
    expect((await publishedFiles(origin)).filter((f) => f.endsWith('.md'))).toEqual([]);
    expect(await listPendingLearnings(config)).toEqual(['otter-2026-09-25-ccc333.md']);
  });
});

describe('publishing what maintenance changed (#823)', () => {
  it('publishes the tracked change, and neither fails on nor publishes a removed file git never tracked', async () => {
    const { config, origin, checkout } = await setUp();
    await savePendingLearning(config, 'kept-2026-01-01-aaa111.md', '---\ntitle: Kept\nconfidence: 0.5\n---\nKept.\n');
    await publishQueuedLearnings(config, 'alice');
    // Maintenance rewrote a tracked learning and pruned one nobody had committed.
    const rewritten = path.join(checkout, 'learnings', 'kept-2026-01-01-aaa111.md');
    fs.writeFileSync(rewritten, '---\ntitle: Kept\nconfidence: 0.9\n---\nKept.\n');
    const prunedUntracked = path.join(checkout, 'learnings', 'draft.md');

    const result = await publishLearningsMaintenance(config, '[teamai] Maintenance', [rewritten, prunedUntracked]);

    expect(result).toEqual({ status: 'published' });
    expect(await publishedContent(origin, 'learnings/kept-2026-01-01-aaa111.md')).toContain('confidence: 0.9');
  });

  it('stages a filename with [ or * as itself, not as a pattern that sweeps in stray files', async () => {
    const { config, origin, checkout } = await setUp();
    await savePendingLearning(config, 'a[1].md', '---\ntitle: A\n---\nA.\n');
    await publishQueuedLearnings(config, 'alice');
    // Maintenance removed a tracked `a[1].md` and wrote a new `b*.md`. The strays
    // match those names as glob patterns and nobody committed them.
    const removed = path.join(checkout, 'learnings', 'a[1].md');
    fs.rmSync(removed);
    const written = path.join(checkout, 'learnings', 'b*.md');
    fs.writeFileSync(written, '---\ntitle: B\n---\nB.\n');
    fs.writeFileSync(path.join(checkout, 'learnings', 'a1.md'), 'stray\n');
    fs.writeFileSync(path.join(checkout, 'learnings', 'bee.md'), 'stray\n');

    const result = await publishLearningsMaintenance(config, '[teamai] Maintenance', [removed, written]);

    expect(result).toEqual({ status: 'published' });
    expect((await publishedFiles(origin)).filter((f) => f.endsWith('.md')).sort()).toEqual(['learnings/b*.md']);
  });
});

describe('publishing what maintenance changed for an HTTP install (#823)', () => {
  it('reports a failed publish, not a throw, after a prune removed a file from the HTTP cache', async () => {
    const cache = path.join(tmp, 'http-cache');
    const removed = path.join(cache, 'learnings', 'stale-2026-01-01-aaa111.md');
    fs.mkdirSync(path.dirname(removed), { recursive: true });
    const config: LocalConfig = {
      repo: { localPath: cache, remote: 'https://team.example/api', kind: 'http', url: 'https://team.example/api' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
    };
    writeInstallConfig(config);

    const result = await publishLearningsMaintenance(config, '[teamai] Maintenance', [removed]);

    expect(result.status).toBe('failed');
  });
});
