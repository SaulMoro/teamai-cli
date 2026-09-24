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
import { inactiveNamespaceDefines, modelsEntryReader } from '../models/profile.js';
import type { LocalConfig } from '../types.js';

/**
 * An active file that exists but cannot be read stops its type (#707), as one
 * that does not parse does. Taking it for absent would deliver the root entry
 * in place of the namespace override. A directory on the file's name stands in
 * for an unreadable file: it fails the read the same way on every platform and
 * user, root included.
 */
describe('reading the active entry files', () => {
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

  // Docs namespaces match their directory case-folded; the entry types do too,
  // so a member gets the override on a case-sensitive filesystem as well.
  it.each(readers)('reads the %s namespace directory whose name differs from the declared one only by case', async (_label, reader) => {
    await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'),
      `version: 1\nprojects:\n  - id: checkout\n    resources: { ${reader.type}: [checkout] }\n`);
    const content: Record<string, string> = {
      env: 'variables:\n  - { key: A, value: b }\n',
      hooks: 'hooks:\n  - { id: lint, description: x, event: Stop, command: echo }\n',
      mcp: 'servers:\n  - { name: db, transport: stdio, command: db }\n',
      models: "profiles:\n  - { id: gw, name: Gateway, base_url: 'https://gw.test', api_key: '${API_KEY}', model_groups: [{ protocols: [anthropic], models: [m] }] }\n",
    };
    await fse.outputFile(path.join(repoPath, ...entryFilePath(reader.type, 'Checkout').split('/')), content[reader.type]);
    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' }, username: 't', scope: 'user', additionalRoles: [], projects: ['checkout'],
    };

    const resolution = await resolveEntriesFor(reader, localConfig);

    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') return;
    expect(resolution.entries.map((entry) => entry.source)).toEqual([entryFilePath(reader.type, 'Checkout')]);
  });

  it('does not take a model profile namespace directory for inactive when only its case differs', async () => {
    await fse.outputFile(path.join(repoPath, 'models', 'Checkout', 'models.yaml'),
      "profiles:\n  - { id: gw, name: Gateway, base_url: 'https://gw.test', api_key: '${API_KEY}', model_groups: [{ protocols: [anthropic], models: [m] }] }\n");

    expect(await inactiveNamespaceDefines(repoPath, ['checkout'], 'gw')).toBe(false);
    expect(await inactiveNamespaceDefines(repoPath, ['billing'], 'gw')).toBe(true);
  });
});
