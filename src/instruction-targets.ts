import path from 'node:path';
import { isToolInstalledForConfig } from './resources/base.js';
import { readFileSafe, remove } from './utils/fs.js';
import { removeClaudeMdSection } from './utils/claudemd.js';
import {
  isAgentExcluded,
  resolveToolBaseDir,
  scopedToolPaths,
  TEAMAI_CLAUDEMD_END,
  TEAMAI_CLAUDEMD_START,
  TEAMAI_CULTURE_END,
  TEAMAI_CULTURE_START,
  TEAMAI_RECALL_RULES_END,
  TEAMAI_RECALL_RULES_START,
  TEAMAI_RULES_END,
  TEAMAI_RULES_START,
  type LocalConfig,
  type Scope,
  type TeamaiConfig,
} from './types.js';

/**
 * Where teamai's instruction blocks (culture, claudemd, recall) go: one file
 * per tool and scope, written only for tools that are installed (#945).
 */

type ToolPaths = TeamaiConfig['toolPaths'][string];

interface TargetEntry {
  /**
   * The file this tool reads the blocks from, relative to the tool's base dir
   * for the scope (`resolveToolBaseDir`) or absolute. Undefined when the tool
   * takes no blocks in this scope.
   */
  readonly file: (paths: ToolPaths) => string | undefined;
  /**
   * Files an earlier release wrote this tool's blocks to, relative to the same
   * base dir. A pull strips teamai blocks from them once no installed tool
   * targets them.
   */
  readonly retired: readonly string[];
}

/** The tool's `claudemd` path from the team's `toolPaths` (honors `toolRoots`). */
const configured = (paths: ToolPaths): string | undefined => paths.claudemd;

// One line per tool, so a change to one tool's target edits one line.
const USER_TARGETS: Readonly<Record<string, TargetEntry>> = {
  claude: { file: configured, retired: [] },
  'claude-internal': { file: configured, retired: [] },
  tclaude: { file: configured, retired: [] },
  hermes: { file: configured, retired: [] },
  copilot: { file: configured, retired: [] },
  omp: { file: configured, retired: [] },
  pi: { file: configured, retired: [] },
  workbuddy: { file: configured, retired: [] },
  codebuddy: { file: configured, retired: [] },
  openclaw: { file: configured, retired: [] },
};

const PROJECT_TARGETS: Readonly<Record<string, TargetEntry>> = {
  claude: { file: configured, retired: [] },
  'claude-internal': { file: configured, retired: [] },
  tclaude: { file: configured, retired: [] },
  hermes: { file: configured, retired: [] },
  copilot: { file: configured, retired: [] },
  omp: { file: configured, retired: [] },
  pi: { file: configured, retired: [] },
  workbuddy: { file: configured, retired: [] },
  codebuddy: { file: configured, retired: [] },
  openclaw: { file: configured, retired: [] },
};

/** Every teamai block a stale target can hold, including the legacy rules block. */
const TEAMAI_BLOCK_MARKERS: ReadonlyArray<readonly [string, string]> = [
  [TEAMAI_CULTURE_START, TEAMAI_CULTURE_END],
  [TEAMAI_CLAUDEMD_START, TEAMAI_CLAUDEMD_END],
  [TEAMAI_RECALL_RULES_START, TEAMAI_RECALL_RULES_END],
  [TEAMAI_RULES_START, TEAMAI_RULES_END],
];

function entryFor(tool: string, scope: Scope): TargetEntry | undefined {
  return (scope === 'user' ? USER_TARGETS : PROJECT_TARGETS)[tool];
}

/** One instruction file and the tools that read it. */
export interface InstructionTarget {
  /** Absolute path. */
  path: string;
  tools: string[];
}

export interface InstructionTargets {
  /** Culture and claudemd targets of installed, non-excluded tools, one per file. */
  targets: InstructionTarget[];
  /** The recall-block subset: tools with an `agents` path, which get the `teamai-recall` subagent. */
  recallTargets: InstructionTarget[];
  /** Known targets no installed tool reads: a pull strips teamai blocks from them. */
  stale: string[];
}

