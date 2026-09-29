import crypto from 'node:crypto';
import path from 'node:path';
import fse from 'fs-extra';
import type {
  LocalConfig,
  TeamaiConfig,
  McpServerDef,
  ManagedMcpManifest,
  ManagedMcpRecord,
} from './types.js';
import {
  getMcpSharing,
  getEnvBackupPath,
  isAgentExcluded,
  getDataHome,
  managedMcpManifestPath,
  managedMcpManifestKey,
  resolveToolBaseDir,
  scopedToolPaths,
  TeamaiConfigSchema,
} from './types.js';
import {
  detectMcpFormat,
  supportsTransport,
  supportsEnvExpansion,
  renderJsonEntry,
  renderCodexBlock,
  resolvePlaceholders,
  referencedVars,
  entryHash,
  MCP_SERVER_KEY,
  type McpFormat,
} from './resources/mcp-format.js';
import { mcpEntryReader, teamMcpToDef } from './resources/mcp.js';
import { envEntryReader } from './resources/env.js';
import { isToolInstalledForConfig } from './resources/base.js';
import { reportEntryResolution, resolveEntriesFor } from './namespaced-entries.js';
import {
  readJson,
  writeJsonAtomic,
  readFileSafe,
  pathExists,
  expandHome,
} from './utils/fs.js';
import { log } from './utils/logger.js';
import { loadProjectMcpManifest } from './utils/mcp-manifest.js';
import { isOnPath, SAFE_BIN_RE, type LookPathOptions } from './utils/lookpath.js';
import {
  carriesResolvedValue,
  ensureExcludedFromGit,
  excludeFromGit,
  existingAncestor,
  findMcpGitExcludes,
  mcpExcludePatternPath,
  removeMcpGitExclude,
  resolvedVariableIn,
  type GitExclusion,
} from './mcp-git-exclude.js';
import { listWorktrees } from './utils/git.js';

// ─── Reconcile engine ────────────────────────────────────────
//
//  Injects team MCP servers into each tool's own config file, idempotently.
//
//  The files here are NOT owned by teamai — ~/.claude.json also holds the OAuth
//  session and all per-project state, and ~/.codex/config.toml holds model and
//  trust settings. So every write is key-level surgery on an existing document,
//  never a regenerate-from-scratch, and never a whole-file TOML round-trip
//  (which would silently drop the user's comments).
//
//  Ownership lives in ~/.teamai/managed-mcp.json rather than a marker inside the
//  entry, because MCP entries have no field we can safely stamp. Only keys the
//  manifest claims are ever rewritten or removed; anything the user added by
//  hand is left strictly alone.

export interface McpReconcileOptions {
  /** Remove all teamai-managed servers instead of injecting the desired set. */
  removeAll?: boolean;
  /** Report intended changes without touching disk. */
  dryRun?: boolean;
  /** Overwrite user-owned servers that collide by name. */
  force?: boolean;
  /**
   * Override PATH lookup for `requires`. Production inject omits this and
   * reads `process.env` / `process.platform`. Tests inject win32 + PATHEXT
   * without mutating the host platform.
   */
  lookPath?: LookPathOptions;
}

export interface McpChange {
  tool: string;
  server: string;
  action: 'added' | 'updated' | 'removed' | 'skipped';
  reason?: string;
}

export interface McpReconcileResult {
  changes: McpChange[];
  /** True when any file was actually written. */
  wrote: boolean;
  /**
   * Set when the team's servers could not be resolved (a file that does not
   * parse, a name twice): nothing was changed, and the reason was reported.
   */
  unresolved?: true;
}

// ─── Manifest ────────────────────────────────────────────────

async function readManifest(manifestPath: string): Promise<ManagedMcpManifest> {
  const data = await readJson<ManagedMcpManifest>(expandHome(manifestPath));
  return data && typeof data === 'object' ? data : {};
}

// ─── Secret lookup ───────────────────────────────────────────

/**
 * Build the ${VAR} lookup table: the team env variables this member receives
 * (root plus active namespace files, the same set pull writes env.sh from),
 * then process env on top.
 *
 * The installed KEY=value backup is read instead only when that set cannot be
 * resolved (pull then keeps env.sh as it is, so MCP sees what the shell sees)
 * or the team has no repo tree to resolve it from (HTTP mode).
 */
export async function buildVarTable(localConfig: LocalConfig): Promise<Record<string, string>> {
  const table: Record<string, string> = {};
  const env = localConfig.repo.kind === 'http'
    ? null
    : await resolveEntriesFor(envEntryReader, localConfig);
  if (env?.kind === 'resolved') {
    for (const variable of env.entries) table[variable.name] = variable.entry.value;
  } else {
    Object.assign(table, await readEnvBackup(localConfig));
  }
  // process.env wins: it lets a user override a team-provided value locally.
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) table[k] = v;
  }
  return table;
}

