import { describe, expect, it } from 'vitest';
import { memberLayout, setupBaseline } from './members.js';
import { parseTarget } from './target.js';

const RUN = '20261112T113044-479be0';

describe('a run id with a member', () => {
  it('names the world alone, or one member of it after @', () => {
    expect(parseTarget(RUN)).toEqual({ runId: RUN, target: { kind: 'world' } });
    expect(parseTarget(`${RUN}@bob`)).toEqual({ runId: RUN, target: { kind: 'member', name: 'bob' } });
  });

  it('refuses a member name a path or a container name could not hold', () => {
    for (const name of ['', 'Bob', '../x', 'a b', 'abcdefghijklm', '-bob']) expect(() => parseTarget(`${RUN}@${name}`)).toThrow(/member name/);
  });
});

describe("a member's layout", () => {
  it('keeps its HOME and clone under the world, and its TMPDIR beside the world\'s, named after the run and the member', () => {
    expect(memberLayout({ dir: `/w/${RUN}`, runId: RUN }, { name: 'bob', tmpRoot: '/private/tmp' })).toEqual({
      root: `/w/${RUN}/members/bob`,
      home: `/w/${RUN}/members/bob/home`,
      project: `/w/${RUN}/members/bob/project`,
      writers: `/w/${RUN}/members/bob/writers.json`,
      tmp: `/private/tmp/teamai-verify-${RUN}-bob`,
    });
  });
});

describe("the harness's own setup", () => {
  it('moves into the baseline only what it changed itself, so what teamai changed before stays a change', () => {
    const baseline = { 'home/.gitconfig': 'a', 'project/.git/config': 'git config', 'project/.git/config#core.bare': 'false' };
    const before = { ...baseline, 'home/.teamai/state.json': 'teamai-wrote', 'project/.git/config#teamai.x': '1' };
    const after = { ...before, 'home/.gitconfig': 'b', 'project/.git/config#remote.origin.url': 'https://teamai.test/world/project.git', 'project/.git/refs/remotes/origin/main': 'c1' };

    expect(setupBaseline(baseline, before, after)).toEqual({ ...baseline, 'home/.gitconfig': 'b', 'project/.git/config#remote.origin.url': 'https://teamai.test/world/project.git', 'project/.git/refs/remotes/origin/main': 'c1' });
  });

  it('drops from the baseline what its setup removed', () => {
    expect(setupBaseline({ x: '1', y: '2' }, { x: '1', y: '2' }, { x: '1' })).toEqual({ x: '1' });
  });
});
