import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from 'yaml';

function isYamlNode(value: unknown): value is Node {
  return !!value && typeof value === 'object' && 'range' in value;
}
import type { EndOutcome, OutputSchema, WorkflowDefinition, WorkflowDiagnostic, WorkflowStep } from './types.js';

const HEADER_KEYS = new Set(['schemaVersion', 'name', 'description', 'ends', 'steps']);
const STEP_KEYS = new Set(['id', 'needs', 'command', 'prompt', 'prompt_file', 'agent', 'output', 'end']);
/** Keys a step without an action may carry. */
const END_ONLY_KEYS = new Set(['id', 'needs', 'if', 'end']);
const TYPE_NAMES = new Set(['string', 'number', 'boolean']);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function formatDiagnostic(diagnostic: WorkflowDiagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}: field "${diagnostic.field}": ${diagnostic.message}`;
}

function unknownKey(file: string, lineCounter: LineCounter, node: Node | null | undefined, field: string, key: string): WorkflowDiagnostic {
  return {
    ...locate(file, lineCounter, node, field, `${file} uses \`${key}\`, which this teamai does not know. Update teamai.`),
    code: 'unknown_key',
  };
}

function locate(file: string, lineCounter: LineCounter, node: Node | null | undefined, field: string, message: string): WorkflowDiagnostic {
  let line = 1;
  let column = 1;
  const offset = node?.range?.[0];
  if (typeof offset === 'number') {
    const pos = lineCounter.linePos(offset);
    line = pos.line;
    column = pos.col;
  }
  return { file, line, column, field, message };
}

function scalarString(node: Node | null | undefined): string | undefined {
  if (!isScalar(node) || typeof node.value !== 'string') return undefined;
  return node.value;
}

function parseOutput(
  node: Node,
  field: string,
  file: string,
  lineCounter: LineCounter,
  diagnostics: WorkflowDiagnostic[],
): OutputSchema | undefined {
  if (isScalar(node)) {
    if (typeof node.value !== 'string') {
      diagnostics.push(locate(file, lineCounter, node, field, 'output shorthand must be string, number, boolean, a literal union, an object, or an array'));
      return undefined;
    }
    const parts = node.value.split('|').map((part) => part.trim()).filter((part) => part.length > 0);
    if (parts.length === 1 && TYPE_NAMES.has(parts[0])) {
      return { type: parts[0] as 'string' | 'number' | 'boolean' };
    }
    if (parts.length >= 2 && parts.every((part) => TOKEN.test(part) && !TYPE_NAMES.has(part))) {
      return { type: 'enum', values: parts };
    }
    diagnostics.push(locate(file, lineCounter, node, field, `unknown output type "${node.value}"`));
    return undefined;
  }
  if (isSeq(node)) {
    if (node.items.length !== 1) {
      diagnostics.push(locate(file, lineCounter, node, field, 'an array shorthand has exactly one item type'));
      return undefined;
    }
    const item = node.items[0];
    if (!isYamlNode(item)) {
      diagnostics.push(locate(file, lineCounter, node, field, 'an array shorthand has exactly one item type'));
      return undefined;
    }
    const items = parseOutput(item, `${field}[]`, file, lineCounter, diagnostics);
    return items ? { type: 'array', items } : undefined;
  }
  if (isMap(node)) {
    if (node.items.length === 0) {
      diagnostics.push(locate(file, lineCounter, node, field, 'an object shorthand needs at least one field'));
      return undefined;
    }
    const fields: Record<string, OutputSchema> = {};
    for (const pair of node.items) {
      const keyNode = isYamlNode(pair.key) ? pair.key : undefined;
      const valueNode = isYamlNode(pair.value) ? pair.value : undefined;
      const key = scalarString(keyNode);
      if (!key || !TOKEN.test(key) || !valueNode) {
        diagnostics.push(locate(file, lineCounter, keyNode ?? node, field, 'output field names must be tokens'));
        continue;
      }
      const child = parseOutput(valueNode, `${field}.${key}`, file, lineCounter, diagnostics);
      if (child) fields[key] = child;
    }
    return Object.keys(fields).length === node.items.length ? { type: 'object', fields } : undefined;
  }
  diagnostics.push(locate(file, lineCounter, node, field, 'output shorthand must be string, number, boolean, a literal union, an object, or an array'));
  return undefined;
}

/**
 * Parse one workflow file. A failure is a list of diagnostics; it does not throw,
 * so one bad file cannot stop the rest of a sync.
 */
