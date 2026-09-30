/**
 * The tool-call classifier (#884): the one place that maps an agent's
 * PostToolUse to what the call did, the files it read, and whether it
 * succeeded. Recall adoption builds on it.
 *
 *   tool_name ── normalizeToolName ── CATEGORY_OF ─┬─ read    the path field
 *                                                  ├─ search  its output_mode, shownFiles(content)
 *                                                  ├─ list    nothing: it shows paths, not a file's lines
 *                                                  └─ shell   classifyShellCommand(command), shownFiles(output) for a search
 *   tool_response ── statusOf, outputOf, searchOutputOf
 *
 * Extension points: PowerShell readers and Windows paths (ticket 07), other
 * agents' tool names and output fields (08). A name not listed here is
 * `unknown` and never counts.
 */
import path from 'node:path';

import { resolveHookCwd } from './hook-cwd.js';
import { classifyShellCommand } from './shell-command.js';
import { normalizeToolName } from './tool-names.js';

/** What a call did: `read`/`search`/`list` whether a tool or a shell command did it; `shell` for any other shell call. */
export type ToolCategory = 'read' | 'shell' | 'search' | 'list' | 'unknown';

export type ToolStatus = 'success' | 'failure' | 'unknown';

export interface ToolCall {
  category: ToolCategory;
  /**
   * The files it read, or a search's output showed lines of: absolute when
   * the call had a cwd to resolve them against, as written otherwise.
   */
  paths: string[];
  status: ToolStatus;
  /** True when the read or search was the call's only command: a tool, or a shell command outside a pipeline. */
  simple: boolean;
  /** A shell call's command line. */
  command?: string;
  /** The text output the agent sent, when it sent one. */
  output?: string;
}

/**
 * Tool names by what they do, after normalizeToolName (which turns
 * `search_content` into `Grep` and `list_dir` into `Glob`).
 */
const CATEGORY_OF: Record<string, Exclude<ToolCategory, 'unknown'>> = {
  Read: 'read',
  Bash: 'shell',
  Grep: 'search',
  grep_code: 'search',
  grep: 'search',
  rg: 'search',
  Glob: 'list',
  glob: 'list',
  search_file: 'list',
  list_files: 'list',
  LS: 'list',
  ls: 'list',
  find: 'list',
};

/**
 * Search tools whose `output_mode` defaults to listing files (Claude's Grep
 * and the agents that copy it). The lowercase `grep` of OpenCode and Pi has
 * no mode: it always prints lines.
 */
const LISTS_BY_DEFAULT = new Set(['Grep', 'grep_code']);

/**
 * Agents whose search tool output no line rule reads yet: OMP's grep prints
 * a markdown tree, Cursor's Grep format is unverified. Their shell searches
 * still count.
 */
const NO_SEARCH_EVIDENCE = new Set(['omp', 'cursor']);

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The call's status from the agent's response. Claude sends PostToolUse only
 * on success; an `exitCode` (CodeBuddy IDE, Qoder) tells a failure apart.
 * Codex sends its output as a plain string with no exit code: unknown.
 */
function statusOf(response: unknown): ToolStatus {
  const r = asObject(response);
  if (!r) return 'unknown';
  return typeof r.exitCode === 'number' && r.exitCode !== 0 ? 'failure' : 'success';
}

/** Claude's response is `{ stdout, … }`; Codex's is the output string. */
function outputOf(response: unknown): string | undefined {
  const output = typeof response === 'string' ? response : asObject(response)?.stdout;
  return typeof output === 'string' ? output : undefined;
}

/**
 * A search tool's text output: the string itself (OpenCode, Pi), Claude's
 * and ZCode's `content`, or Qoder's `results`. A `filenames` list is a
 * listing and is never read.
 */
function searchOutputOf(response: unknown): string | undefined {
  if (typeof response === 'string') return response;
  const r = asObject(response);
  const output = r?.content ?? r?.results;
  return typeof output === 'string' ? output : undefined;
}

function resolveAgainst(file: string, cwd: string | undefined): string {
  if (path.isAbsolute(file)) return path.resolve(file);
  return cwd ? path.resolve(cwd, file) : file;
}

