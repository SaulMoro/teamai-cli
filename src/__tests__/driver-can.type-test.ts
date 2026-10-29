/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type { DriverCan } from '../workflow/requirements.js';

/** A driver that sets every capability, as the local driver does, decides which tools and benchmark trials it launches. */
export const decided: Required<DriverCan> = {
  hitl: false, workspace: [], network: false, isolation: 'none', env: true, tokens: true, max_turns: true, setup: true, tools: [], trials: [],
};
// @ts-expect-error a driver that sets every capability cannot leave out which trials it launches
export const undecided: Required<DriverCan> = {
  hitl: false, workspace: [], network: false, isolation: 'none', env: true, tokens: true, max_turns: true, setup: true, tools: [],
};
// @ts-expect-error a driver that sets every capability cannot leave out which tools it launches a step that names one on
export const toolless: Required<DriverCan> = {
  hitl: false, workspace: [], network: false, isolation: 'none', env: true, tokens: true, max_turns: true, setup: true, trials: [],
};
