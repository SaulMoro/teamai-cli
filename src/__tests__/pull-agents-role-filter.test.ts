import { describe, it, expect } from 'vitest';
import type { ResourceItem } from '../types.js';
import { describeDeliveryConflict, filterAgentsByNamespaces } from '../resources/desired.js';

/** The delivered agents, failing the test on a collision. */
function delivered(result: ReturnType<typeof filterAgentsByNamespaces>): ResourceItem[] {
  if (result.kind === 'conflict') throw new Error(`unexpected collision: ${describeDeliveryConflict(result)}`);
  return result.items;
}

/** The collision message, failing the test when the agents resolved. */
function collision(result: ReturnType<typeof filterAgentsByNamespaces>): string {
  if (result.kind !== 'conflict') throw new Error('expected a collision');
  return describeDeliveryConflict(result);
}

describe('filterAgentsByNamespaces', () => {
  function makeAgent(name: string, namespace?: string): ResourceItem {
    const dir = namespace ? `agents/${namespace}` : 'agents';
    return {
      name,
      type: 'agents',
      sourcePath: `/fake/repo/${dir}/${name}.yaml`,
      relativePath: `${dir}/${name}.yaml`,
      ...(namespace ? { namespace } : {}),
    };
  }

  it('includes agents whose namespace is active and excludes the rest', () => {
    const agents = [
      makeAgent('vr-reviewer', 'frontend'),
      makeAgent('tf-reviewer', 'devops'),
      makeAgent('release-notes', 'pm'),
    ];

    const result = delivered(filterAgentsByNamespaces(agents, ['common', 'frontend', 'pm']));

    expect(result.map((a) => a.name)).toEqual(['vr-reviewer', 'release-notes']);
  });

  it('always includes root-level agents', () => {
    const agents = [
      makeAgent('teamai-helper'),
      makeAgent('tf-reviewer', 'devops'),
    ];

    const result = delivered(filterAgentsByNamespaces(agents, ['frontend']));

    expect(result.map((a) => a.name)).toEqual(['teamai-helper']);
  });

  it('returns every agent when namespaces is null (no role configured)', () => {
    const agents = [
      makeAgent('teamai-helper'),
      makeAgent('vr-reviewer', 'frontend'),
      makeAgent('tf-reviewer', 'devops'),
    ];

    expect(delivered(filterAgentsByNamespaces(agents, null))).toEqual(agents);
  });

  it('throws when two active namespaces deploy the same agent name', () => {
    const agents = [
      makeAgent('reviewer', 'frontend'),
      makeAgent('reviewer', 'devops'),
    ];

    expect(collision(filterAgentsByNamespaces(agents, ['frontend', 'devops']))).toMatch(/Duplicate agent "reviewer" found in active namespaces "frontend" and "devops"/);
  });

  it('delivers the active namespace agent in place of a root agent of the same stem', () => {
    const agents = [
      makeAgent('reviewer'),
      makeAgent('reviewer', 'frontend'),
      makeAgent('helper'),
    ];

    const result = delivered(filterAgentsByNamespaces(agents, ['frontend']));

    expect(result.map((a) => a.relativePath)).toEqual(['agents/frontend/reviewer.yaml', 'agents/helper.yaml']);
  });

  it('delivers the root agent again once the namespace that replaced it is inactive', () => {
    const agents = [
      makeAgent('reviewer'),
      makeAgent('reviewer', 'frontend'),
    ];

    const result = delivered(filterAgentsByNamespaces(agents, ['common']));

    expect(result.map((a) => a.relativePath)).toEqual(['agents/reviewer.yaml']);
  });

  it('names both namespaces when two active ones replace the same root agent', () => {
    const agents = [
      makeAgent('reviewer'),
      makeAgent('reviewer', 'devops'),
      makeAgent('reviewer', 'frontend'),
    ];

    expect(collision(filterAgentsByNamespaces(agents, ['frontend', 'devops']))).toMatch(/Duplicate agent "reviewer" found in active namespaces "frontend" and "devops"/);
  });

  it('still rejects a root agent and a namespace agent of one stem when no role is configured', () => {
    // Legacy mode delivers every namespace, so nothing says which one replaces the root.
    const agents = [
      makeAgent('reviewer'),
      makeAgent('reviewer', 'frontend'),
    ];

    expect(collision(filterAgentsByNamespaces(agents, null))).toMatch(/Duplicate agent "reviewer" found in active namespaces "\(root\)" and "frontend"/);
  });

  it('does not report a duplicate when the colliding namespace is inactive', () => {
    const agents = [
      makeAgent('reviewer', 'frontend'),
      makeAgent('reviewer', 'devops'),
    ];

    const result = delivered(filterAgentsByNamespaces(agents, ['frontend']));

    expect(result.map((a) => a.namespace)).toEqual(['frontend']);
  });

  it('still reports a duplicate when no role is configured, because destinations collide', () => {
    const agents = [
      makeAgent('reviewer', 'frontend'),
      makeAgent('reviewer', 'devops'),
    ];

    expect(collision(filterAgentsByNamespaces(agents, null))).toMatch(/Duplicate agent "reviewer"/);
  });

  /**
   * An agent published with --role/--project lives in a namespace this
   * directory need not activate, and push lets the author keep editing it
   * through the placement record. Pull has to deliver it for the same reason:
   * otherwise the local copy never tracks the team file and the next push
   * writes a stale rendering over whoever changed it (#649 review).
   */
  it('delivers an agent this machine published into an inactive namespace', () => {
    const agents = [makeAgent('vr', 'fe-agents'), makeAgent('other', 'devops')];

    const result = delivered(filterAgentsByNamespaces(agents, ['common'], {
      vr: 'agents/fe-agents/vr.yaml',
    }));

    expect(result.map((a) => a.name)).toEqual(['vr']);
  });

  it('leaves the record alone when an active namespace claims that stem', () => {
    // Agents deploy flattened, so two of one stem would collide on the same
    // filename — and the active one is the agent deployed here.
    const agents = [makeAgent('vr', 'common'), makeAgent('vr', 'fe-agents')];

    const result = delivered(filterAgentsByNamespaces(agents, ['common'], {
      vr: 'agents/fe-agents/vr.yaml',
    }));

    expect(result).toHaveLength(1);
    expect(result[0]?.namespace).toBe('common');
  });

  it('delivers the agent this machine published in place of a root agent of the same stem', () => {
    // The author's flattened copy stands for the placed agent; a shared-root
    // agent of that stem no longer withdraws the record (#707).
    const agents = [makeAgent('vr'), makeAgent('vr', 'fe-agents')];

    const result = delivered(filterAgentsByNamespaces(agents, ['common'], {
      vr: 'agents/fe-agents/vr.yaml',
    }));

    expect(result.map((a) => a.relativePath)).toEqual(['agents/fe-agents/vr.yaml']);
  });

  it('ignores a record that does not match the agent it names', () => {
    const agents = [makeAgent('vr', 'fe-agents')];

    expect(delivered(filterAgentsByNamespaces(agents, ['common'], { vr: 'agents/other/vr.yaml' })))
      .toEqual([]);
  });
});
