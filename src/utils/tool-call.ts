/**
 * The tool-call classifier (#884): the one place that maps an agent's
 * PostToolUse to what the call did, the files it read, and whether it
 * succeeded. Recall adoption builds on it.
 *
 *   tool_name ── normalizeToolName ── CATEGORY_OF ─┬─ read   the path field
 *                                                  └─ shell  classifyShellCommand(command)
 *   tool_response ── statusOf, outputOf
 *
 * Extension points: search and list names and verbs (ticket 06), PowerShell
 * readers and Windows paths (07), other agents' tool names and output fields
 * (08). A name not listed here is `unknown` and never counts.
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
  /** The files it read: absolute when the call had a cwd to resolve them against, as written otherwise. */
  paths: string[];
  status: ToolStatus;
  /** True when the read was the call's only command: a read tool, or a shell reader outside a pipeline. */
  simple: boolean;
  /** A shell call's command line. */
  command?: string;
  /** The text output the agent sent, when it sent one. */
  output?: string;
}

/** Tool names by what they do, after normalizeToolName. */
const CATEGORY_OF: Record<string, 'read' | 'shell'> = {
  Read: 'read',
  Bash: 'shell',
};

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

function resolveAgainst(file: string, cwd: string | undefined): string {
  if (path.isAbsolute(file)) return path.resolve(file);
  return cwd ? path.resolve(cwd, file) : file;
}

/** Classify one PostToolUse payload. */
export function classifyToolCall(stdin: Record<string, unknown>): ToolCall {
  const category = CATEGORY_OF[normalizeToolName(typeof stdin.tool_name === 'string' ? stdin.tool_name : '')];
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

  const command = input.command;
  if (typeof command !== 'string') return unknown;
  const shell = classifyShellCommand(command);
  const output = outputOf(stdin.tool_response);
  return {
    category: shell.category,
    paths: shell.paths.map((f) => resolveAgainst(f, cwd)),
    status,
    simple: shell.simple,
    command,
    ...(output !== undefined ? { output } : {}),
  };
}
