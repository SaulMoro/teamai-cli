import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn() },
}));

import { mcpEntryReader } from '../resources/mcp.js';
import { resolveEntriesFor } from '../namespaced-entries.js';
import type { LocalConfig } from '../types.js';

let repo: string;

beforeEach(async () => {
  repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-handler-'));
});
afterEach(async () => {
  await fse.remove(repo);
});

async function writeMcpYaml(content: string): Promise<void> {
  await fse.ensureDir(path.join(repo, 'mcp'));
  await fse.writeFile(path.join(repo, 'mcp', 'mcp.yaml'), content);
}

function member(over: Partial<Pick<LocalConfig, 'primaryRole' | 'projects'>> = {}): LocalConfig {
  return { repo: { localPath: repo, remote: 'owner/repo' }, username: 'tester', scope: 'user', additionalRoles: [], ...over };
}

async function serversFor(localConfig: LocalConfig) {
  const resolution = await resolveEntriesFor(mcpEntryReader, localConfig);
  if (resolution.kind !== 'resolved') throw new Error('servers did not resolve');
  return resolution.entries.map((entry) => entry.entry);
}

describe('resolveEntriesFor(mcpEntryReader) — per-entry keys (#707)', () => {
  it('keeps a (deprecated) roles list on the entry, and leaves it undefined when omitted', async () => {
    await writeMcpYaml(`
servers:
  - name: playwright
    transport: stdio
    command: npx
    args: ['-y', '@playwright/mcp@latest']
    roles: [frontend]
  - name: shared
    transport: http
    url: https://example.com/api/mcp
`);
    const servers = await serversFor(member());
    expect(servers.map((s) => s.roles)).toEqual([['frontend'], undefined]);
  });

  it('still filters by the deprecated roles list for a member with a role', async () => {
    await writeMcpYaml(`
servers:
  - name: nobody
    transport: http
    url: https://example.com/api/mcp
    roles: []
  - name: shared
    transport: http
    url: https://example.com/shared
`);
    expect((await serversFor(member({ primaryRole: 'frontend' }))).map((s) => s.name)).toEqual(['shared']);
  });

  it('delivers no server that carries the removed projects key', async () => {
    await writeMcpYaml(`
servers:
  - name: checkout-db
    transport: http
    url: https://example.com/checkout
    projects: [checkout]
  - name: both
    transport: http
    url: https://example.com/both
    roles: [frontend]
    projects: [checkout]
  - name: shared
    transport: http
    url: https://example.com/api/mcp
`);
    expect((await serversFor(member({ projects: ['checkout'] }))).map((s) => s.name)).toEqual(['shared']);
  });
});
