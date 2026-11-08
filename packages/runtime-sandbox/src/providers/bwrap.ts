import { execFile } from 'node:child_process';
import path from 'node:path';
import { onPath, type NativeSandbox, type Sandboxed } from './native.js';

// ─── bwrap: Linux namespaces, through bubblewrap ───
//
//  Each exec runs in a new user, PID, IPC and UTS namespace on an empty root that holds only what is bound into it:
//
//    bwrap --die-with-parent --new-session --unshare-all --share-net
//          --ro-bind-try /usr /usr … /etc /etc  --proc /proc --dev /dev --tmpfs /tmp
//          --bind <path> <path> …               the place, and the step's own home and temp directory
//          --ro-bind <path> <path> …            the view's git paths, this machine's PATH directories and install roots
//          --chdir <cwd> -- <argv>
//
//  Every path keeps its host path, binds made shallowest first so a deeper one wins. The member's home and other
//  repositories are not bound, so they do not exist inside. No value goes into the argv: the step's environment is the
//  process's own, which bwrap passes on. The step dies with the runtime process that started it: through the watch pipe
//  native.ts launches every exec with, and --die-with-parent.
//

/** The system directories every process needs, read only: whichever of them this distribution has. */
const SYSTEM = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/etc'];

const OPTIONS = ['--die-with-parent', '--new-session', '--unshare-all', '--share-net'];

const NOT_INSTALLED = 'bwrap is not installed here, or not on PATH. Install bubblewrap (`sudo apt install bubblewrap`, or `sudo dnf install bubblewrap`), and start again. On macOS, use provider: seatbelt';

/** bwrap's arguments for `sandboxed`, the command last. */
export function argsOf({ argv, cwd, writable, readable }: Pick<Sandboxed, 'argv' | 'cwd' | 'writable' | 'readable'>): string[] {
  const binds = [...writable.map((at) => ({ at, flag: '--bind' })), ...readable.map((at) => ({ at, flag: '--ro-bind-try' }))]
    .sort((left, right) => left.at.split(path.sep).length - right.at.split(path.sep).length);

  return [
    ...OPTIONS,
    ...SYSTEM.flatMap((at) => ['--ro-bind-try', at, at]),
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    ...binds.flatMap(({ at, flag }) => [flag, at, at]),
    '--chdir', cwd, '--', ...argv,
  ];
}

export const bwrap: NativeSandbox = {
  provider: 'bwrap',
  isolation: 'sandbox',
  isUnattended: true,

  async preflight(env) {
    const executable = onPath('bwrap', env.PATH);

    if (executable === undefined) return { ok: false, message: NOT_INSTALLED };

    // The options every exec takes, on the host's root: what AppArmor or a kernel without user namespaces refuses.
    const refused = await new Promise<string | undefined>((resolve) => {
      execFile(executable, [...OPTIONS, '--ro-bind', '/', '/', 'true'], { env, timeout: 10_000 }, (error, _stdout, stderr) => {
        resolve(error ? String(stderr).trim().split('\n').at(-1) || error.message : undefined);
      });
    });

    if (refused === undefined) return { ok: true };

    return {
      ok: false,
      message: `bwrap could not create a sandbox: ${refused}. On Ubuntu 24.04 or later, AppArmor keeps unprivileged programs from creating user namespaces: allow bwrap with an AppArmor profile (\`sudo apt install apparmor-profiles\`, then \`sudo ln -s /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/ && sudo systemctl reload apparmor\`), or turn the restriction off with \`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\`. Elsewhere, check that user namespaces are enabled (\`sysctl kernel.unprivileged_userns_clone\`). Then start again`,
    };
  },

  wrap: (sandboxed) => ({ command: 'bwrap', args: argsOf(sandboxed) }),
};
