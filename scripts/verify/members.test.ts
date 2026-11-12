import { describe, expect, it } from 'vitest';
import { addMember, ensureOrigin, memberLayout, setupBaseline } from './members.js';
import type { World } from './world.js';
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
  it('moves into the baseline only what it changed itself, so what teamai changed before or meanwhile stays a change', () => {
    const baseline = { 'home/.gitconfig': 'a', 'project/.git/config': 'git config', 'project/.git/config#core.bare': 'false' };
    const before = { ...baseline, 'home/.teamai/state.json': 'teamai-wrote', 'project/.git/config#teamai.x': '1' };
    // A command of the world that ran beside the setup wrote the last two.
    const after = { ...before, 'home/.gitconfig': 'b', 'project/.git/config#remote.origin.url': 'https://teamai.test/world/project.git', 'project/.git/refs/remotes/origin/main': 'c1', 'home/.teamai/state.json': 'teamai-wrote-again', 'project/.git/config#teamai.y': '2' };

    expect(setupBaseline(baseline, before, after)).toEqual({ ...baseline, 'home/.gitconfig': 'b', 'project/.git/config#remote.origin.url': 'https://teamai.test/world/project.git', 'project/.git/refs/remotes/origin/main': 'c1' });
  });

  it('drops from the baseline what its setup removed', () => {
    const kept = { 'home/.gitconfig': 'git config', 'project/.git/refs/remotes/origin/main': 'c1' };

    expect(setupBaseline(kept, kept, { 'home/.gitconfig': 'git config' })).toEqual({ 'home/.gitconfig': 'git config' });
  });
});

describe('a cleaned world', () => {
  const cleaned: World = {
    runId: RUN, dir: `/nonexistent/${RUN}`, project: `/nonexistent/${RUN}/project`, team: `/nonexistent/${RUN}/team.git`, home: `/nonexistent/${RUN}/home`, tmp: `/nonexistent/${RUN}/tmp`,
    logs: `/nonexistent/${RUN}/logs`, bin: `/nonexistent/${RUN}/bin`, build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' },
    createdAt: '2026-11-12T11:30:44.000Z', baseline: { teamRefs: {}, checkoutStatus: [] }, env: {}, cleanedAt: '2026-11-12T12:00:00.000Z',
  };

  it('gets no origin and no member, and says to make a new world', () => {
    expect(() => ensureOrigin(cleaned)).toThrow(`World ${RUN} was cleaned up at 2026-11-12T12:00:00.000Z. Make a new one.`);
    expect(() => addMember(cleaned, { name: 'bob' })).toThrow(`World ${RUN} was cleaned up at 2026-11-12T12:00:00.000Z. Make a new one.`);
  });
});
