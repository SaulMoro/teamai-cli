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
const UNSAFE_SEGMENT = /[/\\:\u0000-\u001f]/;

/** True if `seg` is safe to use as a single path segment (no separators, no `..`). */
export function isSafeNamespaceSegment(seg: string): boolean {
  return seg.length > 0 && !UNSAFE_SEGMENT.test(seg) && seg !== '.' && seg !== '..';
}

/** A resource namespace: one path segment that cannot escape its parent. */
export const NamespaceSegmentSchema = z.string().min(1).refine(isSafeNamespaceSegment, {
  message: "resource namespace must be a single path segment (no '/', '\\', ':' or control characters, and not '.' or '..')",
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
