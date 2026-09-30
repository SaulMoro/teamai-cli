/**
 * Model aliases (#830): an agent names a kind of model (`model: strong`) and
 * the team says what that kind means in each tool, in `models/aliases.yaml`:
 *
 *   aliases:
 *     strong:
 *       claude: [{ model: opus, effort: high }, { model: fable }]
 *       codex:  { model: gpt-6-sol, effort: high }
 *
 * A member replaces an entry on their machine in `~/.teamai/models/aliases.yaml`,
 * same shape, one file for every scope and team. There `~` or `default` for a
 * tool means that tool gets no model field.
 *
 * This module is the only place that interprets aliases. It loads the files a
 * scope reads, tells an alias from a literal model, and resolves one agent for
 * one tool. Renderers write what it resolves; nothing else reads the files.
 *
 * Resolution, first match wins: the tool's own extras `model` (the alias and
 * its effort are skipped), the member's local entry, the team entry (first
 * option), no model field. Each entry is whole: a local entry replaces the
 * team's, effort included. A tool switched to a model profile with
 * `teamai models switch` filters what the local or team entry gives: Claude
 * keeps `opus`, `sonnet` or `haiku`, which the switch routes to the gateway's
 * models, and every other switched tool gets no model, so it inherits one
 * natively. No switched tool gets an alias effort.
 *
 * A structural error in either file (bad YAML, wrong types, a bad alias name,
 * an effort without a model, `~` in the team file) fails the load: no model
 * can then be told from an alias, so agents with a `model` are held. What
 * this version does not know is dropped with a warning instead, so a newer
 * CLI's additions never freeze this one.
 */
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { getTeamaiHomeDir, type LocalConfig } from '../types.js';
import { readEntryFileText } from '../namespaced-entries.js';
import { liveModelSwitches, type LiveModelSwitch } from './switch.js';
import { ALL_SUPPORTED_TOOLS, agentEffortField, toolExtrasFor, type AgentSpec, type ToolName } from '../resources/agent-format.js';

/**
 * Alias names every team has, whether or not it maps them. A team maps one
 * by defining it. A name reserved in a later version keeps meaning the team's
 * alias wherever a team already defines it.
 */
const RESERVED_ALIASES = ['strong', 'fast'] as const;

/**
 * Names the tools already read as model aliases of their own, best effort and
 * kept short on purpose: a team alias named like one would silently change
 * what every agent with `model: opus` receives, so such an alias is dropped.
 * A full model id is not covered.
 */
const NATIVE_MODEL_ALIASES: ReadonlySet<string> = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit', 'default', 'auto', 'lite']);

const KNOWN_TOOLS: ReadonlySet<string> = new Set(ALL_SUPPORTED_TOOLS);

const OPTION_FIELDS: ReadonlySet<string> = new Set(['model', 'effort']);

/** Repo-relative path of the team aliases file. */
export const TEAM_ALIASES_FILE = 'models/aliases.yaml';

/**
 * The member's override. Its keys have effect only where they name an alias
 * the team file or the reserved names define: one file serves every team.
 */
export function localAliasesPath(): string {
  return path.join(getTeamaiHomeDir(), 'models', 'aliases.yaml');
}

/**
 * In the local file, `~` or `default` for a tool sends it to its own default.
 * The team file rejects `~` and passes `default` through as a model, which is
 * CodeBuddy's native value for its default model.
 */
const LOCAL_DEFAULT = 'default';

/** The Claude aliases a switch points at the gateway's models of that family. */
const SWITCH_ROUTED_CLAUDE_MODELS: ReadonlySet<string> = new Set(['opus', 'sonnet', 'haiku']);

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

/**
 * Tool id to one option or an ordered list, only the first option used, or
 * null (`~`), which only the local file accepts. What this version does not
 * know is gone by now (`dropUnknownEntries`).
 */
const AliasSchema = z.record(z.string(), z.union([z.null(), OptionSchema, z.array(OptionSchema).min(1)]));

const AliasesFileSchema = z.object({
  aliases: z.record(
    z.string().regex(ALIAS_NAME_RE, 'alias names start with a lowercase letter, then lowercase letters, digits or hyphens'),
    AliasSchema,
  ).nullish(),
});

type AliasEntry = AliasOption | AliasOption[] | null;
type AliasEntries = Record<string, AliasEntry>;

