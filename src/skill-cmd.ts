import path from 'node:path';
import { autoDetectInit } from './config.js';
import { log } from './utils/logger.js';
import { listDirs, pathExists } from './utils/fs.js';
import { SkillsHandler } from './resources/skills.js';
import { loadTagsConfig } from './utils/tags.js';
import {
  buildClassifyContext,
  classifySkill,
  formatSkillSource,
  readSkillDescription,
  truncate,
  type SkillSource,
} from './agent-skills.js';
import { detectInstalledAgents, type ResolvedAgent } from './known-agents.js';
import { blockedByRecall, resolvePackagedSkill, skillCatalog } from './skill-content.js';
import type { GlobalOptions, LocalConfig } from './types.js';

const DESCRIPTION_MAX = 160;

interface ResolvedSkill {
  name: string;
  /** Path used to read SKILL.md, contributors and description. */
  primaryPath: string;
  /** Where the primary copy was discovered. */
  primaryOrigin: 'team' | 'agent' | 'builtin';
  /** Optional namespace if found in the team repo. */
  namespace?: string;
}

/**
 * `teamai skill show <name>` — print metadata about a single
 * skill: source classification, contributors, namespace, tags
 * and which installed agents currently host it.
 *
 * The full SKILL.md body is intentionally not rendered; users
 * who need the markdown can `cat` it directly using the path
 * we print under "Repo path" or "Installed in".
 */
export async function skillShow(name: string, options: GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit();

  const agents = await detectInstalledAgents(localConfig, teamConfig);
  const resolved = await locateSkill(name, localConfig, agents);
  if (!resolved) {
    log.error(`Skill "${name}" not found in team repo or any installed agent.`);
    log.dim('Try `teamai list --source all` to see available skills.');
    process.exitCode = 1;
    return;
  }

  const resolvedName = resolved.name;

  // The recall gate holds here too: `skill get` and `skill path` withhold the
  // share workflow while recall is off, and the card would otherwise print the
  // very directory they refuse.
  if (resolved.primaryOrigin === 'builtin' && await blockedByRecall(resolvedName)) {
    log.error(`${resolvedName} needs recall, which is disabled for this team.`);
    log.dim('Turn it on with `teamai recall enable`, or ask your team admin to enable sharing.');
    process.exitCode = 1;
    return;
  }

  // A skill served from the package is built in by construction; BUILTIN_SKILL_NAMES
  // only knows the deployed stub, so classifying by name would call `core` local-only.
  const source: SkillSource = resolved.primaryOrigin === 'builtin'
    ? { kind: 'builtin' }
    : classifySkill(resolvedName, await buildClassifyContext(localConfig));

  const description = truncate(await readSkillDescription(path.join(resolved.primaryPath, 'SKILL.md')), DESCRIPTION_MAX);
  const contributors = await SkillsHandler.readContributors(resolved.primaryPath);

  const tagsConfig = await loadTagsConfig(localConfig.repo.localPath);
  const tags = tagsConfig?.skills?.[resolvedName] ?? [];

  const installedIn = await collectInstalledAgents(resolvedName, agents);

  printSkillCard({
    name: resolvedName,
    source,
    namespace: resolved.namespace ?? (source.kind === 'team' ? source.namespace : undefined),
    description,
    contributors,
    tags,
    primaryPath: resolved.primaryPath,
    primaryOrigin: resolved.primaryOrigin,
    installedIn,
  });

  if (options.verbose) {
    console.log('');
    console.log(`  Verbose: SKILL.md path is ${path.join(resolved.primaryPath, 'SKILL.md')}`);
  }
}

/**
 * `teamai skill` / `teamai skill list` — the repo and installed-agent listing,
 * plus the catalog the installed CLI serves on demand.
 */
export async function skillList(options: GlobalOptions & { json?: boolean }): Promise<void> {
  const catalog = await skillCatalog();

  if (options.json) {
    console.log(JSON.stringify({ skills: catalog }, null, 2));
    return;
  }

  const { list } = await import('./status.js');
  await list('skills', { ...options, source: 'all' });

  console.log('=== BUILT-IN SKILLS (served by the CLI) ===');
  console.log('');
  if (catalog.length === 0) {
    console.log('  (none — the installed package ships no skill content)');
  } else {
    for (const entry of catalog) {
      console.log(`  ${entry.name}${entry.blockedByRecall ? '  (needs recall — teamai recall enable)' : ''}`);
      console.log(`    ${truncate(entry.description, DESCRIPTION_MAX) || '(no description)'}`);
      console.log(`    teamai skill get ${entry.name}`);
    }
  }
  console.log('');
}

