/**
 * Plan's check of an arm's `team: { without: paths }`, before any run exists: each path is a file or directory of the
 * arm's team revision, and leaving it out changes what teamai pull delivers to the arm's trials. Pull's own resolvers
 * decide that, at the revision with the arm's other paths left out, once with the path and once without it.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTeamConfig } from '../config.js';
import {
  buildRolePullContext, collectClaudemdFiles, describeDeliveryConflict, resolveDesiredAgents, resolveDesiredRules,
  resolveDesiredSkills, type DeliveryConflict,
} from '../resources/desired.js';
import { resolveDesiredDocs } from '../resources/docs.js';
import type { LocalConfig } from '../types.js';
import { withTeamRevision } from '../workflow/cache.js';
import type { TeamSelection } from '../workflow/clone.js';
import { git } from '../workflow/worktree.js';

/** Why plan refuses the arm: git could not read its team revision, or a path changes nothing its trials get. */
type Refusal = { code: 'arm_team_unreadable' | 'arm_team_unresolved'; message: string };

/** What teamai pull delivers from one tree of the team repo, as its resolvers say, and `key`, the whole of it as text. */
type Delivery = Awaited<ReturnType<typeof deliveryAt>>;

/** The team repo directories pull's resolvers deliver from, and so the paths plan can tell change nothing. */
const RESOLVED = new Set(['skills', 'rules', 'agents', 'claudemd', 'docs']);

const REMOVE = 'Remove it from the arm\'s team, push it, run teamai pull, and start again.';

/**
 * Why plan refuses arm `arm` that runs without `paths` at team commit `revision`, or undefined when its trials can run
 * without them. `config` is the member's; `selection`, the assets the run's clones install. Refused: a path the revision
 * does not have; teamai.yaml, which the clone's pull reads; and a path under skills/, rules/, agents/, claudemd/ or docs/
 * whose leaving out leaves what pull delivers as it was, with the reason pull's resolvers give.
 */
export async function withoutRefusal(
  config: LocalConfig,
  { arm, paths, revision, selection }: { arm: string; paths: readonly string[]; revision: string; selection: TeamSelection },
): Promise<Refusal | undefined> {
  const short = revision.slice(0, 7);
  const listed = await git(config.repo.localPath, ['ls-tree', '-r', '-z', '--name-only', revision]);
  if (listed.code !== 0) {
    return { code: 'arm_team_unreadable', message: `Arm "${arm}" runs without ${paths.join(', ')}, and git could not list team revision ${short} at ${config.repo.localPath}: ${listed.stderr.trim()}. Repair the team repo, or run teamai pull, and start again.` };
  }
  const files = listed.stdout.split('\0').filter((file) => file !== '');
  const missing = paths.find((one) => !files.some((file) => leavesOut([one], file)));
  if (missing !== undefined) {
    return { code: 'arm_team_unresolved', message: `Arm "${arm}" runs without ${missing}, which team revision ${short} does not have. Fix the arm's team, push it, run teamai pull, and start again.` };
  }
  if (paths.includes('teamai.yaml')) {
    return { code: 'arm_team_unresolved', message: `Arm "${arm}" runs without teamai.yaml, which teamai pull reads to install the team, so no trial could run. ${REMOVE}` };
  }
  // The member as the clone's own pull reads it: the run's selection, on a scope with no state of its own.
  const member: LocalConfig = { repo: config.repo, username: config.username, scope: 'project', projectRoot: config.projectRoot, ...selection };
  const read = await withTeamRevision(member, revision, async (at) => {
    const repo = at.repo.localPath;
    const held = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-without-'));
    const move = async (from: string, to: string, one: string): Promise<void> => {
      await fs.mkdir(path.dirname(path.join(to, one)), { recursive: true });
      await fs.rename(path.join(from, one), path.join(to, one));
    };
    try {
      for (const one of paths) await move(repo, held, one);
      const present = (left: readonly string[]): string[] => files.filter((file) => !leavesOut(left, file));
      const without = await deliveryAt(at, present(paths));
      for (const one of paths) {
        if (!RESOLVED.has(one.split('/')[0] ?? '')) continue;
        await move(held, repo, one);
        const withIt = await deliveryAt(at, present(paths.filter((other) => other !== one)));
        if (withIt.key === without.key) return unchanged({ arm, path: one, short, at, withIt, without });
        await move(repo, held, one);
      }
      return undefined;
    } finally {
      await fs.rm(held, { recursive: true, force: true });
    }
  });
  if (typeof read === 'object') {
    return { code: 'arm_team_unreadable', message: `Arm "${arm}" runs without ${paths.join(', ')}, and what teamai pull delivers at team revision ${short} could not be read: ${read.failed}. Repair the team repo, or run teamai pull, and start again.` };
  }
  return read === undefined ? undefined : { code: 'arm_team_unresolved', message: read };
}

/** Whether running without `paths` leaves out `file`: one of them is that path, or a directory that holds it. */
export function leavesOut(paths: readonly string[], file: string): boolean {
  return paths.some((listed) => file === listed || file.startsWith(`${listed}/`));
}

