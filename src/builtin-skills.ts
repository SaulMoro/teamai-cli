import fs from 'node:fs';
import path from 'node:path';
import fse from 'fs-extra';
import { pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { TeamaiConfig, LocalConfig } from './types.js';
import { resolveToolBaseDir, isAgentExcluded, scopedToolPaths } from './types.js';
import { isToolInstalledForConfig, ResourceHandler } from './resources/base.js';
import { resolveSkillDestination } from './resources/skills.js';
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
 */
export const LEGACY_BUILTIN_SKILL_NAMES = new Set([
  'teamai-share-learnings',
  'team-wiki-codebase',
  'teamai-workflow',
  'teamai-import',
]);

/**
 * Built-in skills that depend on recall being enabled. Skipped when recall is disabled.
 *
 * Only teamai-share-learnings belongs here: it contributes learnings back to the
 * team repo, which is meaningful only when recall is on. team-wiki-codebase is a
 * knowledge-base generator and does not depend on recall, so it must always deploy.
 */
export const RECALL_DEPENDENT_SKILLS = new Set(['teamai-share-learnings']);

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
export async function deployBuiltinSkills(teamConfig: TeamaiConfig, localConfig?: LocalConfig, options?: { reportingOnly?: boolean; skipRecall?: boolean }): Promise<number> {
  // Reporting-only HTTP mode has no team repo to write to, so the workflows the
  // stub routes to are non-functional there. Skip built-in skills entirely.
  if (options?.reportingOnly) {
    log.debug('Reporting-only mode (no team repo): skipping built-in skills');
    return 0;
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
    if (options?.skipRecall && RECALL_DEPENDENT_SKILLS.has(entry)) continue;
    const skillMd = path.join(builtinDir, entry, 'SKILL.md');
    if (await pathExists(skillMd)) {
      skillNames.push(entry);
    }
  }

  if (skillNames.length === 0) return 0;

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
    if (localConfig && isAgentExcluded(localConfig, tool)) continue;

    for (const skillName of skillNames) {
      const srcDir = path.join(builtinDir, skillName);
      const destDir = await resolveSkillDestination(tool, toolPath.skills, baseDir, skillName, srcDir);

      try {
        await fse.ensureDir(destDir);
        await fse.copy(path.join(srcDir, 'SKILL.md'), path.join(destDir, 'SKILL.md'), { overwrite: true });

        deployed++;
      } catch (e) {
        log.error(`Failed to deploy built-in skill ${skillName} to ${toolPath.skills}: ${(e as Error).message}`);
      }
    }
  }

  return deployed;
}
