/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type { DriverCan } from '../workflow/requirements.js';

/** A driver that sets every capability, as the local driver does, decides whether it launches benchmark trials. */
export const decided: Required<DriverCan> = {
  hitl: false, workspace: [], network: false, isolation: 'none', env: true, tokens: true, max_turns: true, setup: true, trials: [],
};
// @ts-expect-error a driver that sets every capability cannot leave out which trials it launches
export const undecided: Required<DriverCan> = {
  hitl: false, workspace: [], network: false, isolation: 'none', env: true, tokens: true, max_turns: true, setup: true,
};
