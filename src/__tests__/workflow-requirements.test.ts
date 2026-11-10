import { describe, expect, it } from 'vitest';
import { DefaultWorkflows } from '../default-workflows.js';
import { parseWorkflow } from '../workflow/parse.js';
import { envAdvice, isPinnedToHost, mergeRequirements, negotiate, type DriverCan, type InEffect, type Offer } from '../workflow/requirements.js';
import { stepWorkflow, type WorkflowStep } from '../workflow/types.js';

describe('envAdvice', () => {
  it('offers env set alone for a key the team declares', () => {
    expect(envAdvice(['SIGNING_KEY'], new Set(['SIGNING_KEY'])))
      .toBe('run teamai env set SIGNING_KEY, or set it in the environment');
  });

  it('names the declare step and the value step for a key the team does not declare', () => {
    expect(envAdvice(['SIGNING_KEY'], new Set()))
      .toBe('set SIGNING_KEY in the environment, or declare it in the team repo with teamai env add SIGNING_KEY --secret and give it a value with teamai env set SIGNING_KEY');
  });

  it('keeps a mixed list to both remedies, each for its own keys', () => {
    expect(envAdvice(['SIGNING_KEY', 'API_TOKEN'], new Set(['SIGNING_KEY'])))
      .toBe('run teamai env set SIGNING_KEY, or set it in the environment; set API_TOKEN in the environment, or declare it in the team repo with teamai env add API_TOKEN --secret and give it a value with teamai env set API_TOKEN');
  });
});

describe('requires.host', () => {
  const flow = (requires: string): ReturnType<typeof parseWorkflow> => parseWorkflow('.teamai/workflows/pinned.yaml', `schemaVersion: v1alpha1
name: pinned
description: pinned
steps:
  - id: build
    command: make
    requires: ${requires}
`);

  it('parses as a step requirement, and refuses any value but true', () => {
    const parsed = flow('{ host: true }');
    expect(parsed.ok && parsed.definition.steps[0]?.requires).toEqual({ host: true });

    const refused = flow('{ host: false }');
    expect(!refused.ok && refused.diagnostics.map((diagnostic) => diagnostic.field)).toEqual(['steps[0].requires.host']);
  });

  it('holds from every level below it, as defaults.requires does for every step', () => {
    expect(mergeRequirements({ host: true }, { env: ['TOKEN'] })).toEqual({ host: true, env: ['TOKEN'] });
    expect(mergeRequirements({ env: ['TOKEN'] })).toEqual({ env: ['TOKEN'] });
  });

  it('pins a step to this host, on top of the pins teamai derives', () => {
    const step = { step: {}, executor: 'command' as const, inShippedWorkflow: false };
    expect(isPinnedToHost({ ...step, requires: {} })).toBe(false);
    expect(isPinnedToHost({ ...step, requires: { host: true } })).toBe(true);
    expect(isPinnedToHost({ ...step, executor: 'prompt', requires: { host: true } })).toBe(true);
    // The derived pin stays a floor: a shipped command step that forgets the key is still pinned.
    expect(isPinnedToHost({ ...step, inShippedWorkflow: true, requires: {} })).toBe(true);
  });

  const offer = (requires: InEffect, executor: Offer['executor']): Offer => ({
    step: 'build', executor, requires, interactive: false, hasContract: false, envKeys: [], runEnvKeys: new Set(), budgeted: false,
    unattended: false, clone: false, prepare: false, tool: executor === 'prompt' ? 'claude' : undefined,
  });
  const env = { declared: new Set<string>(), secrets: new Set<string>(), present: new Set<string>() };
  const remote: DriverCan = { exec: true, tools: ['claude'], remote: true };
  const here: DriverCan = { exec: true, tools: ['claude'] };

  it.each(['command', 'prompt'] as const)('holds a %s step that requires the host from a runtime off this machine, and grants it here', (executor) => {
    expect(negotiate(offer({ host: true }, executor), remote, {}, env)).toEqual({ kind: 'hold', missing: ['host'] });
    expect(negotiate(offer({ host: true }, executor), here, {}, env)).toMatchObject({ kind: 'grant' });
  });
});

describe('the workflows teamai ships', () => {
  /** Every command step of `steps`, with the requirements in effect on it, inline workflows included. */
  const commandSteps = (steps: readonly WorkflowStep[], around: InEffect, prefix: string): Array<{ path: string; requires: InEffect }> => steps.flatMap((step) => {
    const requires = mergeRequirements(around, step.requires);
    const child = stepWorkflow(step);
    const inner = child?.kind === 'inline' ? commandSteps(child.workflow.steps, requires, `${prefix}${step.id}.`) : [];

    return step.command === undefined ? inner : [{ path: `${prefix}${step.id}`, requires }, ...inner];
  });

  it('declare requires.host on every command step, so a team copy under another name keeps the pin teamai derives by name', () => {
    const shipped = DefaultWorkflows.all();
    const steps = shipped.flatMap(({ definition }) => [...definition.steps, ...definition.finally ?? []].flatMap((step) => commandSteps([step], mergeRequirements(definition.defaults?.requires), `${definition.name}:`)));

    expect(shipped.length).toBeGreaterThan(0);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((step) => step.requires.host !== true).map((step) => step.path)).toEqual([]);
  });
});
