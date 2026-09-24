import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(), persist: vi.fn(),
  },
}));

import { buildEntryScopeKeyCheck, entryNamespaceNotes } from '../doctor-delivery.js';
import type { DoctorContext } from '../doctor.js';
import type { LocalConfig } from '../types.js';

/**
 * What `doctor` says about env, hooks and MCP by namespace (#707): overrides
 * and legacy repeats are notes, and the per-entry keys the namespace files
 * replace are one informational check whose fix names every target file.
 */
describe('doctor — env, hooks and MCP namespaces', () => {
  let repoPath: string;

  function ctx(over: Partial<Pick<LocalConfig, 'primaryRole' | 'projects'>> = {}): DoctorContext {
    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' }, username: 't', scope: 'user', additionalRoles: [], ...over,
    };
    return { localConfig, teamConfig: null, toolPaths: {}, hookToolPaths: {}, baseDir: repoPath };
  }

  beforeEach(async () => {
    repoPath = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-doctor-entry-ns-'));
  });
  afterEach(async () => {
    await fse.remove(repoPath);
  });

  it('lists each override as a note naming both files', async () => {
    await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: checkout\n    resources: { env: [checkout] }\n');
    await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'), 'variables:\n  - key: API_BASE\n    value: a\n');
    await fse.outputFile(path.join(repoPath, 'env', 'checkout', 'env.yaml'), 'variables:\n  - key: API_BASE\n    value: b\n');

    expect(await entryNamespaceNotes(ctx({ projects: ['checkout'] })))
      .toEqual(['env: "API_BASE" from env/checkout/env.yaml replaces env/env.yaml']);
    expect(await entryNamespaceNotes(ctx())).toEqual([]);
  });

  it('lists a model profile override as a note', async () => {
    const catalog = (url: string): string => [
      'profiles:',
      `  - { id: gw, name: Gateway, base_url: '${url}', api_key: '\${API_KEY}', model_groups: [{ protocols: [anthropic], models: [m] }] }`,
      '',
    ].join('\n');
    await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: checkout\n    resources: { models: [checkout] }\n');
    await fse.outputFile(path.join(repoPath, 'models', 'models.yaml'), catalog('https://gw.company.test'));
    await fse.outputFile(path.join(repoPath, 'models', 'checkout', 'models.yaml'), catalog('https://gw.checkout.test'));

    expect(await entryNamespaceNotes(ctx({ projects: ['checkout'] })))
      .toEqual(['models: "gw" from models/checkout/models.yaml replaces models/models.yaml']);
  });

  it('lists a name the root file repeats in legacy mode, where it is not an error', async () => {
    await fse.outputFile(path.join(repoPath, 'mcp', 'mcp.yaml'), [
      'servers:',
      '  - { name: db, transport: http, url: https://a.example.com }',
      '  - { name: db, transport: http, url: https://b.example.com }',
      '',
    ].join('\n'));

    expect(await entryNamespaceNotes(ctx()))
      .toEqual(['mcp: "db" is defined more than once in mcp/mcp.yaml (legacy mode does not check this; keep one of them)']);
  });

  it('reports per-entry roles: and projects: in one informational check naming every target file', async () => {
    await fse.outputFile(path.join(repoPath, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: frontend',
      '    resources: { knowledge: [], skills: [], hooks: [fe] }',
      '  - id: devops',
      '    resources: { knowledge: [], skills: [] }',
      '',
    ].join('\n'));
    await fse.outputFile(path.join(repoPath, 'hooks', 'hooks.yaml'), [
      'hooks:',
      '  - { id: lint, description: x, event: Stop, command: echo, roles: [frontend, devops] }',
      '',
    ].join('\n'));
    await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'), 'variables:\n  - { key: A, value: b, projects: [checkout] }\n');

    const [check] = await buildEntryScopeKeyCheck(ctx({ primaryRole: 'frontend' }));
    if (!check) throw new Error('expected the scope-key check');
    expect(check.informational).toBe(true);
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('hooks/hooks.yaml: hook "lint" is scoped with per-entry `roles:`, which is deprecated');
    expect(check.fix).toContain('Copy it into each of hooks/fe/hooks.yaml, hooks/devops/hooks.yaml (declare hooks: [devops] for role devops in manifest/roles.yaml)');
    expect(check.fix).toContain('env/env.yaml: variable "A" is scoped with per-entry `projects:`');
  });

  it('adds no check when no entry carries a per-entry key', async () => {
    await fse.outputFile(path.join(repoPath, 'hooks', 'hooks.yaml'), 'hooks:\n  - { id: lint, description: x, event: Stop, command: echo }\n');
    expect(await buildEntryScopeKeyCheck(ctx())).toEqual([]);
  });
});
