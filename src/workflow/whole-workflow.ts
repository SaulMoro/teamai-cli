/**
 * A `workflow:` step that goes to one runtime whole, as one attempt (case 24): a fleet member drives its sub-graph as a
 * nested run in the attempt's clone, and the owner settles the step from how that run ended. Only a step whose
 * sub-graph a member can run on its own goes whole; every other workflow step is started where it stands, as before.
 */
import { z } from 'zod';
import { DefaultWorkflows } from '../default-workflows.js';
import { JsonValueSchema, type JsonValue } from '../utils/json.js';
import { isRecord } from './expression.js';
import { renderStrings, type TemplateContext } from './template.js';
import { isWorkflowFile, stepWorkflow, type InlineWorkflow, type WorkflowDefinition, type WorkflowStep } from './types.js';

/**
 * Why the workflow `child`, which step `step` runs, does not go whole, or undefined when it does: it is a workflow file
 * whose children are command, prompt or gate steps that work in the copy the step works in, with nothing a member
 * cannot run on its own: a gate the member asks the owner through the attempt's record.
 */
export function notWhole(step: WorkflowStep, child: WorkflowDefinition | InlineWorkflow | undefined): string | undefined {
  // An inline workflow reads the steps and the item around it (scope.ts childScope), which a nested run has none of.
  if (child === undefined || !isWorkflowFile(child)) return 'it is not a workflow file';

  if (isRecord(step.workspace)) return 'it opens a clone, the team repo or a confined directory';

  // A header's `workspace: new` opens a copy at the step only when none is around it, which the step alone does not say.
  if (step.workspace === undefined && child.workspace === 'new') return 'its workflow opens a copy of its own';

  if (child.setup !== undefined) return 'its workflow has a setup of its own';
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
});

export type WholeEnd = z.infer<typeof WholeEndSchema>;
