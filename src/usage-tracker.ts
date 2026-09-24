import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './utils/logger.js';
import { normalizeToolName } from './utils/tool-names.js';
import {
  getCopilotHome,
  getDataHome,
  getTeamaiHomeDir,
  SKILL_NAME_REGEX,
  type LocalConfig,
  type UsageEvent,
  resolveToolRootDir,
  CLAUDE_TOOL_ID,
  DEFAULT_CLAUDE_ROOT,
} from './types.js';
import { ensureDir, readJson, writeJson, pathExists } from './utils/fs.js';
import { getUserHome } from './utils/home.js';
import { resolveHookCwd } from './utils/hook-cwd.js';
import { resolveConfigForDir, resolveMemberToolRoots } from './config.js';
import { acquireLock, releaseLock } from './update.js';

/**
 * The usage JSONL of one scope: `<dataHome>/usage.jsonl`, so each scope reports
 * only the skills used where it is set up (#748). Evaluated at call time to
 * respect HOME changes in tests.
 *
 * The user scope records in `~/.teamai/user-usage.jsonl` instead: every scope
 * used to record in `~/.teamai/usage.jsonl`, and an earlier release still does
 * after a rollback, so what that file holds names no project. It is never
 * read, so the user scope cannot report it to its team.
 */
function getUsagePath(config: LocalConfig): string {
  const dataHome = getDataHome(config);
  const sharedDir = getTeamaiHomeDir();
  if (path.resolve(dataHome) !== path.resolve(sharedDir)) return path.join(dataHome, 'usage.jsonl');
  return path.join(sharedDir, 'user-usage.jsonl');
}

/** Get the known-skills.json path (evaluated at call time to respect HOME changes in tests). */
function getKnownSkillsPath(): string {
  return path.join(getUserHome(), '.teamai', 'known-skills.json');
}

// ─── Data flow ─────────────────────────────────────────
//
//  Claude Code / Claude Internal / CodeBuddy       Cursor
//  ─────────────────────────────────────────       ──────
//  PostToolUse hook (matcher: "Skill")             PostToolUse hook (matcher: "Read")
//      │                                               │
//      ▼                                               ▼
//  { tool_name: "Skill",                          { tool_name: "Read",
//    tool_input: { skill: "tdd" } }                 tool_input: { path: "…/SKILL.md" } }
//      │                                               │
//      └────────────────┬──────────────────────────────┘
//                       ▼
//         teamai track --stdin --tool <name>
//                       │
//                       ▼
//               [extract & validate skill name]
//               [toolArg → toolSource; Read+SKILL.md → 'cursor']
//                       │
//                       ▼
//               [resolveConfigForDir(cwd)] ─null─▶ skip (#748)
//                       │
//                       ▼
//               appendFile(<scope usage file>, JSON line)
//                       │
//                       ▼
//               updateKnownSkills(skill) → known-skills.json
//
//  ─── Slash command tracking (Claude Code only) ────────
//
//  UserPromptSubmit hook (matcher: "*")
//      │
//      ▼
//  { prompt: "/plan-eng-review args..." }
//      │
//      ▼
//  teamai track-slash --stdin --tool <name>
//      │
//      ▼
//  [starts with "/"?] ──No──▶ exit(0)
//      │Yes
//      ▼
//  [extract & validate skill name after "/"]
//      │
//      ▼
//  appendFile(<scope usage file>) + updateKnownSkills()
//

/**
 * Extract skill name from the Skill tool's input.
 * Accepts either a JSON string or a parsed object.
 *
 * Handles multiple field names that different AI tool providers may use:
 *   - skill, name (original)
 *   - skill_name (Claude Code variant)
 *   - command (some providers wrap skill invocation)
 *
 * If the value looks like a file path (e.g. "/root/.cursor/skills/tdd/SKILL.md"),
 * extracts the skill directory name as the skill identifier.
 */
