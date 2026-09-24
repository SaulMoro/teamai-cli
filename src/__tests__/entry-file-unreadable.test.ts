import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(), persist: vi.fn(),
  },
}));

import { entryFilePath, resolveEntriesFor, type EntryReader } from '../namespaced-entries.js';
import { envEntryReader } from '../resources/env.js';
import { hooksEntryReader } from '../resources/hooks.js';
import { mcpEntryReader } from '../resources/mcp.js';
import { modelsEntryReader } from '../models/profile.js';
import type { LocalConfig } from '../types.js';

/**
 * An active file that exists but cannot be read stops its type (#707), as one
 * that does not parse does. Taking it for absent would deliver the root entry
 * in place of the namespace override. A directory on the file's name stands in
 * for an unreadable file: it fails the read the same way on every platform and
 * user, root included.
 */
describe('an active entry file that cannot be read', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-entry-unreadable-'));
  });
  afterEach(async () => {
    await fse.remove(repoPath);
  });

  const readers: [string, EntryReader<unknown>][] = [
    ['env', envEntryReader],
    ['hooks', hooksEntryReader],
    ['mcp', mcpEntryReader],
    ['models', modelsEntryReader],
  ];

  it.each(readers)('fails %s instead of taking the namespace file for absent', async (_label, reader) => {
    await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'),
      `version: 1\nprojects:\n  - id: checkout\n    resources: { ${reader.type}: [checkout] }\n`);
    await fse.ensureDir(path.join(repoPath, ...entryFilePath(reader.type, 'checkout').split('/')));
    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' }, username: 't', scope: 'user', additionalRoles: [], projects: ['checkout'],
    };

    const resolution = await resolveEntriesFor(reader, localConfig);

    expect(resolution.kind).toBe('failed');
    if (resolution.kind !== 'failed') return;
    expect(resolution.failure).toEqual(expect.objectContaining({ kind: 'broken-file', source: entryFilePath(reader.type, 'checkout') }));
  });
});
