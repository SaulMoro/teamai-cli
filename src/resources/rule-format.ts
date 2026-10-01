/**
 * Per-tool on-disk format for rule files.
 *
 * The team repo always stores rules as tool-neutral `<name>.md`. A tool with
 * a rules format of its own gets a render of it (`RULE_FORMATS`): Cursor and
 * JoyCode `.mdc`, Copilot `.instructions.md`, Kiro steering and Qoder rules
 * `.md` with their own frontmatter. Every other tool takes a verbatim `.md`
 * copy.
 *
 * This module is the single place that decision lives, mirroring
 * `agentFileExtensionForTool` in `./agent-format.ts`. Every site that writes,
 * scans, compares, pushes or deletes files in a tool's rules directory must go
 * through it, so a new format never has to be re-discovered call site by call
 * site. Adding one is a render module exporting a `RuleFormat` plus one entry
 * below.
 */

import type { TeamaiConfig } from '../types.js';
import { COPILOT_INSTRUCTIONS_FORMAT } from './copilot-instructions.js';
import { CURSOR_MDC_FORMAT } from './cursor-mdc.js';
import { KIRO_STEERING_FORMAT } from './kiro-steering.js';
import { QODER_RULE_FORMAT } from './qoder-rule.js';

type ToolPath = TeamaiConfig['toolPaths'][string];

/** How one tool's rule file is written from, and read back into, the team `.md`. */
export interface RuleFormat {
  /** The extension the rule file is written with. */
  readonly extension: '.md' | '.mdc' | '.instructions.md';
  /** The bytes the team rule becomes for the tool. */
  render(rawTeamRule: string): string;
  /** Whether a tool copy carries the team rule's body; frontmatter is derived, so not compared. */
  bodyEquals(rawToolRule: string, rawTeamRule: string): boolean;
  /** The team `.md` with a tool copy's body pushed into it, the team frontmatter kept; null for a new rule. */
  mergeBodyIntoTeam(rawToolRule: string, existingTeamMd: string | null): string;
  /** The frontmatter fields the tool scopes a rule by, named in doctor's fix. */
  readonly scopeFields: readonly string[];
}

/**
 * The tools with a rules format of their own. A copy there is a render, so
 * push compares and sends back its body only, and a file teamai did not
 * deliver is the member's own rule in the tool's format, never a new team
 * rule.
 */
const RULE_FORMATS: Readonly<Record<string, RuleFormat>> = {
  cursor: CURSOR_MDC_FORMAT,
  joycode: CURSOR_MDC_FORMAT,
  copilot: COPILOT_INSTRUCTIONS_FORMAT,
  kiro: KIRO_STEERING_FORMAT,
  qoder: QODER_RULE_FORMAT,
  'qoder-cn': QODER_RULE_FORMAT,
};

const SESSION_HOOK_RULE_TOOLS = new Set(['codex', 'codex-internal', 'tcodex']);

/** The tool's own rules format; undefined when it takes the team `.md` verbatim. */
export function ruleFormatForTool(tool: string): RuleFormat | undefined {
  return Object.hasOwn(RULE_FORMATS, tool) ? RULE_FORMATS[tool] : undefined;
}

/**
 * The bytes a team rule becomes for one tool: its render, or the team `.md`
 * verbatim. This is the single spelling of that mapping: `pullItem` writes it
 * and `doctor` compares the delivered file against it, so a stale render is a
 * reported failure rather than a file that merely exists.
 */
export function renderRuleForTool(tool: string, rawTeamRule: string): string {
  return ruleFormatForTool(tool)?.render(rawTeamRule) ?? rawTeamRule;
}

/**
 * True when the tool's rules directory also holds rules the member wrote in
 * the tool's own format, so pull removes only a copy it can prove it wrote
 * there: every tool with a rules format, except Cursor (teamai owns
 * `.cursor/rules`), plus OMP and Pi.
 */
export function sharesRulesDirWithMember(tool: string): boolean {
  if (tool === 'cursor') return false;
  return ruleFormatForTool(tool) !== undefined || tool === 'omp' || tool === 'pi';
}

/** Extension teamai writes rules with for a given tool. */
export function ruleFileExtensionForTool(tool: string): RuleFormat['extension'] {
  return ruleFormatForTool(tool)?.extension ?? '.md';
}