/** The KEY=value file the env channel last wrote. */
async function readEnvBackup(localConfig: LocalConfig): Promise<Record<string, string>> {
  const table: Record<string, string> = {};
  // Must use the same path the env channel wrote (getEnvBackupPath) — self mode
  // uses env.local, not env (which is a committed directory there).
  const envFile = getEnvBackupPath(localConfig);
  const content = await readFileSafe(envFile);
  if (content) {
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      table[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
  return table;
}

// ─── Security gate ───────────────────────────────────────────

function hostAllowed(url: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return true;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return allowedHosts.some((pattern) =>
    pattern.startsWith('*.')
      ? host === pattern.slice(2) || host.endsWith(pattern.slice(1))
      : host === pattern,
  );
}

/** Reject a server that the team's security policy disallows. Returns a reason, or null when OK. */
function policyViolation(def: McpServerDef, sharing: ReturnType<typeof getMcpSharing>): string | null {
  if (def.transport === 'stdio') {
    const { allowedCommands } = sharing;
    if (allowedCommands.length > 0 && def.command && !allowedCommands.includes(def.command)) {
      return `command "${def.command}" is not in sharing.mcp.allowedCommands`;
    }
  } else if (def.url && !hostAllowed(def.url, sharing.allowedHosts)) {
    return `host is not in sharing.mcp.allowedHosts`;
  }
  return null;
}

/** True when every executable in `requires` is on PATH. Returns a reason, or null when OK. */
function requirementsMet(def: McpServerDef, lookPath?: LookPathOptions): string | null {
  if (!def.requires?.length) return null;
  for (const bin of def.requires) {
    // `requires` comes from the team repo's mcp.yaml. Reject anything that is
    // not a bare executable name so a value like `npx; rm -rf ~` is never
    // interpolated into a PATH entry or handed to a shell.
    if (!SAFE_BIN_RE.test(bin)) {
      return `required executable "${bin}" has an invalid name`;
    }
    if (!isOnPath(bin, lookPath)) {
      return `required executable "${bin}" not found on PATH`;
    }
  }
  return null;
}

// ─── Tool targeting ──────────────────────────────────────────

export interface McpTarget {
  tool: string;
  format: McpFormat;
  /** Absolute path of the config file to edit. */
  file: string;
  projectScope: boolean;
}

/**
 * Resolve which tools to write, and where.
 *
 * Installation is detected from the tool's skills/settings path, NOT its MCP
 * path: Claude's project-scope MCP file is <root>/.mcp.json, whose first path
 * segment is the file itself, so the usual directory probe would report "not
 * installed" for a perfectly good Claude install.
 */
export async function resolveMcpTargets(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  /**
   * Also the tools not detected here, and in project scope the built-in
   * location of a tool the team dropped or moved: a file an earlier pull
   * wrote outlives its tool and its mapping.
   */
  options: { includeUndetected?: boolean } = {},
): Promise<McpTarget[]> {
  const projectScope = localConfig.scope === 'project';
  const targets: McpTarget[] = [];

  // Skills/settings/agents probe paths must reflect the active scope: OpenCode's
  // user-scope resources live under ~/.config/opencode, not ~/.opencode.
  const toolPaths = scopedToolPaths(teamConfig, localConfig);
  const entries = Object.entries(toolPaths);
  if (options.includeUndetected && projectScope) {
    for (const [tool, paths] of Object.entries(TeamaiConfigSchema.shape.toolPaths.parse(undefined))) {
      if (paths.mcpProject && toolPaths[tool]?.mcpProject !== paths.mcpProject) entries.push([tool, paths]);
    }
  }
  for (const [tool, paths] of entries) {
    const format = detectMcpFormat(tool);
    if (!format) continue;

    // No fallback between scopes: a tool's project-scope location is a
    // different thing from its user-scope one, not a default for it. Absent
    // `mcpProject` means the tool has no project-scope MCP support (codex), or
    // is already covered by a sibling target writing the shared file (tclaude
    // reads the <root>/.mcp.json that `claude` writes).
    const rel = projectScope ? paths.mcpProject : paths.mcp;
    if (!rel) continue;

    const baseDir = resolveToolBaseDir(tool, localConfig);
    const file = path.join(baseDir, rel);

    const probe = paths.skills ?? paths.settings ?? paths.agents;
    if (!probe) continue;
    if (!options.includeUndetected && !await isToolInstalledForConfig(tool, probe, localConfig, file)) {
      log.debug(`Skipping MCP sync for ${tool}: tool not installed`);
      continue;
    }

    targets.push({ tool, format, file, projectScope });
  }
  return targets;
}

// ─── JSON target I/O ─────────────────────────────────────────

export interface JsonDoc {
  data: Record<string, unknown>;
  servers: Record<string, unknown>;
  /** The existing document stores server names directly at the top level. */
  bare: boolean;
}

/**
 * Read a JSON MCP config. Returns null when the file exists but cannot be
 * parsed — we abandon the injection rather than risk clobbering a file we do
 * not understand (it may hold the user's OAuth session). Copilot project files
 * additionally allow a bare top-level server map, whose shape we preserve.
 */
export async function readJsonDoc(
  file: string,
  serverKey: string,
  allowBare = false,
): Promise<JsonDoc | null> {
  if (!await pathExists(file)) return { data: {}, servers: {}, bare: false };
  const raw = await readFileSafe(file);
  if (raw === null) return null;
  if (raw.trim() === '') return { data: {}, servers: {}, bare: allowBare };
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    const bare = allowBare && !(serverKey in data);
    const servers = bare ? data : (data[serverKey] as Record<string, unknown>) ?? {};
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return null;
    return { data, servers: { ...servers }, bare };
  } catch {
    return null;
  }
}

/** Write a parsed JSON MCP config while preserving its original container shape. */
export async function writeJsonDoc(
  file: string,
  serverKey: string,
  doc: JsonDoc,
): Promise<void> {
  if (doc.bare) {
    await writeJsonAtomic(file, doc.servers);
    return;
  }
  doc.data[serverKey] = doc.servers;
  await writeJsonAtomic(file, doc.data);
}

// ─── Codex TOML target I/O ───────────────────────────────────

/**
 * Replace or delete a `[mcp_servers.<name>]` block by text surgery, leaving the
 * rest of config.toml byte-identical (comments included).
 */
export function spliceCodexBlock(source: string, name: string, block: string | null): string {
  const re = codexBlockRe(name);
  const match = source.match(re);

  if (match) {
    if (block === null) {
      const cleaned = source.replace(re, '');
      return cleaned.replace(/\n{3,}/g, '\n\n');
    }
    return source.replace(re, block.endsWith('\n') ? block + '\n' : block + '\n\n');
  }

  if (block === null) return source;
  const sep = source.length === 0 || source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  return source + sep + block;
}

/**
 * Matches one `[mcp_servers.<name>]` block, from its header to the next table
 * header that is not one of its own sub-tables (e.g. [mcp_servers.<name>.env]),
 * or to end-of-input. End-of-input must be spelled `(?![\s\S])`: JS has no `\z`,
 * and under the `m` flag `$` only means end-of-line, which would truncate the
 * match early.
 */
function codexBlockRe(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    String.raw`^\[mcp_servers\.${escaped}\]\s*$[\s\S]*?(?=^\[(?!mcp_servers\.${escaped}[.\]])|(?![\s\S]))`,
    'm',
  );
}

