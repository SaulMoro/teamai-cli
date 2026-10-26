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
  /** The team commit the trial's assets come from: the arm's. */
  teamRevision: CommitSchema,
  selection: TrialSelectionSchema,
}).strict();

/** The files a check task's `check.add` names, written from its fix before each run of its check. */
const AddedSchema = z.object({ commit: CommitSchema, paths: z.array(z.string().min(1)).nonempty() }).strict();

/** The arm's check, run by teamai in the prompt's clone. */
export const CheckTermsSchema = z.object({ kind: z.literal('check'), ...Shared, ...OfArm, protect: z.array(z.string().min(1)).nonempty(), add: AddedSchema.optional() }).strict();

/** A check task's check, tried by teamai once on a clean clone of its starting commit before any of its trials. */
export const BaselineTermsSchema = z.object({ kind: z.literal('baseline'), ...Shared, add: AddedSchema.optional() }).strict();

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