/** True when the tool stores rules in Cursor-compatible `.mdc` format. */
export function usesCursorMdcRules(tool: string): boolean {
  return ruleFileExtensionForTool(tool) === '.mdc';
}

/** True when the tool stores rules as GitHub Copilot instruction files. */
export function usesCopilotInstructions(tool: string): boolean {
  return ruleFileExtensionForTool(tool) === '.instructions.md';
}

/**
 * True when the tool has no rules format of its own, so its session-start hook
 * adds the team rules (the Codex family, #938). Pull writes no rule file for it.
 */
export function getsRulesFromSessionHook(tool: string): boolean {
  return SESSION_HOOK_RULE_TOOLS.has(tool);
}

/** A managed block pull writes into a tool's instructions file (`claudemd`). */
export type InstructionBlock = 'culture' | 'claudemd' | 'recall' | 'team-rules';

/**
 * Whether pull writes `block` into this tool's instructions file: culture and
 * shared instructions for every tool that has one, recall for a tool that
 * also has `agents`, the team rules for a tool with no rules format (the
 * Codex family has an instructions file in user scope only). The team-rules
 * writer and doctor ask this; culture, shared instructions and recall follow
 * the targets in instruction-targets.ts (#945). Whether the tool is installed
 * is a separate question (`instructionFileInstallProbe`).
 */
export function writesInstructionBlock(
  tool: string, toolPath: ToolPath, block: 'recall',
): toolPath is ToolPath & { claudemd: string; agents: string };
export function writesInstructionBlock(
  tool: string, toolPath: ToolPath, block: InstructionBlock,
): toolPath is ToolPath & { claudemd: string };
export function writesInstructionBlock(tool: string, toolPath: ToolPath, block: InstructionBlock): boolean {
  if (!toolPath.claudemd) return false;
  if (block === 'recall') return toolPath.agents !== undefined;
  if (block === 'team-rules') return getsRulesFromSessionHook(tool);
  return true;
}

/**
 * The tool path whose root says a tool is installed, for the culture and
 * shared-instruction writers; undefined when there is none to
 * probe. Never `claudemd`: a root-level AGENTS.md exists without the tool. A
 * Codex-family entry may carry neither `rules` nor `settings` (a team entry
 * replaces the default whole), so its `skills` root is the last resort.
 */
export function instructionFileInstallProbe(tool: string, toolPath: ToolPath): string | undefined {
  const probe = toolPath.rules ?? toolPath.settings;
  return getsRulesFromSessionHook(tool) ? probe ?? toolPath.skills : probe;
}

/**
 * The rules directory each tool that now gets rules from its session-start
 * hook received `<rule>.md` copies in before #938, relative to the tool's base
 * dir in either scope. The tool never read them. It keeps its own `*.rules`
 * exec-policy files there, so only teamai's copies may be removed from it.
 */
export const LEGACY_RULE_DIRS: Readonly<Record<string, string>> = {
  codex: '.codex/rules',
  'codex-internal': '.codex-internal/rules',
  tcodex: '.tcodex/rules',
};

/**
 * Every extension a rule file may carry on disk, newest layout first.
 *
 * Writers use `ruleFileExtensionForTool`; scanners and deleters use this list so
 * they also see copies left by an older teamai layout (e.g. `.cursor/rules/*.md`
 * written before Cursor rules moved to `.mdc`).
 */
export const RULE_FILE_EXTENSIONS = ['.instructions.md', '.mdc', '.md'] as const;

/**
 * Extract a rule name stem from a filename, accepting any supported extension.
 * Returns null for files that are not rule files.
 */
export function ruleStemFromFilename(filename: string): string | null {
  if (filename.endsWith('.instructions.md')) return filename.slice(0, -'.instructions.md'.length);
  if (filename.endsWith('.mdc')) return filename.slice(0, -'.mdc'.length);
  if (filename.endsWith('.md')) return filename.slice(0, -'.md'.length);
  return null;
}

/**
 * True when `filename` is a copy left in an `.mdc` rules directory by an older
 * teamai layout: the target tool never reads `.md` there, so such a file is inert
 * leftover rather than an active rule.
 */
export function isLegacyCursorRuleFile(tool: string, filename: string): boolean {
  return usesCursorMdcRules(tool) && filename.endsWith('.md');
}
