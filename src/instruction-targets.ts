import path from 'node:path';
import { isToolInstalledForConfig } from './resources/base.js';
import { pathExists, readFileSafe, remove, writeFile } from './utils/fs.js';
import { gitTracking, gitTracks } from './mcp-git-exclude.js';
import { TEAMAI_CONTEXT_RULE_NAME } from './builtin-rules.js';
import { getHermesHome } from './hermes-home.js';
import { getHermesSoulPath } from './hermes-config.js';
import { HERMES_SECTION_LIMIT } from './hermes-hooks.js';
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
 * Where teamai's instruction blocks (culture, claudemd, recall) go: one target
 * per tool and scope, written only for tools that are installed, and never a
 * file the project or another tool shares (#945).
 */

type ToolPaths = TeamaiConfig['toolPaths'][string];

interface TargetEntry {
  /**
   * The file this tool reads the blocks from, relative to the tool's base dir
   * for the scope (`resolveToolBaseDir`) or absolute. Undefined when the tool
   * takes no file in this scope.
   */
  readonly file: (paths: ToolPaths) => string | undefined;
  /** The tool gets this scope's blocks from teamai's session hook or extension instead of a file. */
  readonly hook?: boolean;
  /** The most characters the hook channel takes; the tool drops a larger text whole. */
  readonly hookLimit?: number;
  /** Text teamai writes above the blocks when it creates the file, e.g. the frontmatter a rules loader needs. */
  readonly header?: string;
  /** teamai owns the whole file: one it did not write is left alone, and it is deleted once its blocks are gone. */
  readonly owned?: boolean;
  /**
   * Files an earlier release wrote this tool's blocks to, relative to the same
   * base dir. A pull strips teamai blocks from them once no installed tool
   * targets them.
   */
  readonly retired: readonly string[];
}

/** The tool's `claudemd` path from the team's `toolPaths` (honors `toolRoots`). */
const configured = (paths: ToolPaths): string | undefined => paths.claudemd;

/** teamai's own always-applied file in the tool's rules directory. */
const contextRule = (extension: string) => (paths: ToolPaths): string | undefined =>
  paths.rules === undefined ? undefined : path.posix.join(paths.rules, `${TEAMAI_CONTEXT_RULE_NAME}${extension}`);

/**
 * Cursor applies an `.mdc` rule in every session only with this frontmatter;
 * CodeBuddy and WorkBuddy read the same key.
 */
const ALWAYS_APPLY = '---\nalwaysApply: true\n---\n';
const cursor: TargetEntry = { file: contextRule('.mdc'), header: ALWAYS_APPLY, owned: true, retired: [] };

/**
 * CodeBuddy and WorkBuddy both read the project's .codebuddy/rules, so they
 * share one copy there; uninstalling one keeps it while the other remains.
 */
const codebuddyProjectRule = (): string => `.codebuddy/rules/${TEAMAI_CONTEXT_RULE_NAME}.md`;

// One line per tool, so a change to one tool's target edits one line.
const USER_TARGETS: Readonly<Record<string, TargetEntry>> = {
  claude: { file: configured, retired: [] },
  // Cursor CLI reads ~/.cursor/rules when the session starts under $HOME.
  cursor,
  'claude-internal': { file: configured, retired: [] },
  tclaude: { file: configured, retired: [] },
  // Hermes loads SOUL.md in every session; teamai's rules block is already there.
  hermes: { file: () => getHermesSoulPath(), retired: ['AGENTS.md'] },
  copilot: { file: configured, retired: [] },
  // RULES.md is an always-applied rule beside OMP's single user context file,
  // which ~/.omp/agent/AGENTS.md would take from ~/.agents/AGENTS.md.
  omp: { file: () => '.omp/agent/RULES.md', retired: ['.omp/agent/AGENTS.md'] },
  pi: { file: configured, retired: [] },
  // WorkBuddy reads user rules from ~/.workbuddy/rules; nothing else reads them.
  workbuddy: { file: contextRule('.md'), header: ALWAYS_APPLY, owned: true, retired: ['AGENTS.md'] },
  codebuddy: { file: configured, retired: [] },
  openclaw: { file: configured, retired: [] },
};

const PROJECT_TARGETS: Readonly<Record<string, TargetEntry>> = {
  // Claude loads every unscoped .claude/rules file from the root and any
  // subdirectory, and still reads AGENTS.md and an authored CLAUDE.md as it
  // chose to. CLAUDE.local.md would stop the native AGENTS.md load (#945).
  claude: { file: contextRule('.md'), owned: true, retired: ['.claude/CLAUDE.md'] },
  cursor,
  'claude-internal': { file: configured, retired: [] },
  tclaude: { file: configured, retired: [] },
  // Hermes reads the project's AGENTS.md itself; teamai's Hermes plugin adds
  // the blocks as a system prompt section, which holds 4,000 characters.
  hermes: { file: () => undefined, hook: true, hookLimit: HERMES_SECTION_LIMIT, retired: ['AGENTS.md'] },
  copilot: { file: configured, retired: [] },
  // OMP reads project rules only from the root and keeps one context file per
  // level, so .omp/AGENTS.md would hide the project's AGENTS.md: teamai's OMP
  // extension adds the blocks to each turn's system prompt instead.
  omp: { file: () => undefined, hook: true, retired: ['.omp/AGENTS.md'] },
  // Pi reads the project's AGENTS.md itself; teamai's Pi extension adds the
  // blocks to each run's system prompt.
  pi: { file: () => undefined, hook: true, retired: ['AGENTS.md'] },
  workbuddy: { file: codebuddyProjectRule, header: ALWAYS_APPLY, owned: true, retired: ['AGENTS.md'] },
  codebuddy: { file: codebuddyProjectRule, header: ALWAYS_APPLY, owned: true, retired: ['.codebuddy/CODEBUDDY.md'] },
  openclaw: { file: configured, retired: [] },
};

type MarkerPair = readonly [start: string, end: string, name: string];

const CULTURE: MarkerPair = [TEAMAI_CULTURE_START, TEAMAI_CULTURE_END, 'culture'];
const CLAUDEMD: MarkerPair = [TEAMAI_CLAUDEMD_START, TEAMAI_CLAUDEMD_END, 'claudemd'];
const RECALL: MarkerPair = [TEAMAI_RECALL_RULES_START, TEAMAI_RECALL_RULES_END, 'recall'];
/** The rules block releases before per-file rules wrote into the same files. */
const LEGACY_RULES: MarkerPair = [TEAMAI_RULES_START, TEAMAI_RULES_END, 'rules'];

/** Every teamai block a stale target can hold. */
const STALE_BLOCKS: readonly MarkerPair[] = [CULTURE, CLAUDEMD, RECALL, LEGACY_RULES];

function entryFor(tool: string, scope: Scope): TargetEntry | undefined {
  return (scope === 'user' ? USER_TARGETS : PROJECT_TARGETS)[tool];
}

/** One instruction file and the tools that read it. */
export interface InstructionTarget {
  /** Absolute path. */
  path: string;
  tools: string[];
  /** Whether a tool reading this file has the `teamai-recall` subagent, so the recall block belongs here. */
  recall: boolean;
  header?: string;
  owned?: boolean;
}

/** An installed, non-excluded tool that gets this scope's blocks from its session hook or extension. */
export interface InstructionHook {
  tool: string;
  recall: boolean;
  /** The most characters its channel takes, when it has a limit. */
  limit?: number;
}

export interface InstructionTargets {
  /** Targets of installed, non-excluded tools, one per file. */
  targets: InstructionTarget[];
  hooks: InstructionHook[];
  /** Known targets no installed tool reads: a pull strips teamai blocks from them. */
  stale: InstructionTarget[];
}

/**
 * The block texts to deliver, each with its markers. `null` removes the block;
 * an absent field leaves it as it is.
 */
export interface InstructionBlocks {
  culture?: string | null;
  claudemd?: string | null;
  recall?: string | null;
}

/**
 * The instruction file `tool` reads in the active scope, relative to its base
 * dir or absolute (see `TargetEntry.file`). Tools absent from the table keep
 * their configured `claudemd` path.
 */
export function instructionTargetFile(tool: string, paths: ToolPaths, scope: Scope): string | undefined {
  return (entryFor(tool, scope)?.file ?? configured)(paths);
}

/** Files, relative to the tool's base dir, an earlier release wrote `tool`'s blocks to in `scope`. */
export function retiredInstructionFiles(tool: string, scope: Scope): readonly string[] {
  return entryFor(tool, scope)?.retired ?? [];
}

/** Whether `tool` gets this scope's blocks from teamai's session hook or extension rather than a file. */
export function deliversInstructionsByHook(tool: string, scope: Scope): boolean {
  return entryFor(tool, scope)?.hook === true;
}

/**
 * The text a session hook adds to the prompt: the same blocks a file target
 * holds, recall included only for a tool with the `teamai-recall` subagent.
 */
export function instructionHookText(blocks: InstructionBlocks, recall: boolean): string {
  return [blocks.culture, blocks.claudemd, recall ? blocks.recall : null]
    .filter((block): block is string => typeof block === 'string' && block !== '')
    .join('\n\n');
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

/** The target `tool` reads from `file` in `scope`, with the header and ownership its entry declares. */
export function instructionTargetAt(tool: string, file: string, scope: Scope): InstructionTarget {
  const entry = entryFor(tool, scope);
  return { path: file, tools: [], recall: false, header: entry?.header, owned: entry?.owned };
}

/**
 * Every file teamai may have written instruction blocks to in the active
 * scope: each tool's current target plus the targets earlier releases used.
 */
function knownInstructionTargets(teamConfig: TeamaiConfig, localConfig: LocalConfig): Map<string, InstructionTarget> {
  const known = new Map<string, InstructionTarget>();
  for (const [tool, paths] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    const file = instructionTargetPath(tool, paths, localConfig);
    if (file && !known.has(file)) known.set(file, instructionTargetAt(tool, file, localConfig.scope));
  }
  const table = localConfig.scope === 'user' ? USER_TARGETS : PROJECT_TARGETS;
  for (const [tool, entry] of Object.entries(table)) {
    const baseDir = resolveToolBaseDir(tool, localConfig);
    for (const retired of entry.retired) {
      const file = path.resolve(baseDir, retired);
      if (!known.has(file)) known.set(file, { path: file, tools: [], recall: false });
    }
  }
  return known;
}

/**
 * Whether `tool` is installed, probed through a path under its own root. The
 * instruction file is never the probe: a bare `AGENTS.md` is shared by several
 * tools and says nothing about any one of them.
 */
async function isInstalled(tool: string, paths: ToolPaths, localConfig: LocalConfig): Promise<boolean> {
  // Hermes lives in $HERMES_HOME, which ~/.hermes need not be.
  if (tool === 'hermes') return pathExists(getHermesHome());
  const probe = paths.skills ?? paths.rules ?? paths.agents ?? paths.settings;
  return probe !== undefined && isToolInstalledForConfig(tool, probe, localConfig);
}

/** Resolve where this scope's instruction blocks go, and which files to clean. */
export async function resolveInstructionTargets(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
): Promise<InstructionTargets> {
  const targets = new Map<string, InstructionTarget>();
  // Files an installed tool reads, excluded or not: an excluded tool's file is
  // left alone, not cleaned.
  const inUse = new Set<string>();
  const hooks: InstructionHook[] = [];
  for (const [tool, paths] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    const entry = entryFor(tool, localConfig.scope);
    if (entry?.hook) {
      if (!isAgentExcluded(localConfig, tool) && await isInstalled(tool, paths, localConfig)) {
        hooks.push({ tool, recall: Boolean(paths.agents), limit: entry.hookLimit });
      }
      continue;
    }
    const file = instructionTargetPath(tool, paths, localConfig);
    if (!file || !await isInstalled(tool, paths, localConfig)) continue;
    inUse.add(file);
    if (isAgentExcluded(localConfig, tool)) continue;
    const target = targets.get(file) ?? instructionTargetAt(tool, file, localConfig.scope);
    target.tools.push(tool);
    if (paths.agents) target.recall = true;
    targets.set(file, target);
  }
  const stale = [...knownInstructionTargets(teamConfig, localConfig).values()].filter((t) => !inUse.has(t.path));
  return { targets: [...targets.values()], hooks, stale };
}

// ─── Planning file contents ────────────────────────────

/** A file whose content a plan changes; `content: null` deletes it. */
export interface InstructionFileChange {
  path: string;
  content: string | null;
  /** `write` delivers blocks to a target; `cleanup` removes them from a file no tool loads them from. */
  kind: 'write' | 'cleanup';
}

export interface InstructionPlan {
  changes: InstructionFileChange[];
  warnings: string[];
}

type BlockEdit = { content: string } | { malformed: true };

/**
 * Set (`block` a string) or remove (`block` null) one marker-delimited block.
 * A block whose markers are not exactly one start followed by one end is
 * malformed and left alone, so teamai never deletes text it cannot delimit.
 */
function editBlock(content: string, [start, end]: MarkerPair, block: string | null): BlockEdit {
  const starts = content.split(start).length - 1;
  const ends = content.split(end).length - 1;
  if (starts === 0 && ends === 0) {
    if (block === null) return { content };
    const kept = content.trimEnd();
    return { content: kept ? `${kept}\n\n${block}\n` : `${block}\n` };
  }
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (starts !== 1 || ends !== 1 || endIdx < startIdx) return { malformed: true };
  const after = content.substring(endIdx + end.length);
  if (block !== null) return { content: content.substring(0, startIdx) + block + after };
  const before = content.substring(0, startIdx).replace(/\n+$/, '\n');
  const rest = (before + after.replace(/^\n+/, '\n')).trimEnd();
  return { content: rest ? `${rest}\n` : '' };
}

function hasTeamaiBlock(content: string): boolean {
  return STALE_BLOCKS.some(([start, end]) => content.includes(start) || content.includes(end));
}

function withoutHeader(content: string, header: string | undefined): string {
  return header && content.startsWith(header) ? content.substring(header.length) : content;
}

/**
 * Whether a file left with nothing but teamai's blocks may go. A file git
 * tracks stays, emptied, so the cleanup never deletes a project file; a file
 * whose state git cannot report stays too.
 */
async function mayDelete(file: string): Promise<boolean> {
  const tracked = await gitTracks(file);
  if (tracked.kind !== 'unknown') return tracked.kind === 'untracked';
  return (await gitTracking(file)).kind === 'outside-repo';
}

async function planFile(
  target: InstructionTarget,
  edits: ReadonlyArray<readonly [MarkerPair, string | null]>,
  kind: InstructionFileChange['kind'],
  warnings: string[],
): Promise<InstructionFileChange | null> {
  const existing = await readFileSafe(target.path);
  if (existing !== null && target.owned && !hasTeamaiBlock(existing) && existing !== (target.header ?? '')) {
    warnings.push(`${target.path} was not written by teamai, so teamai left it unchanged. Move or rename it so teamai can deliver the team instructions there.`);
    return null;
  }
  let content = existing ?? target.header ?? '';
  for (const [pair, block] of edits) {
    const edited = editBlock(content, pair, block);
    if ('malformed' in edited) {
      warnings.push(`${target.path} has an incomplete teamai ${pair[2]} block, so teamai left it unchanged. Fix or remove its ${pair[2]} markers by hand.`);
      continue;
    }
    content = edited.content;
  }
  if (content === (existing ?? target.header ?? '')) return null;

  const remainder = withoutHeader(content, target.header).trim();
  if (remainder === '') {
    if (existing === null) return null;
    if (target.owned || await mayDelete(target.path)) return { path: target.path, content: null, kind };
    return { path: target.path, content: '', kind };
  }
  return { path: target.path, content, kind };
}

/** Every header a target writes, so a file teamai created can be recognised later. */
const KNOWN_HEADERS = [ALWAYS_APPLY];

/**
 * Remove every teamai instruction block from `file`, as uninstall does. A
 * `teamai-context` file is teamai's own and goes once its blocks are gone;
 * another file goes only if nothing else was in it and git does not track it.
 * Returns warnings about blocks it could not delimit.
 */
export async function clearInstructionFile(file: string): Promise<{ changed: boolean; warnings: string[] }> {
  const existing = await readFileSafe(file);
  if (existing === null) return { changed: false, warnings: [] };
  const target: InstructionTarget = {
    path: file,
    tools: [],
    recall: false,
    header: KNOWN_HEADERS.find((header) => existing.startsWith(header)),
    owned: path.basename(file).startsWith(`${TEAMAI_CONTEXT_RULE_NAME}.`),
  };
  const plan = await planInstructionFiles([], {}, [target]);
  const { failures } = await applyInstructionPlan(plan, { dryRun: false });
  if (failures.length > 0) throw new Error(failures.join(' '));
  return { changed: plan.changes.length > 0, warnings: plan.warnings };
}

/**
 * Work out every change that delivers `blocks` to `targets` and strips teamai
 * blocks from `stale` files, without writing anything.
 */
export async function planInstructionFiles(
  targets: readonly InstructionTarget[],
  blocks: InstructionBlocks,
  stale: readonly InstructionTarget[] = [],
): Promise<InstructionPlan> {
  const warnings: string[] = [];
  const changes: InstructionFileChange[] = [];
  for (const target of targets) {
    const edits: Array<readonly [MarkerPair, string | null]> = [];
    if (blocks.culture !== undefined) edits.push([CULTURE, blocks.culture]);
    if (blocks.claudemd !== undefined) edits.push([CLAUDEMD, blocks.claudemd]);
    if (blocks.recall !== undefined) edits.push([RECALL, target.recall ? blocks.recall : null]);
    const change = await planFile(target, edits, 'write', warnings);
    if (change) changes.push(change);
  }
  for (const file of stale) {
    const change = await planFile(file, STALE_BLOCKS.map((pair) => [pair, null] as const), 'cleanup', warnings);
    if (change) changes.push(change);
  }
  return { changes, warnings };
}

/**
 * Write a plan, or with `dryRun` only describe it. Returns one line per file
 * changed (or that would change), and one actionable line per file that could
 * not be written; a failure leaves that file as it was and the others go on.
 */
export async function applyInstructionPlan(
  plan: InstructionPlan,
  options: { dryRun: boolean },
): Promise<{ report: string[]; failures: string[] }> {
  const report: string[] = [];
  const failures: string[] = [];
  for (const { path: file, content, kind } of plan.changes) {
    if (!options.dryRun) {
      try {
        if (content === null) await remove(file);
        else await writeFile(file, content);
      } catch (e) {
        failures.push(`Could not update ${file}: ${(e as Error).message}. Check that it is a writable file, then run teamai pull again.`);
        continue;
      }
    }
    report.push(kind === 'write'
      ? `${options.dryRun ? 'Would write' : 'Wrote'} teamai instruction blocks to ${file}`
      : `${options.dryRun ? 'Would remove' : 'Removed'} teamai instruction blocks from ${file}`);
  }
  return { report, failures };
}
