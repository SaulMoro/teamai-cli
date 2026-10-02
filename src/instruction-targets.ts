import path from 'node:path';
import { isToolInstalledForConfig } from './resources/base.js';
import { pathExists, readFileSafe, remove, writeFile } from './utils/fs.js';
import { getUserHome } from './utils/home.js';
import {
  opencodeClaudeFallback, opencodeContextReference, readOpencodeInstructionList, reconcileOpencodeInstructions,
} from './resources/opencode-config.js';
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
  TEAMAI_TEAM_RULES_END,
  TEAMAI_TEAM_RULES_START,
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
   * Files an earlier release wrote this tool's blocks to by default, relative
   * to the same base dir. A pull strips teamai blocks from them once no
   * installed tool targets them. A tool whose target is not its `claudemd`
   * retires the team's configured `claudemd` too (`retiredInstructionFiles`).
   */
  readonly retired: readonly string[];
}

/** The tool's `claudemd` path from the team's `toolPaths` (honors `toolRoots`). */
const configured = (paths: ToolPaths): string | undefined => paths.claudemd;

/**
 * teamai's own always-applied file in the tool's rules directory. A team's
 * `toolPaths` entry without `rules` keeps its configured `claudemd`, which is
 * the member's file there, not teamai's.
 */
const contextRule = (extension: string) => (paths: ToolPaths): string | undefined =>
  paths.rules === undefined ? paths.claudemd : path.posix.join(paths.rules, `${TEAMAI_CONTEXT_RULE_NAME}${extension}`);

/**
 * Cursor applies an `.mdc` rule in every session only with this frontmatter;
 * CodeBuddy and WorkBuddy read the same key.
 */
const ALWAYS_APPLY = '---\nalwaysApply: true\n---\n';
const cursor: TargetEntry = { file: contextRule('.mdc'), header: ALWAYS_APPLY, owned: true, retired: [] };

// A team override or an earlier build could have pointed Codex at the project AGENTS.md.
const codexHook: TargetEntry = { file: () => undefined, hook: true, retired: ['AGENTS.md'] };

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
  // Registered in the user opencode.json `instructions`; AGENTS.md beside it stays the member's.
  opencode: { file: () => '.config/opencode/teamai-context.md', owned: true, retired: [] },
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
  // Codex reads no project file only it reads; its session-start and
  // subagent-start hooks add the blocks (#938, #940).
  codex: codexHook,
  'codex-internal': codexHook,
  tcodex: codexHook,
  // Registered in .opencode/opencode.json `instructions`; the root opencode.json stays the project's.
  opencode: { file: () => '.opencode/teamai-context.md', owned: true, retired: [] },
};

type MarkerPair = readonly [start: string, end: string, name: string];

const CULTURE: MarkerPair = [TEAMAI_CULTURE_START, TEAMAI_CULTURE_END, 'culture'];
const CLAUDEMD: MarkerPair = [TEAMAI_CLAUDEMD_START, TEAMAI_CLAUDEMD_END, 'claudemd'];
const RECALL: MarkerPair = [TEAMAI_RECALL_RULES_START, TEAMAI_RECALL_RULES_END, 'recall'];
/**
 * The rules block releases before per-file rules wrote into instruction files.
 * Hermes still writes it live in SOUL.md, which is only ever a target here,
 * never a retired file, so cleanup never reaches that copy.
 */
const LEGACY_RULES: MarkerPair = [TEAMAI_RULES_START, TEAMAI_RULES_END, 'rules'];
/** The team rules a Codex-family tool reads from its own AGENTS.md in user scope. */
const TEAM_RULES: MarkerPair = [TEAMAI_TEAM_RULES_START, TEAMAI_TEAM_RULES_END, 'team-rules'];

/** Every teamai block a stale target can hold. */
const STALE_BLOCKS: readonly MarkerPair[] = [CULTURE, CLAUDEMD, RECALL, LEGACY_RULES, TEAM_RULES];

function entryFor(tool: string, scope: Scope): TargetEntry | undefined {
  return (scope === 'user' ? USER_TARGETS : PROJECT_TARGETS)[tool];
}

/** One instruction file and the tools that read it. */
export interface InstructionTarget {
  /** Absolute path. */
  path: string;
  tools: string[];
  /** Whether every tool reading this file has the `teamai-recall` subagent, which decides the recall block it gets. */
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
  /** Files earlier releases wrote blocks to that no installed tool reads now: a pull strips teamai blocks from them. */
  stale: InstructionTarget[];
  /** Claude's user file when OpenCode reads the blocks from it, so OpenCode gets no file of its own. */
  opencodeFallback?: string | null;
}

/**
 * The block texts to deliver, each with its markers. `null` removes the block;
 * an absent field leaves it as it is.
 */
