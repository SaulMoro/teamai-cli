import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withoutRefusal } from '../benchmark/team-without.js';
import type { LocalConfig } from '../types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SKILL = (name: string): string => `---\nname: ${name}\ndescription: Helps with ${name}.\n---\nUse ${name}.\n`;
const ROLES = ['version: 1', 'roles:', ...['dev', 'ops'].flatMap((id) => [
  `  - id: ${id}`, '    resources:', `      knowledge: [${id}]`, `      skills: [${id}]`, `      agents: [${id}]`, `      docs: [${id}]`,
]), ''].join('\n');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A member of role dev, which receives the dev namespaces and not the ops ones, and of tag quality, in a git team whose
 * commit holds a rule, CLAUDE.md, shared skills release and lint, which tag quality brings, and solo, which no tag
 * brings, skill release again in dev, skills deploy in dev and runbook in ops, agent reviewer shared and again in dev,
 * agent planner shared only, rule style in ops, docs shared and under api and in namespace ops, and hooks shared and in
 * dev; and that commit. With `role` null, the member holds no role, so every namespace reaches them; without `tags`,
 * the team has no tags.yaml.
 */
function team({ role = 'dev' as string | null, tags = true } = {}): { config: LocalConfig; revision: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-team-without-'));
  dirs.push(root);
  const repo = path.join(root, 'team');
  const files = {
    'teamai.yaml': 'team: acme\nrepo: https://github.com/acme/team.git\nprovider: git\n',
    'manifest/roles.yaml': ROLES,
    ...(tags ? { 'tags.yaml': 'skills:\n  lint: [quality]\n  release: [quality]\n' } : {}),
    'CLAUDE.md': 'Be kind.\n',
    'rules/commits.md': 'Small commits.\n',
    'rules/ops/style.md': 'Ops style.\n',
    'skills/release/SKILL.md': SKILL('release'),
    'skills/lint/SKILL.md': SKILL('lint'),
    'skills/solo/SKILL.md': SKILL('solo'),
    'skills/dev/release/SKILL.md': SKILL('release'),
    'skills/dev/deploy/SKILL.md': SKILL('deploy'),
    'skills/ops/runbook/SKILL.md': SKILL('runbook'),
    'agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews.\n---\nReview.\n',
    'agents/dev/reviewer.yaml': 'name: reviewer\ndescription: Reviews for dev.\nprompt: Review.\n',
    'agents/planner.md': '---\nname: planner\ndescription: Plans.\n---\nPlan.\n',
    'docs/guide.md': 'Shared guide.\n',
    'docs/api/guide.md': 'Shared api guide.\n',
    'docs/ops/guide.md': 'Ops guide.\n',
    'hooks/hooks.yaml': 'hooks: []\n',
    'hooks/dev/hooks.yaml': 'hooks: []\n',
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'seed');
  return {
    config: {
      repo: { localPath: repo, remote: 'https://github.com/acme/team.git', kind: 'git' },
      username: 'tester', scope: 'project', ...(role !== null ? { primaryRole: role } : {}), additionalRoles: [], projects: [], subscribedTags: ['quality'], projectRoot: root, dataHome: path.join(root, 'data'),
    },
    revision: git(repo, 'rev-parse', 'HEAD'),
  };
}

