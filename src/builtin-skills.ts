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
 * The legacy directory that depended on recall. `teamai recall disable` still
 * removes it, as it did before the stub, so a member who upgrades and disables
 * recall before their next pull is not left with the old share workflow.
 */
export const LEGACY_RECALL_SKILL_NAMES = new Set(['teamai-share-learnings']);

/**
 * Whether a skill directory by this name is the CLI's, current or legacy, and
 * therefore never a user's own to push. A member who runs `teamai push --all`
 * after upgrading but before pulling still has the legacy trees on disk.
 */
export function isCliOwnedSkillName(name: string): boolean {
  return BUILTIN_SKILL_NAMES.has(name) || LEGACY_BUILTIN_SKILL_NAMES.has(name);
}

/**
 * Every file a release ever packaged under `skills/`, by directory name.
 *
 * Built as the union of `git ls-tree -r <tag> -- skills/` over all 91 tags, plus
 * `references/provider-tgit.md`, which main carries unreleased and the next
 * release therefore ships. Every path listed here is written by the CLI and is
 * ours to remove. Deployment
 * copied these trees with `overwrite: true` and never deleted anything, so a
 * file that is *not* listed here was put there by the member and survives.
 *
 * `teamai-wiki` (0.13.0, 0.16.x) is deliberately absent: it predates the trees
 * this migration is about, and widening a destructive set is its own change.
 */
export const PACKAGED_SKILL_FILES: ReadonlyMap<string, readonly string[]> = new Map([
  ['teamai', [
    'SKILL.md',
    'references/contribute-member.md',
    'references/join-member.md',
    'references/manage-admin.md',
    'references/provider-tgit.md',
    'references/setup-admin.md',
    'references/troubleshooting.md',
    'references/uninstall.md',
  ]],
  ['teamai-share-learnings', ['SKILL.md']],
  ['team-wiki-codebase', [
    'SKILL.md',
    'README.md',
    'references/agents/graph-rag-agent.md',
    'references/agents/kb-doc-generator.md',
    'references/methodology/phase0-collection.md',
    'references/methodology/phase1-reverse-engineering.md',
    'references/methodology/phase2-document-types.md',
    'references/methodology/phase3-ai-enhancement.md',
    'references/methodology/phase4-quality.md',
    'references/templates/project-overview.md',
    'scripts/scan_repo.py',
    'scripts/validate_kb.py',
  ]],
]);

/**
 * Python bytecode cache of a script we shipped. Compiler output of our own
 * files, so it carries nothing a member wrote and does not make a directory
 * theirs.
 */
function isDerivedArtifact(relativePath: string): boolean {
  return relativePath.endsWith('.pyc') || relativePath.split('/').includes('__pycache__');
}

/** Every file under `dir`, as paths relative to it. Symlinks count as files. */
async function walkFiles(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...await walkFiles(path.join(dir, entry.name), relative));
    } else {
      found.push(relative);
    }
  }
  return found;
}

/** Remove `dir` and every directory under it that holds nothing. */
async function removeEmptyDirs(dir: string): Promise<void> {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirs(path.join(dir, entry.name));
  }
  // Fails when something is left, which is the point: that something is the
  // member's, and their directory stays.
  try { await fs.promises.rmdir(dir); } catch { /* not empty */ }
}

/**
 * Remove from `dir` the files the CLI put there, then the directories that end
 * up empty. Returns false when the member has files of their own in there, so
 * the caller can say the directory was kept.
 *
 * Exported because uninstall must delete a CLI-owned skill directory by the same
 * rule pull does: a file a member added beside our packaged ones was never ours
 * to write and is not ours to remove, whichever command is doing the removing.
 */
export interface PruneResult {
  /** True when the root is a symlink, so nothing under it was read or removed. */
  skippedSymlink: boolean;
  /** Files left in place because the member, not the CLI, put them there. */
  foreign: number;
  /** Files left in place because their backup could not be written, and why. */
  unbackedUp: { file: string; error: string }[];
  /** Whether anything was actually copied, so a log only names a backup that exists. */
  backedUp: number;
}

/** True when the directory is gone: nothing of the member's, nothing unsaved. */
export function prunedWhole(result: PruneResult): boolean {
  return !result.skippedSymlink && result.foreign === 0 && result.unbackedUp.length === 0;
}

export async function removeOwnedFiles(
  dir: string,
  owned: readonly string[],
  backupDir?: string,
): Promise<PruneResult> {
  const ownedPaths = new Set(owned);
  const result: PruneResult = { skippedSymlink: false, foreign: 0, unbackedUp: [], backedUp: 0 };

  // A symlinked skill root points at files we never wrote — a shared checkout,
  // a dotfiles repo. `readdir` follows it and every path under it would match
  // ours by name, so the walk would delete someone else's files through the
  // link. Ownership stops at the link.
  if ((await fs.promises.lstat(dir)).isSymbolicLink()) {
    result.skippedSymlink = true;
    return result;
  }

  for (const relative of await walkFiles(dir)) {
    if (!ownedPaths.has(relative) && !isDerivedArtifact(relative)) {
      result.foreign++;
      continue;
    }
    const file = path.join(dir, relative);
    // Ownership is proven by pathname, not by contents: a member who edited one
    // of our files in place still has that edit in there. The old deployment
    // overwrote it on the next pull, so nothing was preserved either way, but a
    // path a retired release shipped and the current package no longer does was
    // never overwritten. Park a copy before removing so no version of that is a
    // one-way door.
    if (backupDir) {
      try {
        // `errorOnExist` turns a colliding path into a failure rather than a
        // silent overwrite: a lost copy would be the data loss this exists to
        // prevent, wearing the log line of a success.
        await fse.copy(file, path.join(backupDir, relative), { overwrite: false, errorOnExist: true });
        result.backedUp++;
      } catch (e) {
        // A full disk, a read-only home, a colliding copy. Keep the file: a
        // backup that did not happen must not authorise the delete.
        result.unbackedUp.push({ file, error: (e as Error).message });
        continue;
      }
    }
    await remove(file);
  }
  await removeEmptyDirs(dir);

  return result;
}

