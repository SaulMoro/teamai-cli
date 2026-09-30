/**
 * Per-tool on-disk format for rule files.
 *
 * The team repo always stores rules as tool-neutral `<name>.md`. Most tools take
 * a verbatim `.md` copy. Cursor and JoyCode use `.mdc` rules, while GitHub
 * Copilot CLI uses `.instructions.md`; those copies carry native frontmatter.
 *
 * This module is the single place that decision lives, mirroring
 * `agentFileExtensionForTool` in `./agent-format.ts`. Every site that writes,
 * scans, or deletes files in a tool's rules directory must go through it, so a
 * new per-tool extension never has to be re-discovered call site by call site.
 */

import type { TeamaiConfig } from '../types.js';

type ToolPath = TeamaiConfig['toolPaths'][string];

const CURSOR_MDC_RULE_TOOLS = new Set(['cursor', 'joycode']);
const COPILOT_INSTRUCTIONS_RULE_TOOLS = new Set(['copilot']);
const INSTRUCTIONS_FILE_RULE_TOOLS = new Set(['codex', 'codex-internal', 'tcodex']);

/** Extension teamai writes rules with for a given tool. */
export function ruleFileExtensionForTool(tool: string): '.md' | '.mdc' | '.instructions.md' {
  if (usesCursorMdcRules(tool)) return '.mdc';
  return usesCopilotInstructions(tool) ? '.instructions.md' : '.md';
}

/** True when the tool stores rules in Cursor-compatible `.mdc` format. */
export function usesCursorMdcRules(tool: string): boolean {
  return CURSOR_MDC_RULE_TOOLS.has(tool);
}

/** True when the tool stores rules as GitHub Copilot instruction files. */
export function usesCopilotInstructions(tool: string): boolean {
  return COPILOT_INSTRUCTIONS_RULE_TOOLS.has(tool);
}

/**
 * True when the tool reads no rules directory, so team rules are inlined into
 * a managed block of its instructions file (its `claudemd` path) instead.
 */
export function inlinesRulesIntoInstructions(tool: string): boolean {
  return INSTRUCTIONS_FILE_RULE_TOOLS.has(tool);
}

/** A managed block pull writes into a tool's instructions file (`claudemd`). */
export type InstructionBlock = 'culture' | 'claudemd' | 'recall' | 'team-rules';

/**
 * Whether pull writes `block` into this tool's instructions file: culture and
 * shared instructions for every tool that has one, recall for a tool that
 * also has `agents`, team rules for a tool that inlines them. Pull's writers
 * and uninstall both ask this, so what uninstall keeps for a remaining tool is
 * what that tool's next pull refreshes. Whether the tool is installed is a
 * separate question (`instructionFileInstallProbe`).
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
  if (block === 'team-rules') return inlinesRulesIntoInstructions(tool);
  return true;
}

/**
 * The tool path whose root says a tool is installed, for the culture,
 * shared-instruction and team-rules writers; undefined when there is none to
 * probe. Never `claudemd`: a root-level AGENTS.md exists without the tool. A
 * Codex-family entry may carry neither `rules` nor `settings` (a team entry
 * replaces the default whole), so its `skills` root is the last resort.
 */
export function instructionFileInstallProbe(tool: string, toolPath: ToolPath): string | undefined {
  const probe = toolPath.rules ?? toolPath.settings;
  return inlinesRulesIntoInstructions(tool) ? probe ?? toolPath.skills : probe;
}

/**
 * The rules directory each tool that now inlines rules into its instructions
 * file received `<rule>.md` copies in before #938, relative to the tool's base
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
