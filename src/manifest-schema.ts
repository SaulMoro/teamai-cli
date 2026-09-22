import fs from 'node:fs/promises';
import path from 'node:path';
import { expandHome } from './utils/fs.js';
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
// is `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9` and `LPT1`-`LPT9`, plus the console
// handles `CONIN$` and `CONOUT$`; `COM0` and `LPT0` are ordinary names and keep
// parsing. Windows also reads the superscript
// forms of 1, 2 and 3 (U+00B9, U+00B2, U+00B3) as device numbers, so those go in
// with the ASCII digits.
//
// The project id is deliberately left out of this, the way it is left out of the
// rules above: it is a working POSIX directory name that the id rule has always
// accepted, and narrowing it would break manifests that parse today.
const WINDOWS_DEVICE_NAME = /^(con|conin\$|conout\$|prn|aux|nul|(com|lpt)[1-9\u00b9\u00b2\u00b3])(\.|$)/i;

/** True if `seg` is safe to use as a single path segment (no separators, no `..`). */
export function isSafeNamespaceSegment(seg: string): boolean {
  return seg.length > 0
    && !UNSAFE_SEGMENT.test(seg)
    && !TRAILING_DOT_OR_SPACE.test(seg)
    && !WINDOWS_DEVICE_NAME.test(seg);
}

const NAMESPACE_RULE = "resource namespace must be a single path segment (no '/', '\\', ':' or control characters, no trailing '.' or space, which also rules out '.' and '..', and not a Windows device name such as 'CON' or 'COM1')";

/** A resource namespace: one path segment that cannot escape its parent. */
export const NamespaceSegmentSchema = z.string().min(1).refine(isSafeNamespaceSegment, { message: NAMESPACE_RULE });

/**
 * A role id that stands in for a namespace when `roles.yaml` is absent. The
 * manifest never validated it, so it gets the same check here before it can
 * become a path component; an unsafe one fails the command rather than being
 * joined onto the team repo.
 */
export function assertSafeFallbackNamespaces(ids: string[], source: string): string[] {
  const unsafe = ids.find((id) => !isSafeNamespaceSegment(id));
  if (unsafe !== undefined) {
    throw new Error(`Invalid ${source} "${unsafe}": ${NAMESPACE_RULE}`);
  }
  return ids;
}


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
 * The first component of `target` that exists as a symbolic link pointing at
 * nothing, or `null` when the path is simply not there.
 *
 * ENOENT is not proof of absence: a dangling link anywhere on the path — the
 * file itself, or the `manifest/` directory — reads exactly like a file that was
 * never written. Absence is the one answer that lets a caller drop its
 * filtering, so it has to be the true one. `lstat` sees each link itself, and
 * `stat` says whether it leads anywhere.
 */
async function danglingLinkOnPath(target: string): Promise<string | null> {
  let current = target;
  for (;;) {
    const link = await fs.lstat(current).catch(() => null);
    if (link) {
      if (!link.isSymbolicLink()) return null;
      const resolves = await fs.stat(current).then(() => true, () => false);
      return resolves ? null : current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Read a manifest file, separating "there is no such file" from every other
 * reason a read can fail. `readFileSafe` collapses the two into `null`, and a
 * caller that treats `null` as "this team does not use roles/projects" would
 * then drop its filtering because the file is unreadable or empty — the fail-open
 * direction. Absence returns `null` here; anything else throws.
 */
export async function readManifestFile(manifestPath: string, kind: 'projects' | 'roles'): Promise<string | null> {
  // `repo.localPath` is documented as `~/.teamai/...`; the helpers this replaced
  // expanded it, and a path left unexpanded would be searched under the current
  // directory, read as absent, and relax the filtering.
  const resolvedPath = expandHome(manifestPath);
  let content: string;
  try {
    content = await fs.readFile(resolvedPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const dangling = await danglingLinkOnPath(resolvedPath);
      if (!dangling) return null;
      throw new Error(`Could not read ${kind} manifest ${resolvedPath}: ${dangling} is a symbolic link with no target.`);
    }
    throw new Error(`Could not read ${kind} manifest ${resolvedPath}: ${(error as Error).message}`);
  }
  if (content.trim() === '') {
    throw new Error(`Invalid ${kind} manifest: ${resolvedPath} is empty. Delete it, or give it a version and a ${kind} list.`);
  }
  return content;
}

/** One namespace as a manifest declares it, with the entry that declares it. */
export interface NamespaceEntry {
  type: string;
  namespace: string;
  owner: string;
}

/**
 * Two namespaces of the same resource type that differ only by case (or by
 * Unicode normalization) name one directory on the default Windows and macOS
 * filesystems, so a role or project scoped to `frontend` would read `Frontend`'s
 * resources too — the isolation the namespace exists to provide. `kind` names
 * what was being checked, e.g. `roles manifest`.
 */
export function assertNoCaseAliasedNamespaces(entries: Iterable<NamespaceEntry>, kind: string): void {
  const seen = new Map<string, NamespaceEntry>();
  for (const entry of entries) {
    const key = `${entry.type}/${entry.namespace.normalize('NFC').toLowerCase()}`;
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, entry);
    } else if (prior.namespace !== entry.namespace) {
      throw new Error(
        `Invalid ${kind}: ${entry.type} namespaces "${prior.namespace}" (${prior.owner}) and "${entry.namespace}" (${entry.owner}) `
        + 'differ only by case or Unicode normalization and would name the same directory on a case-insensitive filesystem',
      );
    }
  }
}
