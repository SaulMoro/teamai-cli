import { spawnSync } from 'node:child_process';

/**
 * Runs argv[2:] as the foreground job of a new terminal (os.forkpty), writes
 * its pid to argv[1], and exits as it did.
 */
export const IN_TERMINAL = [
  'import os, sys',
  'pid, fd = os.forkpty()',
  'if pid == 0:',
  '    os.execvp(sys.argv[2], sys.argv[2:])',
  'open(sys.argv[1], "w").write(str(pid))',
  'while True:',
  '    try:',
  '        if not os.read(fd, 4096): break',
  '    except OSError:',
  '        break',
  'sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))',
].join('\n');

/** Whether python3 with os.forkpty is available to run IN_TERMINAL. */
export const hasPython = spawnSync('python3', ['-c', 'import os; os.forkpty'], { stdio: 'ignore' }).status === 0;
