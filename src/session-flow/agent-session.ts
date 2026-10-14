/**
 * agent-session.ts -- an agent session, copied from one tool and workspace to another.
 *
 * A copy never overwrites. Before writing, `copy` looks the target up by id across all of the
 * target platform's storage; when it exists, readable or not, the result is `reused` and nothing
 * is written, so turns a member added to the copy survive a retry. A failed write removes only
 * the target this call created, in the target workspace.
 *
 * Adapters stay behind this module. Expected failures are values, never exceptions.
 */

import fs from 'node:fs';
import { ADAPTER_REGISTRY, listAvailablePlatforms, listInstalledPlatforms } from './adapters/index.js';
import { ToolUnavailableError, type AgentAdapter } from './adapters/base.js';
import { imagePlaceholderText, type ContentBlock, type Message, type Session } from './ir.js';
import { deriveTargetSessionId, legacyTargetSessionIds } from './ids.js';
import { degradeThinkingBlocks, fidelityFromSession, type FidelityReport } from './migrate.js';
import { scrubSession } from './scrub.js';

/**
 * A session in one tool: its platform, its id there, and the workspace to look in. A caller that
 * listed the session passes the `filePath` it listed, so exactly that session is read.
 */
export type AgentSessionRef = { platform: string; sessionId: string; cwd?: string; filePath?: string };

export type AgentSessionFailure =
  | { code: 'no_adapter'; platform: string; reason: 'unknown tool' | 'unsupported on win32'; message: string }
  | { code: 'tool_unavailable'; platform: string; message: string }
  | { code: 'not_found'; ref: AgentSessionRef; message: string }
  | { code: 'unreadable'; ref: AgentSessionRef; message: string }
  | { code: 'invalid_workspace'; cwd: string; message: string }
  | { code: 'write_failed'; platform: string; message: string };

export type AgentSessionCopy =
  | {
      status: 'done';
      /** The target's id: the one just written, or the copy that already existed. */
      sessionId: string;
      /** The target workspace. */
      cwd: string;
      /** True when the target already existed and nothing was written. */
      reused: boolean;
      fidelity: FidelityReport;
      /** Secret-looking values replaced, when `scrub` was set. */
      redactedCount?: number;
      /** Where the copy was written, when the target tool lists it. */
      filePath?: string;
      /** The transcript was written, but the target tool may not list it. */
      notice?: string;
    }
  | { status: 'failed'; failure: AgentSessionFailure };

export type AgentSessionCopyRequest = {
  from: AgentSessionRef;
  /** `cwd` must be an absolute path. It need not exist: a deleted project still gets its copy. */
  to: { platform: string; cwd: string };
  /** Redact secret-looking values before writing. The copy stays on this machine, so off by default. */
  scrub?: boolean;
};

export type AgentSessionFound =
  | {
      status: 'done';
      /** The session as stored, its id taken from what was opened, never from the request. */
      session: Session;
      /** Secret-looking values replaced, when `scrub` was set. */
      redactedCount?: number;
    }
  | { status: 'failed'; failure: AgentSessionFailure };

/** One message of a session as text, in order: what a search indexes and a scorer reads. */
export type AgentSessionTranscriptEntry = {
  role: Message['role'];
  timestamp?: string;
  /** What the member and the agent wrote, with tool calls and their input; empty when none. */
  text: string;
  /** The tool results the message carries, each truncated; empty when none. */
  toolOutput: string;
};

export type AgentSession = {
  copy(request: AgentSessionCopyRequest): Promise<AgentSessionCopy>;
  find(ref: AgentSessionRef, options?: { scrub?: boolean }): Promise<AgentSessionFound>;
  transcript(session: Session): AgentSessionTranscriptEntry[];
  platformForTool(tool: string): string | undefined;
};

/** Targets that list a copy only once the sqlite3 CLI registers it. Windows ships no sqlite3. */
const LISTED_THROUGH_SQLITE3 = new Set(['cursor', 'workbuddy']);

/**
 * Why TeamAI cannot use `platform` on this machine, or undefined when it can. `write` also
 * refuses a target whose copy would never show here. Every command that names a platform
 * reports this failure, so its message has this one home.
 */
