import fs from 'node:fs';
import path from 'node:path';
import fse from 'fs-extra';
import { pathExists, remove } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { TeamaiConfig, LocalConfig } from './types.js';
import { resolveToolBaseDir, isAgentExcluded, scopedToolPaths } from './types.js';
import { isToolInstalledForConfig, ResourceHandler } from './resources/base.js';
import { CODEX_TOOL, resolveSkillDestination, SHARED_AGENT_SKILLS_PATH } from './resources/skills.js';
import { getUserHome } from './utils/home.js';
import { packagedSkillRoots } from './skill-content.js';

// ─── Built-in skills deployment ──────────────────────────
//
//  The CLI ships one deployable skill: the `teamai` discovery
//  stub under skills/.  On each `teamai pull` its SKILL.md is
//  copied to local AI tool skill directories.  The workflow
//  content it points at is never copied — it lives under
//  skill-data/ and is printed by `teamai skill get`, so what
//  the agent reads always matches the installed CLI version.
//
//  npm package
//    skills/teamai/SKILL.md          (about 2 KB)
//      │
//      ▼  (teamai pull / teamai init)
//    ~/.claude/skills/teamai/SKILL.md
//    ~/.codex-internal/skills/teamai/SKILL.md
//    ~/.cursor/skills/teamai/SKILL.md
//    ...
//
//    skill-data/{core,setup,wiki,share}/   never copied
//

/**
 * Names of CLI built-in skills. Used by push to exclude them from team repo
 * push, by pull cleanup, and by uninstall.
 */
export const BUILTIN_SKILL_NAMES = new Set(['teamai']);

/**
 * Built-in skill directories earlier releases deployed, kept only so that pull
 * can remove them from agent skills directories. Retire this set once 0.23.x is
 * no longer in the field.
 *
 * Only names the CLI actually wrote belong here. `teamai-workflow` and
 * `teamai-import` were reserved in the old BUILTIN_SKILL_NAMES guard but never
 * packaged, so a directory by either name is a user's own skill and must not be
 * removed.
 */
export const LEGACY_BUILTIN_SKILL_NAMES = new Set([
  'teamai-share-learnings',
  'team-wiki-codebase',
]);

/**
 * Remove the skill directories earlier releases deployed.
 *
 * Unconditional: those trees were overwritten on every pull (`overwrite: true`),
 * so no local edit ever survived in them, and leaving them behind costs every
 * agent on the machine the context they were deployed to save.
 */
async function pruneLegacyBuiltinSkills(tool: string, configuredSkillsPath: string, baseDir: string): Promise<void> {
  // The shared .agents/skills directory belongs to Codex alone. Reaching it from
  // another tool's pass would delete Codex's copies while Codex is excluded or
  // not installed, which the enabledAgents whitelist rules out.
  const skillRoots = [configuredSkillsPath];
  if (tool === CODEX_TOOL) skillRoots.push(SHARED_AGENT_SKILLS_PATH);
  for (const legacyName of LEGACY_BUILTIN_SKILL_NAMES) {
    for (const root of skillRoots) {
      const dir = path.join(baseDir, root, legacyName);
      if (!await pathExists(dir)) continue;
      try {
        await remove(dir);
        log.debug(`Removed legacy built-in skill ${legacyName} from ${tool} (${dir})`);
      } catch (e) {
        log.debug(`Could not remove legacy built-in skill ${legacyName} from ${tool}: ${(e as Error).message}`);
      }
    }
  }
}

/**
 * Deploy CLI built-in skills to all configured AI tool skill directories.
 *
 * Copies the SKILL.md of each skill in the npm package's skills/ folder to
 * every tool's skills path defined in teamai.yaml. Only that one file: the
 * deployed unit is a discovery stub, and its workflow content is served by
 * `teamai skill get` from skill-data/.
 *
 * The stub is written verbatim — no frontmatter repair on the way out, so a
 * deployed copy that differs from the packaged one is a bug, not a variant.
 *
 * Silently skips if:
 * - Built-in skills directory doesn't exist (dev environment without build)
 * - A tool's skills directory is not configured
 */
export async function deployBuiltinSkills(teamConfig: TeamaiConfig, localConfig?: LocalConfig, options?: { reportingOnly?: boolean }): Promise<number> {
  // Reporting-only HTTP mode has no team repo to write to, so the workflows the
  // stub routes to are non-functional there. Nothing is deployed, but the
  // directories earlier releases left behind are still removed: a team that
  // switched to reporting-only would otherwise keep them for good.
  const deploy = !options?.reportingOnly;
  if (!deploy) {
    log.debug('Reporting-only mode (no team repo): pruning legacy built-in skills without deploying');
  }

  const builtinDir = packagedSkillRoots().deployRoot;

  if (!await pathExists(builtinDir)) {
    log.debug('No built-in skills directory found, skipping deployment');
    return 0;
  }

  let entries: string[];
  try {
    entries = await fs.promises.readdir(builtinDir);
  } catch {
    return 0;
  }

  // Filter to directories that contain SKILL.md
  const skillNames: string[] = [];
  for (const entry of entries) {
    const skillMd = path.join(builtinDir, entry, 'SKILL.md');
    if (await pathExists(skillMd)) {
      skillNames.push(entry);
    }
  }

  if (deploy && skillNames.length === 0) return 0;

  const defaultBaseDir = getUserHome();
  let deployed = 0;

  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig ?? {}))) {
    if (!toolPath.skills) continue;
    const baseDir = localConfig ? resolveToolBaseDir(tool, localConfig) : defaultBaseDir;

    // Skip tools that are not installed
    const installed = localConfig
      ? await isToolInstalledForConfig(tool, toolPath.skills, localConfig)
      : await ResourceHandler.isToolInstalled(toolPath.skills, baseDir);
    if (!installed) {
      log.debug(`Skipping built-in skill deployment for ${tool}: tool not installed`);
      continue;
    }
    // An excluded agent is neither written to nor deleted from (usage-guide:
    // "the enabledAgents whitelist also gates CLI built-in skills"), so its
    // legacy directories are left alone too.
    if (localConfig && isAgentExcluded(localConfig, tool)) continue;

    await pruneLegacyBuiltinSkills(tool, toolPath.skills, baseDir);
    if (!deploy) continue;

    for (const skillName of skillNames) {
      const srcDir = path.join(builtinDir, skillName);
      const destDir = await resolveSkillDestination(tool, toolPath.skills, baseDir, skillName, srcDir);

      try {
        await fse.ensureDir(destDir);
        // Releases before the discovery stub deployed this same directory with a
        // references/ tree beside SKILL.md. Copying one file over it would leave
        // ~39 KB of pre-stub instructions in place forever, so everything the
        // deployed unit does not contain goes first.
        for (const entry of await fs.promises.readdir(destDir)) {
          if (entry === 'SKILL.md') continue;
          await remove(path.join(destDir, entry));
          log.debug(`Removed stale built-in skill file ${skillName}/${entry} from ${tool}`);
        }
        await fse.copy(path.join(srcDir, 'SKILL.md'), path.join(destDir, 'SKILL.md'), { overwrite: true });

        deployed++;
      } catch (e) {
        log.error(`Failed to deploy built-in skill ${skillName} to ${toolPath.skills}: ${(e as Error).message}`);
      }
    }
  }

  return deployed;
}
