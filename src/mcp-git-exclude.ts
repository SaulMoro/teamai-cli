import path from 'node:path';
import fse from 'fs-extra';
import type { McpServerDef } from './types.js';
import type { McpTarget } from './mcp-reconcile.js';
import { referencedVars, supportsEnvExpansion } from './resources/mcp-format.js';
import { execCommand } from './utils/exec.js';
import { pathExists, readFileSafe } from './utils/fs.js';
import { log } from './utils/logger.js';

// ─── Project MCP configs and git ─────────────────────────────
//
//  A project-scope MCP config that holds a resolved `${VAR}` sits in the
//  business repo's working tree with the value in plaintext, and one
//  `git add -A` commits it (#882). teamai lists such a file in the clone's own
//  `.git/info/exclude`, inside a block it owns: local to the clone, nothing
//  committed, and the team's `.gitignore` never touched.

export const MCP_EXCLUDE_START = '# [teamai:mcp-exclude:start] project MCP configs holding resolved ${VAR} values';
export const MCP_EXCLUDE_END = '# [teamai:mcp-exclude:end]';

/**
 * Whether `target`'s file carries a value teamai resolved from a `${VAR}`: a
 * project-scope file holding one of `names` whose definition references a
 * variable the tool does not expand itself.
 */
export function carriesResolvedValue(
  target: McpTarget,
  teamDefs: McpServerDef[],
  names: Iterable<string>,
): boolean {
  if (!target.projectScope) return false;
  const present = new Set(names);
  return teamDefs.some((def) => present.has(def.name)
    && referencedVars(def).length > 0
    && !supportsEnvExpansion(target.format, target.projectScope, def));
}

/** The `info/exclude` git reads for `dir`'s checkout (worktrees and submodules included), and `dir`'s path from its root. */
async function gitExcludeFile(dir: string): Promise<{ excludeFile: string; prefix: string } | null> {
  const result = await execCommand('git', ['rev-parse', '--show-prefix', '--git-path', 'info/exclude'], { cwd: dir, timeoutMs: 10_000 })
    .catch(() => null);
  if (!result || result.code !== 0) return null;
  const [prefix = '', gitPath = ''] = result.stdout.split(/\r?\n/);
  if (!gitPath) return null;
  // Real path, so one repository reached through a symlink (macOS /var) is one file.
  const base = await fse.realpath(dir).catch(() => dir);
  return { excludeFile: path.resolve(base, gitPath), prefix };
}

/**
 * Whether git would put `file` in a commit: in a repository, and tracked or
 * untracked without an ignore rule. Read-only.
 */
export async function gitWouldTrack(file: string): Promise<boolean> {
  const result = await execCommand('git', ['check-ignore', '-q', '--', path.basename(file)], { cwd: path.dirname(file), timeoutMs: 10_000 })
    .catch(() => null);
  // 0: ignored. 1: not ignored (or tracked). 128: not a repository, or git failed.
  return result?.code === 1;
}

/**
 * teamai's block and what surrounds it; null without both markers, so a damaged
 * block never takes the member's lines with it. The last start marker opens it:
 * one that lost its end marker is left behind, not paired with the next block's end.
 */
function splitBlock(content: string): { before: string; patterns: string[]; after: string } | null {
  const start = content.lastIndexOf(MCP_EXCLUDE_START);
  const endAt = start === -1 ? -1 : content.indexOf(MCP_EXCLUDE_END, start);
  if (endAt === -1) return null;
  const patterns = content.slice(start + MCP_EXCLUDE_START.length, endAt)
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const after = content.slice(endAt + MCP_EXCLUDE_END.length).replace(/^\r?\n/, '');
  return { before: content.slice(0, start), patterns, after };
}

/**
 * Add `file` to its repository's `.git/info/exclude` when git would otherwise
 * track it. Idempotent; a path already ignored, or outside any repository,
 * adds nothing. A failure warns rather than failing the sync that wrote the file.
 */
export async function excludeFromGit(file: string): Promise<void> {
  if (!await pathExists(file) || !await gitWouldTrack(file)) return;
  const location = await gitExcludeFile(path.dirname(file));
  if (!location) return;
  const { excludeFile } = location;
  // Anchored at the working tree root, glob characters escaped.
  const pattern = `/${location.prefix}${path.basename(file)}`.replace(/[\\*?[\]!#]/g, '\\$&');
  try {
    const content = (await readFileSafe(excludeFile)) ?? '';
    const block = splitBlock(content);
    if (block?.patterns.includes(pattern)) return;
    const head = block ? block.before : content;
    const patterns = [...(block?.patterns ?? []), pattern];
    const body = [MCP_EXCLUDE_START, ...patterns, MCP_EXCLUDE_END].join('\n');
    const sep = head === '' || head.endsWith('\n') ? '' : '\n';
    await fse.outputFile(excludeFile, `${head}${sep}${body}\n${block?.after ?? ''}`);
    log.debug(`Added ${pattern} to ${excludeFile}`);
  } catch (e) {
    log.warn(
      `${file} holds a resolved MCP variable, and adding it to ${excludeFile} failed: ${e instanceof Error ? e.message : String(e)}. `
      + `Add \`${pattern}\` to that file yourself so git does not commit the value.`,
    );
  }
}

/**
 * The `.git/info/exclude` files holding teamai's block, one per repository
 * among those `dirs` are in: a config inside a nested repository or submodule
 * is excluded from that repository, not from the project root's.
 */
export async function findMcpGitExcludes(dirs: Iterable<string>): Promise<string[]> {
  const found = new Set<string>();
  for (const dir of new Set(dirs)) {
    const location = await gitExcludeFile(dir);
    if (!location || found.has(location.excludeFile)) continue;
    const content = await readFileSafe(location.excludeFile);
    if (content !== null && splitBlock(content)) found.add(location.excludeFile);
  }
  return [...found];
}

/** Remove teamai's block from `excludeFile`, one `findMcpGitExcludes` returned. */
export async function removeMcpGitExclude(excludeFile: string): Promise<boolean> {
  const content = await readFileSafe(excludeFile);
  const block = content === null ? null : splitBlock(content);
  if (!block) return false;
  await fse.writeFile(excludeFile, block.before + block.after);
  return true;
}