export function parseWorkflow(file: string, content: string): {
  ok: true;
  definition: WorkflowDefinition;
  promptFileLocations: Record<number, { line: number; column: number }>;
} | { ok: false; diagnostics: WorkflowDiagnostic[] } {
  const diagnostics: WorkflowDiagnostic[] = [];
  const promptFileLocations: Record<number, { line: number; column: number }> = {};
  if (content.trim() === '') {
    return { ok: false, diagnostics: [{ file, line: 1, column: 1, field: '(root)', message: 'workflow file is empty' }] };
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(content, { lineCounter, uniqueKeys: true });
  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      const pos = lineCounter.linePos(error.pos[0] ?? 0);
      diagnostics.push({
        file,
        line: pos.line,
        column: pos.col,
        field: '(document)',
        message: error.message,
      });
    }
    return { ok: false, diagnostics };
  }

  const root = doc.contents;
  if (!isMap(root)) {
    return { ok: false, diagnostics: [locate(file, lineCounter, root, '(root)', 'workflow must be a YAML mapping')] };
  }

  for (const pair of root.items) {
    const key = scalarString(pair.key);
    if (!key || !HEADER_KEYS.has(key)) {
      diagnostics.push(unknownKey(file, lineCounter, pair.key ?? root, key ?? '(root)', key ?? '(root)'));
    }
  }

  const schemaPair = root.items.find((pair) => scalarString(pair.key) === 'schemaVersion');
  const schemaValue = scalarString(schemaPair?.value);
  if (schemaValue !== 'v1alpha1') {
    diagnostics.push(locate(file, lineCounter, schemaPair?.value ?? schemaPair?.key ?? root, 'schemaVersion', 'schemaVersion must be v1alpha1'));
  }

  const namePair = root.items.find((pair) => scalarString(pair.key) === 'name');
  const name = scalarString(namePair?.value);
  const fileName = file.slice(file.lastIndexOf('/') + 1).replace(/\.yaml$/, '');
  if (!name || !TOKEN.test(name)) {
    diagnostics.push(locate(file, lineCounter, namePair?.value ?? namePair?.key ?? root, 'name', 'name must be a non-empty token'));
  } else if (name !== fileName) {
    diagnostics.push(locate(file, lineCounter, namePair?.value ?? namePair?.key ?? root, 'name', `name must match the file name "${fileName}"`));
  }

  const descriptionPair = root.items.find((pair) => scalarString(pair.key) === 'description');
  const description = scalarString(descriptionPair?.value)?.trim();
  if (!description) {
    diagnostics.push(locate(file, lineCounter, descriptionPair?.value ?? descriptionPair?.key ?? root, 'description', 'description must be a non-empty string'));
  }

  const endsPair = root.items.find((pair) => scalarString(pair.key) === 'ends');
  const ends = endsPair ? parseEnds(endsPair.value ?? endsPair.key, file, lineCounter, diagnostics) : undefined;

  const stepsPair = root.items.find((pair) => scalarString(pair.key) === 'steps');
  const stepsNode = stepsPair?.value;
  const steps: WorkflowStep[] = [];
  if (!isSeq(stepsNode) || stepsNode.items.length === 0) {
    diagnostics.push(locate(file, lineCounter, stepsNode ?? stepsPair?.key ?? root, 'steps', 'steps must be a non-empty list'));
  } else {
    const seen = new Set<string>();
    const graph: GraphNode[] = [];
    const endings: Ending[] = [];
    stepsNode.items.forEach((item, index) => {
      const field = `steps[${index}]`;
      if (!isMap(item)) {
        diagnostics.push(locate(file, lineCounter, item, field, 'a step must be a mapping with exactly one action'));
        return;
      }
      for (const pair of item.items) {
        const key = scalarString(pair.key);
        if (!key || !STEP_KEYS.has(key)) {
          diagnostics.push(unknownKey(file, lineCounter, pair.key ?? item, `${field}.${key ?? 'key'}`, key ?? 'key'));
        }
      }
      const idPair = item.items.find((pair) => scalarString(pair.key) === 'id');
      const id = scalarString(idPair?.value)?.trim();
      if (!id || !TOKEN.test(id)) {
        diagnostics.push(locate(file, lineCounter, idPair?.value ?? idPair?.key ?? item, `${field}.id`, 'id must be a non-empty token'));
      } else if (seen.has(id)) {
        diagnostics.push(locate(file, lineCounter, idPair?.value ?? item, `${field}.id`, `step id "${id}" is duplicated`));
      } else {
        seen.add(id);
      }
      const label = id ? `step "${id}"` : field;
      const needsPair = item.items.find((pair) => scalarString(pair.key) === 'needs');
      let needs: string[] | undefined;
      if (needsPair) {
        const values = isSeq(needsPair.value) ? needsPair.value.items.map((need) => scalarString(isYamlNode(need) ? need : undefined)) : [];
        if (!isSeq(needsPair.value) || values.some((need) => !need || !TOKEN.test(need))) {
          diagnostics.push(locate(file, lineCounter, needsPair.value ?? needsPair.key ?? item, `${field}.needs`, `${label} needs must be a list of step ids`));
        } else {
          needs = values as string[];
          if (id && TOKEN.test(id)) graph.push({ id, field: `${field}.needs`, needs, node: needsPair.value as Node });
        }
      } else if (index > 0) {
        diagnostics.push({
          ...locate(file, lineCounter, item, `${field}.needs`, `${label} must declare needs; use needs: [] for another root`),
          code: 'missing_needs',
        });
      }
      const commandPair = item.items.find((pair) => scalarString(pair.key) === 'command');
      const command = scalarString(commandPair?.value);
      const promptPair = item.items.find((pair) => scalarString(pair.key) === 'prompt');
      const prompt = scalarString(promptPair?.value);
      const promptFilePair = item.items.find((pair) => scalarString(pair.key) === 'prompt_file');
      const promptFile = scalarString(promptFilePair?.value);
      const actions = [commandPair, promptPair, promptFilePair].filter(Boolean);
      const endPair = item.items.find((pair) => scalarString(pair.key) === 'end');
      const end = scalarString(endPair?.value)?.trim();
      if (endPair && (!end || !TOKEN.test(end))) {
        diagnostics.push(locate(file, lineCounter, endPair.value ?? endPair.key ?? item, `${field}.end`, `${label} end must be a name from ends`));
      } else if (endPair && end && id && TOKEN.test(id)) {
        endings.push({ id, field: `${field}.end`, end, node: endPair.value as Node, only: actions.length === 0 });
      }
      if (endPair && actions.length === 0) {
        for (const pair of item.items) {
          const key = scalarString(pair.key);
          if (!key || !STEP_KEYS.has(key) || END_ONLY_KEYS.has(key)) continue;
          diagnostics.push(locate(file, lineCounter, pair.key as Node, `${field}.${key}`, `${label} has no action, so it carries only id, needs, if, and end`));
        }
      }
      if (actions.length > 1 || (actions.length === 0 && !endPair)) {
        diagnostics.push(locate(file, lineCounter, item, field, 'a step has exactly one action: command, prompt, or prompt_file'));
      }
      if (commandPair && (command === undefined || command.trim() === '')) {
        diagnostics.push(locate(file, lineCounter, commandPair?.value ?? commandPair?.key ?? item, `${field}.command`, 'command must be a non-empty string'));
      }
      if (promptPair && (prompt === undefined || prompt.trim() === '')) {
        diagnostics.push(locate(file, lineCounter, promptPair.value ?? promptPair.key ?? item, `${field}.prompt`, 'prompt must be a non-empty string'));
      }
      if (promptFilePair) {
        if (!isPromptFilePath(promptFile)) {
          diagnostics.push(locate(file, lineCounter, promptFilePair.value ?? promptFilePair.key ?? item, `${field}.prompt_file`, 'prompt_file must be a relative path under prompts/'));
        } else if (isYamlNode(promptFilePair.value)) {
          const position = locate(file, lineCounter, promptFilePair.value, `${field}.prompt_file`, '');
          promptFileLocations[index] = { line: position.line, column: position.column };
        }
      }
      const agentPair = item.items.find((pair) => scalarString(pair.key) === 'agent');
      const agent = scalarString(agentPair?.value)?.trim();
      if (agentPair && (!agent || !TOKEN.test(agent))) {
        diagnostics.push(locate(file, lineCounter, agentPair.value ?? agentPair.key ?? item, `${field}.agent`, 'agent must be a non-empty token'));
      } else if (agentPair && commandPair) {
        diagnostics.push(locate(file, lineCounter, agentPair.key ?? item, `${field}.agent`, 'agent is only allowed on a prompt or prompt_file step'));
      }
      let output: OutputSchema | undefined;
      const outputPair = item.items.find((pair) => scalarString(pair.key) === 'output');
      if (outputPair?.value) {
        output = parseOutput(outputPair.value, `${field}.output`, file, lineCounter, diagnostics);
      } else if (outputPair) {
        diagnostics.push(locate(file, lineCounter, outputPair.key ?? item, `${field}.output`, 'output must be a shorthand type'));
      }
      if (id && TOKEN.test(id) && (actions.length === 1 || endPair) && !diagnostics.some((d) => d.field === field || d.field.startsWith(`${field}.`))) {
        steps.push({
          id,
          ...(needs ? { needs } : {}),
          ...(command ? { command } : {}),
          ...(prompt ? { prompt } : {}),
          ...(promptFile ? { promptFile } : {}),
          ...(agent ? { agent } : {}),
          ...(output ? { output } : {}),
          ...(end ? { end } : {}),
        });
      }
    });
    diagnostics.push(...graphDiagnostics(file, lineCounter, graph, seen));
    // A malformed ends header is already reported; checking steps against it would only add noise.
    if (!endsPair || ends) diagnostics.push(...endDiagnostics(file, lineCounter, ends, endsPair?.value, endings, graph));
  }

  if (diagnostics.length > 0 || !name || !description) return { ok: false, diagnostics };
  return {
    ok: true,
    definition: { schemaVersion: 'v1alpha1', name, description, ...(ends ? { ends } : {}), steps },
    promptFileLocations,
  };
}

