import fs from 'node:fs/promises';
import { z } from 'zod';

/**
 * What `manifest/projects.yaml` and `manifest/roles.yaml` share: the spelling of
 * a resource namespace, and the shape of the error a bad manifest produces.
 *
 * A namespace becomes a path component (`skills/<namespace>/`,
 * `agents/<namespace>/`, `learnings/<namespace>/`), so it may not escape the
 * directory it names. Nothing else about it is constrained: it is a directory
 * name, so any name a filesystem accepts — non-ASCII, or holding a space —
 * stays valid. (A project id is narrower still, because it is also typed on the
 * command line; that guard lives with the project schema.)
 */
// `:` is unsafe with the separators rather than merely unusual: on Windows
// `path.resolve(base, 'C:evil')` is drive-relative and lands outside `base`.
// The control ranges are both of them, C0 with DEL and C1: a segment carrying one
// is a name no admin typed on purpose, and it renders as something other than
// what it is in a terminal that reports the path back.
const UNSAFE_SEGMENT = /[/\\:\u0000-\u001f\u007f-\u009f]/;

// Win32 strips trailing spaces and periods from every path component, so a
// namespace ending in one is not the directory the manifest names: `.. ` arrives
// as `..` and escapes the parent, `frontend.` arrives as `frontend` and lands in
// another namespace's directory, which is the isolation the namespace exists for.
// Refusing the trailing character covers both, and `.`/`..` fall out of it.
const TRAILING_DOT_OR_SPACE = /[ .]$/;

// Windows reserves these names for devices in every directory, extension or not:
// `CON`, `NUL`, `COM1`, `CON.txt` all open a device rather than a file, so a
// namespace spelled that way cannot be the directory the manifest means. The set
// is `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9` and `LPT1`-`LPT9`; `COM0` and
// `LPT0` are ordinary names and keep parsing.
//
// The project id is deliberately left out of this, the way it is left out of the
// rules above: it is a working POSIX directory name that the id rule has always
// accepted, and narrowing it would break manifests that parse today.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** True if `seg` is safe to use as a single path segment (no separators, no `..`). */
export function isSafeNamespaceSegment(seg: string): boolean {
  return seg.length > 0
    && !UNSAFE_SEGMENT.test(seg)
    && !TRAILING_DOT_OR_SPACE.test(seg)
    && !WINDOWS_DEVICE_NAME.test(seg);
}

/** A resource namespace: one path segment that cannot escape its parent. */
export const NamespaceSegmentSchema = z.string().min(1).refine(isSafeNamespaceSegment, {
  message: "resource namespace must be a single path segment (no '/', '\\', ':' or control characters, no trailing '.' or space, which also rules out '.' and '..', and not a Windows device name such as 'CON' or 'COM1')",
});

/**
 * Parse a manifest, reporting a failure the way the hand-written checks around
 * it do: one line naming the offending entry. A raw ZodError reaches the CLI as
 * an object dump, which tells an admin nothing about which line to edit.
 */
export function parseManifest<S extends z.ZodTypeAny>(schema: S, raw: unknown, kind: 'projects' | 'roles'): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const detail = parsed.error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
  throw new Error(`Invalid ${kind} manifest: ${detail}`);
}

/**
 * Read a manifest file, separating "there is no such file" from every other
 * reason a read can fail. `readFileSafe` collapses the two into `null`, and a
 * caller that treats `null` as "this team does not use roles/projects" would
 * then drop its filtering because the file is unreadable or empty — the fail-open
 * direction. Absence returns `null` here; anything else throws.
 */
export async function readManifestFile(manifestPath: string, kind: 'projects' | 'roles'): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(manifestPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Could not read ${kind} manifest ${manifestPath}: ${(error as Error).message}`);
  }
  if (content.trim() === '') {
    throw new Error(`Invalid ${kind} manifest: ${manifestPath} is empty. Delete it, or give it a version and a ${kind} list.`);
  }
  return content;
}
