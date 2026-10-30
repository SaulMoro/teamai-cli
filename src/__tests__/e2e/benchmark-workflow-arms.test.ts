/**
 * Real CLI: an arm that runs a team workflow on each task instead of one prompt. The plan pins the workflow and the
 * workflows it runs at the arm's team revision, runs every prompt of them on the arm's tool and model, and the record
 * measures the trial over all of its prompt turns.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, PRODUCT_URL, said, type BenchmarkFixture, type BenchmarkFixtureOptions } from '../helpers/benchmark-fixture.js';

const SUITE = `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: prompt
  - name: flow
    workflow: fixer
repetitions: 1
timeout: 10m
`;

/** Plans on codex, which the arm's tool replaces, then runs a workflow of its own that fixes. */
const FIXER = `schemaVersion: v1alpha1
name: fixer
description: Plan the task, then fix it.
inputs: { task: string }
steps:
  - id: plan
    prompt: "Plan this: {{ inputs.task }}"
    tool: codex
  - id: fix
    needs: [plan]
    workflow: fix-once
`;

const FIX_ONCE = `schemaVersion: v1alpha1
name: fix-once
description: Fix it.
steps:
  - id: fix
    prompt: Fix it.
`;

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const RecordSchema = z.object({
  arms: z.array(z.object({ name: z.string(), tool: z.string(), workflow: z.object({ name: z.string(), sourceHash: z.string() }).optional() }).passthrough()),
  trials: z.array(z.object({
    arm: z.string(), result: z.string(), limit: z.string().optional(), durationMs: z.number().optional(), unenforced: z.array(z.string()).optional(),
    tokens: z.object({ input: z.number().optional(), output: z.number().optional(), complete: z.boolean() }).optional(),
    cost: z.object({ amount: z.number(), unit: z.string(), complete: z.boolean() }).optional(),
    agent: z.object({ tool: z.object({ name: z.string() }).passthrough() }).passthrough().optional(),
  }).passthrough()),
}).passthrough();

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

/** manifest/roles.yaml: each role receiving the workflow namespaces listed. */
function rolesReceiving(roles: Record<string, string[]>): string {
  return ['version: 1', 'roles:', ...Object.entries(roles).flatMap(([id, namespaces]) => [`  - id: ${id}`, '    resources:', '      knowledge: []', '      skills: []', `      workflows: [${namespaces.join(', ')}]`]), ''].join('\n');
}

async function fixtureWith(suite: string, workflows: Record<string, string>, { team, ...more }: Partial<BenchmarkFixtureOptions> = {}): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture({
    tool: 'fixes', sandbox: true, tools: ['claude'], suite,
    team: { ...Object.fromEntries(Object.entries(workflows).map(([name, text]) => [`workflows/${name}.yaml`, text])), ...team },
    ...more,
  });
  fixtures.push(fixture);
  return fixture;
}

