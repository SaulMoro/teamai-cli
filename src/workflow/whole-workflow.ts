/**
 * A `workflow:` step that goes to one runtime whole, as one attempt (case 24): a fleet member drives its sub-graph as a
 * nested run in the attempt's clone, and the owner settles the step from how that run ended. Only a step whose
 * sub-graph a member can run on its own goes whole; every other workflow step is started where it stands, as before.
 */
import { z } from 'zod';
import { DefaultWorkflows } from '../default-workflows.js';
import { JsonValueSchema, type JsonValue } from '../utils/json.js';
import { isRecord } from './expression.js';
import { mergeRequirements, type InEffect } from './requirements.js';
import { renderStrings, type TemplateContext } from './template.js';
import { isWorkflowFile, stepWorkflow, type InlineWorkflow, type WorkflowDefinition, type WorkflowStep } from './types.js';
import { TokenUsageSchema } from './step-state.js';

/** A step of a workflow that goes whole that runs something, with the `requires` in effect for it. */
export type WholeRun = { step: WorkflowStep; executor: 'command' | 'prompt'; requires: InEffect };

/**
 * Whether workflow step `step`, which runs workflow `child` with `requires` in effect, goes whole: why not, or its
 * workflow and the steps of it that run something, each with the `requires` in effect for it. The one fit rule: the
 * owner's engine leaves only such a step unexpanded and judges a runtime's offer on these steps, and a fleet member
 * judges whether it can run them before it claims the step.
 */
export function wholeFit(step: WorkflowStep, child: WorkflowDefinition | InlineWorkflow | undefined, requires: InEffect): { unfit: string } | { child: WorkflowDefinition; runs: WholeRun[] } {
  const unfit = notWhole(step, child);

  if (unfit !== undefined || child === undefined || !isWorkflowFile(child)) return { unfit: unfit ?? 'it is not a workflow file' };
  const inEffect = (inner: WorkflowStep): InEffect => mergeRequirements(requires, child.defaults?.requires, inner.requires);

  // A gate step runs nothing: the member asks its question through the attempt's record.
  const runs = child.steps.flatMap((inner): WholeRun[] => {
    if (inner.command !== undefined) return [{ step: inner, executor: 'command', requires: inEffect(inner) }];

    return inner.prompt === undefined ? [] : [{ step: inner, executor: 'prompt', requires: inEffect(inner) }];
  });

  return { child, runs };
}

/**
 * The workflow a member runs as the nested run of whole workflow step `step`: `child`, with the budget the step's
 * children spend together, the smaller of the step's own and the workflow's, as the owner's engine gives that workflow
 * (scope.ts `childScope`). A `for_each` step's budget covers all its items, which the owner counts as each item ends.
 */
export function wholeRunDefinition(step: WorkflowStep, child: WorkflowDefinition): WorkflowDefinition {
  const budgets = [step.forEach === undefined ? step.budget?.tokens : undefined, child.budget?.tokens].filter((tokens) => tokens !== undefined);

  return budgets.length === 0 ? child : { ...child, budget: { tokens: Math.min(...budgets) } };
}

/**
 * Why the workflow `child`, which step `step` runs, does not go whole, or undefined when it does: it is a workflow file
 * whose children are command, prompt or gate steps that work in the copy the step works in, with nothing a member
 * cannot run on its own: a gate the member asks the owner through the attempt's record.
 */
function notWhole(step: WorkflowStep, child: WorkflowDefinition | InlineWorkflow | undefined): string | undefined {
  // An inline workflow reads the steps and the item around it (scope.ts childScope), which a nested run has none of.
  if (child === undefined || !isWorkflowFile(child)) return 'it is not a workflow file';

  // A workflow a `from` step wrote is in no definition, so a member could not check what it runs.
  if (stepWorkflow(step)?.kind === 'from') return 'it runs the workflow a step wrote';

  if (isRecord(step.workspace)) return 'it opens a clone, the team repo or a confined directory';

  // A header's `workspace: new` opens a copy at the step only when none is around it, which the step alone does not say.
  if (step.workspace === undefined && child.workspace === 'new') return 'its workflow opens a copy of its own';

  if (child.setup !== undefined) return 'its workflow has a setup of its own';

  // An allowance its prompts end their turn at is counted by the owner's engine across them, which a nested run is not.
  if (step.onLimit === 'end_turn') return 'it gives its prompts a turn allowance (on_limit: end_turn)';
  const isShipped = DefaultWorkflows.named(child.name) !== undefined;

  for (const inner of child.steps) {
    const what = `step "${inner.id}"`;

    // A gate the member asks the owner through the attempt's record, whose person answers it.
    if (inner.command === undefined && inner.prompt === undefined && inner.hitl === undefined) return `${what} is neither a command, a prompt nor a gate`;

    if (inner.answer !== undefined || (inner.command !== undefined && isShipped)) return `${what} runs only on this machine`;

    if (stepWorkflow(inner) !== undefined) return `${what} runs a workflow`;

    if (inner.interactive) return `${what} needs a person at its tool`;

    if (inner.workspace !== undefined && inner.workspace !== 'continue' && inner.workspace !== 'read-only') return `${what} opens a copy of its own`;

    if (inner.role !== undefined) return `${what} runs with a team role`;

    if (inner.deliver !== undefined) return `${what} delivers`;
  }

  return undefined;
}

/**
 * The inputs workflow `child` starts with when step `step` runs it in `context`: its `with` rendered, over the defaults
 * the workflow declares, as the engine starts a workflow step. Or why it does not render.
 */
export function wholeInputs(step: Pick<WorkflowStep, 'with'>, child: Pick<WorkflowDefinition, 'defaults'>, context: TemplateContext): { inputs: JsonValue } | { error: string } {
  const rendered = renderStrings(step.with ?? {}, context);

  if (!rendered.ok) return { error: `with ${rendered.error.source}: ${rendered.error.message}` };
  const given = isRecord(rendered.value) ? { ...child.defaults?.inputs, ...rendered.value } : rendered.value;
  const parsed = JsonValueSchema.safeParse(given);

  return parsed.success ? { inputs: parsed.data } : { error: 'with does not render to JSON' };
}

/**
 * How a whole workflow ended where it ran, as its runtime's exec answers it on stdout: the outcome, the end it reached,
 * the workflow's outputs, and the failure that ended it.
 */
export const WholeEndSchema = z.object({
  outcome: z.enum(['succeeded', 'failed']),
  end: z.string().min(1).optional(),
  outputs: z.record(z.string(), JsonValueSchema).optional(),
  failure: z.object({ code: z.string().min(1), message: z.string() }).optional(),
  /** The tokens its steps spent, which the budgets around the step count. */
  tokens: TokenUsageSchema.optional(),
});

export type WholeEnd = z.infer<typeof WholeEndSchema>;