/**
 * The text of one `[mcp_servers.<name>]` block, trimmed to the single trailing
 * newline `renderCodexBlock` emits so the two forms compare directly — the
 * splice pads a written block with a blank line to separate it from the next
 * table.
 */
export function codexBlockIn(source: string, name: string): string | null {
  const match = source.match(codexBlockRe(name));
  return match === null ? null : match[0].trimEnd() + '\n';
}

/** Extract the names of all `[mcp_servers.X]` tables present in a config.toml. */
export function codexServerNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/gm)) names.add(m[1]);
  return [...names];
}

// ─── Desired set ─────────────────────────────────────────────

/** One team server in the rendered form that lands in a tool's own config. */
export interface DesiredMcpEntry {
  entry: unknown;
  hash: string;
  /** Codex alone stores a TOML block rather than a JSON value. */
  block?: string;
}

/** Everything the per-server filters need, resolved once per run. */
export interface DesiredMcpContext {
  sharing: ReturnType<typeof getMcpSharing>;
  excluded: Set<string>;
  vars: Record<string, string>;
  lookPath?: McpReconcileOptions['lookPath'];
}

export async function buildDesiredMcpContext(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  options: McpReconcileOptions = {},
): Promise<DesiredMcpContext> {
  return {
    sharing: getMcpSharing(teamConfig),
    excluded: new Set(localConfig.excludedSkills ?? []),
    vars: await buildVarTable(localConfig),
    lookPath: options.lookPath,
  };
}

/**
 * Which of `teamDefs` apply to `target`, rendered the way they land in the
 * tool's config, and a skip entry naming why each of the rest does not.
 *
 * Exported so `doctor` can check what should have arrived without restating
 * the filters (#624). A second copy of them is how an MCP server ends up
 * skipped for `unresolved variable(s)` during one pull and reported as
 * correctly delivered forever after.
 */
export function desiredMcpForTarget(
  target: McpTarget,
  teamDefs: McpServerDef[],
  ctx: DesiredMcpContext,
): { desired: Map<string, DesiredMcpEntry>; skipped: McpChange[] } {
  const desired = new Map<string, DesiredMcpEntry>();
  const skipped: McpChange[] = [];

  for (const raw of teamDefs) {
    if (raw.tools && !raw.tools.includes(target.tool)) continue;
    if (ctx.excluded.has(raw.name)) {
      skipped.push({ tool: target.tool, server: raw.name, action: 'skipped', reason: 'excluded by user' });
      continue;
    }
    if (!supportsTransport(target.format, raw.transport)) {
      skipped.push({
        tool: target.tool,
        server: raw.name,
        action: 'skipped',
        reason: `${target.tool} does not support ${raw.transport} transport`,
      });
      continue;
    }
    const violation = policyViolation(raw, ctx.sharing);
    if (violation) {
      skipped.push({ tool: target.tool, server: raw.name, action: 'skipped', reason: violation });
      continue;
    }
    const missingBin = requirementsMet(raw, ctx.lookPath);
    if (missingBin) {
      skipped.push({ tool: target.tool, server: raw.name, action: 'skipped', reason: missingBin });
      continue;
    }

    // Pass ${VAR} through where the tool expands it itself, so the secret
    // never lands on disk; otherwise resolve and require every var to exist.
    // A resolved value is written verbatim into the target file, including
    // project-scope files that get committed — the team has opted into that
    // by declaring the server with a ${VAR} a tool cannot expand itself.
    const passthrough = supportsEnvExpansion(target.format, target.projectScope, raw);
    let def = raw;
    if (!passthrough) {
      const { def: resolved, missing } = resolvePlaceholders(raw, ctx.vars);
      if (missing.length > 0) {
        skipped.push({
          tool: target.tool,
          server: raw.name,
          action: 'skipped',
          reason: `unresolved variable(s): ${missing.join(', ')}`,
        });
        continue;
      }
      def = resolved;
    } else if (referencedVars(raw).length > 0) {
      log.debug(`${raw.name}: passing ${referencedVars(raw).join(', ')} through to ${target.tool}`);
    }

    if (target.format === 'codex') {
      const block = renderCodexBlock(def);
      desired.set(raw.name, { entry: block, hash: entryHash(block), block });
    } else {
      const entry = renderJsonEntry(target.format, def);
      desired.set(raw.name, { entry, hash: entryHash(entry) });
    }
  }

  return { desired, skipped };
}