export function extractSkillName(toolInput: string | Record<string, unknown>): string | null {
  try {
    const parsed = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
    const raw: unknown = parsed?.skill ?? parsed?.name ?? parsed?.skill_name ?? parsed?.command ?? null;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // If value looks like a path to SKILL.md, extract the parent directory name
    const skillMdMatch = trimmed.match(/\/([^/]+)\/SKILL\.md$/i);
    if (skillMdMatch) return skillMdMatch[1];

    // If value looks like a filesystem path, extract the last segment
    if (trimmed.startsWith('/') || trimmed.startsWith('~')) {
      const segments = trimmed.split('/').filter(Boolean);
      return segments[segments.length - 1] || null;
    }

    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Validate a skill name against allowed characters.
 * Prevents path traversal and overly long names.
 */
export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_REGEX.test(name);
}

/** A resolved, validated skill invocation from a PostToolUse payload. */
export interface ResolvedSkillUse {
  /** The validated skill name (passes {@link isValidSkillName}). */
  skillName: string;
  /** 'cursor' for a Read of a SKILL.md path, otherwise the caller's tool. */
  source: 'cursor' | null;
}

/**
 * Resolve a skill invocation from a PostToolUse hook payload — the single source
 * of truth shared by the usage tracker and the webhook handler so they can never
 * drift. Handles both shapes: Claude/CodeBuddy's `Skill` tool, and Cursor's
 * `Read` of a `.../SKILL.md` path. Returns null for anything else — including a
 * normal (non-SKILL.md) `Read`, so a plain file read never counts as skill use.
 * The returned name is already validated with {@link isValidSkillName}.
 */
export function resolveSkillUse(
  toolName: string,
  toolInput: Record<string, unknown>,
): ResolvedSkillUse | null {
  let skillName: string | null = null;
  let source: 'cursor' | null = null;

  if (toolName === 'Skill') {
    skillName = extractSkillName(toolInput);
  } else if (toolName === 'Read') {
    const filePath =
      (typeof toolInput.file_path === 'string' ? toolInput.file_path : null) ??
      (typeof toolInput.filePath === 'string' ? toolInput.filePath : null) ??
      (typeof toolInput.path === 'string' ? toolInput.path : null);
    // Only a Read of a SKILL.md file is skill use — a normal file read is not.
    if (filePath && /\/SKILL\.md$/i.test(filePath)) {
      skillName = extractSkillName({ skill: filePath });
      source = 'cursor';
    }
  } else {
    return null;
  }

  if (!skillName || !isValidSkillName(skillName)) return null;
  return { skillName, source };
}

/**
 * Well-known local skill directories to check for skill existence.
 * Ordered by likelihood of being present.
 */
const SKILL_DIRS = [
  '.claude/skills',
  '.claude-internal/skills',
  '.tclaude/skills',
  '.cursor/skills',
  '.codebuddy/skills',
  '.codex/skills',
  '.codex-internal/skills',
  '.tcodex/skills',
  '.openclaw/skills',
  '.hermes/skills',
];
const PROJECT_SKILL_DIRS = [...SKILL_DIRS, '.github/skills'];

/**
 * Check whether a skill actually exists on disk (has a SKILL.md in any tool's skills directory).
 * This prevents tracking phantom skills from typos or path inputs like "/data".
 *
 * Performance: Checks a bounded list of user and project directories with one stat() each.
 */
export async function skillExistsOnDisk(skillName: string, toolRoots?: Record<string, string>): Promise<boolean> {
  const home = getUserHome();
  // A Claude Code relocated with CLAUDE_CONFIG_DIR keeps its skills under the
  // recorded root, which the static list cannot know; the caller resolves it
  // from the hook's directory (resolveMemberToolRoots).
  const claudeRoot = resolveToolRootDir(CLAUDE_TOOL_ID, DEFAULT_CLAUDE_ROOT, toolRoots);
  const userSkillDirs = [
    path.join(claudeRoot, 'skills'),
    ...SKILL_DIRS.map((dir) => path.join(home, dir)),
    path.join(getCopilotHome(), 'skills'),
  ];
  // Check user-level directories
  for (const dir of userSkillDirs) {
    const skillMd = path.join(dir, skillName, 'SKILL.md');
    if (await pathExists(skillMd)) return true;
  }
  // Check project-level directories (cwd)
  const cwd = process.cwd();
  if (path.resolve(cwd) !== path.resolve(home)) {
    for (const dir of PROJECT_SKILL_DIRS) {
      const skillMd = path.join(cwd, dir, skillName, 'SKILL.md');
      if (await pathExists(skillMd)) return true;
    }
  }
  return false;
}

/**
 * Append a usage event to the local JSONL file.
 * Silently fails on I/O errors (disk full, permission denied, etc.)
 * to avoid disrupting the AI coding session.
 */
export async function appendUsageEvent(event: UsageEvent, config: LocalConfig): Promise<void> {
  try {
    const usagePath = getUsagePath(config);
    await ensureDir(path.dirname(usagePath));
    const line = JSON.stringify(event) + '\n';
    if (await withUsageLock(usagePath, APPEND_LOCK_WAIT, () => fs.promises.appendFile(usagePath, line, 'utf-8'))) {
      log.debug(`Tracked skill: ${event.skill}`);
      return;
    }
    // The lock is still held: record the event in a side file of its own for
    // the next lock holder to fold in, rather than race a rewrite.
    const pendingPath = path.join(path.dirname(usagePath), `${pendingPrefix(usagePath)}${randomUUID()}.jsonl`);
    await fs.promises.writeFile(pendingPath, line, { encoding: 'utf-8', flag: 'wx' });
    log.debug(`Tracked skill: ${event.skill} (in ${pendingPath}; ${usagePath}.lock is held)`);
  } catch (e) {
    log.error(`Failed to write usage event: ${(e as Error).message}`);
  }
}

/**
 * Read all usage events from a scope's JSONL file.
 * Skips corrupted lines gracefully.
 */
export async function readUsageEvents(config: LocalConfig): Promise<UsageEvent[]> {
  try {
    const content = await fs.promises.readFile(getUsagePath(config), 'utf-8');
    const events: UsageEvent[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as UsageEvent;
        if (parsed.skill && parsed.timestamp) {
          events.push(parsed);
        }
      } catch {
        log.debug(`Skipping corrupted JSONL line: ${trimmed.slice(0, 50)}`);
      }
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Truncate the usage JSONL file, keeping only events after `afterTimestamp`.
 * Used after successful auto-report to keep the file small.
 */
export async function truncateUsageAfterReport(reportedCount: number, config: LocalConfig): Promise<void> {
  try {
    // All lines reported → an empty file; otherwise keep the unreported lines.
    await rewriteUsageFile(config, (lines) => lines.slice(reportedCount));
    log.debug(`Truncated usage.jsonl: removed ${reportedCount} reported events`);
  } catch (e) {
    log.error(`Failed to truncate usage.jsonl: ${(e as Error).message}`);
  }
}

/** Most events a scope's usage file keeps; `pull` drops the oldest beyond it (#788). */
export const USAGE_EVENT_CAP = 5_000;

/**
 * Keep only the newest {@link USAGE_EVENT_CAP} events of a scope's usage file,
 * so a scope that never reports (http, `usageReport: false`, a rejecting
 * remote) stops growing without emptying `teamai stats`. The report truncates
 * the first N lines it read, so this must run after that truncate, never
 * between the report's read and its truncate. Counts non-empty lines, as the
 * truncate does. A file at or below the cap is not rewritten.
 */
export async function capUsageEvents(config: LocalConfig): Promise<void> {
  let dropped = 0;
  try {
    await rewriteUsageFile(config, (lines) => {
      if (lines.length <= USAGE_EVENT_CAP) return null;
      dropped = lines.length - USAGE_EVENT_CAP;
      return lines.slice(-USAGE_EVENT_CAP);
    });
    if (dropped) log.debug(`Capped usage.jsonl: dropped ${dropped} oldest events`);
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT') return;
    log.error(`Could not cap ${getUsagePath(config)} to ${USAGE_EVENT_CAP} events: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A hook append waits at most ~250 ms for the usage lock, inside its foreground budget. */
const APPEND_LOCK_WAIT = { attempts: 10, delayMs: 25 };
/** A rewrite waits up to ~5 s for a peer's rewrite to finish. */
const REWRITE_LOCK_WAIT = { attempts: 100, delayMs: 50 };

/**
 * Run `fn` holding the lock every writer of this usage file takes (#788): hook
 * appends, the report's truncate and the cap. A rewrite then cannot drop an
 * append made while it runs, and two pulls cannot interleave their rewrites.
 * The holder first folds in the side files of appends that gave up waiting. A
 * lock whose owner is gone is reclaimed. Returns false, without running `fn`,
 * when the lock is still held after the wait.
 */
async function withUsageLock(
  usagePath: string,
  wait: { attempts: number; delayMs: number },
  fn: () => Promise<void>,
): Promise<boolean> {
  const lockPath = `${usagePath}.lock`;
  for (let i = 0; i < wait.attempts; i++) {
    if (await acquireLock(lockPath)) {
      try {
        await foldPendingEvents(usagePath);
        await fn();
      } finally {
        await releaseLock(lockPath);
      }
      return true;
    }
    await new Promise((r) => setTimeout(r, wait.delayMs));
  }
  return false;
}

/** Name prefix of the side files an append writes while the usage lock is held. */
function pendingPrefix(usagePath: string): string {
  return `${path.basename(usagePath, '.jsonl')}.pending-`;
}

/**
 * Append the side files of appends that gave up on the lock to the usage file,
 * then remove them. Each holds one whole line; one without its newline is
 * still being written and waits for the next holder.
 */
async function foldPendingEvents(usagePath: string): Promise<void> {
  const dir = path.dirname(usagePath);
  const prefix = pendingPrefix(usagePath);
  const names = await fs.promises.readdir(dir).catch(() => []);
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.jsonl')) continue;
    const pendingPath = path.join(dir, name);
    try {
      const content = await fs.promises.readFile(pendingPath, 'utf-8');
      if (!content.endsWith('\n')) continue;
      await fs.promises.appendFile(usagePath, content, 'utf-8');
      await fs.promises.rm(pendingPath, { force: true });
    } catch (e) {
      log.debug(`Could not fold ${pendingPath} into ${usagePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Replace a scope's usage file with the non-empty lines `keep` returns, or
 * leave it untouched when `keep` returns null. The copy is written to a temp
 * file beside the file, with its mode, and renamed over it, so a kill or a full
 * disk leaves the old file whole. A symlinked file is replaced at its target.
 */
async function rewriteUsageFile(config: LocalConfig, keep: (lines: string[]) => string[] | null): Promise<void> {
  const usagePath = getUsagePath(config);
  const rewritten = await withUsageLock(usagePath, REWRITE_LOCK_WAIT, async () => {
    // Replace the file itself, not a symlink to it.
    const target = await fs.promises.realpath(usagePath);
    await removeOrphanTemps(target);
    const lines = (await fs.promises.readFile(target, 'utf-8')).split('\n').filter((l) => l.trim());
    const kept = keep(lines);
    if (!kept) return;
    const mode = (await fs.promises.stat(target)).mode & 0o7777;
    const tmpPath = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, kept.length ? kept.join('\n') + '\n' : '', { encoding: 'utf-8', mode });
      // The create mode passes through the umask.
      await fs.promises.chmod(tmpPath, mode);
      await fs.promises.rename(tmpPath, target);
    } catch (e) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
      throw e;
    }
  });
  if (!rewritten) {
    throw new Error(`${usagePath}.lock is still held after 5 s, so the file was left as it is; remove the lock if no teamai process is running`);
  }
}

/** Remove the temp copies a killed rewrite left beside `target`; only the lock holder writes one. */
async function removeOrphanTemps(target: string): Promise<void> {
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}.`;
  const names = await fs.promises.readdir(dir).catch(() => []);
  for (const name of names) {
    if (!name.startsWith(prefix) || !/^\d+\.[0-9a-f]{12}\.tmp$/.test(name.slice(prefix.length))) continue;
    await fs.promises.rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
}

/**
 * Add a skill to the known-skills set (persisted across truncations).
 * Silently fails on I/O errors to avoid disrupting the AI coding session.
 */
export async function updateKnownSkills(skillName: string): Promise<void> {
  try {
    const knownPath = getKnownSkillsPath();
    const existing = await readJson<string[]>(knownPath);
    const skills = new Set(Array.isArray(existing) ? existing : []);
    if (skills.has(skillName)) return; // already known
    skills.add(skillName);
    await writeJson(knownPath, Array.from(skills).sort());
    log.debug(`Added ${skillName} to known-skills.json`);
  } catch (e) {
    log.error(`Failed to update known-skills: ${(e as Error).message}`);
  }
}

/**
 * Read the set of skills the current user has ever used.
 * Merges local usage.jsonl (unreported events) with known-skills.json (persisted history).
 */
export async function readKnownSkills(): Promise<Set<string>> {
  const skills = new Set<string>();

  // Source 1: unreported events in the usage.jsonl of the scope governing the cwd
  // (Source 2 below stays machine-wide; neither leaves the machine)
  const config = await resolveConfigForDir();
  const events = config ? await readUsageEvents(config) : [];
  for (const event of events) {
    skills.add(event.skill);
  }

  // Source 2: known-skills.json (survives truncation)
  try {
    const known = await readJson<string[]>(getKnownSkillsPath());
    if (Array.isArray(known)) {
      for (const name of known) {
        if (typeof name === 'string') skills.add(name);
      }
    }
  } catch {
    // known-skills.json missing or corrupted — use only JSONL data
  }

  return skills;
}

/**
 * Read STDIN fully and return its content as a string.
 * Returns empty string if STDIN is not a pipe or is empty.
 */
async function readStdin(): Promise<string> {
  // If STDIN is a TTY (interactive), don't block waiting for input
  if (process.stdin.isTTY) return '';

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Handle the `teamai track` CLI command.
 * Called by PostToolUse hook with CLI args (legacy) or STDIN JSON (current).
 */
export async function track(rawToolName: string, toolInput: string, tool?: string): Promise<void> {
  const toolName = normalizeToolName(rawToolName);
  // Only track Skill tool calls
  if (toolName !== 'Skill') {
    return;
  }

  const skillName = extractSkillName(toolInput);
  if (!skillName) {
    log.debug('Could not extract skill name from tool input');
    return;
  }

  if (!isValidSkillName(skillName)) {
    log.debug(`Invalid skill name rejected: ${skillName.slice(0, 50)}`);
    return;
  }

  const config = await resolveConfigForDir();
  if (!config) return;

  const event: UsageEvent = {
    skill: skillName,
    timestamp: new Date().toISOString(),
    tool: tool ?? 'claude',
  };

  await appendUsageEvent(event, config);
  await updateKnownSkills(skillName);
}

/**
 * Handle the `teamai track --stdin` mode.
 * Reads PostToolUse hook JSON from STDIN and extracts tool usage info.
 *
 * Supports two tool formats:
 *   - Claude Code "Skill" tool:  { tool_name: "Skill", tool_input: { skill: "tdd" } }
 *   - Cursor "Read" tool:        { tool_name: "Read",  tool_input: { path: "…/SKILL.md" } }
 *
 * @param toolArg - Optional tool identifier from --tool CLI flag.
 *                  When provided, used as the toolSource (e.g. 'claude-internal').
 *                  When absent, defaults to 'claude' for backward compatibility.
 *                  Exception: Read + SKILL.md always overrides to 'cursor'.
 */
export async function trackFromStdin(toolArg?: string): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    log.debug('No STDIN data received');
    return;
  }

  let hookData: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: unknown };
  try {
    hookData = JSON.parse(raw);
  } catch {
    log.error('Failed to parse STDIN JSON');
    return;
  }

  const rawName = hookData.tool_name;
  if (typeof rawName !== 'string') return;
  const toolName = normalizeToolName(rawName);

  const toolInput = hookData.tool_input;
  if (!toolInput || typeof toolInput !== 'object') {
    if (toolName === 'Skill' || toolName === 'Read') {
      log.debug('Missing or invalid tool_input in STDIN JSON');
    }
    return;
  }

  let skillName: string | null = null;
  let toolSource = toolArg ?? 'claude';

  if (toolName === 'Skill') {
    skillName = extractSkillName(toolInput);
  } else if (toolName === 'Read') {
    const filePath =
      (typeof toolInput.file_path === 'string' ? toolInput.file_path : null) ??
      (typeof toolInput.filePath === 'string' ? toolInput.filePath : null) ??
      (typeof toolInput.path === 'string' ? toolInput.path : null);
    if (filePath && /\/SKILL\.md$/i.test(filePath)) {
      skillName = extractSkillName({ skill: filePath });
      toolSource = 'cursor';
    }
  } else {
    return;
  }

  if (!skillName) {
    log.debug('Could not extract skill name from STDIN tool_input');
    return;
  }

  if (!isValidSkillName(skillName)) {
    log.debug(`Invalid skill name rejected: ${skillName.slice(0, 50)}`);
    return;
  }

  const config = await resolveConfigForDir(resolveHookCwd(hookData));
  if (!config) return;

  const event: UsageEvent = {
    skill: skillName,
    timestamp: new Date().toISOString(),
    tool: toolSource,
  };

  await appendUsageEvent(event, config);
  await updateKnownSkills(skillName);
}

/**
 * Handle the `teamai track-slash --stdin` mode.
 * Reads UserPromptSubmit hook JSON from STDIN and tracks slash commands.
 *
 * STDIN JSON format (Claude Code UserPromptSubmit):
 *   { prompt: "/plan-eng-review args...", session_id: "...", hook_event_name: "UserPromptSubmit" }
 *
 * Extracts the first word after "/" as the skill name.
 *
 * @param toolArg - Optional tool identifier from --tool CLI flag.
 *                  Defaults to 'claude' for backward compatibility.
 */
export async function trackSlashCommand(toolArg?: string): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    log.debug('No STDIN data for slash tracking');
    return;
  }

  let hookData: { prompt?: string; cwd?: unknown };
  try {
    hookData = JSON.parse(raw);
  } catch {
    log.error('Failed to parse slash command STDIN JSON');
    return;
  }

  const prompt = hookData.prompt;
  if (typeof prompt !== 'string' || !prompt.startsWith('/')) {
    return;
  }

  // Extract all skill names after "/" in the prompt
  // (e.g. "/plan-eng-review some args /tdd /code-review" → ["plan-eng-review", "tdd", "code-review"])
  const matches = [...prompt.matchAll(/\/([a-zA-Z0-9_\-:.]+)/g)];
  if (matches.length === 0) {
    log.debug('Could not extract skill name from slash command');
    return;
  }

  const hookCwd = resolveHookCwd(hookData);
  const config = await resolveConfigForDir(hookCwd);
  if (!config) return;
  // The same root resolution import and the local agent use, from the hook's
  // directory: a project set up before a user-scope relocation has no record
  // of its own and follows user scope.
  const toolRoots = await resolveMemberToolRoots(hookCwd);

  for (const match of matches) {
    const skillName = match[1];

    if (!isValidSkillName(skillName)) {
      log.debug(`Invalid slash skill name rejected: ${skillName.slice(0, 50)}`);
      continue;
    }

    // Verify the skill actually exists on disk to avoid tracking phantom skills
    // (e.g. user typing "/data" which is not a real skill)
    if (!await skillExistsOnDisk(skillName, toolRoots)) {
      log.debug(`Slash command "/${skillName}" is not a known skill — skipping tracking`);
      continue;
    }

    const event: UsageEvent = {
      skill: skillName,
      timestamp: new Date().toISOString(),
      tool: toolArg ?? 'claude',
    };

    await appendUsageEvent(event, config);
    await updateKnownSkills(skillName);
  }
}
