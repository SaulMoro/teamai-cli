/**
 * Per-tool on-disk format for rule files.
 *
 * The team repo always stores rules as tool-neutral `<name>.md`. A tool with
 * a rules format of its own gets a render of it (`RULE_FORMATS`): Cursor and
 * JoyCode `.mdc`, Copilot `.instructions.md`, Kiro steering, Qoder, CodeBuddy
 * (which WorkBuddy shares) and Oh My Pi rules `.md` with their own
 * frontmatter. Every other tool takes a verbatim `.md` copy.
 *
 * This module is the single place that decision lives, mirroring
 * `agentFileExtensionForTool` in `./agent-format.ts`. Every site that writes,
 * scans, compares, pushes or deletes files in a tool's rules directory must go
 * through it, so a new format never has to be re-discovered call site by call
 * site. Adding one is a render module exporting a `RuleFormat` plus one entry
 * below.
 */

import type { Scope, TeamaiConfig } from '../types.js';
import { CODEBUDDY_RULE_FORMAT } from './codebuddy-rule.js';
import { COPILOT_INSTRUCTIONS_FORMAT } from './copilot-instructions.js';
import { CURSOR_MDC_FORMAT } from './cursor-mdc.js';
import { JOYCODE_RULE_FORMAT } from './joycode-rule.js';
import { KIRO_STEERING_FORMAT } from './kiro-steering.js';
import { OMP_RULE_FORMAT } from './omp-rule.js';
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
  /** The tool reads only the top level of its rules directory, so a namespaced rule is written flat (`ruleStemsForTool`). */
  readonly flat?: true;
}

/**
 * The tools with a rules format of their own. A copy there is a render, so
 * push compares and sends back its body only, and a file teamai did not
 * deliver is the member's own rule in the tool's format, never a new team
 * rule.
 */