/**
 * Something a file sets that no tool receives as written, dropped with a
 * message. With `tool`, it is about that tool key's entry of `alias` in
 * `file`; without, about the alias as a whole.
 */
export interface AliasWarning {
  readonly alias: string;
  readonly file: 'team' | 'local';
  readonly tool?: ToolName;
  readonly message: string;
}

/** The aliases a scope reads, or why they cannot be read. */
export type ModelAliases =
  | {
    readonly ok: true;
    /** Every alias name: reserved, and defined in the team file. */
    readonly names: ReadonlySet<string>;
    readonly team: ReadonlyMap<string, AliasEntries>;
    /** The member's override, for the names in `names` only. */
    readonly local: ReadonlyMap<string, AliasEntries>;
    /**
     * Every entry the files set that was dropped, one actionable message
     * each. Pull prints those an agent it delivers uses (`aliasWarningsFor`).
     */
    readonly warnings: readonly AliasWarning[];
    /**
     * Each tool `models switch` can switch, by its own id: a variant such as
     * tclaude has no entry, so it is never switched.
     */
    readonly switches: Readonly<Partial<Record<ToolName, LiveModelSwitch>>>;
  }
  | { readonly ok: false; readonly reason: string };

/**
 * Which resolution step produced a tool's model: `literal` when `model` is not
 * an alias. `local` without a model is the member's `~` or `default`.
 * `switched` is a local or team model the switch filtered: Claude's family
 * alias it kept, or no model.
 */
export type ResolutionStep = 'extras' | 'literal' | 'switched' | 'local' | 'team' | 'default';

/**
 * What one tool receives for an agent's model, or why it cannot be resolved.
 * `effort` is present only when the alias produced it: an effort the tool's
 * extras set is the extras' own, and the step `extras` skips the alias whole.
 */