/** What pull delivers from the team repo `at` names, whose files are `present`, by pull's resolvers. */
async function deliveryAt(at: LocalConfig, present: readonly string[]) {
  const team = await loadTeamConfig(at.repo.localPath);
  if (team === null) throw new Error('its teamai.yaml cannot be read');
  const context = await buildRolePullContext(at);
  const [skills, rules, agents, claudemd, docs] = await Promise.all([
    resolveDesiredSkills(team, at, context), resolveDesiredRules(team, at, context), resolveDesiredAgents(team, at, context),
    collectClaudemdFiles(at, context), resolveDesiredDocs(at.repo.localPath, context?.inactiveDocsNamespaces ?? []),
  ]);
  const sources = (items: ReadonlyArray<{ relativePath: string }>): string[] => items.map((item) => item.relativePath).sort();
  const key = JSON.stringify({
    // A skill is delivered as its directory, so each file in it is part of what the trial gets.
    skills: skills.kind === 'resolved' ? sources(skills.items).map((source) => present.filter((file) => file.startsWith(`${source}/`))) : describeDeliveryConflict(skills),
    rules: sources(rules.items),
    agents: agents.kind === 'resolved' ? sources(agents.items) : describeDeliveryConflict(agents),
    claudemd: claudemd.contents,
    docs: docs.files,
  });
  return { key, context, skills, rules, agents, claudemd, docs };
}

/**
 * Why pull delivers the same with `path` as without it, from what its resolvers gave with it (`withIt`) and without
 * it: pull delivers no skills or agents, the item is one the member excludes, its namespace does not reach the member,
 * another item stands in its place, or the tag channel leaves it out.
 */
function unchanged(input: { arm: string; path: string; short: string; at: LocalConfig; withIt: Delivery; without: Delivery }): string {
  const { arm, path: listed, short, at, withIt, without } = input;
  const covers = (source: string): boolean => leavesOut([listed], source) || leavesOut([source], listed);
  const runs = `Arm "${arm}" runs without ${listed}`;
  const inPlace = (source: string, namespace: string | undefined): string => `${runs}, but ${namespace === undefined ? 'the team root' : `its namespace ${namespace}`} delivers ${source} in its place; list ${source} too.`;
  const inactive = (namespace: string): string => `${runs}, which is in namespace ${namespace}, and the arm's roles or projects don't receive ${namespace}, so leaving it out changes nothing. ${REMOVE}`;
  const noneOf = (conflict: DeliveryConflict): string => `${runs}, and teamai pull delivers no ${conflict.type}s at team revision ${short} with or without it: ${describeDeliveryConflict(conflict)}. Fix that in the team repo, push it, run teamai pull, and start again.`;
  // The namespace a team path `<root>/<namespace>/...` is in, when the member receives none of `active`.
  const notReceived = (active: readonly string[] | undefined): string | undefined => {
    const [, namespace, ...rest] = listed.split('/');
    return active !== undefined && namespace !== undefined && rest.length > 0 && !active.includes(namespace) ? namespace : undefined;
  };
  const replacing = (overrides: ReadonlyArray<{ source: string; replaces: string }>): string | undefined => {
    const override = overrides.find((one) => covers(one.replaces));
    return override && inPlace(override.source, override.source.split('/')[1]);
  };
  const { context } = withIt;
  const active = context?.activeNamespaces;
  switch (listed.split('/')[0]) {
    case 'skills': {
      if (withIt.skills.kind === 'conflict') return noneOf(withIt.skills);
      const delivered = withIt.skills.items;
      const item = withIt.skills.teamItems.find((one) => covers(one.relativePath) && !delivered.some((other) => other.relativePath === one.relativePath));
      if (item === undefined) break;
      if (at.excludedSkills?.includes(item.name)) return `${runs}, skill ${item.name}, which the member excludes, so pull leaves it out already and leaving it out changes nothing. ${REMOVE}`;
      if (item.namespace !== undefined && active && !active.skills.includes(item.namespace)) return inactive(item.namespace);
      const standIn = delivered.find((one) => one.name === item.name);
      if (standIn) return inPlace(standIn.relativePath, standIn.namespace);
      if (item.namespace === undefined && context) return `${runs}, a shared skill, which the arm's roles or projects receive only through a subscribed tag, and none brings it, so leaving it out changes nothing. ${REMOVE}`;
      break;
    }
    case 'rules': {
      const namespace = notReceived(active?.knowledge);
      if (namespace !== undefined) return inactive(namespace);
      if (withIt.rules.skippedByTags > without.rules.skippedByTags) return `${runs}, a rule tagged only with tags the member does not subscribe, so pull leaves it out already and leaving it out changes nothing. ${REMOVE}`;
      return replacing(withIt.rules.overrides) ?? generic();
    }
    case 'agents': {
      if (withIt.agents.kind === 'conflict') return noneOf(withIt.agents);
      const namespace = notReceived(active?.agents);
      return namespace !== undefined ? inactive(namespace) : replacing(withIt.agents.overrides) ?? generic();
    }
    case 'claudemd': {
      const namespace = notReceived(active?.knowledge);
      return namespace !== undefined ? inactive(namespace) : replacing(withIt.claudemd.overrides) ?? generic();
    }
    case 'docs': {
      const withheld = withIt.docs.withheld.find(({ dir }) => covers(`docs/${dir}`));
      if (withheld) return inactive(withheld.dir);
      break;
    }
    default:
      break;
  }
  return generic();

  function generic(): string {
    return `${runs}, and teamai pull delivers the same team assets at team revision ${short} with or without it, so leaving it out changes nothing. ${REMOVE}`;
  }
}
