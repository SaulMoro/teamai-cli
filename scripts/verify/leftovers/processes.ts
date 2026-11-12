/**
 * Processes whose working directory or arguments name a path of the world, on each machine the world runs on: `ps` and
 * `lsof` on macOS, /proc on Linux (inside a container member too). Never a process's environment.
 */
import { captureOn, machinesOf } from '../target.js';
import { attributeLeftover, type LeftoverKind, type Observed } from '../leftovers.js';

export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
  readonly cwd: string | undefined;
}

/** `ps -axo pid=,ppid=,command=`: one process a line, its command as ps prints it. */
export function parsePs(stdout: string): Proc[] {
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);

    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '', cwd: undefined }] : [];
  });
}

/** `lsof -a -d cwd -Fpn`: `p<pid>` then `n<path>` for each process, as each pid's working directory. */
export function parseLsofCwd(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | undefined;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined) cwds.set(pid, line.slice(1));
  }

  return cwds;
}

/** One line per process from /proc: pid, ppid, cwd and the arguments joined by spaces, tab-separated. Reads no environ. */
const PROC_SCRIPT = `for d in /proc/[0-9]*; do p=\${d#/proc/}; pp=$(sed 's/.*) //' "$d/stat" 2>/dev/null | cut -d' ' -f2); [ -n "$pp" ] || continue; c=$(readlink "$d/cwd" 2>/dev/null); a=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null); printf '%s\\t%s\\t%s\\t%s\\n' "$p" "$pp" "$c" "$a"; done`;

export function parseProcLines(stdout: string): Proc[] {
  return stdout.split('\n').flatMap((line) => {
    const [pid = '', ppid = '', cwd = '', ...command] = line.split('\t');

    return /^\d+$/.test(pid) && /^\d+$/.test(ppid) ? [{ pid: Number(pid), ppid: Number(ppid), cwd: cwd || undefined, command: command.join('\t').trim() }] : [];
  });
}

/** The absolute paths a command line names, as arguments or option values. */
export function pathsNamed(command: string): string[] {
  return [...command.matchAll(/(?:^|[\s=:'"])(\/[^\s'"]+)/g)].flatMap((match) => match[1] ?? []);
}

/** `pid` and every parent of it in `procs`: the harness's own chain, never a leftover. */
export function lineageOf(pid: number, procs: readonly Proc[]): Set<number> {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const chain = new Set<number>();

  for (let at: number | undefined = pid; at !== undefined && at > 1 && !chain.has(at); at = byPid.get(at)?.ppid) chain.add(at);

  return chain;
}

export const processes: LeftoverKind = {
  title: 'world process',
  onCleanup: 'refuse',
  async observe({ world, self, others }) {
    return machinesOf(world).map((machine): Observed => {
      let procs: Proc[];
      const notes: string[] = [];

      if (machine.platform === 'darwin') {
        const listed = captureOn(world, machine.target, ['ps', '-axo', 'pid=,ppid=,command=']);

        if (listed.code !== 0) return { kind: 'not_observed', what: `processes on ${machine.label}`, why: `ps failed: ${listed.why}` };
        const cwds = captureOn(world, machine.target, ['lsof', '-a', '-d', 'cwd', '-Fpn']);

        // lsof exits 1 when one process it could not read, and still lists the rest.
        if (cwds.stdout === '') notes.push(`NOT OBSERVED: working directories on ${machine.label}, lsof listed none (${cwds.why})`);
        const cwdOf = parseLsofCwd(cwds.stdout);
        procs = parsePs(listed.stdout).map((proc) => ({ ...proc, cwd: cwdOf.get(proc.pid) }));
      } else {
        const listed = captureOn(world, machine.target, ['sh', '-c', PROC_SCRIPT]);

        if (listed.code !== 0 || listed.stdout === '') return { kind: 'not_observed', what: `processes on ${machine.label}`, why: `/proc could not be read: ${listed.why}` };
        procs = parseProcLines(listed.stdout);
      }

      const harness = machine.target.kind === 'world' ? lineageOf(process.pid, procs) : new Set<number>();

      const findings = procs.filter((proc) => !harness.has(proc.pid)).map((proc) => ({
        what: `process ${proc.pid} on ${machine.label} (${proc.command.slice(0, 160)})`,
        attribution: attributeLeftover({ paths: [...proc.cwd === undefined ? [] : [proc.cwd], ...pathsNamed(proc.command)], journals: [], runs: [], marked: false }, self, others),
      }));

      return { kind: 'observed', findings: findings.filter((finding) => finding.attribution.kind !== 'unrelated'), notes };
    });
  },
};