/**
 * The MCP server entries already present in `target`'s own config file, in the
 * same rendered form `desiredMcpForTarget` produces, or null when the file
 * exists and cannot be parsed — the same condition that makes the write path
 * abandon the injection rather than clobber a file it does not understand.
 *
 * Entries rather than names, because a name being present does not mean the
 * team's server arrived: the appliers refuse to overwrite an entry teamai does
 * not own, so an unrelated server of the same name leaves the key there and the
 * team's definition undelivered. Only the value tells those two apart.
 *
 * Read-only. An MCP server is an entry inside a tool's config rather than a
 * file of its own, so this, not a destination path, is what "delivered" means.
 */
export async function installedMcpEntries(target: McpTarget): Promise<Map<string, unknown> | null> {
  if (target.format === 'codex') {
    const raw = await readFileSafe(target.file);
    if (raw === null) return new Map();
    return new Map(codexServerNames(raw).map((name) => [name, codexBlockIn(raw, name)]));
  }
  const serverKey = MCP_SERVER_KEY[target.format as Exclude<McpFormat, 'codex'>];
  const allowBare = target.format === 'copilot' && target.projectScope;
  const doc = await readJsonDoc(target.file, serverKey, allowBare);
  return doc === null ? null : new Map(Object.entries(doc.servers));
}

/**
 * Why `target`'s file may hold a value teamai resolved (#882), or null when it
 * is missing or proven not to. Judged by what is on disk and in the manifest
 * (`owned`: the records it holds for the file's tool), never by delivery: an
 * owned entry whose definition cannot be read, or has left the team's servers,
 * is unproven, and so is one still as a pull wrote it with a resolved value,
 * whatever its definition says now. A file that does not parse is judged by
 * `owned` alone. `ctx` is asked for only by a record an older teamai wrote.
 */
export async function resolvedValueEvidence(
  target: McpTarget,
  teamDefs: McpServerDef[] | null,
  owned: ManagedMcpRecord[],
  vars: Record<string, string>,
  ctx: () => Promise<DesiredMcpContext>,
): Promise<string | null> {
  const raw = await readFileSafe(target.file);
  if (raw === null) return null;
  const installed = await installedMcpEntries(target);
  const records = installed ? owned.filter((record) => installed.has(record.name)) : owned;
  const present = records.map((record) => record.name);
  if (!teamDefs) return present.length > 0 ? `teamai's ${present.join(', ')}, and the team's MCP servers cannot be read` : null;
  const dropped = present.find((name) => !teamDefs.some((def) => def.name === name));
  if (dropped) return `teamai's ${dropped}, which has left the team's MCP servers`;
  const needing = present.find((name) => carriesResolvedValue(target, teamDefs, [name]));
  if (needing) return `teamai's ${needing}, which needs a resolved \${VAR}`;
  // An entry as a pull wrote it holds what that pull resolved, whatever its definition says now.
  let desired: Map<string, DesiredMcpEntry> | undefined;
  for (const record of installed ? records : []) {
    if (entryHash(installed?.get(record.name)) !== record.hash) continue;
    if (record.resolved === true) return `teamai's ${record.name}, as a pull wrote it with a resolved \${VAR}`;
    if (record.resolved !== undefined) continue;
    // An older teamai did not note it: stale, unless today's definition writes the same entry.
    desired ??= desiredMcpForTarget(target, teamDefs, await ctx()).desired;
    if (desired.get(record.name)?.hash !== record.hash) {
      return `teamai's ${record.name}, which an earlier pull wrote and its current definition no longer produces`;
    }
  }
  const variable = resolvedVariableIn(target, teamDefs, vars, raw);
  return variable ? `the value of $${variable}` : null;
}

/** `load`, run once, on the first call. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => value ??= load();
}

/**
 * `localConfig` and, in project scope, one config per other linked worktree:
 * each worktree has its own MCP configs and managed-mcp manifest.
 */
export async function projectWorktreeConfigs(localConfig: LocalConfig): Promise<LocalConfig[]> {
  const configs: LocalConfig[] = [localConfig];
  if (localConfig.scope === 'project' && localConfig.projectRoot) {
    const { resolveProjectDataHome } = await import('./config.js');
    for (const wt of await listWorktrees(localConfig.projectRoot)) {
      if (wt === localConfig.projectRoot) continue;
      configs.push({ ...localConfig, projectRoot: wt, dataHome: await resolveProjectDataHome(wt) });
    }
  }
  return configs;
}

/** A project worktree's managed-mcp.json: `{}` when it is gone, empty or does not parse. */
async function readProjectMcpManifest(cfg: LocalConfig, projectRoot: string): Promise<ManagedMcpManifest> {
  return (await loadProjectMcpManifest(getDataHome(cfg), projectRoot, { dryRun: true })).manifest;
}

/**
 * The files of `groups` (the checkouts of one exclude line) not proven free of
 * a value teamai resolved (#882), each with why. A missing file is clean; so is
 * one a tool reads that parses and holds no server at all, and one in a nested
 * repository's linked worktree, read as the file of its line this project maps
 * is, that parses and holds none. One holding servers is clean only when its worktree's manifest
 * records what teamai wrote to that tool's file (an empty list once teamai took
 * its last server out), and the file holds none of the team's servers that need
 * a resolved `${VAR}` there, none of teamai's own entries the manifest records
 * and cleanup left (their definition may have left mcp.yaml), and none of the
 * values of the variables set in this environment. Anything else (no tool reads
 * it, it does not parse, the team's servers cannot be read, the manifest is
 * lost, empty, does not parse or has no record for the tool) is not: a server
 * teamai wrote, since dropped from mcp.yaml, with a value no longer set, looks
 * like the member's own.
 * `before` is `localConfig`'s manifest as it stood before a reconcile rewrote it.
 * With `otherWorktrees: 'empty'` another worktree's file is clean only when it
 * holds no server at all: today's definitions and values cannot judge an entry
 * that worktree's last pull wrote (a `${VAR}` since made a literal), only a
 * pull there can.
 */
