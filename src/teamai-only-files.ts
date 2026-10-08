import fs from 'node:fs';
import path from 'node:path';
import { gitTracks, realFilePath } from './git-exclude.js';
import { judgeTeamaiOnlyCodexHooks } from './hooks.js';
import { instructionTargetPath } from './instruction-targets.js';
import { findMcpGitExcludes } from './mcp-git-exclude.js';
import { judgeTeamaiOnlyMcpConfigs } from './mcp-reconcile.js';
import { opencodeContextReference } from './resources/opencode-config.js';
import { RulesHandler } from './resources/rules.js';
import { resolveToolBaseDir, scopedToolPaths, type LocalConfig, type TeamaiConfig } from './types.js';
import { readFileSafe } from './utils/fs.js';

// ─── teamai-only files (#915) ─────────────────────────────────
//
//  A shared config file teamai writes entries into, in a project, that holds
//  nothing but teamai's entries: no other top-level key, and every entry one
//  teamai owns. While git does not track it, pull lists it in teamai's
//  `delivered` git exclude block; once it holds anything else, it is the
//  member's too, and git sees it again. Files: the project MCP configs with no
//  per-member alternative (judgeTeamaiOnlyMcpConfigs), `.codex/hooks.json`
//  (judgeTeamaiOnlyCodexHooks) and OpenCode's `.opencode/opencode.json`.

/**
 * How a shared file teamai writes entries into stands:
 * - `teamai-only`: untracked, and holds only teamai's entries;
 * - `mixed`: untracked, and holds something teamai does not own, or does not parse;
 * - `tracked`: git tracks it, whatever it holds;
 * - `unknown`: git could not say whether it tracks it.
 */
export type TeamaiOnlyState = 'teamai-only' | 'mixed' | 'tracked' | 'unknown';

export interface SharedFileJudgement {
  /** Absolute, as teamai writes it. */
  file: string;
  state: TeamaiOnlyState;
  /** `unknown`: what git said. */
  error?: string;
}

/**
 * Every shared file of this project scope that teamai writes entries into and
 * that exists and holds anything, judged. Run after the MCP and hook
 * reconciles: their adoption of unrecorded entries equal to a team render
 * (#993) is what makes a file written before an upgrade, or before its record
 * was lost, teamai-only. Read-only.
 */
export async function judgeTeamaiOnlyFiles(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<SharedFileJudgement[]> {
  if (localConfig.scope !== 'project') return [];
  const verdicts = [
    ...await judgeTeamaiOnlyMcpConfigs(teamConfig, localConfig),
    ...[await judgeTeamaiOnlyCodexHooks(teamConfig, localConfig), await judgeOpencodeInstructions(teamConfig, localConfig)]
      .filter((verdict) => verdict !== null),
  ];
  // One file judged twice (a team mapping two writers to it) is teamai-only only if both say so.
  const byFile = new Map<string, boolean>();
  for (const { file, teamaiOnly } of verdicts) byFile.set(file, (byFile.get(file) ?? true) && teamaiOnly);
  const judged: SharedFileJudgement[] = [];
  for (const [file, teamaiOnly] of byFile) {
    const tracking = await gitTracks(file);
    if (tracking.kind === 'unknown') judged.push({ file, state: 'unknown', error: tracking.error });
    else judged.push({ file, state: tracking.kind === 'tracked' ? 'tracked' : teamaiOnly ? 'teamai-only' : 'mixed' });
  }
  return judged;
}

/**
 * The real paths of those of `files` that teamai's `mcp-exclude` block keeps
 * out of git whatever they hold, as they hold a value teamai resolved (#882):
 * leaving the `delivered` block does not make them visible.
 */
export async function keptOutByMcpExclude(files: readonly string[]): Promise<Set<string>> {
  const blocks = await findMcpGitExcludes(files.map((file) => path.dirname(file)));
  const listed = [...blocks.values()].flat().flatMap(({ files: protectedFiles }) => protectedFiles);
  return new Set(await Promise.all(listed.map((file) => realFilePath(file))));
}

/** The notice of a listed teamai-only file that now holds something teamai does not own. */
export async function describeNoLongerTeamaiOnly(file: string, projectRoot: string): Promise<string> {
  return `${await shownPath(file, projectRoot)} now holds entries teamai does not own, so git can see it.`;
}

/**
 * The failure for a shared file git could not say it tracks (`unknown`):
 * `kept`, its line from the last pull stays; else it has none.
 */
export async function describeUnknownTracking(judgement: SharedFileJudgement, projectRoot: string, kept: boolean): Promise<string> {
  const shown = await shownPath(judgement.file, projectRoot);
  return `git could not say whether it tracks ${shown}: ${judgement.error ?? 'git failed'}. `
    + (kept ? 'teamai keeps its git exclude line as the last pull left it. ' : 'teamai cannot tell whether to keep it out of git. ')
    + 'Fix the repository, then run `teamai pull` again.';
}

/** `file` from the project root when it is inside it, else its real path. */
async function shownPath(file: string, projectRoot: string): Promise<string> {
  const [real, root] = await Promise.all([realFilePath(file), realFilePath(projectRoot)]);
  const rel = path.relative(root, real);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : real;
}

/**
 * OpenCode's `.opencode/opencode.json`, when it exists and holds anything,
 * and whether it holds only teamai's `instructions`: entries equal to the ones
 * teamai writes there (the rules glob of `opencodeInstructionsTarget`, and the
 * `teamai-context` entry), at least one, and no other top-level key. There is
 * no record of them; equality is the proof. A symlink is the member's.
 */
async function judgeOpencodeInstructions(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<{ file: string; teamaiOnly: boolean } | null> {
  const target = await new RulesHandler().opencodeInstructionsTarget(teamConfig, localConfig, []);
  if (target === null) return null;
  const file = target.configFile;
  if (!(await fs.promises.lstat(file).catch(() => null))?.isFile()) return null;
  const raw = await readFileSafe(file);
  if (raw === null || raw.trim() === '') return null;
  const paths = scopedToolPaths(teamConfig, localConfig).opencode;
  const contextFile = paths ? await instructionTargetPath('opencode', paths, localConfig) : undefined;
  const context = contextFile ? opencodeContextReference(contextFile, 'project', resolveToolBaseDir('opencode', localConfig)) : null;
  const ours = (entry: unknown): boolean => typeof entry === 'string'
    && (target.owns(entry) || (context?.config === file && entry === context.entry));
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { file, teamaiOnly: false };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { file, teamaiOnly: false };
  const { instructions, ...others } = data as { instructions?: unknown };
  if (Object.keys(others).length > 0) return { file, teamaiOnly: false };
  if (instructions === undefined) return null;
  return { file, teamaiOnly: Array.isArray(instructions) && instructions.length > 0 && instructions.every(ours) };
}
