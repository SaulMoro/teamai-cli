/**
 * The trial terms a generated benchmark step carries. Zod only, so types.ts, requirements.ts, store.ts and the drivers
 * import it without a cycle.
 *
 * Only a `prompt` step ever reaches a driver: teamai leases a `check` step to the driver that asked, runs it itself
 * inside `workflow next --prepare`, and leases again. Both kinds stay step markers, so `negotiate` gates them the same
 * way and teamai knows how to run what it leased.
 */
import { z } from 'zod';

/**
 * A task or arm name. It becomes one step-path segment, one expression path field and part of a branch name, so it has
 * no "." and no "[".
 */
export const BENCHMARK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const BenchmarkNameSchema = z.string().regex(BENCHMARK_NAME, 'must be letters, digits, "-" or "_", with no "."');

export const CommitSchema = z.string().regex(/^[0-9a-f]{40}$/, 'must be a full 40-character commit');

/**
 * The names a trial's setup, tool and check never see, whatever the team env or a suite declares: credentials a trial
 * could push, publish or authenticate with. Start freezes them into the plan's `withhold`, the copy every reader uses.
 */
export const TRIAL_WITHHELD_ENV = [
  'GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN', 'GL_TOKEN', 'CI_JOB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS',
] as const;

/** The asset selection of the config the run started in, as `LocalConfig` names it. */
export const TrialSelectionSchema = z.object({
  primaryRole: z.string().min(1).optional(),
  additionalRoles: z.array(z.string()),
  projects: z.array(z.string()),
  subscribedTags: z.array(z.string()).optional(),
  excludedSkills: z.array(z.string()),
}).strict();
export type TrialSelection = z.infer<typeof TrialSelectionSchema>;

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

/** The team commit an arm's trials install assets from; undefined for an arm without team assets. */
export function teamRevisionOf(team: ArmTeam): string | undefined {
  return team.kind === 'none' ? undefined : team.revision;
}

/**
 * The limits a suite's `trial` sets on every trial's prompt; an absent key is no limit. The driver that launches the
 * tool enforces them. Reaching one ends the agent's turn, and the trial's check or judge still decides it.
 */
export const TrialLimitsSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  /** Input plus output tokens, as a workflow budget counts them. */
  tokens: z.number().int().positive().optional(),
  /** Agent turns, as the tool counts them. */
  maxTurns: z.number().int().positive().optional(),
}).strict();
export type TrialLimits = z.infer<typeof TrialLimitsSchema>;

/** The limit a trial prompt's report names when one of its suite's limits ended the agent's turn. */
export const TrialLimitSchema = z.enum(['timeout', 'budget', 'max_turns']);
export type TrialLimit = z.infer<typeof TrialLimitSchema>;

/** Whether `limits` sets `limit`. */
export function setsLimit(limits: TrialLimits | undefined, limit: TrialLimit): boolean {
  switch (limit) {
    case 'timeout':
      return limits?.timeoutMs !== undefined;
    case 'budget':
      return limits?.tokens !== undefined;
    case 'max_turns':
      return limits?.maxTurns !== undefined;
    default: {
      const unhandled: never = limit;
      return unhandled;
    }
  }
}

const Shared = {
  task: BenchmarkNameSchema,
  /** Where the step's clone starts, and the commit agent configuration comes from. */
  startingCommit: CommitSchema,
};
const OfArm = {
  arm: BenchmarkNameSchema,
  /** 1-based. */
  repetition: z.number().int().positive(),
  /** 1-based position in the plan's trial list. */
  order: z.number().int().positive(),
};

export const PromptTermsSchema = z.object({
  kind: z.literal('prompt'),
  ...Shared,
  ...OfArm,
  tool: z.string().min(1),
  /** A model name the plan resolved at start, never an alias. Absent: the tool's default model. */
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  /** The team assets the trial gets: the arm's. */
  team: ArmTeamSchema,
  selection: TrialSelectionSchema,
  limits: TrialLimitsSchema.optional(),
}).strict();

/**
 * Files a check task's `check.add` writes before each run of its check, as `commit` has them: its fix, or the commit
 * start made of the files it names in the suite directory, as `kind` says.
 */
const AddedSchema = z.object({ kind: z.enum(['fix', 'suite']), commit: CommitSchema, paths: z.array(z.string().min(1)).nonempty() }).strict();
export type Added = z.infer<typeof AddedSchema>;

/** The arm's check, run by teamai in the prompt's clone. */
export const CheckTermsSchema = z.object({ kind: z.literal('check'), ...Shared, ...OfArm, protect: z.array(z.string().min(1)).nonempty(), add: z.array(AddedSchema).nonempty().optional() }).strict();

/** A check task's check, tried by teamai once on a clean clone of its starting commit before any of its trials. */
export const BaselineTermsSchema = z.object({ kind: z.literal('baseline'), ...Shared, add: z.array(AddedSchema).nonempty().optional() }).strict();

const TrialTermsSchema = z.discriminatedUnion('kind', [PromptTermsSchema, CheckTermsSchema, BaselineTermsSchema]);
export type TrialTerms = z.infer<typeof TrialTermsSchema>;
export type PromptTerms = z.infer<typeof PromptTermsSchema>;

/** The tool `can.trials` must list for this step; null for a step teamai runs itself, which needs a non-empty list. */
export function trialTool(terms: TrialTerms): string | null {
  switch (terms.kind) {
    case 'prompt':
      return terms.tool;
    case 'check':
    case 'baseline':
      return null;
    default: {
      const unhandled: never = terms;
      return unhandled;
    }
  }
}

/**
 * What `Trials.next` answers a driver for a prompt trial, in `{ data: { lease } }`: the engine's lease without
 * `workspace` and `setup`, which teamai already applied, plus `cwd`, the prepared clone. Every TypeScript driver
 * parses it at its boundary. `passthrough` keeps the engine's other fields, so a field it adds later breaks no driver.
 */
export const PreparedTrialLeaseSchema = z.object({
  run: z.string().min(1),
  step: z.string().min(1),
  attempt: z.string().min(1),
  revision: z.number().int(),
  pass: z.number().int().positive(),
  prompt: z.string(),
  trial: PromptTermsSchema,
  /** The names the tool's environment must not hold. */
  envScope: z.object({ provide: z.array(z.string()), withhold: z.array(z.string()) }),
  /** What the tool's environment must hold: the attempt marker, so a `teamai` call from the tool drives no run. */
  env: z.record(z.string()),
  /** The prepared clone: absolute, outside the member checkout, with its own `.git` and no remotes. */
  cwd: z.string().min(1),
  /** The run's deadline: a lease past it is cancelled on the next call. */
  expiresAt: z.string().optional(),
}).passthrough();
export type PreparedTrialLease = z.infer<typeof PreparedTrialLeaseSchema>;