function parseEnds(
  node: Node | null | undefined,
  file: string,
  lineCounter: LineCounter,
  diagnostics: WorkflowDiagnostic[],
): Record<string, EndOutcome> | undefined {
  if (!isMap(node) || node.items.length === 0) {
    diagnostics.push(locate(file, lineCounter, node, 'ends', 'ends must map each end name to succeeded or failed'));
    return undefined;
  }
  const ends: Record<string, EndOutcome> = {};
  for (const pair of node.items) {
    const name = scalarString(isYamlNode(pair.key) ? pair.key : undefined);
    const outcome = scalarString(isYamlNode(pair.value) ? pair.value : undefined);
    if (!name || !TOKEN.test(name) || (outcome !== 'succeeded' && outcome !== 'failed')) {
      const at = isYamlNode(pair.value) ? pair.value : isYamlNode(pair.key) ? pair.key : node;
      diagnostics.push(locate(file, lineCounter, at, `ends.${name ?? 'key'}`, 'ends must map each end name to succeeded or failed'));
      continue;
    }
    ends[name] = outcome;
  }
  return Object.keys(ends).length === node.items.length ? ends : undefined;
}

interface GraphNode {
  id: string;
  field: string;
  needs: string[];
  node: Node;
}

/** Diagnostics for the `needs` graph: ids that name no step, and cycles reported at their first declared step. */
function graphDiagnostics(file: string, lineCounter: LineCounter, graph: GraphNode[], ids: Set<string>): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const step of graph) {
    for (const need of step.needs) {
      if (!ids.has(need)) {
        diagnostics.push(locate(file, lineCounter, step.node, step.field, `step "${step.id}" needs "${need}", which is not a step in this workflow`));
      }
    }
  }

  const byId = new Map(graph.map((step) => [step.id, step]));
  const order = new Map(graph.map((step, index) => [step.id, index]));
  const visited = new Map<string, 'open' | 'closed'>();
  const path: string[] = [];
  const cycles: string[][] = [];
  const visit = (id: string): void => {
    visited.set(id, 'open');
    path.push(id);
    for (const need of byId.get(id)?.needs ?? []) {
      if (visited.get(need) === 'open') cycles.push(path.slice(path.indexOf(need)));
      else if (!visited.has(need) && byId.has(need)) visit(need);
    }
    path.pop();
    visited.set(id, 'closed');
  };
  for (const step of graph) if (!visited.has(step.id)) visit(step.id);

  const first = (cycle: string[]): number => Math.min(...cycle.map((id) => order.get(id) ?? 0));
  for (const cycle of cycles.sort((left, right) => first(left) - first(right))) {
    const start = cycle.findIndex((id) => order.get(id) === first(cycle));
    const ids = [...cycle.slice(start), ...cycle.slice(0, start)];
    const step = byId.get(ids[0] ?? '');
    if (!step) continue;
    diagnostics.push(locate(file, lineCounter, step.node, step.field, `step "${step.id}" is in a needs cycle: ${[...ids, step.id].join(' -> ')}`));
  }
  return diagnostics;
}

interface Ending {
  id: string;
  field: string;
  end: string;
  node: Node;
  /** The step has no action and only ends the workflow. */
  only: boolean;
}

/** Diagnostics that keep `end` on steps consistent with the declared `ends`. */
function endDiagnostics(
  file: string,
  lineCounter: LineCounter,
  ends: Record<string, EndOutcome> | undefined,
  endsNode: unknown,
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
      diagnostics.push(locate(file, lineCounter, isYamlNode(pair.key) ? pair.key : endsNode, `ends.${name}`, `end "${name}" is declared in ends, but no step ends with it`));
    }
  }
  return diagnostics;
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function isPromptFilePath(value: string | undefined): value is string {
  if (!value || value.trim() === '' || pathIsAbsolute(value)) return false;
  const segments = value.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
  return segments.length >= 2 && segments[0] === 'prompts' && !segments.includes('..');
}