export async function mcpConfigsNotProvenClean(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  groups: Array<{ pattern: string; files: string[] }>,
  options: { before?: ManagedMcpManifest; otherWorktrees?: 'judged' | 'empty' } = {},
): Promise<Map<string, string>> {
  const { before, otherWorktrees = 'judged' } = options;
  const resolution = await resolveEntriesFor(mcpEntryReader, localConfig);
  const teamDefs = resolution.kind === 'failed' ? null : resolution.entries.map((entry) => teamMcpToDef(entry.entry));
  // Keyed by real path: the protected paths come from git, which resolves symlinks (macOS /var).
  const targets = new Map<string, { target: McpTarget; owned: ManagedMcpRecord[]; recorded: boolean; foreign: boolean }>();
  const realRoot = (root: string | undefined): Promise<string | undefined> =>
    root ? fse.realpath(root).catch(() => root) : Promise.resolve(undefined);
  const ownRoot = await realRoot(localConfig.projectRoot);
  for (const cfg of await projectWorktreeConfigs(localConfig)) {
    const manifest = cfg === localConfig && before ? before
      : cfg.projectRoot ? await readProjectMcpManifest(cfg, cfg.projectRoot)
      : {};
    // This checkout listed again under its real path is not another worktree.
    const foreign = cfg !== localConfig && await realRoot(cfg.projectRoot) !== ownRoot;
    for (const target of await resolveMcpTargets(teamConfig, cfg, { includeUndetected: true })) {
      const dir = await fse.realpath(path.dirname(target.file)).catch(() => path.dirname(target.file));
      const key = path.join(dir, path.basename(target.file));
      const records = manifest[managedMcpManifestKey(target.tool, true)];
      const recorded = Array.isArray(records);
      const owned = recorded ? records : [];
      // One file reached twice (two tools share it, or a checkout through a symlink) merges what each says.
      const seen = targets.get(key);
      targets.set(key, {
        target,
        owned: [...seen?.owned ?? [], ...owned],
        recorded: recorded || seen?.recorded === true,
        foreign: foreign || seen?.foreign === true,
      });
    }
  }
  // Short values, paths and the login name turn up in ordinary configs, so they prove nothing.
  const identity = new Set(['USER', 'LOGNAME', 'USERNAME']);
  const vars = await buildVarTable(localConfig);
  const ctx = once(() => buildDesiredMcpContext(teamConfig, localConfig));
  const values = Object.entries(vars)
    .filter(([name, value]) => value.length >= 8 && !identity.has(name) && !/^([/~]|[A-Za-z]:[\\/])/.test(value));
  const held = new Map<string, string>();
  for (const { pattern, files } of groups) {
    // A file no worktree of this project maps, in a checkout of the same repository as
    // one it does: a nested repository's linked worktree, read as that one is.
    const siblingFile = files.find((file) => targets.has(file));
    const sibling = siblingFile === undefined ? undefined : targets.get(siblingFile);
    const nested = siblingFile && path.join(siblingFile, ...mcpExcludePatternPath(pattern).split('/').map(() => '..'));
    for (const file of files) {
      if (!await pathExists(file)) continue;
      const known = targets.get(file)
        ?? (sibling && nested ? { target: { ...sibling.target, file }, owned: [], recorded: false, foreign: true, nested } : undefined);
      const installed = known ? await installedMcpEntries(known.target) : null;
      const raw = (await readFileSafe(file)) ?? '';
      const named = known && installed && teamDefs
        ? [...installed.keys()].find((name) => carriesResolvedValue(known.target, teamDefs, [name]))
        : undefined;
      const why = !known ? 'no tool teamai knows reads it'
        : !installed ? 'it does not parse'
        : installed.size === 0 ? undefined
        : 'nested' in known ? `it holds MCP servers in a linked worktree of the repository at ${known.nested}, which teamai cannot judge`
        : known.foreign && otherWorktrees === 'empty' ? 'it holds MCP servers in another worktree, which only a pull there can judge'
        : !teamDefs ? 'the team\'s MCP servers cannot be read'
        : named ? `it holds the team's ${named}, which needs a resolved \${VAR}`
        : await resolvedValueEvidence(known.target, teamDefs, known.owned, vars, ctx).then((e) => e && `it holds ${e}`)
          ?? values.filter(([, value]) => raw.includes(value)).map(([name]) => `it holds the value of $${name}`)[0]
          ?? (known.recorded ? undefined : 'it holds MCP servers, and managed-mcp.json, teamai\'s record of which it wrote there, is gone, does not parse or has no entry for it');
      if (why) held.set(file, why);
    }
  }
  return held;
}

// ─── Main entry ──────────────────────────────────────────────

export function mcpTargetExcluded(localConfig: LocalConfig, target: McpTarget): boolean {
  if (!isAgentExcluded(localConfig, target.tool)) return false;
  // tclaude has no project-scope MCP file: it reads the <root>/.mcp.json the
  // claude target writes, so that target stays live while tclaude is enabled.
  return !(target.projectScope && target.tool === 'claude' && !isAgentExcluded(localConfig, 'tclaude'));
}

