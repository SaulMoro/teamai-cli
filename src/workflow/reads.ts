import { isMap, type Node } from 'yaml';
import { evaluateExpression, expressionPaths, isTruthy, type Expression, type ExpressionPath } from './expression.js';
import { declaresField, isYamlNode, locate, position, scalarString, undeclaredOutput, type Child, type GraphNode, type ParseContext } from './parse-context.js';
import type { EndOutcome, OutputSchema, WorkflowDiagnostic, WorkflowStep } from './types.js';

export interface ConditionNode {
  id: string;
  field: string;
  node: Node;
  expression: Expression;
}

/** Reports an `if` that is always false, and queues what every other `if` reads for `readDiagnostics`. */
export function conditionDiagnostics({ file, lineCounter }: ParseContext, conditions: ConditionNode[], reads: ReadSite[]): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const condition of conditions) {
    const paths = expressionPaths(condition.expression);
    if (paths.length === 0 && !isTruthy(evaluateExpression(condition.expression, { steps: {} }))) {
      diagnostics.push({
        ...locate(file, lineCounter, condition.node, condition.field, `step "${condition.id}" if is always false, so the step never runs`),
        code: 'false_if',
      });
      continue;
    }
    reads.push({ id: condition.id, field: condition.field, at: position(lineCounter, condition.node), what: 'if', paths, ends: endComparisons(condition.expression) });
  }
  return diagnostics;
}

/** Where a step reads paths: its `if`, its prompt, or one `env` value. */
export interface ReadSite {
  /** The step whose ancestors the site may read: the reader, or the step that runs the inline workflow the reader is in. */
  id: string;
  /** The step that reads, when it is inside an inline workflow that `id` runs. */
  reader?: string;
  field: string;
  at: { line: number; column: number };
  /** `if`, `prompt`, `prompt_file` or `env.<NAME>`. */
  what: string;
  paths: ExpressionPath[];
  /** The names an `if` compares a step's end with. */
  ends?: Array<{ step: string; end: string }>;
  code?: WorkflowDiagnostic['code'];
}

/** What a workflow lets a step read: its ancestors through `needs`, the output each step declares, and the declared inputs. */
export interface ReadScope {
  ancestors: (id: string) => Set<string>;
  outputs: Map<string, OutputSchema | undefined>;
  /** Undefined when the inputs header is malformed, so `inputs.…` reads are not checked. */
  inputs?: OutputSchema;
  /** The workflow each workflow step runs: an inline one, or a file when a sync knows it. */
  children: Map<string, Child>;
}

export function readScope(
  needs: Map<string, string[]>,
  steps: WorkflowStep[],
  inputs: Record<string, OutputSchema> | undefined,
  children: Map<string, Child>,
): ReadScope {
  return {
    children,
    ancestors: (id) => {
      const found = new Set<string>();
      const pending = [...(needs.get(id) ?? [])];
      for (let need = pending.pop(); need !== undefined; need = pending.pop()) {
        if (found.has(need)) continue;
        found.add(need);
        pending.push(...(needs.get(need) ?? []));
      }
      return found;
    },
    outputs: new Map(steps.map((step) => [step.id, step.output])),
    ...(inputs ? { inputs: { type: 'object', fields: inputs } } : {}),
  };
}

/**
 * Diagnostics for what each `if` and template reads: only declared inputs, only steps it needs,
 * directly or through their needs, and only output fields that a step with `output` declares.
 */
