/** The names, team assets, limits and check files a benchmark plan records. Zod and the commit schema only. */
import { z } from 'zod';
import { CommitSchema } from '../workflow/clone.js';

/**
 * A task or arm name. It becomes one step-path segment, one expression path field and part of a branch name, so it has
 * no "." and no "[".
 */
export const BENCHMARK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const BenchmarkNameSchema = z.string().regex(BENCHMARK_NAME, 'must be letters, digits, "-" or "_", with no "."');

/**
 * The team assets of an arm's trials, as start resolved the suite's `team`: the revision this checkout pulled, a ref of
 * the team repo at the commit it named then, the pulled revision without some skills, or none.
 */
export const ArmTeamSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pulled'), revision: CommitSchema }).strict(),
  z.object({ kind: z.literal('ref'), ref: z.string().min(1), revision: CommitSchema }).strict(),
  z.object({ kind: z.literal('without'), skills: z.array(z.string().min(1)).nonempty(), revision: CommitSchema }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
]);
export type ArmTeam = z.infer<typeof ArmTeamSchema>;

/**
 * The limits a suite's `trial` sets on every trial's prompt, as the record keeps them; an absent key is no limit. Each
 * prompt carries them under `on_limit: end_turn`, so reaching one ends the agent's turn, and the trial's check or judge
 * still decides it.
 */
export const TrialLimitsSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  /** Input plus output tokens, as a workflow budget counts them. */
  tokens: z.number().int().positive().optional(),
  /** Agent turns, as the tool counts them. */
  maxTurns: z.number().int().positive().optional(),
}).strict();
export type TrialLimits = z.infer<typeof TrialLimitsSchema>;

/**
 * Files a check task's `check.add` writes before each run of its check, as `commit` has them: its fix, or the commit
 * start made of the files it names in the suite directory, as `kind` says.
 */
export const AddedSchema = z.object({ kind: z.enum(['fix', 'suite']), commit: CommitSchema, paths: z.array(z.string().min(1)).nonempty() }).strict();
export type Added = z.infer<typeof AddedSchema>;