export type ModelResolution =
  | { readonly ok: true; readonly step: ResolutionStep; readonly model?: string; readonly effort?: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Load the aliases `localConfig`'s scope reads: the team file of its checkout
 * and the member's override. A missing file is an empty mapping, so `strong`
 * and `fast` resolve to no model field.
 */
export async function loadModelAliases(localConfig: LocalConfig): Promise<ModelAliases> {
  const team = await readAliasesFile(path.join(localConfig.repo.localPath, ...TEAM_ALIASES_FILE.split('/')), TEAM_ALIASES_FILE, 'team');
  if (!team.ok) return team;
  const optOut = [...team.aliases].flatMap(([alias, entries]) => Object.keys(entries).filter((tool) => entries[tool] === null).map((tool) => `${alias}.${tool}`));
  if (optOut.length > 0) {
    return {
      ok: false,
      reason: `Invalid model aliases file at ${TEAM_ALIASES_FILE}: ${optOut.join(', ')}: ~ is accepted only in a member's ${localAliasesPath()}. `
        + 'Remove the entry to leave the tool on its default model',
    };
  }
  const localPath = localAliasesPath();
  const local = await readAliasesFile(localPath, localPath, 'local');
  if (!local.ok) return local;
  const names = new Set<string>([...RESERVED_ALIASES, ...team.aliases.keys()]);
  // Read once per load, and only matters for aliases: a literal model is written as is.
  const switches = await liveModelSwitches();
  // A local name no team here defines is another team's: it has no effect, so no warning either.
  const localHere = new Map([...local.aliases].filter(([alias]) => names.has(alias)));
  return {
    ok: true,
    names,
    team: team.aliases,
    local: localHere,
    warnings: [
      ...team.warnings,
      ...droppedEffortWarnings(team.aliases, TEAM_ALIASES_FILE, 'team'),
      // A native name is in no team's `names`: the member meant it for all of them.
      ...local.warnings.filter(({ alias }) => names.has(alias) || NATIVE_MODEL_ALIASES.has(alias)),
      ...droppedEffortWarnings(localHere, localPath, 'local'),
    ],
    switches,
  };
}

/**
 * One aliases file, `label` naming it in messages. A structural error fails
 * it whole; what this version does not know is dropped with a warning.
 */
async function readAliasesFile(
  absolutePath: string,
  label: string,
  file: AliasWarning['file'],
): Promise<{ ok: true; aliases: Map<string, AliasEntries>; warnings: AliasWarning[] } | { ok: false; reason: string }> {
  const read = await readEntryFileText(absolutePath, label);
  if (!read.ok) return read;
  let document: unknown = null;
  try {
    document = read.text === null ? null : YAML.parse(read.text);
  } catch (error) {
    return { ok: false, reason: `Invalid model aliases YAML at ${label}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const known = dropUnknownEntries(document ?? {}, label, file);
  const parsed = AliasesFileSchema.safeParse(known.document);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Invalid model aliases file at ${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    };
  }
  return { ok: true, aliases: new Map(Object.entries(parsed.data.aliases ?? {})), warnings: known.warnings };
}

/**
 * Take out what this version does not know before the schema sees it, so a
 * newer CLI's additions never fail the file: an alias named like a native
 * model alias, a tool key that is not a tool and an option field other than
 * `model` and `effort`, each with a warning, and `gateways`, reserved for
 * mappings keyed by model profile, silently. Whatever is not shaped like an
 * alias map is left for the schema to reject.
 */
function dropUnknownEntries(document: unknown, label: string, file: AliasWarning['file']): { document: unknown; warnings: AliasWarning[] } {
  if (!isRecord(document) || !isRecord(document['aliases'])) return { document, warnings: [] };
  const warnings: AliasWarning[] = [];
  const aliases: Record<string, unknown> = {};
  for (const [alias, value] of Object.entries(document['aliases'])) {
    if (NATIVE_MODEL_ALIASES.has(alias)) {
      warnings.push({ alias, file, message: `${label}: alias "${alias}" has the name of a tool's own model alias, so it is ignored `
        + `and agents with model: ${alias} receive ${alias} as written. Rename the alias, such as "${alias}-team".` });
      continue;
    }
    if (!isRecord(value)) {
      aliases[alias] = value;
      continue;
    }
    const entries: Record<string, unknown> = {};
    for (const [tool, entry] of Object.entries(value)) {
      if (tool === 'gateways') continue;
      if (!KNOWN_TOOLS.has(tool)) {
        warnings.push({ alias, file, message: `${label}: alias "${alias}" maps "${tool}", which is not a tool teamai knows, so that entry `
          + 'is ignored. Fix the tool id, or update teamai if a newer version added that tool.' });
        continue;
      }
      const unknown = new Set<string>();
      const withoutUnknown = (option: unknown): unknown => {
        if (!isRecord(option)) return option;
        const fields = Object.keys(option).filter((field) => !OPTION_FIELDS.has(field));
        for (const field of fields) unknown.add(field);
        return fields.length === 0 ? option : Object.fromEntries(Object.entries(option).filter(([field]) => OPTION_FIELDS.has(field)));
      };
      entries[tool] = Array.isArray(entry) ? entry.map(withoutUnknown) : withoutUnknown(entry);
      if (unknown.size > 0) {
        const fields = [...unknown].map((field) => `"${field}"`).join(', ');
        warnings.push({ alias, file, tool: tool as ToolName, message: `${label}: alias "${alias}" sets ${fields} for ${tool}, which teamai `
          + `does not know, so ${tool} receives that entry without it. Remove it, or update teamai if a newer version added it.` });
      }
    }
    aliases[alias] = entries;
  }
  return { document: { ...document, aliases }, warnings };
}

/**
 * An effort mapped for a tool whose agent files TeamAI writes no effort field
 * for is dropped: the tool receives the model alone. One message per alias
 * and tool, however many of its options set an effort.
 */