async function locateSkill(
  name: string,
  localConfig: LocalConfig,
  agents: ResolvedAgent[],
): Promise<ResolvedSkill | null> {
  const teamSkillsDir = path.join(localConfig.repo.localPath, 'skills');

  // 1. Flat layout in team repo
  const flat = path.join(teamSkillsDir, name);
  if (await pathExists(path.join(flat, 'SKILL.md'))) {
    return { name, primaryPath: flat, primaryOrigin: 'team' };
  }

  // 2. Namespaced layout in team repo
  if (await pathExists(teamSkillsDir)) {
    const namespaces = await listDirs(teamSkillsDir);
    for (const ns of namespaces) {
      const candidate = path.join(teamSkillsDir, ns, name);
      if (await pathExists(path.join(candidate, 'SKILL.md'))) {
        return { name, primaryPath: candidate, primaryOrigin: 'team', namespace: ns };
      }
    }
  }

  // 3. Built-in skill served by the CLI (including legacy-name aliases).
  //    Resolved before the agent fallback: under the discovery-stub model the
  //    agent directory holds a stub, not the content this command describes.
  const packaged = await resolvePackagedSkill(name);
  if (packaged) {
    return { name: packaged.name, primaryPath: packaged.dir, primaryOrigin: 'builtin' };
  }

  // 4. First installed agent that has the skill
  for (const agent of agents) {
    if (!agent.installed) continue;
    const candidate = path.join(agent.absoluteSkillsPath, name);
    if (await pathExists(path.join(candidate, 'SKILL.md'))) {
      return { name, primaryPath: candidate, primaryOrigin: 'agent' };
    }
  }

  return null;
}

async function collectInstalledAgents(
  name: string,
  agents: ResolvedAgent[],
): Promise<Array<{ agent: ResolvedAgent; path: string }>> {
  const matches: Array<{ agent: ResolvedAgent; path: string }> = [];
  for (const agent of agents) {
    if (!agent.installed) continue;
    const skillDir = path.join(agent.absoluteSkillsPath, name);
    if (await pathExists(path.join(skillDir, 'SKILL.md'))) {
      matches.push({ agent, path: skillDir });
    }
  }
  return matches;
}

const PRIMARY_PATH_LABEL: Record<ResolvedSkill['primaryOrigin'], string> = {
  team: 'Repo path  ',
  agent: 'Source path',
  builtin: 'Package path',
};

interface SkillCard {
  name: string;
  source: SkillSource;
  namespace?: string;
  description: string;
  contributors: string[];
  tags: string[];
  primaryPath: string;
  primaryOrigin: ResolvedSkill['primaryOrigin'];
  installedIn: Array<{ agent: ResolvedAgent; path: string }>;
}

function printSkillCard(card: SkillCard): void {
  const bar = '='.repeat(60);
  console.log('');
  console.log(bar);
  console.log(`  skill: ${card.name}`);
  console.log(bar);
  console.log('');

  console.log(`  Source       : ${formatSkillSource(card.source)}`);
  if (card.namespace) {
    console.log(`  Namespace    : ${card.namespace}`);
  }
  console.log(`  Description  : ${card.description || '(none)'}`);
  console.log(`  Contributors : ${card.contributors.length > 0 ? card.contributors.join(', ') : '(none)'}`);
  console.log(`  Tags         : ${card.tags.length > 0 ? card.tags.join(', ') : '(none)'}`);
  console.log(`  ${PRIMARY_PATH_LABEL[card.primaryOrigin]}  : ${card.primaryPath}/`);
  if (card.primaryOrigin === 'builtin') {
    console.log(`  Read it with : teamai skill get ${card.name}`);
  }

  if (card.installedIn.length === 0) {
    console.log('  Installed in : (not installed in any agent yet)');
  } else {
    const first = card.installedIn[0];
    console.log(`  Installed in : ${first.agent.id} (${first.path})`);
    for (let i = 1; i < card.installedIn.length; i++) {
      const entry = card.installedIn[i];
      console.log(`                 ${entry.agent.id} (${entry.path})`);
    }
  }
  console.log('');
}