describe('benchmark arm workflow', () => {
  it('runs the arm\'s workflow and its sub-workflow on the arm\'s tool and model in the trial clone, and measures every prompt turn', async () => {
    const fixture = await fixtureWith(SUITE.replace('  tool: claude\n', '  tool: claude\n  model: claude-flow-1\n'), { fixer: FIXER, 'fix-once': FIX_ONCE });

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, said(ran)).toBe(0);
    const runId = z.object({ run: z.string() }).parse(envelope(ran).data?.done).run;
    const record = RecordSchema.parse(fixture.benchmarkRecord(runId));
    expect(record.arms.map(({ name, workflow }) => ({ name, workflow }))).toEqual([
      { name: 'prompt', workflow: undefined },
      { name: 'flow', workflow: { name: 'fixer', sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/) } },
    ]);
    const flow = record.trials.find((trial) => trial.arm === 'flow');
    expect(flow).toMatchObject({
      result: 'passed',
      durationMs: expect.any(Number),
      tokens: { input: 8, output: 4, complete: true },
      cost: { amount: 0.5, unit: 'USD', complete: true },
      agent: { tool: { name: 'claude' } },
    });
    // The prompt arm's one launch, then the flow arm's two, all on claude: the flow's second continues its first's clone.
    const [prompt, plan, fix] = fixture.toolLaunches();
    expect([prompt, plan, fix].map((launch) => launch?.tool)).toEqual(['claude', 'claude', 'claude']);
    expect([prompt, plan, fix].map((launch) => launch?.model)).toEqual(['claude-flow-1', 'claude-flow-1', 'claude-flow-1']);
    const turns = z.object({ steps: z.array(z.object({ id: z.string(), tool: z.string().optional(), durationMs: z.number().optional() }).passthrough()) })
      .parse(fixture.runFile(runId)).steps.filter(({ id, tool }) => id.startsWith('trials.r1.fix.flow.') && tool !== undefined);
    expect(turns).toHaveLength(2);
    expect(flow?.durationMs).toBe(turns.reduce((total, { durationMs = 0 }) => total + durationMs, 0));
    expect([prompt?.head, plan?.head]).toEqual([fixture.startingCommit, fixture.startingCommit]);
    expect(fix?.cwd).toBe(plan?.cwd);
    expect(plan?.cwd).not.toBe(prompt?.cwd);
  }, 240_000);

  it('refuses before any run a workflow arm whose workflow asks a person, naming the arm, the workflow and the step', async () => {
    const asks = `schemaVersion: v1alpha1
name: fixer
description: Ask, then fix.
inputs: { task: string }
steps:
  - id: fix
    prompt: "{{ inputs.task }}"
  - id: ship
    needs: [fix]
    approve: Ship it?
    command: echo shipped
    workspace: continue
`;
    const fixture = await fixtureWith(SUITE, { fixer: asks });

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, said(ran)).toBe(1);
    expect(ErrorSchema.parse(envelope(ran)).error.message).toContain('Arm "flow" runs workflow "fixer", whose step "ship" asks a person');
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);

  it("skips a workflow arm's next step once its first turn spends the trial timeout, and still checks what the trial left", async () => {
    const flowOnly = SUITE.replace('  - name: prompt\n  - name: flow\n    workflow: fixer\n', '  - name: flow\n    workflow: fixer\n')
      .replace('timeout: 10m\n', 'timeout: 10m\ntrial: { timeout: 5s }\n');
    const fixture = await fixtureWith(flowOnly, { fixer: FIXER, 'fix-once': FIX_ONCE }, { tool: 'hangs' });

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, said(ran)).toBe(0);
    const runId = z.object({ run: z.string() }).parse(envelope(ran).data?.done).run;
    const { trials } = RecordSchema.parse(fixture.benchmarkRecord(runId));
    expect(trials.map(({ arm, result, limit }) => ({ arm, result, limit }))).toEqual([{ arm: 'flow', result: 'failed', limit: 'timeout' }]);
    expect(fixture.toolLaunches()).toHaveLength(1);
    const { steps } = z.object({ steps: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()) }).parse(fixture.runFile(runId));
    expect(steps.filter(({ id }) => id.startsWith('trials.r1.fix.flow.')).map(({ id, status }) => ({ id, status }))).toEqual(expect.arrayContaining([
      { id: 'trials.r1.fix.flow.workflow.plan', status: 'succeeded' },
      { id: 'trials.r1.fix.flow.workflow.fix', status: 'skipped' },
      { id: 'trials.r1.fix.flow.check', status: 'succeeded' },
    ]));
  }, 240_000);

  it('records max_turns as not enforced on a workflow arm, and a trial whose workflow failed as error', async () => {
    const flowFirst = SUITE.replace('  - name: prompt\n  - name: flow\n    workflow: fixer\n', '  - name: flow\n    workflow: fixer\n  - name: prompt\n')
      .replace('timeout: 10m\n', 'timeout: 10m\ntrial: { timeout: 5m, max_turns: 20 }\n');
    const fixture = await fixtureWith(flowFirst, { fixer: FIXER, 'fix-once': FIX_ONCE }, { tool: 'fails-first' });

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, said(ran)).toBe(0);
    const runId = z.object({ run: z.string() }).parse(envelope(ran).data?.done).run;
    const { trials } = RecordSchema.parse(fixture.benchmarkRecord(runId));
    expect(trials.map(({ arm, result, unenforced }) => ({ arm, result, unenforced }))).toEqual([
      { arm: 'flow', result: 'error', unenforced: ['max_turns'] },
      { arm: 'prompt', result: 'passed', unenforced: undefined },
    ]);
  }, 240_000);

  it('judges a criteria task on the workflow step, from the evidence of its prompt passes', async () => {
    const criteria = `schemaVersion: v1alpha1
title: Fix the answer
prompt: Make answer.js export 42.
startingCommit: {{startingCommit}}
successCriteria: answer.js exports 42.
`;
    const fixture = await fixtureWith(SUITE, { fixer: FIXER, 'fix-once': FIX_ONCE }, { tasks: { fix: criteria } });

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, said(ran)).toBe(0);
    const runId = z.object({ run: z.string() }).parse(envelope(ran).data?.done).run;
    const { trials } = RecordSchema.parse(fixture.benchmarkRecord(runId));
    expect(trials.map(({ arm, result }) => ({ arm, result }))).toEqual([{ arm: 'prompt', result: 'passed' }, { arm: 'flow', result: 'passed' }]);
    expect(fixture.judgeLaunches().map(({ diff }) => diff?.includes('module.exports = 42;'))).toEqual([true, true]);
  }, 240_000);

  it.each([
    { why: 'delivers a pull request', step: '    deliver: pr\n    workspace: new\n' },
    { why: 'opens a workspace other than continue', step: '    workspace: new\n' },
    { why: 'runs a command in the member\'s checkout; give it workspace: continue', step: '' },
  ])('refuses before any run a workflow arm whose step $why', async ({ why, step }) => {
    const unrunnable = `schemaVersion: v1alpha1
name: fixer
description: Fix, then do more.
inputs: { task: string }
steps:
  - id: fix
    prompt: "{{ inputs.task }}"
  - id: more
    needs: [fix]
${step.includes('deliver') ? '    prompt: Ship it.\n' : '    command: echo more\n'}${step}`;
    const fixture = await fixtureWith(SUITE, { fixer: unrunnable });

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, said(ran)).toBe(1);
    expect(ErrorSchema.parse(envelope(ran)).error.message).toContain(`Arm "flow" runs workflow "fixer", whose step "more" ${why}.`);
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);

  it('runs a workflow arm\'s workflow and sub-workflow from the namespace the member\'s role receives', async () => {
    const fixture = await fixtureWith(SUITE, {
      'ops/fixer': FIXER, 'ops/fix-once': FIX_ONCE,
      // Another role's fixer, which this member must not run: it takes no task.
      'other/fixer': FIX_ONCE.replace('name: fix-once', 'name: fixer'),
    }, { role: 'ops', team: { 'manifest/roles.yaml': rolesReceiving({ ops: ['ops'], other: ['other'] }) } });

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, said(ran)).toBe(0);
    const runId = z.object({ run: z.string() }).parse(envelope(ran).data?.done).run;
    const { trials } = RecordSchema.parse(fixture.benchmarkRecord(runId));
    expect(trials.map(({ arm, result }) => ({ arm, result }))).toEqual([{ arm: 'prompt', result: 'passed' }, { arm: 'flow', result: 'passed' }]);
  }, 240_000);

  it('refuses before any run a workflow arm whose workflow two namespaces of the member\'s role define', async () => {
    const fixture = await fixtureWith(SUITE, { 'ops/fixer': FIXER, 'devops/fixer': FIXER, 'fix-once': FIX_ONCE }, {
      role: 'ops', team: { 'manifest/roles.yaml': rolesReceiving({ ops: ['ops', 'devops'] }) },
    });

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, said(ran)).toBe(1);
    const { error } = ErrorSchema.parse(envelope(ran));
    expect(error.code).toBe('workflow_namespace_conflict');
    expect(error.message).toMatch(/^Arm "flow" runs workflow "fixer", which this member receives from more than one namespace: .*workflows\/(dev)?ops\/fixer\.yaml and workflows\/(dev)?ops\/fixer\.yaml/);
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);

  it('refuses before any run a workflow arm whose workflow takes no input task', async () => {
    const fixture = await fixtureWith(SUITE, { fixer: FIX_ONCE.replace('name: fix-once', 'name: fixer') });

    const ran = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(ran.code, said(ran)).toBe(1);
    expect(ErrorSchema.parse(envelope(ran)).error.message).toContain('Arm "flow" runs workflow "fixer", which takes no input task');
    expect(fixture.runIds()).toEqual([]);
  }, 120_000);
});
