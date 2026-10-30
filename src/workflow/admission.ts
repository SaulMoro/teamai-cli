/**
 * Admission: what a run takes in before it runs a workflow. `startRun` admits a workflow from the cache; a `from` step's
 * producer gets its workflow output admitted when it reports. Either way the run gets the definitions it runs, the
 * scorers their steps list pinned, and no secret value, and its delivery is checked.
 */
import { secretKey } from '../env-resolution.js';
import { pinScorers } from '../scorers/cache.js';
import type { PinnedScorer } from '../scorers/pin.js';
import type { LocalConfig } from '../types.js';
import { redactJson } from '../utils/redact.js';
import { stepWorkflow, type RunState, type WorkflowDefinition, type WorkflowFailure, type WorkflowStep } from './types.js';
import { deliveryProblem } from './workspace.js';

/** A workflow admitted for a run: its definition, the workflows it runs by name, and the scorers their steps list, pinned. */
export interface Admitted {
  definition: WorkflowDefinition;
  workflows: Record<string, WorkflowDefinition>;
  scorers: Record<string, PinnedScorer>;
}

/** What is admitted: a workflow the cache holds, with every workflow it runs. */
export type Candidate = { kind: 'cached'; definition: WorkflowDefinition; workflows: Record<string, WorkflowDefinition> };

/**
 * Admits `candidate` for a run whose workspaces start from `base`. The scorers its steps list are pinned as the member's
 * cache holds them; a name without a valid version is left out. Refused when it cannot deliver what its steps declare, or
 * when a value it pins holds one of `secrets`, which a run never stores.
 */
export async function admitWorkflow(
  config: LocalConfig, candidate: Candidate, { secrets, base }: { secrets: Record<string, string>; base?: RunState['base'] },
): Promise<{ admitted: Admitted } | { failure: WorkflowFailure }> {
  const { definition, workflows } = candidate;
  const undeliverable = deliveryProblem(definition, workflows, base);
  if (undeliverable) return { failure: undeliverable };
  const scorers = await pinScorers(config, listedScorers([definition, ...Object.values(workflows)]));
  const pinned = Object.fromEntries([
    ...[definition, ...Object.values(workflows)].map((pinnedDefinition) => [`workflows/${pinnedDefinition.name}.yaml`, pinnedDefinition]),
    ...Object.entries(scorers).map(([scorerName, scorer]) => [`scorer ${scorerName}`, scorer]),
  ]);
  for (const [label, value] of Object.entries(pinned)) {
    const held = heldSecret(value, secrets);
    const secret = held && secretKey(held);
    if (secret) {
      return { failure: { code: 'invalid_inputs', message: `${label} holds the value of ${secret}, a secret on this machine, which a run never stores. Replace the value with requires.env: [${secret}], then pull again.` } };
    }
  }
  return { admitted: { definition, workflows, scorers } };
}

/** The name of the first of `secrets` whose value `value` holds, as the run file would mask it. */
export function heldSecret(value: unknown, secrets: Record<string, string>): string | undefined {
  const text = JSON.stringify(value);
  return Object.entries(secrets).find(([name, secret]) => JSON.stringify(redactJson(value, { [name]: secret })) !== text)?.[0];
}

/** Every scorer name a step of `definitions` lists, inline workflows included. */
function listedScorers(definitions: ReadonlyArray<{ steps: WorkflowStep[] }>): string[] {
  return definitions.flatMap((definition) => definition.steps.flatMap((step) => {
    const child = stepWorkflow(step);
    return [...step.scorers?.names ?? [], ...(child?.kind === 'inline' ? listedScorers([child.workflow]) : [])];
  }));
}