/**
 * Reconcile one scope's tool configs to the team's desired MCP server set.
 * Idempotent: unchanged servers produce no write at all.
 */
export async function reconcileMcpForConfig(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  options: McpReconcileOptions = {},
): Promise<McpReconcileResult> {
  // Each project config's exclusion from git, established before a resolved value is written into it.
  const exclusions = new Map<string, GitExclusion>();
  // The project configs this run wrote: a line it added for one stays, whatever fails after.
  const written = new Set<string>();
  const protect = !options.removeAll && !options.dryRun;
  // Read before the reconcile records what it writes: a manifest it recreates says nothing of what came before.
  const before = protect && localConfig.projectRoot ? await readProjectMcpManifest(localConfig, localConfig.projectRoot) : undefined;
  try {
    return await reconcileTargets(teamConfig, localConfig, options, exclusions, written);
  } finally {
    // Also after a failed write: what earlier pulls wrote is on disk either way.
    if (protect) await protectResolvedMcpConfigs(teamConfig, localConfig, exclusions, written, before);
  }
}

/**
 * List each project MCP config holding a value teamai resolved in
 * `.git/info/exclude` (#882), and take out the line of one proven clean. It
 * covers what is on disk, whether or not this run delivered to it: the file of
 * a disabled or undetected tool, or one written before the team turned
 * delivery off, still holds what a pull wrote.
 */
async function protectResolvedMcpConfigs(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  exclusions: Map<string, GitExclusion>,
  written: Set<string>,
  before: ManagedMcpManifest | undefined,
): Promise<void> {
  const { projectRoot } = localConfig;
  if (localConfig.scope !== 'project' || !projectRoot || localConfig.repo.kind === 'http') return;
  try {
    await protectProjectMcpConfigs(teamConfig, localConfig, projectRoot, exclusions, written, before);
  } catch (e) {
    log.warn(
      `Could not check this project's MCP configs for resolved values to keep out of git: ${e instanceof Error ? e.message : String(e)}. `
      + 'Run `teamai doctor` to see whether git would commit one.',
    );
  }
}

async function protectProjectMcpConfigs(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  projectRoot: string,
  exclusions: Map<string, GitExclusion>,
  written: Set<string>,
  before: ManagedMcpManifest | undefined,
): Promise<void> {
  const resolution = await resolveEntriesFor(mcpEntryReader, localConfig);
  const teamDefs = resolution.kind === 'failed' ? null : resolution.entries.map((entry) => teamMcpToDef(entry.entry));
  const { manifest } = await loadProjectMcpManifest(getDataHome(localConfig), projectRoot, { dryRun: true });
  const vars = await buildVarTable(localConfig);
  const ctx = once(() => buildDesiredMcpContext(teamConfig, localConfig));
  const holding = new Set<string>();
  const unproven = new Set<string>();
  for (const target of await resolveMcpTargets(teamConfig, localConfig, { includeUndetected: true })) {
    // Tried before its write this run, and reported there.
    if (exclusions.get(target.file)?.kind === 'failed') continue;
    const owned = manifest[managedMcpManifestKey(target.tool, true)] ?? [];
    if (await resolvedValueEvidence(target, teamDefs, owned, vars, ctx)) holding.add(target.file);
    else unproven.add(target.file);
  }
  // Also a file listed before its write: a concurrent uninstall may have taken its line out since.
  for (const file of holding) await excludeFromGit(file);
  // A line this run added for a file it then did not write restores the file's state before the run.
  // One it wrote holds the value even when no scan finds it (shorter than eight characters).
  const addedNow = [...unproven].filter((file) => {
    const exclusion = exclusions.get(file);
    return !holding.has(file) && !written.has(file) && exclusion?.kind === 'excluded' && exclusion.added;
  });
  await releaseMcpGitExcludes(teamConfig, localConfig, projectRoot, addedNow, before);
}

/**
 * Take out of teamai's block in `.git/info/exclude` the line of each project
 * MCP config proven free of a value teamai resolved (#882), in every worktree
 * sharing it: `teamai mcp remove` leaves nothing of teamai's to protect. A
 * config not proven clean keeps its line.
 */
export async function releaseCleanMcpGitExcludes(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
  const { projectRoot } = localConfig;
  if (localConfig.scope !== 'project' || !projectRoot || localConfig.repo.kind === 'http') return;
  try {
    await releaseMcpGitExcludes(teamConfig, localConfig, projectRoot, []);
  } catch (e) {
    log.warn(
      `Could not check whether this project's MCP configs still need their .git/info/exclude lines: ${e instanceof Error ? e.message : String(e)}. `
      + 'The lines stay; `teamai uninstall` removes them.',
    );
  }
}

/**
 * Remove each line of teamai's block whose files are all proven clean or in
 * `addedNow`: files this run listed and holds no evidence for, whose line it
 * takes back out even when they cannot be proven clean (one that does not parse).
 */
