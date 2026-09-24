import path from 'node:path';
import fs from 'node:fs/promises';
import fse from 'fs-extra';
import { ResourceHandler } from './base.js';
import { resolveBaseDir, type ResourceItem, type TeamaiConfig, type LocalConfig } from '../types.js';
import { expandHome, listDirs, listFilesRecursive, pruneEmptyDirs } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { caseFoldKey } from '../manifest-schema.js';
import { resolveResourceNamespaces } from '../resource-namespaces.js';

/**
 * The single directory the team docs bundle is copied into. In project scope a
 * `~/`-prefixed `sharing.docs.localDir` is relative to the project root, not to
 * HOME. `pull` writes here and `doctor` checks here (#598).
 */
export function resolveDocsDestination(teamConfig: TeamaiConfig, localConfig: LocalConfig): string {
  const localDir = teamConfig.sharing.docs.localDir;
  if (localConfig.scope === 'project' && localConfig.projectRoot && localDir.startsWith('~/')) {
    return path.join(localConfig.projectRoot, localDir.substring(2));
  }
  const expanded = expandHome(localDir);
  return path.isAbsolute(expanded) ? expanded : path.resolve(resolveBaseDir(localConfig), expanded);
}

/** A path relative to the docs root, as `listFilesRecursive` spells it. */
const isDotted = (relativePath: string): boolean => relativePath.split('/').some((segment) => segment.startsWith('.'));

/** What pull delivers from the team repo's `docs/`, and what it withholds (#707). */
export interface DesiredDocs {
  /** The team repo's `docs/`. */
  readonly sourceDir: string;
  /** The files delivered, relative to `sourceDir`: no dotfiles, nothing of an inactive namespace. */
  readonly files: readonly string[];
  /** Each `docs/<dir>/` of a namespace declared but not active here, with its files. */
  readonly withheld: ReadonlyArray<{ readonly dir: string; readonly files: readonly string[] }>;
}

/**
 * The docs this member receives: every file under `docs/` except those under a
 * top-level directory named by `inactiveNamespaces`. A directory no role or
 * project declares is never withheld. Names compare case-folded, so a
 * `docs/Checkout/` is withheld with `checkout` on every filesystem rather than
 * only on the ones that would open it under that name.
 */
export async function resolveDesiredDocs(repoPath: string, inactiveNamespaces: readonly string[]): Promise<DesiredDocs> {
  const sourceDir = path.join(expandHome(repoPath), 'docs');
  const inactive = new Set(inactiveNamespaces.map(caseFoldKey));
  const withheldDirs = new Set((await listDirs(sourceDir)).filter((dir) => inactive.has(caseFoldKey(dir))));
  const files: string[] = [];
  const withheld = new Map<string, string[]>([...withheldDirs].map((dir) => [dir, []]));
  for (const file of await listFilesRecursive(sourceDir)) {
    if (isDotted(file)) continue;
    const slash = file.indexOf('/');
    const dirFiles = slash === -1 ? undefined : withheld.get(file.slice(0, slash));
    if (dirFiles) dirFiles.push(file.slice(slash + 1));
    else files.push(file);
  }
  return { sourceDir, files, withheld: [...withheld].map(([dir, dirFiles]) => ({ dir, files: dirFiles })) };
}

/**
 * `resolveDesiredDocs` for a caller that holds no pull context (recall,
 * contribute, doctor): the same namespaces pull resolves. Legacy mode withholds
 * nothing. Throws when the scope's manifests cannot be read, as pull stops the
 * scope then.
 */
export async function resolveDocsForDirectory(localConfig: LocalConfig): Promise<DesiredDocs> {
  const resolved = await resolveResourceNamespaces(localConfig);
  return resolveDesiredDocs(localConfig.repo.localPath, resolved?.inactiveDocsNamespaces ?? []);
}

/** The file's bytes, or null when it is not a file this process can read. */
async function readBytes(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

export class DocsHandler extends ResourceHandler {
  readonly type = 'docs' as const;

  async scanLocalForPush(_teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<ResourceItem[]> {
    // Docs are managed directly in team repo
    return [];
  }

  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const docsDir = path.join(localConfig.repo.localPath, 'docs');
    // Nested documents are synced as part of the same bundle.
    if (await this.countDocFiles(docsDir) === 0) return [];

    return [{
      name: 'docs',
      type: 'docs',
      sourcePath: docsDir,
      relativePath: 'docs/',
    }];
  }

  async countDocFiles(sourcePath: string): Promise<number> {
    const files = await listFilesRecursive(sourcePath);
    return files.filter(f => f.split('/').every(segment => !segment.startsWith('.'))).length;
  }

  async pushItem(_item: ResourceItem, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<void> {
    // No-op
  }

  /**
   * Sync docs from team repo to local docs directory, withholding a docs
   * namespace this directory does not have active. `pull` resolves the set
   * once and calls `pullDocs`.
   */
  async pullItem(_item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    await this.pullDocs(await resolveDocsForDirectory(localConfig), teamConfig, localConfig);
  }

  /** Copy the files `desired` delivers into the docs destination, overwriting what is there. */
  async pullDocs(desired: DesiredDocs, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const localDocsDir = resolveDocsDestination(teamConfig, localConfig);
    const withheld = new Set(desired.withheld.map(({ dir }) => dir));
    try {
      await fse.copy(desired.sourceDir, localDocsDir, {
        overwrite: true,
        filter: (srcPath: string) => {
          const relative = path.relative(desired.sourceDir, srcPath).split(path.sep).join('/');
          if (relative === '') return true;
          return !isDotted(relative) && !withheld.has(relative.split('/')[0] ?? '');
        },
      });
      log.debug(`Synced docs → ${localDocsDir}`);
    } catch (e) {
      log.warn(`Failed to sync docs: ${(e as Error).message}`);
    }
  }

  /**
   * Remove the local copies of the docs `desired` withholds, the way a
   * deactivated namespace's skills and agents go: only a copy byte-equal to the
   * team file is deleted. An edited one is kept and named, so nothing a member
   * wrote is lost; a file the team repo does not have is never looked at.
   */
  async withdrawInactiveNamespaces(desired: DesiredDocs, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const localDocsDir = resolveDocsDestination(teamConfig, localConfig);
    for (const { dir, files } of desired.withheld) {
      const kept: string[] = [];
      for (const file of files) {
        const deployed = path.join(localDocsDir, dir, file);
        const current = await readBytes(deployed);
        if (current === null) continue;
        const source = await readBytes(path.join(desired.sourceDir, dir, file));
        if (source === null || !current.equals(source)) {
          kept.push(`${dir}/${file}`);
          continue;
        }
        await fs.rm(deployed, { force: true });
        log.debug(`[${localConfig.scope}] Removed ${dir}/${file} of inactive docs namespace "${dir}"`);
      }
      await pruneEmptyDirs(path.join(localDocsDir, dir));
      if (kept.length > 0) {
        log.warn(
          `[${localConfig.scope}] Kept ${kept.length} doc(s) of docs namespace "${dir}", which is not active here: `
          + `they differ from the team copy (${kept.join(', ')} in ${localDocsDir}). Back them up, then delete them manually.`,
        );
      }
    }
  }

  async removeItem(_name: string, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<string[]> {
    log.warn('Removing docs is not supported via remove command. Delete from team repo directly.');
    return [];
  }
}
