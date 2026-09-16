import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.resolve('dist/index.js');

describe('role-scoped agents (built CLI)', () => {
  it.each(['none', 'ambiguous', 'inactive'])('pushes valid edits with %s blocked agents and revokes copies per tool', (blocked) => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-agent-scopes-'));
    const home = path.join(sandbox, 'home');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'remote.git');
    const clone = path.join(home, '.teamai/team-repo');
    const env = { ...process.env, HOME: home, FORCE_COLOR: '0', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    const cli = (...args: string[]) => {
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: 'utf8', input: '', timeout: 20000 });
      return { code: result.status, output: result.stdout + result.stderr };
    };
    const configure = (role: string) => write(path.join(home, '.teamai/config.yaml'), `repo:\n  localPath: ${clone}\n  remote: ${remote}\nusername: tester\nupdatePolicy: skip\nscope: user\nprimaryRole: ${role}\n`);
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(seed, { recursive: true });
      for (const tool of ['claude', 'codex', 'codebuddy', 'opencode']) fs.mkdirSync(path.join(home, `.${tool}/agents`), { recursive: true });
      git(seed, 'init', '-b', 'main');
      write(path.join(seed, 'teamai.yaml'), `team: test\nrepo: ${remote}\nprovider: git\nusageReport: false\ntoolPaths:\n  claude:\n    agents: .claude/agents\n  codex:\n    agents: .codex/agents\n  codebuddy:\n    agents: .codebuddy/agents\n  opencode:\n    agents: .opencode/agents\n`);
      write(path.join(seed, 'manifest/roles.yaml'), 'version: 1\nroles:\n  - id: aaa\n    resources:\n      knowledge: []\n      skills: []\n      agents: [aaa]\n  - id: zzz\n    resources:\n      knowledge: []\n      skills: []\n      agents: [zzz]\n');
      const inactive = 'name: reviewer\ndescription: Inactive\ninstructions: Read aaa.\n';
      write(path.join(seed, 'agents/aaa/reviewer.yaml'), inactive);
      write(path.join(seed, 'agents/zzz/reviewer.yaml'), 'name: reviewer\ndescription: Active\ninstructions: Read zzz.\n');
      write(path.join(seed, 'agents/aaa/targeted.yaml'), 'name: targeted\ndescription: Old\ninstructions: Old instructions.\ntargets: [claude, codebuddy, opencode]\n');
      write(path.join(seed, 'agents/zzz/targeted.yaml'), 'name: targeted\ndescription: New\ninstructions: New instructions.\ntargets: [codex]\n');
      git(seed, 'add', '.'); git(seed, 'commit', '-m', 'fixture');
      git(sandbox, 'init', '--bare', remote);
      git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', 'main');
      fs.mkdirSync(path.dirname(clone), { recursive: true });
      git(sandbox, 'clone', '-b', 'main', remote, clone);
      configure('aaa');
      let result = cli('pull', '--force'); expect(result.code, result.output).toBe(0);
      for (const tool of ['claude', 'codebuddy', 'opencode']) expect(fs.existsSync(path.join(home, `.${tool}/agents/targeted.md`))).toBe(true);
      configure('zzz');
      result = cli('pull', '--force'); expect(result.code, result.output).toBe(0);
      for (const tool of ['claude', 'codebuddy', 'opencode']) expect(fs.existsSync(path.join(home, `.${tool}/agents/targeted.md`))).toBe(false);
      expect(fs.readFileSync(path.join(home, '.codex/agents/targeted.toml'), 'utf8')).toContain('New instructions.');
      result = cli('push', '--all', '--dry-run'); expect(result.code, result.output).toBe(0);
      expect(result.output).not.toMatch(/reviewer/);
      if (blocked !== 'none') {
        write(path.join(seed, 'agents/aaa/blocked.yaml'), 'name: blocked\ndescription: Blocked\ninstructions: Inactive source.\n');
        if (blocked === 'ambiguous') {
          write(path.join(seed, 'agents/zzz/blocked.yaml'), 'name: blocked\ndescription: Blocked\ninstructions: Active source.\n');
          write(path.join(seed, 'agents/collision/blocked.yaml'), 'name: blocked\ndescription: Blocked\ninstructions: Other active source.\n');
          const manifest = path.join(seed, 'manifest/roles.yaml');
          write(manifest, fs.readFileSync(manifest, 'utf8').replace('agents: [zzz]', 'agents: [zzz, collision]'));
        }
        git(seed, 'add', '.'); git(seed, 'commit', '-m', 'blocked agent fixture');
        git(seed, 'push', 'origin', 'main'); git(clone, 'pull', '--ff-only');
        write(path.join(home, '.claude/agents/blocked.md'), '---\nname: blocked\ndescription: Local edit\n---\nLocal instructions.\n');
      }
      if (blocked !== 'none') {
        result = cli('push', '--all', '--dry-run');
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('[agents] Skipped blocked:');
        expect(result.output).not.toContain('[agents] blocked (modified)');
        result = cli('push', '--all');
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('[agents] Skipped blocked:');
        expect(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/teamai/push/')).toBe('');
      }
      const deployed = path.join(home, '.claude/agents/reviewer.md');
      write(deployed, fs.readFileSync(deployed, 'utf8').replace('Read zzz.', 'Edited zzz.'));
      result = cli('push', '--all');
      if (blocked !== 'none') expect(result.output).toContain('[agents] Skipped blocked:');
      expect(result.output).not.toContain('pathspec');
      // A local-path remote cannot create a hosted PR. Verify the pushed branch itself.
      const branches = git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/teamai/push/').split('\n').filter(Boolean);
      expect(branches, result.output).toHaveLength(1);
      const branch = branches[0];
      if (!branch) throw new Error('No pushed branch');
      expect(git(remote, 'show', `${branch}:agents/zzz/reviewer.yaml`)).toContain('Edited zzz.');
      expect(git(remote, 'show', `${branch}:agents/aaa/reviewer.yaml`)).toBe(inactive.trim());
      expect(git(remote, 'diff', '--name-only', `main...${branch}`)).toBe('agents/zzz/reviewer.yaml');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60000);
});
