/**
 * The clone place a step opens with `workspace: { clone: … }`: a fresh clone of `commit`, with its own git data and no
 * remotes, and the team assets `team` names installed under a HOME of its own. Zod only, so types.ts, parse.ts and the
 * place import it without a cycle.
 */
import { z } from 'zod';

export const CommitSchema = z.string().regex(/^[0-9a-f]{40}$/, 'must be a full 40-character commit');

/** The asset selection a team install delivers, as `LocalConfig` names it, frozen when the place was written. */
export const TeamSelectionSchema = z.object({
  primaryRole: z.string().min(1).optional(),
  additionalRoles: z.array(z.string()),
  projects: z.array(z.string()),
  subscribedTags: z.array(z.string()).optional(),
  excludedSkills: z.array(z.string()),
}).strict();
export type TeamSelection = z.infer<typeof TeamSelectionSchema>;

/**
 * Which team assets the clone gets at `revision`: the revision as pulled, the revision a ref named (the ref is only its
 * name), or the revision without some skills. `none` installs nothing.
 */
const TreatmentSchema = z.union([
  z.literal('pulled'),
  z.object({ without: z.array(z.string().min(1)).nonempty() }).strict(),
  z.string().min(1).refine((ref) => ref !== 'none', 'none takes no revision or selection'),
]);

export const CloneTeamSchema = z.union([
  z.object({ treatment: z.literal('none') }).strict(),
  z.object({ revision: CommitSchema, selection: TeamSelectionSchema, treatment: TreatmentSchema }).strict(),
]);
export type CloneTeam = z.infer<typeof CloneTeamSchema>;
/** A team the clone gets assets of: any treatment but `none`. */
export type InstalledTeam = Extract<CloneTeam, { revision: string }>;

/**
 * `commit` is where the clone starts. `repo` keys the commit cache it may be fetched from, never a URL: preparation is
 * offline, from the run's checkout or that cache.
 */
export const ClonePlaceSchema = z.object({
  commit: CommitSchema,
  repo: z.string().min(1).optional(),
  team: CloneTeamSchema,
}).strict();
export type ClonePlace = z.infer<typeof ClonePlaceSchema>;

/** The skills the install leaves out: the selection's own, and those the treatment runs without. */
export function excludedSkillsOf(team: InstalledTeam): string[] {
  const without = typeof team.treatment === 'object' ? team.treatment.without : [];
  return [...new Set([...team.selection.excludedSkills, ...without])].sort();
}