/**
 * The instruction file `tool` reads in the active scope, relative to its base
 * dir or absolute (see `TargetEntry.file`). Tools absent from the table keep
 * their configured `claudemd` path.
 */
export function instructionTargetFile(tool: string, paths: ToolPaths, scope: Scope): string | undefined {
  return (entryFor(tool, scope)?.file ?? configured)(paths);
}

/** Absolute instruction file of `tool` in the active scope, or undefined when it takes none. */
export function instructionTargetPath(
  tool: string,
  paths: ToolPaths,
  localConfig: LocalConfig,
): string | undefined {
  const file = instructionTargetFile(tool, paths, localConfig.scope);
  return file === undefined ? undefined : path.resolve(resolveToolBaseDir(tool, localConfig), file);
}

/**
 * Every file teamai may have written instruction blocks to in the active
 * scope: each tool's current target plus the targets earlier releases used.
 */
export function knownInstructionTargets(teamConfig: TeamaiConfig, localConfig: LocalConfig): string[] {
  const known = new Set<string>();
  for (const [tool, paths] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    const target = instructionTargetPath(tool, paths, localConfig);
    if (target) known.add(target);
  }
  const table = localConfig.scope === 'user' ? USER_TARGETS : PROJECT_TARGETS;
  for (const [tool, entry] of Object.entries(table)) {
    const baseDir = resolveToolBaseDir(tool, localConfig);
    for (const file of entry.retired) known.add(path.resolve(baseDir, file));
  }
  return [...known];
}

/**
 * Whether `tool` is installed, probed through a path under its own root. The
 * instruction file is never the probe: a bare `AGENTS.md` is shared by several
 * tools and says nothing about any one of them.
 */
async function isInstalled(tool: string, paths: ToolPaths, localConfig: LocalConfig): Promise<boolean> {
  const probe = paths.skills ?? paths.rules ?? paths.agents ?? paths.settings;
  return probe !== undefined && isToolInstalledForConfig(tool, probe, localConfig);
}

function addTarget(targets: Map<string, InstructionTarget>, file: string, tool: string): void {
  const existing = targets.get(file);
  if (existing) existing.tools.push(tool);
  else targets.set(file, { path: file, tools: [tool] });
}

/** Resolve where this scope's instruction blocks go, and which files to clean. */
export async function resolveInstructionTargets(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
): Promise<InstructionTargets> {
  const targets = new Map<string, InstructionTarget>();
  const recallTargets = new Map<string, InstructionTarget>();
  // Files an installed tool reads, excluded or not: an excluded tool's file is
  // left alone, not cleaned.
  const owned = new Set<string>();
  for (const [tool, paths] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    const file = instructionTargetPath(tool, paths, localConfig);
    if (!file || !await isInstalled(tool, paths, localConfig)) continue;
    owned.add(file);
    if (isAgentExcluded(localConfig, tool)) continue;
    addTarget(targets, file, tool);
    if (paths.agents) addTarget(recallTargets, file, tool);
  }
  const stale = knownInstructionTargets(teamConfig, localConfig).filter((file) => !owned.has(file));
  return { targets: [...targets.values()], recallTargets: [...recallTargets.values()], stale };
}

/**
 * Remove every teamai block from `file` and delete the file when nothing else
 * is left. Returns true when the file changed.
 */
export async function stripInstructionBlocks(file: string): Promise<boolean> {
  const before = await readFileSafe(file);
  if (before === null) return false;
  for (const [start, end] of TEAMAI_BLOCK_MARKERS) {
    await removeClaudeMdSection(file, start, end);
  }
  const after = await readFileSafe(file);
  if (after === null || after === before) return false;
  if (after.trim() === '') await remove(file);
  return true;
}
