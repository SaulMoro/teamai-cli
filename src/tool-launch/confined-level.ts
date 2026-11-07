/**
 * What a confined run spent, as reports and labels name it. The level it reaches (`CONFINED_LEVELS`) and what its tool
 * can do there (`ACCESS_LEVELS`) are in `@teamai/tool-core/launch`. It imports only zod, so the workflow's schemas read
 * it without loading the scorers.
 */
import { z } from 'zod';

/** What a tool stated a run cost, in its own unit. */
export const CostSchema = z.object({ amount: z.number().finite().nonnegative(), unit: z.string().min(1) });

/** What a confined run's tool reports it used, as far as it reports it. */
export const ConfinedUsageSchema = z.object({
  inputTokens: z.number().finite().nonnegative().optional(),
  outputTokens: z.number().finite().nonnegative().optional(),
  cost: CostSchema.optional(),
});

export type ConfinedUsage = z.infer<typeof ConfinedUsageSchema>;
