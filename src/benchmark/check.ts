/**
 * How a task's check ended, classified once, when the check step settles. Pure. The verdict is stored on the settled
 * step (`verdict`, step-state.ts), and result.ts maps the stored value: nothing classifies a check a second time, and
 * no result is read back from a failure code.
 *
 * Its own module because result.ts (imported by records.ts) needs the verdict and trial.ts (which imports engine.ts)
 * produces it. In trial.ts it would make records.ts -> trial.ts -> engine.ts -> records.ts.
 */
import { z } from 'zod';
import type { CommandExit } from '../workflow/shell-command.js';
import type { BASELINE_OUTPUTS } from './plan.js';

/** What a check says about the repo it ran in. */
export const CheckVerdictSchema = z.discriminatedUnion('verdict', [
  z.object({ verdict: z.literal('passed') }).strict(),
  /** It ran to the end and failed: the check's own answer. */
  z.object({ verdict: z.literal('failed'), exitCode: z.number().int() }).strict(),
  /** It says nothing about the repo: it could not start, was killed, or ran out of time. */
  z.object({
    verdict: z.literal('could_not_run'),
    cause: z.enum(['not_found', 'not_executable', 'spawn_failed', 'signal', 'timeout']),
    detail: z.string().optional(),
  }).strict(),
]);
export type CheckVerdict = z.infer<typeof CheckVerdictSchema>;

const SHELL_SIGNAL_BASE = 128;
/** The highest signal number on Linux, whose real-time signals go up to 64; other POSIX systems stop below it. */
const MAX_SIGNAL = 64;

/**
 * The only check classification. Exit 0 passes. 126 (found, not executable) and 127 (not found) are the POSIX shell's
 * own answers that the command never ran; on win32, cmd.exe answers 9009 for a command it cannot find. A spawn
 * failure, a signal and a timeout could not run either, and so does an exit from 129 to 192 outside win32: that is
 * how a POSIX shell reports a command a signal killed, as 128 plus the signal's number, when it does not exec the
 * command itself. Every other exit is the check's own answer: failed.
 */
export function checkVerdict(exit: CommandExit, platform: NodeJS.Platform): CheckVerdict {
  switch (exit.kind) {
    case 'exited':
      if (exit.code === 0) return { verdict: 'passed' };
      if (exit.code === 127 || (platform === 'win32' && exit.code === 9009)) return { verdict: 'could_not_run', cause: 'not_found' };
      if (exit.code === 126) return { verdict: 'could_not_run', cause: 'not_executable' };
      if (platform !== 'win32' && exit.code > SHELL_SIGNAL_BASE && exit.code <= SHELL_SIGNAL_BASE + MAX_SIGNAL) {
        return { verdict: 'could_not_run', cause: 'signal', detail: `exit ${exit.code}` };
      }
      return { verdict: 'failed', exitCode: exit.code };
    case 'signal':
      return { verdict: 'could_not_run', cause: 'signal', detail: exit.signal };
    case 'timeout':
      return { verdict: 'could_not_run', cause: 'timeout' };
    case 'spawn_failed':
      return { verdict: 'could_not_run', cause: 'spawn_failed', detail: exit.message };
    default: {
      const unhandled: never = exit;
      return unhandled;
    }
  }
}

/**
 * A baseline's output, which its task's trials read: `fails` is what the task expects, so its trials run; `passes`
 * makes the task invalid. A check that could not run says nothing about the starting commit, and gives none.
 */
export function baselineOutput(verdict: CheckVerdict): { baseline: (typeof BASELINE_OUTPUTS)[number] } | undefined {
  switch (verdict.verdict) {
    case 'passed':
      return { baseline: 'passes' };
    case 'failed':
      return { baseline: 'fails' };
    case 'could_not_run':
      return undefined;
    default: {
      const unhandled: never = verdict;
      return unhandled;
    }
  }
}