function droppedEffortWarnings(aliases: ReadonlyMap<string, AliasEntries>, label: string, file: AliasWarning['file']): AliasWarning[] {
  const warnings: AliasWarning[] = [];
  for (const [alias, entries] of aliases) {
    for (const tool of ALL_SUPPORTED_TOOLS) {
      const entry = entries[tool];
      if (entry === undefined || entry === null || agentEffortField(tool) !== undefined) continue;
      const withEffort = (Array.isArray(entry) ? entry : [entry]).find((option) => typeof option !== 'string' && option.effort !== undefined);
      if (withEffort === undefined || typeof withEffort === 'string') continue;
      const hint = tool === 'cursor'
        ? `Remove it, or write it into the model in Cursor's bracket form, such as "${withEffort.model}[effort=${withEffort.effort}]".`
        : `Remove effort from ${alias}.${tool} to silence this warning.`;
      warnings.push({ alias, file, tool, message: `${label}: alias "${alias}" sets an effort for ${tool}, but effort is not supported for `
        + `${tool} agent files, so ${tool} receives the model without it. ${hint}` });
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

/**
 * The warnings about what `tool` receives for `spec`: those about its alias as
 * a whole, and those about the entry its model comes from. A tool whose
 * extras model skips the alias, or that is switched, receives no entry as
 * written. Pull prints only these, so a member hears of an entry only when an
 * agent they receive uses it; doctor lists them all.
 */
export function aliasWarningsFor(aliases: ModelAliases, spec: AgentSpec, tool: ToolName): string[] {
  if (!aliases.ok || spec.model === undefined) return [];
  const alias = spec.model;
  const switched = aliases.switches[tool];
  const readsEntry = toolExtrasFor(spec, tool)?.['model'] === undefined && !(switched?.ok === true && switched.switched);
  const source = readsEntry ? entrySource(aliases, alias, tool) : undefined;
  return aliases.warnings
    .filter((warning) => warning.alias === alias
      && (warning.tool === undefined || (warning.file === source?.file && warning.tool === source.key)))
    .map((warning) => warning.message);
}

/** Which file's entry, under which tool key, `fromEntries` reads for `tool`. */
function entrySource(aliases: ModelAliases & { ok: true }, alias: string, tool: ToolName): { file: AliasWarning['file']; key: string } | undefined {
  const local = entryKey(aliases.local.get(alias), tool);
  if (local !== undefined) return { file: 'local', key: local };
  const team = entryKey(aliases.team.get(alias), tool);
  return team !== undefined ? { file: 'team', key: team } : undefined;
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

  const switched = aliases.switches[tool];
  if (switched?.ok === false) {
    return { ok: false, reason: `Cannot tell whether a tool is switched to a model profile: ${switched.reason}` };
  }
  const resolution = fromEntries(aliases, spec.model, tool, extras);
  return switched?.switched ? throughSwitch(resolution, tool) : resolution;
}

/** What the member's local entry, else the team entry, gives `tool` for `alias`. */
function fromEntries(aliases: ModelAliases & { ok: true }, alias: string, tool: ToolName, extras: Record<string, unknown> | undefined): ModelResolution {
  const local = toolEntry(aliases.local.get(alias), tool);
  if (local === null || local === LOCAL_DEFAULT) return { ok: true, step: 'local' };
  if (local !== undefined) return fromOption('local', local, tool, extras);
  const team = toolEntry(aliases.team.get(alias), tool);
  if (team === undefined || team === null) return { ok: true, step: 'default' };
  return fromOption('team', team, tool, extras);
}

/**
 * What a switched tool keeps of `resolution`: the gateway receives only what
 * the switch routes. A resolution with no model, such as the member's
 * opt-out, has nothing to filter and keeps its step.
 */
function throughSwitch(resolution: ModelResolution, tool: ToolName): ModelResolution {
  if (!resolution.ok || resolution.model === undefined) return resolution;
  return tool === 'claude' && SWITCH_ROUTED_CLAUDE_MODELS.has(resolution.model)
    ? { ok: true, step: 'switched', model: resolution.model }
    : { ok: true, step: 'switched' };
}

/** `tool`'s entry in one file's alias, its own key before the tool it inherits from. */
function toolEntry(entries: AliasEntries | undefined, tool: ToolName): AliasEntry | undefined {
  const key = entryKey(entries, tool);
  return key === undefined ? undefined : entries![key];
}

/** The key of `tool`'s entry in one file's alias. */
function entryKey(entries: AliasEntries | undefined, tool: ToolName): string | undefined {
  if (entries === undefined) return undefined;
  if (Object.hasOwn(entries, tool)) return tool;
  const base = ALIAS_BASE_TOOL[tool];
  return base !== undefined && Object.hasOwn(entries, base) ? base : undefined;
}

/**
 * What the first option of `entry` gives `tool`. The effort is kept only for
 * a tool with an effort field that its extras do not set.
 */
function fromOption(
  step: 'local' | 'team',
  entry: AliasOption | AliasOption[],
  tool: ToolName,
  extras: Record<string, unknown> | undefined,
): ModelResolution {
  const first = Array.isArray(entry) ? entry[0]! : entry;
  const option = typeof first === 'string' ? { model: first } : first;
  const effortField = agentEffortField(tool);
  const effort = option.effort !== undefined && effortField !== undefined && extras?.[effortField] === undefined
    ? option.effort
    : undefined;
  return { ok: true, step, model: option.model, ...(effort !== undefined ? { effort } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