async function releaseMcpGitExcludes(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  projectRoot: string,
  addedNow: string[],
  before?: ManagedMcpManifest,
): Promise<void> {
  const dirs = [projectRoot];
  for (const target of await resolveMcpTargets(teamConfig, localConfig, { includeUndetected: true })) dirs.push(path.dirname(target.file));
  const excludes = await findMcpGitExcludes(dirs);
  if (excludes.size === 0) return;
  // Keyed as findMcpGitExcludes keys them: by real path (macOS /var).
  const exempt = new Set(await Promise.all(addedNow.map(realFilePath)));
  const held = await mcpConfigsNotProvenClean(
    teamConfig,
    localConfig,
    [...excludes.values()].flat(),
    { before, otherWorktrees: 'empty' },
  );
  for (const [excludeFile, entries] of excludes) {
    const cleanEntries = entries.filter((entry) => entry.files.every((file) => !held.has(file) || exempt.has(file)));
    const clean = cleanEntries.map((entry) => entry.pattern);
    if (clean.length === 0) continue;
    const result = await removeMcpGitExclude(excludeFile, clean);
    if (result === 'written') {
      // A line this run added and took back out is no change the member saw.
      const rolledBack = cleanEntries.filter((entry) => entry.files.some((file) => exempt.has(file))).map((entry) => entry.pattern);
      const released = clean.filter((pattern) => !rolledBack.includes(pattern));
      if (released.length > 0) log.info(`Removed ${released.join(', ')} from ${excludeFile}: no MCP config there holds a value teamai resolved.`);
      if (rolledBack.length > 0) log.debug(`Took ${rolledBack.join(', ')} back out of ${excludeFile}: this run wrote no resolved value there.`);
    }
    // Left as it is: the next pull tries again.
    if (result === 'locked') log.debug(`Kept ${clean.join(', ')} in ${excludeFile}: another teamai command held it past the wait.`);
  }
}

/** `file` with the real path of its closest existing directory. */
async function realFilePath(file: string): Promise<string> {
  const dir = await existingAncestor(file);
  const real = await fse.realpath(dir).catch(() => dir);
  return path.join(real, path.relative(dir, file));
}

async function reconcileTargets(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  options: McpReconcileOptions,
  exclusions: Map<string, GitExclusion>,
  written: Set<string>,
): Promise<McpReconcileResult> {
  const changes: McpChange[] = [];
  let wrote = false;

  const sharing = getMcpSharing(teamConfig);
  const removeAll = options.removeAll === true;

  // HTTP-mode teams have no repo tree: team MCP servers are delivered through
  // the local-agent install_mcp channel and recorded in the same
  // managed-mcp.json this function prunes against. Running the desired-set
  // reconcile here would see an always-empty desired set and delete every
  // HTTP-installed server on each session-start sync. Skip it — the explicit
  // removeAll teardown (teamai uninstall) must still run.
  if (localConfig.repo.kind === 'http' && !removeAll) {
    return { changes, wrote };
  }

  let teamDefs: McpServerDef[] = [];
  if (!removeAll) {
    // A file that does not parse, or a server name defined twice, keeps every
    // installed server as it is: reconciling to an empty set would remove them.
    const resolution = await resolveEntriesFor(mcpEntryReader, localConfig);
    reportEntryResolution(resolution);
    if (resolution.kind === 'failed') return { changes, wrote, unresolved: true };
    teamDefs = resolution.entries.map((entry) => teamMcpToDef(entry.entry));
  }
  if (!removeAll && teamDefs.length > 0 && !sharing.autoApply) {
    log.info(`${teamDefs.length} team MCP server(s) available. Run \`teamai mcp inject\` to apply.`);
    return { changes, wrote };
  }
  const targets = await resolveMcpTargets(teamConfig, localConfig);
  if (targets.length === 0) return { changes, wrote };

  const dataHome = getDataHome(localConfig);
  const projectScope = localConfig.scope === 'project';
  // Project scope uses a PER-WORKTREE manifest under the partition (migrating this
  // worktree's records out of any legacy shared file on first read); user scope
  // keeps the single global file. Either way this reconcile owns exactly one file.
  let manifestPath: string;
  let manifest: ManagedMcpManifest;
  if (projectScope && localConfig.projectRoot) {
    ({ manifestPath, manifest } = await loadProjectMcpManifest(dataHome, localConfig.projectRoot, { dryRun: options.dryRun }));
  } else {
    manifestPath = managedMcpManifestPath(dataHome);
    manifest = await readManifest(manifestPath);
  }

  // An empty desired set still has to run: it is how servers dropped from
  // mcp.yaml get cleaned out of the tools we previously injected them into.
  const nothingOwned = Object.values(manifest).every((r) => r.length === 0);
  if (teamDefs.length === 0 && nothingOwned) return { changes, wrote };

  const desiredContext = await buildDesiredMcpContext(teamConfig, localConfig, options);

  for (const target of targets) {
    // Same enabledAgents / disabledAgents gate as the other resource syncs. The
    // manifest entry is left as is: an excluded tool is skipped, not cleaned,
    // and `removeAll` (uninstall) still reaches every tool.
    if (!removeAll && mcpTargetExcluded(localConfig, target)) continue;
    const manifestKey = managedMcpManifestKey(target.tool, target.projectScope);
    const owned = manifest[manifestKey] ?? [];
    const ownedNames = new Set(owned.map((r) => r.name));
    const nextRecords: ManagedMcpRecord[] = [];

    // Which of this team's servers apply to this tool, and in what rendered form.
    const { desired, skipped } = desiredMcpForTarget(target, teamDefs, desiredContext);
    changes.push(...skipped);

    // A resolved value lands only in a file git leaves out of a commit (#882).
    // Otherwise the file stays as it was, its manifest entry with it.
    if (carriesResolvedValue(target, teamDefs, desired.keys())) {
      const exclusion = exclusions.get(target.file) ?? await ensureExcludedFromGit(target.file, { dryRun: options.dryRun });
      exclusions.set(target.file, exclusion);
      if (exclusion.kind === 'failed') {
        const reason = `${target.file} is not kept out of git: ${exclusion.reason}`;
        for (const server of desired.keys()) changes.push({ tool: target.tool, server, action: 'skipped', reason });
        log.warn(
          `Did not write ${target.tool}'s MCP servers to ${target.file}: it would hold resolved values, and teamai could not `
          + `keep it out of git first: ${exclusion.reason}. The file is left as it was. ${exclusion.fix}`,
        );
        continue;
      }
    }

    const wroteTarget = target.format === 'codex'
      ? await applyCodex(target, desired, ownedNames, nextRecords, changes, options)
      : await applyJson(target, desired, owned, ownedNames, nextRecords, changes, options);
    if (wroteTarget) written.add(target.file);
    wrote = wroteTarget || wrote;

    // Whether each entry holds a resolved value: once its definition stops
    // needing one, what this pull wrote still does (#882).
    if (target.projectScope) for (const record of nextRecords) record.resolved ??= carriesResolvedValue(target, teamDefs, [record.name]);
    // An emptied project record stays: it says teamai owns nothing left in that
    // file, which a lost record cannot, and so lets its exclude line go (#882).
    if (nextRecords.length > 0 || (target.projectScope && manifest[manifestKey] !== undefined)) manifest[manifestKey] = nextRecords;
    else delete manifest[manifestKey];
  }

  if (!options.dryRun && wrote) {
    await writeJsonAtomic(manifestPath, manifest);
  }
  return { changes, wrote };
}

