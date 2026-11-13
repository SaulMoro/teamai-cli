/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type { ShortcutStart } from '../workflow-commands.js';

export const released: ShortcutStart = { startsAs: 'cli' };
export const inStep: ShortcutStart = { startsAs: 'step-command' };
// @ts-expect-error a shortcut starts as the CLI's or as a person's that a command step may run, never as both
export const both: ShortcutStart = { asCli: true, canRunInStep: true };
