import { execFile } from 'node:child_process';
import { isWithin, onPath, type NativeSandbox, type Sandboxed } from './native.js';

// ─── seatbelt: macOS's own sandbox, through sandbox-exec ───
//
//  Each exec runs `sandbox-exec -p <profile> -D NAME=<path> … <argv>`. The profile confines files only, so a step here is
//  at `isolation: worktree`: it has no PID namespace and keeps this Mac's network.
//
//    (allow default)                                 processes, the network, Mach services: as on the host
//    (deny file-read-data … (subpath HOME))          the member's home and temp directory: not read or written
//    (deny file-write* (subpath "/"))                nothing written anywhere …
//    (allow file-write* /dev/null, /dev/tty…)        … but the devices a shell writes to,
//    (allow file-read-data … (subpath R…))           the view's git paths and the PATH's tools, read only,
//    (allow file-read-data … file-write* (subpath W…)) and the place: worktree, result, run directory, tool homes, and
//                                                    the step's own home and temp directory
//    (deny file-write* (subpath R…))                 … except a read-only path inside the place: the worktree's .git
//
//  A later rule wins over an earlier one, so the allows open the place inside the denied home. A path goes in as a `-D`
//  parameter, never into the profile's text, so no path can change the profile. Metadata stays readable, so a step can
//  resolve its own paths through the home; a directory's listing and a file's content cannot be read there.
//

const NOT_MACOS = 'seatbelt runs only on macOS 14 or later, and this machine has no sw_vers. On Linux, use provider: bwrap; anywhere, provider: sbx or docker';

/** What `file` printed on stdout, or why it could not run. */
function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: true; stdout: string } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: 10_000 }, (error, stdout, stderr) => {
      resolve(error ? { ok: false, message: String(stderr).trim().split('\n').at(-1) || error.message } : { ok: true, stdout: String(stdout) });
    });
  });
}

/**
 * What the profile denies reading under the member's home, and allows again in the place. An allow reopens only the
 * operations it names: `file-read*` after a deny of `file-read-data` leaves the data denied (macOS 27).
 */
const READ = 'file-read-data file-read-xattr';

/** A profile's text, and the `-D` parameters (`NAME=<path>`) it reads its paths from. */
export interface SeatbeltProfile {
  profile: string;
  params: string[];
}

/** The profile a step runs under. */
export function profileOf({ writable, readable, hidden }: Pick<Sandboxed, 'writable' | 'readable' | 'hidden'>): SeatbeltProfile {
  const params: string[] = [];

  const subpaths = (prefix: string, paths: string[]): string => paths.map((at, index) => {
    params.push(`${prefix}${index}=${at}`);

    return `(subpath (param "${prefix}${index}"))`;
  }).join(' ');

  // A read-only path inside a writable one (the worktree's .git) needs its own deny, after the allow it is inside of.
  const lockedIn = readable.filter((at) => writable.some((place) => isWithin(at, place)));

  const lines = [
    '(version 1)',
    '(allow default)',
    ...(hidden.length > 0 ? [`(deny ${READ} file-write* ${subpaths('HIDDEN', hidden)})`] : []),
    '(deny file-write* (subpath "/"))',
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    ...(readable.length > 0 ? [`(allow ${READ} ${subpaths('READ', readable)})`] : []),
    `(allow ${READ} file-write* ${subpaths('WRITE', writable)})`,
    ...(lockedIn.length > 0 ? [`(deny file-write* ${subpaths('LOCKED', lockedIn)})`] : []),
  ];

  return { profile: lines.join('\n'), params };
}

export const seatbelt: NativeSandbox = {
  provider: 'seatbelt',
  isolation: 'worktree',
  isUnattended: false,

  async preflight(env) {
    const swVers = onPath('sw_vers', env.PATH);

    if (swVers === undefined) return { ok: false, message: NOT_MACOS };
    const version = await run(swVers, ['-productVersion'], env);

    if (!version.ok) return { ok: false, message: `sw_vers could not tell this Mac's version (${version.message}). ${NOT_MACOS}` };
    const major = Number(version.stdout.trim().split('.')[0]);

    if (!(major >= 14)) return { ok: false, message: `seatbelt needs macOS 14 or later, and this Mac runs ${version.stdout.trim()}. Update macOS, or use provider: sbx or docker` };
    const sandboxExec = onPath('sandbox-exec', env.PATH);

    if (sandboxExec === undefined) return { ok: false, message: 'sandbox-exec, which macOS ships in /usr/bin, is not on PATH. Put /usr/bin on PATH, and start again' };
    const probe = await run(sandboxExec, ['-p', '(version 1)(allow default)', 'true'], env);

    return probe.ok ? { ok: true } : { ok: false, message: `sandbox-exec could not start a sandbox (${probe.message}). Run \`sandbox-exec -p '(version 1)(allow default)' true\` to see why, and start again` };
  },

  wrap(sandboxed) {
    const { profile, params } = profileOf(sandboxed);

    return { command: 'sandbox-exec', args: ['-p', profile, ...params.flatMap((param) => ['-D', param]), ...sandboxed.argv] };
  },
};
