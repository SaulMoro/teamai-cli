/**
 * Model aliases (#830): an agent names a kind of model (`model: strong`) and
 * the team says what that kind means in each tool, in `models/aliases.yaml`:
 *
 *   aliases:
 *     strong:
 *       claude: [{ model: opus, effort: high }, { model: fable }]
 *       codex:  { model: gpt-6-sol, effort: high }
 *
 * This module is the only place that interprets aliases. It loads the files a
 * scope reads, tells an alias from a literal model, and resolves one agent for
 * one tool. Renderers write what it resolves; nothing else reads the files.
 *
 * Resolution, first match wins: the tool's own extras `model` (the alias and
 * its effort are skipped), the team entry (first option), no model field.
 */
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import { readEntryFileText } from '../namespaced-entries.js';
import { ALL_SUPPORTED_TOOLS, agentEffortField, toolExtrasFor, type AgentSpec, type ToolName } from '../resources/agent-format.js';

/** Alias names every team has, whether or not it maps them. */
const RESERVED_ALIASES = ['strong', 'fast'] as const;

/** Repo-relative path of the team aliases file. */
const TEAM_ALIASES_FILE = 'models/aliases.yaml';

const ALIAS_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Tools that share another tool's model catalog read its entry when they have
 * none of their own. Not the extras inheritance: that one covers only tclaude
 * and tcodex (`toolExtrasFor`).
 */
const ALIAS_BASE_TOOL: Partial<Record<ToolName, ToolName>> = {
  'claude-internal': 'claude',
  tclaude: 'claude',
  'codex-internal': 'codex',
  tcodex: 'codex',
  'qoder-cn': 'qoder',
};

const OptionSchema = z.union([
  z.string().min(1),
  z.object({ model: z.string().min(1), effort: z.string().min(1).optional() }),
]);
type AliasOption = z.infer<typeof OptionSchema>;

/** Tool id to one option or an ordered list; only the first option is used. */
const AliasSchema = z.preprocess(
  // `gateways` is reserved for mappings keyed by model profile; v1 ignores it.
  (value) => (isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'gateways')) : value),
  z.record(z.string(), z.union([OptionSchema, z.array(OptionSchema).min(1)])),
);

const AliasesFileSchema = z.object({
  aliases: z.record(
    z.string().regex(ALIAS_NAME_RE, 'alias names start with a lowercase letter, then lowercase letters, digits or hyphens'),
    AliasSchema,
  ).nullish(),
});

type AliasEntries = Record<string, AliasOption | AliasOption[]>;

/** The aliases a scope reads, or why they cannot be read. */
export type ModelAliases =
  | {
    readonly ok: true;
    /** Every alias name: reserved, and defined in the team file. */
    readonly names: ReadonlySet<string>;
    readonly team: ReadonlyMap<string, AliasEntries>;
    /** What the files set that no tool receives, one actionable message each. */
    readonly warnings: readonly string[];
  }
  | { readonly ok: false; readonly reason: string };

/** Which resolution step produced a tool's model: `literal` when `model` is not an alias. */
export type ResolutionStep = 'extras' | 'literal' | 'team' | 'default';

/**
 * What one tool receives for an agent's model, or why it cannot be resolved.
 * `effort` is present only when the alias produced it: an effort the tool's
 * extras set is the extras' own, and the step `extras` skips the alias whole.
 */