export interface InstructionBlocks {
  culture?: string | null;
  claudemd?: string | null;
  /** For a tool with the `teamai-recall` subagent. */
  recall?: string | null;
  /** For a tool without it: the agent runs `teamai recall` itself. Same markers. */
  directRecall?: string | null;
}

/**
 * The instruction file `tool` reads in the active scope, relative to its base
 * dir or absolute (see `TargetEntry.file`). Tools absent from the table keep
 * their configured `claudemd` path.
 */
export function instructionTargetFile(tool: string, paths: ToolPaths, scope: Scope): string | undefined {
  return (entryFor(tool, scope)?.file ?? configured)(paths);
}

/**
 * Files, relative to the tool's base dir or absolute, an earlier release wrote
 * `tool`'s blocks to in `scope`: the defaults, and the `claudemd` the team's
 * `toolPaths` gives a tool whose target moved off it.
 */
export function retiredInstructionFiles(tool: string, paths: ToolPaths, scope: Scope): readonly string[] {
  const entry = entryFor(tool, scope);
  if (!entry) return [];
  const previous = paths.claudemd === instructionTargetFile(tool, paths, scope) ? undefined : paths.claudemd;
  return previous === undefined || entry.retired.includes(previous) ? entry.retired : [...entry.retired, previous];
}

/** Whether `tool` gets this scope's blocks from teamai's session hook or extension rather than a file. */
export function deliversInstructionsByHook(tool: string, scope: Scope): boolean {
  return entryFor(tool, scope)?.hook === true;
}

/**
 * The text a session hook adds to the prompt: the same blocks a file target
 * holds, with the recall block that matches whether the tool has the
 * `teamai-recall` subagent.
 */
export function instructionHookText(blocks: InstructionBlocks, recall: boolean): string {
  return [blocks.culture, blocks.claudemd, recall ? blocks.recall : blocks.directRecall]
    .filter((block): block is string => typeof block === 'string')
    .map(managedBlockBody)
    .filter((body) => body !== '')
    .join('\n\n');
}

/** The text a session hook adds for `tool`, resolved for the member, project and scope in `localConfig`. */
export async function instructionHookTextFor(teamConfig: TeamaiConfig, localConfig: LocalConfig, tool: string): Promise<string> {
  const { buildRolePullContext } = await import('./resources/desired.js');
  const { resolveInstructionBlocks } = await import('./pull.js');
  const { blocks } = await resolveInstructionBlocks(teamConfig, localConfig, await buildRolePullContext(localConfig));
  return instructionHookText(blocks, Boolean(scopedToolPaths(teamConfig, localConfig)[tool]?.agents));
}

/** The message for hook text over its channel's limit, or null when it fits. */
export function hookLimitProblem(hook: InstructionHook, text: string): string | null {
  if (hook.limit === undefined || text.length <= hook.limit) return null;
  return `${hook.tool} cannot load this project's team instructions: they are ${text.length} characters, over the `
    + `${hook.limit}-character limit of its prompt section, so ${hook.tool} skips them. Shorten culture.md or the `
    + 'claudemd/ files for this scope, or run `teamai recall disable`, which drops the recall block from them. '
    + 'teamai does not cut them or write them to AGENTS.md.';
}

/**
 * Whether the extension or plugin that adds a hook tool's team instructions is
 * installed as this build writes it, and if not, what to do.
 */
export async function instructionHookChannel(tool: string): Promise<{ ready: boolean; fix: string }> {
  const rerun = 'Run `teamai hooks inject` to reinstall it; `teamai hooks remove` takes it away.';
  if (tool === 'omp' || tool === 'pi') {
    const { buildOmpExtensionSource, resolveOmpExtensionsDir, OMP_HOOK_FILE } = await import('./omp-hooks.js');
    const { buildPiExtensionSource, resolvePiExtensionsDir, PI_HOOK_FILE } = await import('./pi-hooks.js');
    const file = tool === 'omp' ? path.join(resolveOmpExtensionsDir(), OMP_HOOK_FILE) : path.join(resolvePiExtensionsDir(), PI_HOOK_FILE);
    const expected = tool === 'omp' ? buildOmpExtensionSource() : buildPiExtensionSource();
    return {
      ready: await readFileSafe(file) === expected,
      fix: `${file} is missing or out of date, so ${tool} sessions in this project get no team instructions. ${rerun}`,
    };
  }
  if (tool === 'hermes') {
    const {
      buildInstructionsPlugin, foreignInstructionsPlugin, getInstructionsPluginDir, HERMES_INSTRUCTIONS_PLUGIN, ownsInstructionsPlugin,
    } = await import('./hermes-hooks.js');
    const { getHermesConfigPath, isHermesPluginEnabled } = await import('./hermes-config.js');
    if (!await ownsInstructionsPlugin()) return { ready: false, fix: foreignInstructionsPlugin() };
    const dir = getInstructionsPluginDir();
    const plugin = buildInstructionsPlugin();
    const installed = await readFileSafe(path.join(dir, '__init__.py')) === plugin.init
      && await readFileSafe(path.join(dir, 'plugin.yaml')) === plugin.manifest;
    if (!installed) {
      return { ready: false, fix: `The Hermes plugin ${dir} is missing or out of date, so Hermes sessions in this project get no team instructions. ${rerun}` };
    }
    return {
      ready: await isHermesPluginEnabled(HERMES_INSTRUCTIONS_PLUGIN),
      fix: `${HERMES_INSTRUCTIONS_PLUGIN} is not in plugins.enabled of ${getHermesConfigPath()}, and Hermes loads no user plugin that is not listed there. `
        + 'Add it there (or remove it from plugins.disabled), then start a new Hermes session.',
    };
  }
  return { ready: true, fix: '' };
}