// ─── Appliers ────────────────────────────────────────────────

async function applyJson(
  target: McpTarget,
  desired: Map<string, { entry: unknown; hash: string }>,
  owned: ManagedMcpRecord[],
  ownedNames: Set<string>,
  nextRecords: ManagedMcpRecord[],
  changes: McpChange[],
  options: McpReconcileOptions,
): Promise<boolean> {
  const serverKey = MCP_SERVER_KEY[target.format as Exclude<McpFormat, 'codex'>];
  const allowBare = target.format === 'copilot' && target.projectScope;
  const doc = await readJsonDoc(target.file, serverKey, allowBare);
  if (!doc) {
    log.warn(`Could not parse ${target.file} — skipping MCP injection for ${target.tool}`);
    return false;
  }

  const ownedHash = new Map(owned.map((r) => [r.name, r.hash]));
  let dirty = false;

  for (const [name, { entry, hash }] of desired) {
    const existing = doc.servers[name];
    if (existing !== undefined && !ownedNames.has(name) && !options.force) {
      changes.push({
        tool: target.tool,
        server: name,
        action: 'skipped',
        reason: 'a server with this name already exists and is not managed by teamai',
      });
      continue;
    }
    nextRecords.push({ name, hash });
    if (existing !== undefined && ownedHash.get(name) === hash) continue;
    doc.servers[name] = entry;
    dirty = true;
    changes.push({ tool: target.tool, server: name, action: existing === undefined ? 'added' : 'updated' });
  }

  for (const name of ownedNames) {
    if (desired.has(name)) continue;
    if (doc.servers[name] !== undefined) {
      delete doc.servers[name];
      dirty = true;
    }
    changes.push({ tool: target.tool, server: name, action: 'removed' });
  }

  if (!dirty || options.dryRun) return false;

  // Key-level surgery: every unrelated top-level key is carried over untouched.
  // Some tools (OpenCode) key the server map under `mcp`, not `mcpServers`;
  // writing the wrong key would strip the servers and, worse, leave a phantom
  // empty `mcpServers` in a file the tool never reads under that name.
  await writeJsonDoc(target.file, serverKey, doc);
  return true;
}

async function applyCodex(
  target: McpTarget,
  desired: Map<string, { entry: unknown; hash: string; block?: string }>,
  ownedNames: Set<string>,
  nextRecords: ManagedMcpRecord[],
  changes: McpChange[],
  options: McpReconcileOptions,
): Promise<boolean> {
  let source = (await readFileSafe(target.file)) ?? '';
  const present = new Set(codexServerNames(source));
  let dirty = false;

  for (const [name, { hash, block }] of desired) {
    if (present.has(name) && !ownedNames.has(name) && !options.force) {
      changes.push({
        tool: target.tool,
        server: name,
        action: 'skipped',
        reason: 'a server with this name already exists and is not managed by teamai',
      });
      continue;
    }
    nextRecords.push({ name, hash });
    const next = spliceCodexBlock(source, name, block!);
    if (next === source) continue;
    source = next;
    dirty = true;
    changes.push({ tool: target.tool, server: name, action: present.has(name) ? 'updated' : 'added' });
  }

  for (const name of ownedNames) {
    if (desired.has(name)) continue;
    const next = spliceCodexBlock(source, name, null);
    if (next !== source) {
      source = next;
      dirty = true;
    }
    changes.push({ tool: target.tool, server: name, action: 'removed' });
  }

  if (!dirty || options.dryRun) return false;

  await fse.ensureDir(path.dirname(target.file));
  const tmp = `${target.file}.${process.pid}.tmp`;
  await fse.writeFile(tmp, source, 'utf-8');
  await fse.chmod(tmp, 0o600);
  await fse.rename(tmp, target.file);
  return true;
}

export async function writeCodexAtomic(file: string, content: string): Promise<void> {
  await fse.ensureDir(path.dirname(file));
  const suffix = crypto.randomBytes(6).toString('hex');
  const tmp = `${file}.${process.pid}.${suffix}.tmp`;
  await fse.writeFile(tmp, content, 'utf-8');
  await fse.chmod(tmp, 0o600);
  await fse.rename(tmp, file);
}