export type ModelResolution =
  | { readonly ok: true; readonly step: ResolutionStep; readonly model?: string; readonly effort?: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Load the aliases `localConfig`'s scope reads. A missing file is an empty
 * mapping, so `strong` and `fast` resolve to no model field.
 */
export async function loadModelAliases(localConfig: LocalConfig): Promise<ModelAliases> {
  const read = await readEntryFileText(path.join(localConfig.repo.localPath, ...TEAM_ALIASES_FILE.split('/')), TEAM_ALIASES_FILE);
  if (!read.ok) return read;
  let document: unknown = null;
  try {
    document = read.text === null ? null : YAML.parse(read.text);
  } catch (error) {
    return { ok: false, reason: `Invalid model aliases YAML at ${TEAM_ALIASES_FILE}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = AliasesFileSchema.safeParse(document ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Invalid model aliases file at ${TEAM_ALIASES_FILE}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    };
  }
  const team = new Map(Object.entries(parsed.data.aliases ?? {}));
  return { ok: true, names: new Set([...RESERVED_ALIASES, ...team.keys()]), team, warnings: droppedEffortWarnings(team) };
}

/**
 * An effort mapped for a tool whose agent files TeamAI writes no effort field
 * for is dropped: the tool receives the model alone. One message per alias
 * and tool, however many of its options set an effort.
 */
function droppedEffortWarnings(team: ReadonlyMap<string, AliasEntries>): string[] {
  const warnings: string[] = [];
  for (const [alias, entries] of team) {
    for (const tool of ALL_SUPPORTED_TOOLS) {
      if (!Object.hasOwn(entries, tool) || agentEffortField(tool) !== undefined) continue;
      const entry = entries[tool]!;
      const withEffort = (Array.isArray(entry) ? entry : [entry]).find((option) => typeof option !== 'string' && option.effort !== undefined);
      if (withEffort === undefined || typeof withEffort === 'string') continue;
      const hint = tool === 'cursor'
        ? `Remove it, or write it into the model in Cursor's bracket form, such as "${withEffort.model}[effort=${withEffort.effort}]".`
        : `Remove effort from ${alias}.${tool} to silence this warning.`;
      warnings.push(`${TEAM_ALIASES_FILE}: alias "${alias}" sets an effort for ${tool}, but effort is not supported for ${tool} agent files, `
        + `so ${tool} receives the model without it. ${hint}`);
    }
  }
  return warnings;
}

/**
 * Whether `model` names an alias. While the aliases cannot be read, only the
 * reserved names are known to be aliases.
 */
export function isModelAlias(aliases: ModelAliases, model: string): boolean {
  return aliases.ok ? aliases.names.has(model) : (RESERVED_ALIASES as readonly string[]).includes(model);
}

/** What `tool` receives for `spec`'s model. */
export function resolveAgentModel(aliases: ModelAliases, spec: AgentSpec, tool: ToolName): ModelResolution {
  const extras = toolExtrasFor(spec, tool);
  const extrasModel = extras?.['model'];
  if (extrasModel !== undefined) {
    return { ok: true, step: 'extras', ...(typeof extrasModel === 'string' ? { model: extrasModel } : {}) };
  }
  if (spec.model === undefined) return { ok: true, step: 'default' };
  // An unreadable file may define any name, so no model can be told literal.
  if (!aliases.ok) return aliases;
  if (!aliases.names.has(spec.model)) return { ok: true, step: 'literal', model: spec.model };

  const option = teamOption(aliases.team.get(spec.model), tool);
  if (option === undefined) return { ok: true, step: 'default' };
  const effortField = agentEffortField(tool);
  const effort = option.effort !== undefined && effortField !== undefined && extras?.[effortField] === undefined
    ? option.effort
    : undefined;
  return { ok: true, step: 'team', model: option.model, ...(effort !== undefined ? { effort } : {}) };
}

/** The first option of `tool`'s entry, its own key before the tool it inherits from. */
function teamOption(entries: AliasEntries | undefined, tool: ToolName): { model: string; effort?: string } | undefined {
  if (entries === undefined) return undefined;
  const base = ALIAS_BASE_TOOL[tool];
  const entry = Object.hasOwn(entries, tool) ? entries[tool] : base !== undefined && Object.hasOwn(entries, base) ? entries[base] : undefined;
  const first = Array.isArray(entry) ? entry[0] : entry;
  if (first === undefined) return undefined;
  return typeof first === 'string' ? { model: first } : first;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