/**
 * One backup root per process run. A date alone collides: two pulls on the same
 * day would have the second overwrite the first's copies.
 */
const PRUNE_RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;

/**
 * Where the prune parks what it removes: outside every agent directory, so no
 * agent reads it back as a skill, and under the member's own `~/.teamai`.
 *
 * The skill root is part of the path because one tool can prune the same skill
 * name from two roots — Codex reads `.codex/skills` and the shared
 * `.agents/skills` — and those two copies are different files.
 */
function skillBackupDir(tool: string, skillRoot: string, skillName: string): string {
  const rootSlug = skillRoot.replace(/[\\/:]+/g, '-').replace(/^-+/, '');
  // Machine data, not project data: under project scope `baseDir` is the repo
  // root, where a backup per session start would show up as a dirty tree.
  return path.join(getUserHome(), '.teamai', 'removed-skills', PRUNE_RUN_ID, tool, rootSlug, skillName);
}

/**
 * Remove the skill directories earlier releases deployed.
 *
 * Only the files those releases packaged: each was overwritten on every pull
 * (`overwrite: true`), so no local edit ever survived in one, while a file the
 * member added beside them was never touched and is not ours to delete. A
 * directory that still holds such a file is kept, and the member is told.
 */
export async function pruneLegacyBuiltinSkills(
  tool: string,
  configuredSkillsPath: string,
  baseDir: string,
  names: ReadonlySet<string> = LEGACY_BUILTIN_SKILL_NAMES,
): Promise<void> {
  // The shared .agents/skills directory belongs to Codex alone. Reaching it from
  // another tool's pass would delete Codex's copies while Codex is excluded or
  // not installed, which the enabledAgents whitelist rules out.
  const skillRoots = [configuredSkillsPath];
  if (tool === CODEX_TOOL) skillRoots.push(SHARED_AGENT_SKILLS_PATH);
  for (const legacyName of names) {
    for (const root of skillRoots) {
      const dir = path.join(baseDir, root, legacyName);
      if (!await pathExists(dir)) continue;
      try {
        const backupDir = skillBackupDir(tool, root, legacyName);
        const result = await removeOwnedFiles(dir, PACKAGED_SKILL_FILES.get(legacyName) ?? [], backupDir);
        const saved = result.backedUp > 0 ? `; a copy is in ${backupDir}` : '';
        if (prunedWhole(result)) {
          log.debug(`Removed legacy built-in skill ${legacyName} from ${tool} (${dir})${saved}`);
        } else if (result.unbackedUp.length > 0) {
          log.warn(`Kept "${legacyName}" (${tool}): ${result.unbackedUp.length} file(s) in ${dir} could not be backed up, so they were not removed. First: ${result.unbackedUp[0].file} — ${result.unbackedUp[0].error}`);
        } else {
          log.warn(`Kept "${legacyName}" (${tool}): ${dir} holds files TeamAI did not put there. The packaged files were removed${saved}; delete the rest yourself once you have saved what you need.`);
        }
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
 * Reporting-only HTTP teams get the stub too. The release before this one had
 * nothing to deploy there that worked without a team repo, so it deployed
 * nothing; the stub's content is served by the installed CLI, and `skill get
 * wiki` — a local knowledge-base generator — needs no repo at all. Skipping it
 * while still pruning the legacy trees would leave those members with no
 * discoverable entry point at all.
 *
 * Silently skips if:
 * - Built-in skills directory doesn't exist (dev environment without build)
 * - A tool's skills directory is not configured
 */
export async function deployBuiltinSkills(teamConfig: TeamaiConfig, localConfig?: LocalConfig): Promise<number> {
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
    // An excluded agent is neither written to nor deleted from (usage-guide:
    // "the enabledAgents whitelist also gates CLI built-in skills"), so its
    // legacy directories are left alone too.
    if (localConfig && isAgentExcluded(localConfig, tool)) continue;

    await pruneLegacyBuiltinSkills(tool, toolPath.skills, baseDir);

    for (const skillName of skillNames) {
      const srcDir = path.join(builtinDir, skillName);
      const destDir = await resolveSkillDestination(tool, toolPath.skills, baseDir, skillName, srcDir);

      try {
        // Releases before the discovery stub deployed this same directory with a
        // references/ tree beside SKILL.md. Copying one file over it would leave
        // ~39 KB of pre-stub instructions in place forever, so the files those
        // releases wrote go first — and only those: a file a member added here
        // is theirs, and the old deployment never deleted it either.
        if (await pathExists(destDir)) {
          // Only the paths this release no longer ships. `SKILL.md` is written
          // one line below, so pruning it would archive an identical copy on
          // every session start and never reach a file worth keeping.
          const shippedNow = new Set(await walkFiles(srcDir));
          const retired = (PACKAGED_SKILL_FILES.get(skillName) ?? []).filter((p) => !shippedNow.has(p));
          const backupDir = skillBackupDir(tool, path.relative(baseDir, destDir), skillName);
          const result = await removeOwnedFiles(destDir, retired, backupDir);
          if (result.unbackedUp.length > 0) {
            log.warn(`Kept ${result.unbackedUp.length} file(s) under ${destDir}: their backup could not be written, so they were not removed. First: ${result.unbackedUp[0].file} — ${result.unbackedUp[0].error}`);
          }
        }
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
