/** Workflow types for the v1alpha1 local-driver subset. */

export interface DriverIdentity {
  kind: string;
  machine: string;
  workspace: string;
}

export type OutputSchema =
  | { type: 'string' }
  | { type: 'number' }
  | { type: 'boolean' }
  | { type: 'enum'; values: string[] }
  | { type: 'object'; fields: Record<string, OutputSchema> }
  | { type: 'array'; items: OutputSchema };

export interface WorkflowStep {
  id: string;
  /** Step ids this step waits for. Absent only on the first step, which is a root. */
  needs?: string[];
  /** Expression source; a false value skips the step. */
  if?: string;
  command?: string;
  /** Resolved, revision-bound prompt text. */
  prompt?: string;
  /** Original team-repo-relative source path for a cached prompt. */
  promptFile?: string;
  agent?: string;
  output?: OutputSchema;
  /** Variables a command step receives, as written; `{{ inputs.… }}` and `{{ steps.… }}` render when the step is leased. */
  env?: Record<string, string>;
  /** Name in `ends` this step finishes the workflow with when it succeeds. A step with no action only ends the workflow and is never leased. */
  end?: string;
}

export type EndOutcome = 'succeeded' | 'failed';

export interface WorkflowDefinition {
  schemaVersion: 'v1alpha1';
  name: string;
  description: string;
  /** Values `start --inputs` must pass, each typed with the output shorthand. Every input is required. */
  inputs?: Record<string, OutputSchema>;
  /** Named ends a step can finish this workflow with, each with the run outcome it gives. */
  ends?: Record<string, EndOutcome>;
  steps: WorkflowStep[];
}

export interface WorkflowDiagnostic {
  file: string;
  line: number;
  column: number;
  field: string;
  message: string;
  /**
   * The cache must not keep an older runnable copy of a file with any code.
   * `unknown_key`: a key this version does not know.
   * `missing_needs`: a step after the first has no `needs`; a copy cached under the old linear rules must not run as a graph.
   * `false_if`: an `if` is always false; an older copy would still run the step the author turned off.
   * `bad_template`: a `{{ inputs.… }}` or `{{ steps.… }}` that does not read a valid path; a prompt cached before
   *   templates existed would now render it as empty text instead of the text it was written as.
   * `dotted_name`: a step id or an `inputs` or `output` field name contains "."; no path can read it, and a
   *   step id would clash with the dotted paths that address steps inside a sub-workflow.
   */
  code?: 'unknown_key' | 'missing_needs' | 'false_if' | 'bad_template' | 'dotted_name';
}

export type StepStatus = 'pending' | 'leased' | 'succeeded' | 'failed' | 'skipped';
export type StepOutcome = 'success' | 'failed' | 'released';
export type RunStatus = 'running' | 'succeeded' | 'failed';

export interface StepLease {
  attempt: string;
  revision: number;
  driver: DriverIdentity;
}

export interface StepState {
  id: string;
  status: StepStatus;
  attempt?: string;
  lease?: StepLease;
  outcome?: StepOutcome;
  outputs?: unknown;
  exitCode?: number;
  message?: string;
  tool?: string;
  model?: string;
  session?: string;
  tokens?: TokenUsage;
  failure?: WorkflowFailure;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  cachedInput?: number;
}

export interface WorkflowFailure {
  code: string;
  message: string;
}

/** Durable run file. `revision` rejects stale reports; `definition` is the cached snapshot. */
export interface RunState {
  schemaVersion: 'v1alpha1';
  id: string;
  name: string;
  revision: number;
  status: RunStatus;
  /** The end this run reached, set when it settles. */
  end?: string;
  /** The validated `--inputs`, stored when the workflow declares inputs. */
  inputs?: Record<string, unknown>;
  sourceHash: string;
  definition: WorkflowDefinition;
  steps: StepState[];
  settledAttempts: string[];
  /** Cumulative settled-attempt count; settledAttempts is bounded at 32 for dedup. */
  settledCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CachedWorkflow {
  relativePath: string;
  sourceHash: string;
  definition: WorkflowDefinition;
  validatedAt: string;
}

export type WorkflowEnvelope =
  | { data: Record<string, unknown> }
  | { error: { code: string; message: string } };

export function isWorkflowError(
  envelope: WorkflowEnvelope,
): envelope is { error: { code: string; message: string } } {
  return 'error' in envelope;
}