/** Whether `file` is `root` or under it; always, when `root` has no base to place it. */
function within(file: string, root: string): boolean {
  if (!path.isAbsolute(root)) return true;
  const rel = path.relative(root, file);
  return path.isAbsolute(file) && (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)));
}

/**
 * The files a search's output shows lines of, never its text: each line that
 * starts with a path under one of the search `roots` followed by `:`
 * (`path:12:text`, `path:text`, OpenCode's `path:` header), resolved against
 * `base`. A bare path line is a listing. A search of one file prints no path,
 * so its `target` counts when the output shows anything and names nothing
 * under it. Only the output held in memory is scanned: no file is read.
 */
function shownFiles(output: string, roots: string[], base: string | undefined, target: string | undefined): string[] {
  const files = new Set<string>();
  let under = false;
  for (const line of output.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const prefix = line.slice(0, colon);
    // `12:text` (a line number), OpenCode's `  Line 12: text`.
    if (/^\s|^\d+$/.test(prefix)) continue;
    const file = resolveAgainst(prefix, base);
    if (!roots.some((root) => within(file, root))) continue;
    files.add(file);
    if (target !== undefined && file !== target) under = true;
  }
  if (target !== undefined && !under && output.trim()) files.add(target);
  return [...files];
}

/** Classify one PostToolUse payload from `agent` (the dispatch tool id). */
export function classifyToolCall(stdin: Record<string, unknown>, agent?: string): ToolCall {
  const name = normalizeToolName(typeof stdin.tool_name === 'string' ? stdin.tool_name : '');
  const category = CATEGORY_OF[name];
  const input = asObject(stdin.tool_input);
  const status = statusOf(stdin.tool_response);
  const cwd = resolveHookCwd(stdin);
  const unknown: ToolCall = { category: 'unknown', paths: [], status, simple: false };
  if (!input || !category) return unknown;

  if (category === 'read') {
    const file = input.file_path;
    if (typeof file !== 'string' || !file.trim()) return unknown;
    return { category, paths: [resolveAgainst(file, cwd)], status, simple: true };
  }
  if (category === 'list') return { category, paths: [], status, simple: true };

  if (category === 'search') {
    const response = asObject(stdin.tool_response);
    const given = input.output_mode ?? response?.mode;
    const mode = typeof given === 'string' ? given : LISTS_BY_DEFAULT.has(name) ? 'files_with_matches' : 'content';
    if (mode === 'files_with_matches') return { category: 'list', paths: [], status, simple: true };
    const output = searchOutputOf(stdin.tool_response);
    if (mode !== 'content' || output === undefined || NO_SEARCH_EVIDENCE.has(agent ?? '')) {
      return { category, paths: [], status, simple: true };
    }
    // Relative output paths are relative to the searched path (Pi), else to the cwd.
    const root = typeof input.path === 'string' && input.path.trim() ? resolveAgainst(input.path, cwd) : undefined;
    const base = root ?? cwd;
    const target = root !== undefined && path.isAbsolute(root) ? root : undefined;
    return { category, paths: shownFiles(output, base ? [base] : [], base, target), status, simple: true };
  }

  const command = input.command;
  if (typeof command !== 'string') return unknown;
  const shell = classifyShellCommand(command);
  const output = outputOf(stdin.tool_response);
  const optional = output !== undefined ? { output } : {};
  if (shell.category === 'search') {
    // A shell search prints paths as its operands wrote them: relative to the cwd.
    const roots = shell.paths.map((f) => resolveAgainst(f, cwd));
    // Only a lone search prints its output; after a pipe, what shows may no longer be the file's lines.
    const target = shell.target !== undefined && shell.simple ? resolveAgainst(shell.target, cwd) : undefined;
    const paths = output !== undefined ? shownFiles(output, roots, cwd, target) : [];
    return { category: 'search', paths, status, simple: shell.simple, command, ...optional };
  }
  return {
    category: shell.category,
    paths: shell.paths.map((f) => resolveAgainst(f, cwd)),
    status,
    simple: shell.simple,
    command,
    ...optional,
  };
}