/**
 * What keeps an installed hook tool from getting this member's team
 * instructions in the scope: its extension or plugin, or the size of the text.
 * pull and init print these after installing the hooks; doctor checks them.
 */
export async function instructionChannelProblems(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
  const { hooks } = await resolveInstructionTargets(teamConfig, localConfig);
  const problems: string[] = [];
  for (const hook of hooks) {
    const channel = await instructionHookChannel(hook.tool);
    if (!channel.ready) {
      problems.push(channel.fix);
      continue;
    }
    const overLimit = hookLimitProblem(hook, await instructionHookTextFor(teamConfig, localConfig, hook.tool));
    if (overLimit) problems.push(overLimit);
  }
  return problems;
}

/** A block's text without its markers and DO NOT EDIT line, which only a file needs. */
function managedBlockBody(block: string): string {
  return block
    .split('\n')
    .filter((line) => !/^<!-- (\[teamai:[a-z-]+:(start|end)\]|DO NOT EDIT\b).*-->$/.test(line.trim()))
    .join('\n')
    .trim();
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
 * The target `tool` reads from `file` in `scope`, with the header and
 * ownership its entry declares. Only teamai's `teamai-context` file takes
 * them; a configured file is the member's.
 */
export function instructionTargetAt(tool: string, file: string, scope: Scope): InstructionTarget {
  const entry = entryFor(tool, scope);
  const own = path.basename(file).startsWith(`${TEAMAI_CONTEXT_RULE_NAME}.`);
  return { path: file, tools: [], recall: false, header: own ? entry?.header : undefined, owned: own ? entry?.owned : undefined };
}

/**
 * The files earlier releases wrote instruction blocks to in the active scope.
 * A tool's current target is not among them: a tool that is not installed
 * here may still be installed by a teammate who shares the file (#945).
 */
function retiredTargets(toolPaths: Record<string, ToolPaths>, localConfig: LocalConfig): Map<string, InstructionTarget> {
  const current = new Set(Object.entries(toolPaths).map(([tool, paths]) => instructionTargetPath(tool, paths, localConfig)));
  const known = new Map<string, InstructionTarget>();
  const table = localConfig.scope === 'user' ? USER_TARGETS : PROJECT_TARGETS;
  for (const tool of Object.keys(table)) {
    const baseDir = resolveToolBaseDir(tool, localConfig);
    for (const retired of retiredInstructionFiles(tool, toolPaths[tool] ?? {}, localConfig.scope)) {
      const file = path.resolve(baseDir, retired);
      if (!current.has(file) && !known.has(file)) known.set(file, { path: file, tools: [], recall: false });
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
  // teamai installs the OMP extension only where ~/.omp exists; a project's
  // own .omp/ says nothing about this member using OMP.
  if (tool === 'omp') return pathExists(path.join(getUserHome(), '.omp'));
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
  const toolPaths = scopedToolPaths(teamConfig, localConfig);
  for (const [tool, paths] of Object.entries(toolPaths)) {
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
    // The subagent block only where every tool reading the file has the subagent.
    target.recall = Boolean(paths.agents) && (target.tools.length === 0 || target.recall);
    target.tools.push(tool);
    targets.set(file, target);
  }
  const stale = [...retiredTargets(toolPaths, localConfig).values()].filter((t) => !inUse.has(t.path));
  // OpenCode reads ~/.claude/CLAUDE.md while its own user AGENTS.md does not
  // exist; when Claude's blocks are there, a second copy would duplicate them.
  const opencode = [...targets.values()].find((target) => target.tools.includes('opencode'));
  const opencodeFallback = localConfig.scope === 'user' && opencode !== undefined
    ? await opencodeClaudeFallback(getUserHome(), [...targets.keys()])
    : null;
  if (opencode && opencodeFallback) {
    targets.delete(opencode.path);
    stale.push(opencode);
  }
  return { targets: [...targets.values()], hooks, stale, opencodeFallback };
}

/**
 * List teamai's OpenCode instruction file in OpenCode's `instructions` while
 * it holds teamai's blocks, and drop the entry once they are gone: OpenCode
 * reads no file it is not told about. Returns what it did or, with `dryRun`,
 * would do.
 */
export async function registerOpencodeContext(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  resolved: Pick<InstructionTargets, 'targets' | 'stale'>,
  dryRun: boolean,
  planned: readonly string[] = [],
): Promise<string | null> {
  const paths = scopedToolPaths(teamConfig, localConfig).opencode;
  const contextFile = paths && instructionTargetPath('opencode', paths, localConfig);
  if (!contextFile) return null;
  const wanted = resolved.targets.some((target) => target.path === contextFile);
  if (!wanted && !resolved.stale.some((target) => target.path === contextFile)) return null;
  const present = wanted && (await holdsInstructionBlocks(contextFile) || (dryRun && planned.includes(contextFile)));
  const { config, entry } = opencodeContextReference(contextFile, localConfig.scope, resolveToolBaseDir('opencode', localConfig));
  if (dryRun) {
    const listed = (await readOpencodeInstructionList(config))?.includes(entry) ?? false;
    if (listed === present) return null;
    return `Would ${present ? 'add' : 'remove'} "${entry}" ${present ? 'to' : 'from'} the instructions of ${config}`;
  }
  const changed = await reconcileOpencodeInstructions(config, entry, present, 'team instructions');
  return changed ? `${present ? 'Added' : 'Removed'} "${entry}" ${present ? 'to' : 'from'} the instructions of ${config}` : null;
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
  // A block that opened the file leaves no blank line above what follows it.
  const rest = (before + after.replace(/^\n+/, before ? '\n' : '')).trimEnd();
  return { content: rest ? `${rest}\n` : '' };
}

function hasTeamaiBlock(content: string): boolean {
  return STALE_BLOCKS.some(([start, end]) => content.includes(start) || content.includes(end));
}

/**
 * Whether `file` holds teamai's blocks. A same-named file teamai did not write
 * is left as it is, so no tool should be told to load it.
 */
export async function holdsInstructionBlocks(file: string): Promise<boolean> {
  const content = await readFileSafe(file);
  return content !== null && hasTeamaiBlock(content);
}

function withoutHeader(content: string, header: string | undefined): string {
  return header && content.startsWith(header) ? content.substring(header.length) : content;
}

/**
 * Whether teamai created the file: it writes a new file starting with a block
 * (an older release with blank lines first), while a member's file starts
 * with their own text.
 */
function createdByTeamai(content: string): boolean {
  return content.trimStart().startsWith('<!-- [teamai:');
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
    if (target.owned || (createdByTeamai(existing) && await mayDelete(target.path))) return { path: target.path, content: null, kind };
    return { path: target.path, content: '', kind };
  }
  return { path: target.path, content, kind };
}

/** Every header a target writes, so a file teamai created can be recognised later. */
const KNOWN_HEADERS = [ALWAYS_APPLY];

/**
 * Remove teamai instruction blocks from `file` (those whose start marker is in
 * `starts`, or all of them), as uninstall does. A
 * `teamai-context` file is teamai's own and goes once its blocks are gone;
 * another file goes only if nothing else was in it and git does not track it.
 * Returns warnings about blocks it could not delimit.
 */
export async function clearInstructionFile(
  file: string,
  starts?: readonly string[],
): Promise<{ changed: boolean; warnings: string[] }> {
  const existing = await readFileSafe(file);
  if (existing === null) return { changed: false, warnings: [] };
  const target: InstructionTarget = {
    path: file,
    tools: [],
    recall: false,
    header: KNOWN_HEADERS.find((header) => existing.startsWith(header)),
    owned: path.basename(file).startsWith(`${TEAMAI_CONTEXT_RULE_NAME}.`),
  };
  const blocks = starts === undefined ? STALE_BLOCKS : STALE_BLOCKS.filter(([start]) => starts.includes(start));
  const warnings: string[] = [];
  const change = await planFile(target, blocks.map((pair) => [pair, null] as const), 'cleanup', warnings);
  const plan: InstructionPlan = { changes: change ? [change] : [], warnings };
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
    const recall = target.recall ? blocks.recall : blocks.directRecall;
    if (recall !== undefined) edits.push([RECALL, recall]);
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
