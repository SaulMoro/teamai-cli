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

import { ADAPTER_REGISTRY, listInstalledPlatforms } from './adapters/index.js';
import type { AgentAdapter } from './adapters/base.js';
import type { Session } from './ir.js';
import { deriveTargetSessionId, legacyTargetSessionIds } from './ids.js';
import { degradeThinkingBlocks, fidelityFromSession, type FidelityReport } from './migrate.js';
import { scrubSession } from './scrub.js';

/** A session in one tool: its platform, its id there, and the workspace to look in. */
export type AgentSessionRef = { platform: string; sessionId: string; cwd?: string };

export type AgentSessionFailure =
  | { code: 'no_adapter'; platform: string; reason: 'unknown tool'; message: string }
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

export type AgentSession = {
  copy(request: AgentSessionCopyRequest): Promise<AgentSessionCopy>;
};

function adapterFor(platform: string): AgentAdapter | AgentSessionFailure {
  const factory = ADAPTER_REGISTRY[platform];
  if (!factory) {
    return {
      code: 'no_adapter',
      platform,
      reason: 'unknown tool',
      message: `Unknown platform "${platform}". Known platforms: ${Object.keys(ADAPTER_REGISTRY).join(', ')}.`,
    };
  }
  return factory();
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const failed = (failure: AgentSessionFailure): AgentSessionCopy => ({ status: 'failed', failure });

async function readSource(source: AgentAdapter, ref: AgentSessionRef): Promise<Session | AgentSessionFailure> {
  try {
    return await source.readSession(ref.sessionId, ref.cwd);
  } catch (e) {
    const where = ref.cwd ? ` in ${ref.cwd}` : '';
    if (!(await source.existingSessionId(ref.sessionId, ref.cwd))) {
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

async function copy({ from, to, scrub = false }: AgentSessionCopyRequest): Promise<AgentSessionCopy> {
  const source = adapterFor(from.platform);
  if ('code' in source) return failed(source);
  const target = adapterFor(to.platform);
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

export const AgentSession = { copy } as const satisfies AgentSession;
