import { describe, expect, it } from 'vitest';
import { formatDiagnostic, parseWorkflow } from '../workflow/parse.js';

const FILE = 'workflows/build.yaml';

function parse(content: string, file = FILE) {
  return parseWorkflow(file, content);
}

describe('parseWorkflow', () => {
  it('parses a command-only workflow in order', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Compile, then test.
steps:
  - id: compile
    command: npm run build
  - id: test
    needs: [compile]
    command: npm test
    output:
      ok: boolean
      verdict: pass | fix
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps.map((step) => step.id)).toEqual(['compile', 'test']);
    expect(result.definition.steps[1]?.output).toEqual({
      type: 'object',
      fields: {
        ok: { type: 'boolean' },
        verdict: { type: 'enum', values: ['pass', 'fix'] },
      },
    });
  });

  it('parses inline and file prompts with optional agents', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Review and summarize.
steps:
  - id: review
    prompt: Review this repository.
    agent: reviewer
  - id: summarize
    needs: [review]
    prompt_file: prompts/summary.md
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps).toEqual([
      { id: 'review', prompt: 'Review this repository.', agent: 'reviewer' },
      { id: 'summarize', needs: ['review'], promptFile: 'prompts/summary.md' },
    ]);
    expect(result.promptFileLocations['steps[1]']?.line).toBe(10);
  });

  it('names the file, line, and field when the header does not match', () => {
    const result = parse(`schemaVersion: v1
name: other
description: ''
steps: []
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fields = result.diagnostics.map((diagnostic) => diagnostic.field);
    expect(fields).toEqual(expect.arrayContaining(['schemaVersion', 'name', 'description', 'steps']));
    const name = result.diagnostics.find((diagnostic) => diagnostic.field === 'name');
    expect(name?.line).toBe(2);
    expect(name?.file).toBe(FILE);
    expect(formatDiagnostic(name!)).toBe(`${FILE}:2: field "name": name must match the file name "build"`);
  });

  it('rejects a duplicated step id at its source line', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: one
    command: echo one
  - id: one
    needs: []
    command: echo two
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const duplicate = result.diagnostics.find((diagnostic) => diagnostic.message.includes('duplicated'));
    expect(duplicate).toMatchObject({ file: FILE, line: 7, field: 'steps[1].id' });
    expect(formatDiagnostic(duplicate!)).toContain(`${FILE}:7:`);
  });

  it('rejects multiple actions and an agent on a command', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: one
    command: echo one
    prompt: Review it.
    agent: reviewer
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'steps[0]', message: 'a step has exactly one action: command, prompt, prompt_file, or workflow' }),
      expect.objectContaining({ field: 'steps[0].agent', message: 'agent is only allowed on a prompt or prompt_file step' }),
    ]));
  });

  it('rejects empty prompts and unsafe prompt_file paths', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: one
    prompt: ''
  - id: two
    needs: [one]
    prompt_file: ../secret.md
  - id: three
    needs: [two]
    prompt_file: .git/config
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'steps[0].prompt', message: 'prompt must be a non-empty string' }),
      expect.objectContaining({ field: 'steps[1].prompt_file', message: 'prompt_file must be a relative path under prompts/' }),
      expect.objectContaining({ field: 'steps[2].prompt_file', message: 'prompt_file must be a relative path under prompts/' }),
    ]));
  });

  it('names a step key this version does not know', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: one
    command: npm test
    for_each: items
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'unknown_key',
        field: 'steps[0].for_each',
        message: 'workflows/build.yaml uses `for_each`, which this teamai does not know. Update teamai.',
      }),
    ]));
  });

  it('checks a with template under a key YAML reads as a number', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Review it.
steps:
  - id: review
    prompt: Review {{ with.1 }}
    with:
      1: "{{ inputs.nope }}"
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'bad_template', field: 'steps[0].with.1', line: 8 }),
    ]));
  });

  it('reads an element of a declared array by index', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Fix the first file.
inputs:
  labels: [string]
outputs:
  first: steps.review.outputs.files[0].path
steps:
  - id: review
    command: node review.js
    output:
      files: [{ path: string }]
  - id: fix
    needs: [review]
    if: steps.review.outputs.files[0].path == 'a.ts' && inputs.labels[0] == 'bug'
    prompt: Fix {{ steps.review.outputs.files[0].path }}
`);
    expect(result).toMatchObject({ ok: true });
  });

  it('rejects an index into a value that is not declared as an array, and names the path as written', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Fix the first file.
inputs:
  title: string
outputs:
  first: steps.review.outputs.verdict[0]
steps:
  - id: review
    command: node review.js
    output:
      verdict: pass | fix
  - id: fix
    needs: [review]
    if: inputs.title[0] == 'a' || steps.review.outputs.verdict[0] == 'p'
    prompt: Fix {{ with.nope[0] }}
    with:
      refs: [a]
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic).sort()).toEqual([
      'workflows/build.yaml:15: field "steps[1].if": step "fix" if reads inputs.title[0], which is not an input the workflow declares',
      'workflows/build.yaml:15: field "steps[1].if": step "fix" if reads steps.review.outputs.verdict[0], which is not in the output step "review" declares',
      'workflows/build.yaml:16: field "steps[1].prompt": step "fix" prompt reads with.nope[0], which is not a name its with declares',
      'workflows/build.yaml:7: field "outputs.first": output "first" reads steps.review.outputs.verdict[0], which is not in the output step "review" declares',
    ]);
  });

  it('rejects a comparison of a value declared as something other than a number', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Check the review.
inputs:
  title: string
steps:
  - id: review
    command: node review.js
    output:
      verdict: pass | fix
  - id: fix
    needs: [review]
    if: steps.review.outputs.verdict < 1 || inputs.title > 0 || steps.review.outcome >= 1
    command: node fix.js
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:13: field "steps[1].if": step "fix" if compares steps.review.outputs.verdict with <, but it is not a number',
      'workflows/build.yaml:13: field "steps[1].if": step "fix" if compares inputs.title with >, but it is not a number',
      'workflows/build.yaml:13: field "steps[1].if": step "fix" if compares steps.review.outcome with >=, but it is not a number',
    ]);
  });

  it('rejects a list argument declared as something other than an array', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Check the review.
steps:
  - id: review
    command: node review.js
    output:
      verdict: pass | fix
  - id: fix
    needs: [review]
    if: any(steps.review.outputs.verdict, true)
    command: node fix.js
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:11: field "steps[1].if": step "fix" if passes steps.review.outputs.verdict to any as its list, but it is not an array',
    ]);
  });

  it('checks what a predicate reads of each element against the items the list declares', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Check the review.
steps:
  - id: review
    command: node review.js
    output:
      files: [{ path: string, lines: number, tags: [string] }]
  - id: fix
    needs: [review]
    if: any(steps.review.outputs.files, .pth == 'a') || all(steps.review.outputs.files, .path < 1) || any(steps.review.outputs.files, any(.path, true))
    command: node fix.js
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:11: field "steps[1].if": step "fix" if reads .pth, which is not in an item of steps.review.outputs.files',
      'workflows/build.yaml:11: field "steps[1].if": step "fix" if compares .path with <, but it is not a number',
      'workflows/build.yaml:11: field "steps[1].if": step "fix" if passes .path to any as its list, but it is not an array',
    ]);
  });

  it('accepts comparisons, functions and predicates that fit the declared types', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Check the review.
inputs:
  limit: number
steps:
  - id: review
    command: node review.js
    output:
      count: number
      files: [{ path: string, lines: number, tags: [string] }]
  - id: fix
    needs: [review]
    if: steps.review.outputs.count < inputs.limit && length(filter(steps.review.outputs.files, .lines >= 10)) > 0 && any(steps.review.outputs.files, any(.tags, . == 'bug') && .path != '') && all(steps.review.outputs.files, length(.tags) > 0) && steps.review.outputs.files[0].lines > 0
    command: node fix.js
`);
    expect(result).toMatchObject({ ok: true });
  });

  it('reports an if that calls a function on literals and is always false', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Never runs.
steps:
  - id: one
    if: any([], . == 1) || length([]) > 0
    command: node one.js
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'false_if', message: 'step "one" if is always false, so the step never runs' })]);
  });

  it('checks a predicate an inline step runs over an enclosing step once, in the enclosing workflow', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Check the review.
steps:
  - id: review
    command: node review.js
    output:
      files: [{ path: string }]
  - id: grp
    needs: [review]
    workflow:
      steps:
        - id: local
          command: node local.js
          output:
            n: number
        - id: use
          needs: [local]
          if: any(steps.review.outputs.files, .pth == 'a') && steps.local.outputs.n < length(steps.review.outputs.files)
          command: node use.js
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:19: field "steps[1].workflow.steps[1].if": step "use" if reads .pth, which is not in an item of steps.review.outputs.files',
    ]);
  });

  it('reports an end compared inside a predicate that the workflow a step runs does not declare', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Check the review.
inputs:
  tags: [string]
steps:
  - id: check
    workflow:
      ends:
        done: succeeded
      steps:
        - id: one
          command: node one.js
          end: done
  - id: fix
    needs: [check]
    if: any(inputs.tags, steps.check.end == 'nope')
    command: node fix.js
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: 'undeclared_end',
      message: 'step "fix" if compares steps.check.end with \'nope\', which is not an end the inline workflow of step "check" declares',
    })]);
  });

  it('rejects a YAML syntax error with the file and line', () => {
    const result = parse('schemaVersion: [\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({ file: FILE, field: '(document)' });
    expect(result.diagnostics[0]?.line).toBeGreaterThan(0);
    expect(formatDiagnostic(result.diagnostics[0]!)).toContain(`${FILE}:`);
  });
});
