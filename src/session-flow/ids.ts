/**
 * ids.ts -- the id a session gets when TeamAI writes it into a tool.
 *
 * Every target id is derived: sha256 over the target platform, the canonical
 * target workspace and the source session id, shaped as a UUIDv7. No source id
 * is ever reused, for any platform:
 *
 * - Reusing a source UUID wrote the copy over whatever already had that id in
 *   the target, and a same-platform CodeBuddy IDE copy replaced the live
 *   conversation.
 * - The workspace is part of the key for every platform. Claude Code resumes by
 *   id across all project directories, and a rollback without a workspace
 *   deletes the id everywhere, so one id in two workspaces is not two sessions.
 *
 * The same request (platform, workspace, source) always names the same target.
 * Copies written by an older TeamAI kept the source UUID, or (Claude Code and
 * CodeBuddy) left the workspace out of the hash, so they carry other ids.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Derive the id to write a session under in `targetPlatform` at `targetCwd`.
 *
 * Throws before anything is written when `targetCwd` is not absolute: a
 * relative path or a placeholder such as `md5:<hash>` would resolve against
 * the directory the command runs in, so both the id and the file would move
 * with it.
 */
export function deriveTargetSessionId(target: {
  targetPlatform: string;
  targetCwd: string;
  sourceSessionId: string;
}): string {
  const { targetPlatform, targetCwd, sourceSessionId } = target;
  if (!path.isAbsolute(targetCwd)) {
    throw new Error(
      `Target workspace "${targetCwd}" is not an absolute path, so the session was not written. ` +
        'Pass an absolute directory (--target-cwd for `session migrate`, --cwd for `session resume`).',
    );
  }
  const hex = crypto
    .createHash('sha256')
    .update(`teamai:${targetPlatform}:${canonicalWorkspace(targetCwd)}:${sourceSessionId}`)
    .digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  // Version nibble 7 keeps the UUIDv7 shape Codex expects of a thread id. The
  // time bits are hash, not a timestamp: sorting comes from session timestamps.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `7${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * One spelling per workspace: the native real path. It resolves symlinks
 * (`/tmp/x` and `/private/tmp/x` on macOS) and, on case-insensitive file
 * systems, letter case (`/Users/me/Repo` and `/users/me/repo`), so a retry
 * from another spelling names the same target. A path that does not exist yet
 * is only resolved, so its id can change once the directory is created through
 * another spelling.
 */
function canonicalWorkspace(cwd: string): string {
  try {
    return fs.realpathSync.native(path.resolve(cwd));
  } catch {
    return path.resolve(cwd);
  }
}

const SAFE_SESSION_FILE_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isSafeSessionFileId(sessionId: string): boolean {
  return SAFE_SESSION_FILE_ID_RE.test(sessionId);
}

/**
 * Reject a session id that is not one path segment.
 * Rollback concatenates the id into a file path; `../` would unlink outside
 * the platform's storage directory.
 */
export function assertSafeSessionFileId(sessionId: string): void {
  if (!isSafeSessionFileId(sessionId)) {
    throw new Error('Refusing to delete a session id that is not a single path segment.');
  }
}
