/**
 * Paths as agents write them and recall prints them (#884), compared the same
 * way on every OS. On Windows one file is `C:\kb\x.md`, `c:/kb/x.md` or Git
 * Bash's `/c/kb/x.md`, whatever platform runs the comparison. Nothing here
 * reads the disk or depends on the host's `path` flavour, and a path is
 * normalized only to compare it, never where it is recorded or shown.
 */
import path from 'node:path';

/** A drive-lettered path: `C:\…` or `C:/…`. */
const DRIVE = /^[A-Za-z]:[\\/]/;

/** Whether `p` is absolute on either platform: `/…`, `\…`, `C:\…` or `C:/…`. */
export function isAbsolutePath(p: string): boolean {
  return path.win32.isAbsolute(p);
}

/** The `path` flavour of `p`'s own platform: Windows for a drive-lettered or backslash-rooted path. */
function flavourOf(p: string): path.PlatformPath {
  return DRIVE.test(p) || p.startsWith('\\') ? path.win32 : path.posix;
}

/**
 * `file` resolved against `base`: an absolute path normalized in its own
 * platform's form (Git Bash's `/c/…` stays as written), a relative one
 * resolved against `base` in base's form, or left as written with no base.
 */
export function resolvePath(file: string, base?: string): string {
  if (isAbsolutePath(file)) return flavourOf(file).normalize(file);
  return base ? flavourOf(base).resolve(base, file) : file;
}

/**
 * `p` in one form, for comparison only: `/` separators, a Git Bash drive
 * (`/c/…`) as its letter (`c:/…`), the drive letter in lowercase, `.` and
 * `..` collapsed, and no trailing separator.
 */
export function pathKey(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/^\/([A-Za-z])(?:\/|$)/, '$1:/');
  const key = path.posix.normalize(slashed.replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase()));
  return key.length > 1 && key.endsWith('/') && !/^[a-z]:\/$/.test(key) ? key.slice(0, -1) : key;
}

/** Whether `a` and `b` name the same file, each written on either platform. */
export function samePath(a: string, b: string): boolean {
  return isAbsolutePath(a) === isAbsolutePath(b) && pathKey(a) === pathKey(b);
}

/** Whether `file` is `dir` or lies under it; both absolute. */
export function isWithin(file: string, dir: string): boolean {
  const f = pathKey(file);
  const d = pathKey(dir);
  return f === d || f.startsWith(d.endsWith('/') ? d : `${d}/`);
}