describe('withoutRefusal', () => {
  it.each([
    ['a rule, CLAUDE.md, a shared skill no namespace shadows, and a skill in a namespace the member receives', ['CLAUDE.md', 'rules/commits.md', 'skills/dev/deploy', 'skills/lint']],
    ['a shared skill with the version its namespace delivers in its place', ['skills/dev/release', 'skills/release']],
    ['a shared skill with the whole namespace that delivers it in its place', ['skills/dev', 'skills/release']],
    ['a file inside a skill', ['skills/lint/SKILL.md']],
    ['a page in a docs directory no role or project declares', ['docs/api/guide.md']],
    ['a shared hooks file, whose entries a namespace adds to rather than replaces', ['hooks/hooks.yaml']],
    ['a shared agent no namespace the member receives has a version of', ['agents/planner.md']],
  ])('lets an arm run without %s', async (_case, paths) => {
    const { config, revision } = team();

    expect(await withoutRefusal(config, { arm: 'ablated', paths, revision })).toBeUndefined();
  });

  it.each([
    ['a path the revision does not have', ['rules/commits.md', 'skills/nope'], 'arm_team_unresolved',
      'Arm "ablated" runs without skills/nope, which team revision {r} does not have. Fix the arm\'s team, push it, run teamai pull, and start again.'],
    ['teamai.yaml', ['teamai.yaml'], 'arm_team_unresolved',
      'Arm "ablated" runs without teamai.yaml, which teamai pull reads to install the team, so no trial could run. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a skill in a namespace the member does not receive', ['skills/ops/runbook'], 'arm_team_unresolved',
      'Arm "ablated" runs without skills/ops/runbook, which is in namespace ops, and the arm\'s roles or projects don\'t receive ops, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a namespace the member does not receive', ['skills/ops'], 'arm_team_unresolved',
      'Arm "ablated" runs without skills/ops, which is in namespace ops, and the arm\'s roles or projects don\'t receive ops, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a shared skill no tag the member subscribes delivers to its role', ['skills/solo'], 'arm_team_unresolved',
      'Arm "ablated" runs without skills/solo, a shared skill, which the arm\'s roles or projects receive only through a subscribed tag, and none brings it, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a shared skill a namespace the member receives delivers in its place', ['skills/release'], 'arm_team_unresolved',
      'Arm "ablated" runs without skills/release, but its namespace dev delivers skills/dev/release in its place; list skills/dev/release too.'],
    ['a shared agent a namespace the member receives delivers in its place, in another format', ['agents/reviewer.md'], 'arm_team_unresolved',
      'Arm "ablated" runs without agents/reviewer.md, but its namespace dev delivers agents/dev/reviewer.yaml in its place; list agents/dev/reviewer.yaml too.'],
    ['a rule in a namespace the member does not receive', ['rules/ops/style.md'], 'arm_team_unresolved',
      'Arm "ablated" runs without rules/ops/style.md, which is in namespace ops, and the arm\'s roles or projects don\'t receive ops, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
    ['a page in a docs namespace a role declares and the member does not receive', ['docs/ops/guide.md'], 'arm_team_unresolved',
      'Arm "ablated" runs without docs/ops/guide.md, which is in namespace ops, and the arm\'s roles or projects don\'t receive ops, so leaving it out changes nothing. Remove it from the arm\'s team, push it, run teamai pull, and start again.'],
  ])('refuses an arm without %s', async (_case, paths, code, message) => {
    const { config, revision } = team();

    expect(await withoutRefusal(config, { arm: 'ablated', paths, revision })).toEqual({ code, message: message.replace('{r}', revision.slice(0, 7)) });
  });

  it('lets a member with no role or project run without a skill of any namespace, and a shared skill without its namespace versions refused', async () => {
    const { config, revision } = team({ role: null });

    expect(await withoutRefusal(config, { arm: 'ablated', paths: ['docs/guide.md', 'skills/ops/runbook', 'skills/solo'], revision })).toBeUndefined();
    expect(await withoutRefusal(config, { arm: 'ablated', paths: ['skills/release'], revision })).toEqual({
      code: 'arm_team_unresolved',
      message: 'Arm "ablated" runs without skills/release, but its namespace dev delivers skills/dev/release in its place; list skills/dev/release too.',
    });
  });

  it('lets an arm run without a namespaced skill in a team with no tags.yaml', async () => {
    const { config, revision } = team({ tags: false });

    expect(await withoutRefusal(config, { arm: 'ablated', paths: ['skills/dev/deploy'], revision })).toBeUndefined();
  });

  it('refuses an arm whose revision the team repo cannot read', async () => {
    const { config } = team();

    expect(await withoutRefusal(config, { arm: 'ablated', paths: ['CLAUDE.md'], revision: 'f'.repeat(40) })).toEqual({
      code: 'arm_team_unreadable',
      message: expect.stringMatching(/^Arm "ablated" runs without CLAUDE\.md, and git could not list team revision fffffff at .+: .+\. Repair the team repo, or run teamai pull, and start again\.$/),
    });
  });
});
