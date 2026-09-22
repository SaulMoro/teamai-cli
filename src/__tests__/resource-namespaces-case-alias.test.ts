import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import type { LocalConfig } from '../types.js';

function repoWith(roles: string, projects: string): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-ns-case-'));
  mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
  writeFileSync(path.join(repoDir, 'manifest', 'roles.yaml'), roles, 'utf-8');
  writeFileSync(path.join(repoDir, 'manifest', 'projects.yaml'), projects, 'utf-8');
  return repoDir;
}

function localConfig(repoDir: string): LocalConfig {
  return {
    repo: { localPath: repoDir, remote: 'https://github.com/acme/team.git' },
    username: 'e2e',
    primaryRole: 'fe',
    projects: ['p'],
  } as LocalConfig;
}

describe('resolveResourceNamespaces: roles.yaml and projects.yaml share one directory per resource type', () => {
  const ROLES = 'version: 1\nroles:\n  - id: fe\n    resources: { knowledge: [], skills: [frontend] }\n';

  it('rejects a project namespace that aliases a role namespace by case', async () => {
    const repoDir = repoWith(ROLES, 'version: 1\nprojects:\n  - id: p\n    name: P\n    resources: { skills: [Frontend] }\n');
    try {
      await expect(resolveResourceNamespaces(localConfig(repoDir))).rejects.toThrow(
        /skills namespaces "frontend" \(role fe\) and "Frontend" \(project p\) differ only by case/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('accepts the same spelling shared by a role and a project', async () => {
    const repoDir = repoWith(ROLES, 'version: 1\nprojects:\n  - id: p\n    name: P\n    resources: { skills: [frontend, p-only] }\n');
    try {
      const resolved = await resolveResourceNamespaces(localConfig(repoDir));
      expect(resolved?.activeNamespaces.skills).toEqual(expect.arrayContaining(['frontend', 'p-only']));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
