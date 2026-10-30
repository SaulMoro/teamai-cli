/**
 * The team workflow an arm's trials run on each task, pinned for a plan: read at the arm's team revision with every
 * workflow it runs by name, refused when a trial could not run it unattended in its clone, and copied as workflow files
 * whose prompts all run on the arm's tool, model and effort. Each copy is keyed `<name>.<12 hex>` by a hash of the copy,
 * so two arms that run one workflow on different tools get two copies, and a copy runs the keys of its sub-workflows.
 */
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import { loadCachedWorkflow, loadWorkflowTree, syncWorkflowDefinitions, withTeamRevision } from '../workflow/cache.js';
import { stepWorkflow, type InlineWorkflow, type WorkflowStep } from '../workflow/types.js';
import type { PlannedArm } from './plan.js';

/** An arm's workflow as the plan pins it: the workflow and its sub-workflows, as copies keyed for a bundle. */
export interface PinnedArmWorkflow {
  name: string;
  /** Over the sources of the workflow and every workflow it runs, as the team revision stores them. */
  sourceHash: string;
  /** The key of the copy a trial runs. */
  key: string;
  /** Every copy, the workflow's and its sub-workflows', by key, as workflow files write them. */
  files: Record<string, Record<string, unknown>>;
}

const FileSchema = z.object({ steps: z.array(z.record(z.unknown())) }).passthrough();
type FileStep = Record<string, unknown>;

/**
 * Workflow `name` of `arm` at team commit `revision`, pinned with its copies; or why a trial could not run it: it has
 * no runnable version there, takes no input `task`, or a step of it, or of a workflow it runs, delivers, asks a person,
 * or works outside the trial's clone.
 */
export async function pinArmWorkflow(config: LocalConfig, { arm, name, revision }: { arm: PlannedArm; name: string; revision: string }): Promise<{ ok: true; pinned: PinnedArmWorkflow } | { ok: false; message: string }> {
  const runs = `Arm "${arm.name}" runs workflow "${name}"`;
  const read = await withTeamRevision(config, revision, async (at) => {
    await syncWorkflowDefinitions(at, { scopeLabel: `team commit ${revision.slice(0, 7)}` });
    const top = await loadCachedWorkflow(at, name);
    if (!top) return { missing: `${runs}, which has no runnable version at team commit ${revision.slice(0, 7)}` };
    const tree = await loadWorkflowTree(at, top);
    if ('failed' in tree) return { missing: `${runs}, which cannot run: ${tree.failed.message}` };
    const children = await Promise.all(Object.keys(tree.workflows).map(async (child) => [child, await loadCachedWorkflow(at, child)] as const));
    return { top, tree, children };
  });
  if ('failed' in read) return { ok: false, message: `${runs}, and team commit ${revision.slice(0, 7)} could not be read: ${read.failed}. Repair the team repo, or run teamai pull, and start again.` };
  if ('missing' in read) return { ok: false, message: `${read.missing}. Fix the arm's workflow, push it, run teamai pull, and start again.` };
  const { top, tree, children } = read;
  if (top.definition.inputs?.task?.type !== 'string') {
    return { ok: false, message: `${runs}, which takes no input task, the task's prompt each trial passes it. Add inputs: { task: string } to it, push it, run teamai pull, and start again.` };
  }
  const sources = new Map([[top.definition.name, top], ...children.flatMap(([child, cached]) => (cached ? [[child, cached] as const] : []))]);
  for (const [file, cached] of sources) {
    const refused = unrunnableStep(cached.definition.steps);
    if (refused !== undefined) {
      const holder = file === top.definition.name ? '' : `, which runs workflow "${file}"`;
      return { ok: false, message: `${runs}${holder}, whose step "${refused.step}" ${refused.why}. A trial runs unattended in its own clone: change the workflow, push it, run teamai pull, and start again.` };
    }
  }
  const raws = new Map<string, { raw: z.infer<typeof FileSchema>; parsed: readonly WorkflowStep[] }>();
  for (const [file, cached] of sources) {
    const raw = FileSchema.safeParse(cached.content === undefined ? undefined : parse(cached.content));
    if (!raw.success) return { ok: false, message: `${runs}, and this member's cache holds no source of workflows/${file}.yaml to copy. Run teamai pull, and start again.` };
    raws.set(file, { raw: raw.data, parsed: cached.definition.steps });
  }
  const files: Record<string, Record<string, unknown>> = {};
  const keys = new Map<string, string>();
  // Sub-workflows first, so a copy names the keys of the copies it runs; the tree has no cycle, and holds every file.
  const keyOf = (file: string): string => {
    const known = keys.get(file);
    const source = raws.get(file);
    if (known !== undefined || !source) return known ?? file;
    const { name: _name, defaults, ...header } = source.raw;
    const { model: _model, ...keptDefaults } = z.record(z.unknown()).catch({}).parse(defaults ?? {});
    const body = { ...header, ...(Object.keys(keptDefaults).length > 0 ? { defaults: keptDefaults } : {}), steps: copySteps(source.raw.steps, source.parsed, arm, keyOf) };
    const key = `${file}.${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12)}`;
    files[key] = { ...body, name: key };
    keys.set(file, key);
    return key;
  };
  return { ok: true, pinned: { name, sourceHash: tree.sourceHash, key: keyOf(top.definition.name), files } };
}

/** The first step of `steps`, inline workflows included, that a trial cannot run, and why. */
function unrunnableStep(steps: readonly WorkflowStep[], prefix = ''): { step: string; why: string } | undefined {
  for (const step of steps) {
    const id = `${prefix}${step.id}`;
    if (step.deliver !== undefined) return { step: id, why: 'delivers a pull request' };
    if (step.hitl !== undefined || step.interactive === true) return { step: id, why: 'asks a person' };
    if (step.workspace !== undefined && step.workspace !== 'continue') return { step: id, why: 'opens a workspace other than continue' };
    if (step.command !== undefined && step.workspace === undefined) return { step: id, why: 'runs a command in the member\'s checkout; give it workspace: continue' };
    const child = stepWorkflow(step);
    const inner = child?.kind === 'inline' ? unrunnableStep(child.workflow.steps, `${id}.`) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/**
 * `raw`, the steps as the file writes them, with every prompt on the arm's tool, model and effort and its prompt file's
 * text inline, and every workflow it runs by name run by its copy's key. `parsed` are the same steps as the cache holds
 * them, in the same order.
 */
function copySteps(raw: readonly FileStep[], parsed: readonly WorkflowStep[], arm: PlannedArm, keyOf: (file: string) => string): FileStep[] {
  return raw.map((step, index) => {
    const definition = parsed[index];
    if (!definition) return step;
    if (definition.prompt !== undefined) {
      const { prompt_file: _file, model: _model, ...rest } = step;
      return { ...rest, prompt: definition.prompt, tool: arm.tool, ...(arm.model ? { model: { name: arm.model, ...(arm.effort ? { effort: arm.effort } : {}) } } : {}) };
    }
    const child = stepWorkflow(definition);
    if (child?.kind === 'named') return { ...step, workflow: keyOf(child.name) };
    if (child?.kind === 'inline') return { ...step, workflow: copyInline(step.workflow, child.workflow, arm, keyOf) };
    return step;
  });
}

function copyInline(raw: unknown, parsed: InlineWorkflow, arm: PlannedArm, keyOf: (file: string) => string): unknown {
  const file = FileSchema.safeParse(raw);
  return file.success ? { ...file.data, steps: copySteps(file.data.steps, parsed.steps, arm, keyOf) } : raw;
}