export function noAdapter(
  platform: string,
  use: 'read' | 'write',
): Extract<AgentSessionFailure, { code: 'no_adapter' }> | undefined {
  const known = listAvailablePlatforms();
  if (!known.includes(platform)) {
    return {
      code: 'no_adapter',
      platform,
      reason: 'unknown tool',
      message: `Unknown platform "${platform}". Known platforms: ${known.join(', ')}.`,
    };
  }
  if (use === 'write' && process.platform === 'win32' && LISTED_THROUGH_SQLITE3.has(platform)) {
    return {
      code: 'no_adapter',
      platform,
      reason: 'unsupported on win32',
      message:
        `Writing ${platform} sessions is not supported on Windows: ${platform} lists a session only after ` +
        'the sqlite3 CLI registers it, so the copy would never show. Pick another target platform.',
    };
  }
  return undefined;
}

function adapterFor(platform: string, use: 'read' | 'write'): AgentAdapter | AgentSessionFailure {
  return noAdapter(platform, use) ?? ADAPTER_REGISTRY[platform]();
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const failed = (failure: AgentSessionFailure): AgentSessionCopy => ({ status: 'failed', failure });

async function readSource(source: AgentAdapter, ref: AgentSessionRef): Promise<Session | AgentSessionFailure> {
  try {
    return await source.readSession({ sessionId: ref.sessionId, projectPath: ref.cwd, filePath: ref.filePath });
  } catch (e) {
    if (e instanceof ToolUnavailableError) return { code: 'tool_unavailable', platform: ref.platform, message: e.message };
    const where = ref.filePath ? ` at ${ref.filePath}` : ref.cwd ? ` in ${ref.cwd}` : '';
    const exists = ref.filePath
      ? fs.existsSync(ref.filePath)
      : Boolean(await source.existingSessionId(ref.sessionId, ref.cwd));
    if (!exists) {
      return { code: 'not_found', ref, message: `No ${ref.platform} session ${ref.sessionId}${where}.` };
    }
    return {
      code: 'unreadable',
      ref,
      message: `The ${ref.platform} session ${ref.sessionId}${where} could not be read: ${messageOf(e)}`,
    };
  }
}

/**
 * The id of the copy of `sourceSessionId` that already exists in the target, or undefined.
 * `targetId` is the id `deriveTargetSessionId` gives the copy; it names the workspace, so it is
 * looked up anywhere on the platform. Ids an older TeamAI used did not name the workspace, so
 * they count only in `cwd`: a copy under one elsewhere is another workspace's.
 *
 * Every path that writes a session into a tool checks this first and writes nothing on a hit.
 */
export async function existingCopyId(
  target: AgentAdapter,
  copy: { targetId: string; cwd: string; sourcePlatform: string; targetPlatform: string; sourceSessionId: string },
): Promise<string | undefined> {
  const derived = await target.existingSessionId(copy.targetId);
  if (derived) return derived;
  for (const id of legacyTargetSessionIds(copy)) {
    const found = await target.existingSessionId(id, copy.cwd);
    if (found) return found;
  }
  return undefined;
}

/** Best-effort: the file the target tool lists for the copy. */
async function listedFilePath(target: AgentAdapter, sessionId: string, cwd: string): Promise<string | undefined> {
  try {
    return (await target.listConversations(cwd)).find((meta) => meta.sessionId === sessionId)?.filePath;
  } catch {
    return undefined;
  }
}

/**
 * Read one session. Redacted unless `scrub` is false: a new caller, such as a scorer, gets
 * redacted text without having to remember to ask for it.
 */
async function find(ref: AgentSessionRef, { scrub = true }: { scrub?: boolean } = {}): Promise<AgentSessionFound> {
  const source = adapterFor(ref.platform, 'read');
  if ('code' in source) return { status: 'failed', failure: source };
  const session = await readSource(source, ref);
  if ('code' in session) return { status: 'failed', failure: session };
  if (!scrub) return { status: 'done', session };
  const scrubbed = scrubSession(session);
  return { status: 'done', session: scrubbed.session, redactedCount: scrubbed.redactedCount };
}

async function copy({ from, to, scrub = false }: AgentSessionCopyRequest): Promise<AgentSessionCopy> {
  const source = adapterFor(from.platform, 'read');
  if ('code' in source) return failed(source);
  const target = adapterFor(to.platform, 'write');
  if ('code' in target) return failed(target);
  if (!target.isReady()) {
    return failed({
      code: 'tool_unavailable',
      platform: to.platform,
      message:
        `Target platform "${to.platform}" is not installed or its storage directory was not found. ` +
        `Install the client first, or pick another target (available: ${listInstalledPlatforms().join(', ') || 'none'}).`,
    });
  }

  const session = await readSource(source, from);
  if ('code' in session) return failed(session);

  let targetId: string;
  try {
    targetId = deriveTargetSessionId({ targetPlatform: to.platform, targetCwd: to.cwd, sourceSessionId: session.sessionId });
  } catch (e) {
    return failed({ code: 'invalid_workspace', cwd: to.cwd, message: messageOf(e) });
  }

  // Scrub before measuring, measure before degrading: the report counts exactly what is lost or
  // degraded on the way into the target, the same numbers the --dry-run preview shows.
  // A local copy keeps image file paths, so the target can still open the file.
  const scrubbed = scrub ? scrubSession(session, { dropImagePaths: false }) : null;
  const base = scrubbed ? scrubbed.session : session;
  const fidelity = fidelityFromSession(base, to.platform);
  const redacted = scrubbed ? { redactedCount: scrubbed.redactedCount } : {};

  const existing = await existingCopyId(target, {
    targetId,
    sourcePlatform: from.platform,
    targetPlatform: to.platform,
    sourceSessionId: session.sessionId,
    cwd: to.cwd,
  });
  if (existing) return { status: 'done', sessionId: existing, cwd: to.cwd, reused: true, fidelity, ...redacted };

  let written: string;
  try {
    written = await target.writeSession(degradeThinkingBlocks(base, to.platform), to.cwd);
  } catch (e) {
    // The target did not exist a moment ago, so whatever the write left there is this call's.
    // Scoped to the target workspace, so a copy anywhere else is never touched.
    let message = `Writing the ${to.platform} copy failed: ${messageOf(e)}`;
    try {
      await target.deleteSession(targetId, to.cwd);
    } catch (cleanup) {
      message += `. Removing the partial copy ${targetId} also failed: ${messageOf(cleanup)}`;
    }
    return failed({ code: 'write_failed', platform: to.platform, message });
  }
  const notice = target.consumeWriteNotice();
  const filePath = await listedFilePath(target, written, to.cwd);
  return {
    status: 'done',
    sessionId: written,
    cwd: to.cwd,
    reused: false,
    fidelity,
    ...redacted,
    ...(filePath ? { filePath } : {}),
    ...(notice ? { notice } : {}),
  };
}

/**
 * A tool result keeps this many characters. Whole file reads and build logs would otherwise
 * dominate the transcript: the length search normalizes by, and the prompt a scorer reads.
 */
const TOOL_RESULT_MAX_CHARS = 2_000;

function truncated(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)} [truncated ${text.length - TOOL_RESULT_MAX_CHARS} chars]`;
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'thinking':
      return `[thinking] ${block.text}`;
    case 'tool_call':
      return `[tool_call] ${block.toolName} ${JSON.stringify(block.arguments)}`;
    case 'tool_result':
      return `[tool_result${block.isError ? ' error' : ''}] ${truncated(block.content)}`;
    case 'image':
      return imagePlaceholderText(block);
    default: {
      const unhandled: never = block;
      return unhandled;
    }
  }
}

/**
 * One entry per message, so a match or a judgement cites the message it came from. Tool calls
 * carry their input as JSON in `text`; tool results, which arrive as user messages, sit apart in
 * `toolOutput`, so they never read as something the member typed and search can weigh them less.
 * Redaction is the caller's: pass a redacted session.
 */
function transcript(session: Session): AgentSessionTranscriptEntry[] {
  return session.messages.map((message) => ({
    role: message.role,
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    text: message.content.filter((block) => block.type !== 'tool_result').map(blockText).join('\n'),
    toolOutput: message.content.filter((block) => block.type === 'tool_result').map(blockText).join('\n'),
  }));
}

/** Tool names whose session platform has another name. Every other platform is its own tool name. */
const PLATFORM_OF_TOOL: Record<string, string> = { claude: 'claude-code' };

/** The session platform a tool (a workflow step's `tool`) reads and writes, or undefined when it has none. */
function platformForTool(tool: string): string | undefined {
  const platform = PLATFORM_OF_TOOL[tool] ?? tool;
  return listAvailablePlatforms().includes(platform) ? platform : undefined;
}

export const AgentSession = { copy, find, transcript, platformForTool } as const satisfies AgentSession;