const RULE_FORMATS: Readonly<Record<string, RuleFormat>> = {
  cursor: CURSOR_MDC_FORMAT,
  joycode: JOYCODE_RULE_FORMAT,
  copilot: COPILOT_INSTRUCTIONS_FORMAT,
  kiro: KIRO_STEERING_FORMAT,
  qoder: QODER_RULE_FORMAT,
  'qoder-cn': QODER_RULE_FORMAT,
  codebuddy: CODEBUDDY_RULE_FORMAT,
  // Same engine as CodeBuddy; in a project it reads .codebuddy/rules too.
  workbuddy: CODEBUDDY_RULE_FORMAT,
  omp: OMP_RULE_FORMAT,
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

/** `fe/style` as a tool that reads only the top of its rules directory gets it: `fe.style`. */
export function flatStem(name: string): string {
  return name.replaceAll('/', '.');
}

/**
 * The file stem each of `teamNames` has in the tool's rules directory: the
 * team name, or for a tool that reads only the top level (`RuleFormat.flat`)
 * the name with its `/` turned into `.`, so `fe/style` is `fe.style`. A
 * namespaced rule whose flat stem another of `teamNames` also has is left out
 * (`flatStemSharers` names the others), so no two rules share a file and push
 * maps each copy back to one rule; a root rule keeps its own name.
 */
export function ruleStemsForTool(tool: string, teamNames: Iterable<string>): Map<string, string> {
  const names = [...new Set(teamNames)];
  if (!ruleFormatForTool(tool)?.flat) return new Map(names.map((name) => [name, name]));
  const stems = new Map<string, string>();
  for (const name of names) {
    if (!name.includes('/') || flatStemSharers(tool, name, names).length === 0) stems.set(name, flatStem(name));
  }
  return stems;
}

/** The other names among `teamNames` that `name` shares its flat stem with in the tool's rules directory. */
export function flatStemSharers(tool: string, name: string, teamNames: Iterable<string>): string[] {
  if (!ruleFormatForTool(tool)?.flat) return [];
  const stem = flatStem(name);
  return [...new Set(teamNames)].filter((other) => other !== name && flatStem(other) === stem);
}

/**
 * The team rule a file in the tool's rules directory (`stem`, its path less
 * the extension) is the copy of, given the tool's `stems`
 * (`ruleStemsForTool`): `fe.style` is `fe/style` for OMP. Undefined for a
 * file below the top of a directory the tool reads only the top of, which is
 * no rule of the tool's; `stem` itself when no team rule is delivered there.
 */
export function teamRuleNameForFile(tool: string, stem: string, stems: ReadonlyMap<string, string>): string | undefined {
  if (!ruleFormatForTool(tool)?.flat) return stem;
  if (stem.includes('/')) return undefined;
  for (const [name, delivered] of stems) {
    if (delivered === stem) return name;
  }
  return stem;
}

/**
 * The flat stems the copies of `removed` rules have in the tool's rules
 * directory, beyond their own names: none unless the tool reads only the top
 * level, and none that a rule still in `teamNames` is delivered at. A file
 * there may be the member's own, so only a delivery record makes it teamai's.
 */
export function flatStemsOfRemoved(tool: string, removed: Iterable<string>, teamNames: Iterable<string>): Set<string> {
  if (!ruleFormatForTool(tool)?.flat) return new Set();
  const live = new Set(ruleStemsForTool(tool, teamNames).values());
  return new Set([...removed].filter((name) => name.includes('/')).map(flatStem).filter((stem) => !live.has(stem)));
}

/**
 * True when the tool's rules directory also holds rules the member wrote in
 * the tool's own format, so pull removes only a copy it can prove it wrote
 * there: every tool with a rules format, except Cursor (teamai owns
 * `.cursor/rules`), plus Pi.
 */
export function sharesRulesDirWithMember(tool: string): boolean {
  if (tool === 'cursor') return false;
  return ruleFormatForTool(tool) !== undefined || tool === 'pi';
}

/** Extension teamai writes rules with for a given tool. */
export function ruleFileExtensionForTool(tool: string): RuleFormat['extension'] {
  return ruleFormatForTool(tool)?.extension ?? '.md';
}

/** True when the tool stores rules as `.mdc` files (Cursor, JoyCode), so it reads no `.md` there. */
export function usesMdcRules(tool: string): boolean {
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
 * A rules directory where earlier pulls left team rule copies the tool does
 * not load as teamai means it to. Pull reclaims the unedited ones on every
 * rules sync (`RulesHandler.reclaimLegacyRuleCopies`): a copy of a rule still
 * delivered is replaced by its current delivery, others are removed, and an
 * edited one is kept and named. `uninstall` removes the same unedited ones.
 *
 * Adding a directory is one entry. A copy is unedited when it holds
 * `legacyRender` of the team rule (now or at a revision this checkout
 * pulled), the tool's current render, or the hash the delivery ledger
 * recorded for it, or for its namesake in `copiedFrom.dir`.
 */
export interface LegacyRuleDir {
  readonly tool: string;
  /** The scopes earlier pulls wrote it in. */
  readonly scopes: readonly Scope[];
  /** Relative to the tool's base dir in that scope (HOME or the project root). */
  readonly dir: string;
  /** The extension the copies were written with. */
  readonly ext: '.md' | '.mdc';
  /** What an older teamai wrote there from the team rule; the team `.md` verbatim when absent. */
  readonly legacyRender?: (rawTeamRule: string) => string;
  /**
   * For a directory the tool does read, whose copies the tool itself copied
   * from another one: that directory, relative to the same base dir, and the
   * file the tool leaves once it has copied. The ledger hash recorded in
   * `dir` for the same file also proves a copy unedited, or edited when it
   * differs. Such a directory is reclaimed only once the marker exists and
   * while the tool is not excluded, even while teamai delivers to it, and the
   * built-in rules teamai deploys there are left to that delivery.
   */
  readonly copiedFrom?: { readonly dir: string; readonly marker: string };
  /** Why a copy kept there is a problem, completing "Kept <files>: ..., and". */
  readonly why: string;
  /** What to do with a kept copy, as one sentence. */
  readonly advice: string;
}

/**
 * The warning naming the copies kept in a legacy rules directory: why they
 * matter there, and what to do with them.
 */
export function keptLegacyCopiesWarning(files: readonly string[], entry: LegacyRuleDir): string {
  return `Kept ${files.join(', ')}: teamai could not verify that ${files.length === 1 ? 'it matches' : 'they match'} `
    + `what it delivered there, and ${entry.why}. ${entry.advice}`;
}

const codexLegacyDir = (tool: string, dir: string): LegacyRuleDir => ({
  tool,
  scopes: ['user', 'project'],
  dir,
  ext: '.md',
  // Codex keeps its own `*.rules` exec-policy files there, so only teamai's
  // copies may be removed from it.
  why: 'Codex does not read .md files in its rules directory (team rules now reach it through its session-start hook)',
  advice: 'Delete what you did not edit; to keep your changes, move them into AGENTS.md outside the teamai markers, then delete the copy.',
});

export const LEGACY_RULE_DIRS: readonly LegacyRuleDir[] = [
  // Before #938 the Codex family got `<rule>.md` copies it never read.
  codexLegacyDir('codex', '.codex/rules'),
  codexLegacyDir('codex-internal', '.codex-internal/rules'),
  codexLegacyDir('tcodex', '.tcodex/rules'),
  // WorkBuddy reads a project's rules from CodeBuddy's .codebuddy/rules (#946).
  {
    tool: 'workbuddy',
    scopes: ['project'],
    dir: '.workbuddy/rules',
    ext: '.md',
    why: 'WorkBuddy reads a project\'s rules from .codebuddy/rules, not from .workbuddy/rules',
    advice: 'Delete what you did not edit; to keep your changes, move them into .codebuddy/rules under a name of your own, then delete the copy.',
  },
  // WorkBuddy's one-time migration (`migrateLegacyDataOnce`) copied
  // ~/.codebuddy/rules, team copies included, into the rules it loads.
  {
    tool: 'workbuddy',
    scopes: ['user'],
    dir: '.workbuddy/rules',
    ext: '.md',
    copiedFrom: { dir: '.codebuddy/rules', marker: '.workbuddy/.migrated-from-codebuddy' },
    why: 'WorkBuddy copied it from ~/.codebuddy/rules into the rules it loads, and teamai no longer delivers it here',
    advice: 'Delete it if you did not edit it; to keep your changes, rename it to a name of your own.',
  },
];

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
  return usesMdcRules(tool) && filename.endsWith('.md');
}
