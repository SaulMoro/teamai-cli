import fs from 'node:fs';
import path from 'node:path';
import { gitTracks, realFilePath } from './git-exclude.js';
import { judgeTeamaiOnlyCodexHooks } from './hooks.js';
import { instructionTargetPath } from './instruction-targets.js';
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
    judged.push({
      file,
      state: tracking.kind === 'tracked' ? 'tracked' : tracking.kind === 'unknown' ? 'unknown' : teamaiOnly ? 'teamai-only' : 'mixed',
    });
  }
  return judged;
}

/** The notice of a listed teamai-only file that now holds something teamai does not own. */
export async function describeNoLongerTeamaiOnly(file: string, projectRoot: string): Promise<string> {
  const [real, root] = await Promise.all([realFilePath(file), realFilePath(projectRoot)]);
  const rel = path.relative(root, real);
  const shown = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : real;
  return `${shown} now holds entries teamai does not own, so git can see it.`;
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