export function readDiagnostics(file: string, sites: ReadSite[], scope: ReadScope): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const site of sites) {
    const at = (message: string): WorkflowDiagnostic => ({
      file, ...site.at, field: site.field, message, ...(site.code ? { code: site.code } : {}),
    });
    const readable = scope.ancestors(site.id);
    const reader = site.reader ?? site.id;
    const reported = new Set<string>();
    for (const path of site.paths) {
      if (path.root === 'inputs') {
        if (scope.inputs && !declaresField(scope.inputs, path.fields)) {
          diagnostics.push(at(`step "${reader}" ${site.what} reads inputs.${path.fields.join('.')}, which is not an input the workflow declares`));
        }
        continue;
      }
      if (!readable.has(path.step)) {
        if (!reported.has(path.step)) {
          diagnostics.push(at(site.reader === undefined
            ? `step "${reader}" ${site.what} reads steps.${path.step}, which is not a step it needs, directly or through its needs`
            : `step "${reader}" ${site.what} reads steps.${path.step}, which is not a step it needs, or one the step that runs its workflow needs, directly or through their needs`));
        }
        reported.add(path.step);
        continue;
      }
      const undeclared = undeclaredOutput(scope.children, path);
      if (undeclared) {
        diagnostics.push({ ...at(`step "${reader}" ${site.what} ${undeclared}`), code: 'undeclared_output' });
        continue;
      }
      const output = scope.outputs.get(path.step);
      if (path.field === 'outputs' && output && !declaresField(output, path.fields)) {
        diagnostics.push(at(`step "${reader}" ${site.what} reads steps.${path.step}.outputs.${path.fields.join('.')}, which is not in the output step "${path.step}" declares`));
      }
    }
    for (const { step, end } of site.ends ?? []) {
      const child = readable.has(step) ? scope.children.get(step) : undefined;
      if (!child || Object.hasOwn(child.ends ?? {}, end)) continue;
      diagnostics.push({
        ...at(`step "${reader}" ${site.what} compares steps.${step}.end with '${end}', which is not an end ${child.label} declares`),
        code: 'undeclared_end',
      });
    }
  }
  return diagnostics;
}

/**
 * Splits what steps read into reads of their own workflow, and reads of steps that are not in it.
 * `ids` is undefined for a workflow file, whose steps can read nothing outside it.
 */
export function splitReads(sites: ReadSite[], ids: Set<string> | undefined): { local: ReadSite[]; outer: ReadSite[] } {
  const inside = (path: ExpressionPath): boolean => !ids || path.root === 'inputs' || ids.has(path.step);
  const endInside = ({ step }: { step: string }): boolean => !ids || ids.has(step);
  return {
    local: sites.map((site) => ({ ...site, paths: site.paths.filter(inside), ends: site.ends?.filter(endInside) })),
    outer: sites.flatMap((site) => {
      const paths = site.paths.filter((path) => !inside(path));
      return paths.length > 0 ? [{ ...site, paths, ends: site.ends?.filter((end) => !endInside(end)) }] : [];
    }),
  };
}

/** The names an expression compares a step's end with, as in `steps.check.end == 'ready'`. */
function endComparisons(expression: Expression): Array<{ step: string; end: string }> {
  if (expression.kind === 'not') return endComparisons(expression.operand);
  if (expression.kind !== 'binary') return [];
  if (expression.operator === '&&' || expression.operator === '||') {
    return [...endComparisons(expression.left), ...endComparisons(expression.right)];
  }
  const [read, value] = expression.left.kind === 'path' ? [expression.left, expression.right] : [expression.right, expression.left];
  if (read.kind !== 'path' || read.path.root !== 'steps' || read.path.field !== 'end') return [];
  return value.kind === 'literal' && typeof value.value === 'string' ? [{ step: read.path.step, end: value.value }] : [];
}

export interface Ending {
  id: string;
  field: string;
  end: string;
  node: Node;
  /** The step has no action and only ends the workflow. */
  only: boolean;
}

/** Diagnostics that keep `end` on steps consistent with the declared `ends`. */
export function endDiagnostics(
  { file, lineCounter }: ParseContext,
  ends: Record<string, EndOutcome> | undefined,
  endsNode: unknown,
  prefix: string,
  endings: Ending[],
  graph: GraphNode[],
): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const endOnly = new Set(endings.filter((step) => step.only).map((step) => step.id));
  for (const step of graph) {
    for (const need of step.needs.filter((id) => endOnly.has(id))) {
      diagnostics.push(locate(file, lineCounter, step.node, step.field, `step "${step.id}" needs "${need}", which only ends the workflow, so "${step.id}" can never run`));
    }
  }
  for (const step of endings) {
    if (!ends) {
      diagnostics.push(locate(file, lineCounter, step.node, step.field, `step "${step.id}" ends with "${step.end}", but the workflow declares no ends`));
    } else if (!Object.hasOwn(ends, step.end)) {
      diagnostics.push(locate(file, lineCounter, step.node, step.field, `step "${step.id}" ends with "${step.end}", which is not declared in ends`));
    }
  }
  if (isMap(endsNode)) {
    for (const pair of endsNode.items) {
      const name = scalarString(isYamlNode(pair.key) ? pair.key : undefined);
      if (!name || endings.some((step) => step.end === name)) continue;
      diagnostics.push(locate(file, lineCounter, isYamlNode(pair.key) ? pair.key : endsNode, `${prefix}ends.${name}`, `end "${name}" is declared in ends, but no step ends with it`));
    }
  }
  return diagnostics;
}
