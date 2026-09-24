import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filterEventsByScope } from '../team-push.js';
import { dataHomeKey } from '../dashboard-collector.js';
import type { DashboardEvent, LocalConfig } from '../types.js';

/** An event written before events carried a data home key, attributed by cwd. */
function makeEvent(cwd: string | undefined, sessionId = 's1'): DashboardEvent {
  return { type: 'prompt_submit', timestamp: new Date().toISOString(), sessionId, tool: 'claude', cwd };
}

/** An event recorded by the scope whose data home is `dataHome`. */
async function scopedEvent(cwd: string | undefined, sessionId: string, dataHome: string): Promise<DashboardEvent> {
  return { ...makeEvent(cwd, sessionId), dataHomeKey: await dataHomeKey(dataHome) };
}

const repo = { localPath: '/unused/team-repo', remote: 'https://example.test/team.git' };

function projectScope(projectRoot: string, dataHome = '/home/jeff/.teamai/projects/p'): LocalConfig {
  return { repo, username: 'jeff', scope: 'project', additionalRoles: [], projectRoot, dataHome };
}

function userScope(dataHome = '/home/jeff/.teamai'): LocalConfig {
  return { repo, username: 'jeff', scope: 'user', additionalRoles: [], dataHome };
}

async function ids(events: DashboardEvent[], config?: LocalConfig): Promise<string[]> {
  return (await filterEventsByScope(events, config)).map((e) => e.sessionId);
}

describe('filterEventsByScope', () => {
  const events: DashboardEvent[] = [
    makeEvent('/Users/jeff/project-a', 's1'),
    makeEvent('/Users/jeff/project-a/src', 's2'),
    makeEvent('/Users/jeff/other-work', 's3'),
    makeEvent('/Users/jeff/project-b', 's4'),
    makeEvent(undefined, 's5'),
  ];

  it('returns all events when no scope is given', async () => {
    expect(await filterEventsByScope(events)).toEqual(events);
  });

  describe('events that carry a data home key', () => {
    const scoped = (): Promise<DashboardEvent[]> => Promise.all([
      scopedEvent('/Users/jeff/project-a', 'p1', '/home/jeff/.teamai/projects/p'),
      scopedEvent(undefined, 'p2', '/home/jeff/.teamai/projects/p'),
      scopedEvent('/Users/jeff/project-a', 'u1', '/home/jeff/.teamai'),
      scopedEvent('/Users/jeff/project-a', 'q1', '/home/jeff/.teamai/projects/q'),
    ]);

    it('a project keeps its own, whatever their cwd', async () => {
      expect(await ids(await scoped(), projectScope('/Users/jeff/project-a'))).toEqual(['p1', 'p2']);
    });

    it('the user scope keeps its own and no project\'s', async () => {
      expect(await ids(await scoped(), userScope())).toEqual(['u1']);
    });

    it('a session goes whole to the scope of its first keyed event', async () => {
      // A Stop carries the whole transcript's totals, so P must not count them again.
      const moved = [
        makeEvent('/Users/jeff/other-work', 'm1'),
        await scopedEvent('/Users/jeff/other-work', 'm1', '/home/jeff/.teamai'),
        { ...(await scopedEvent('/Users/jeff/project-a', 'm1', '/home/jeff/.teamai/projects/p')), type: 'stop' as const, prompts: 5 },
      ];
      expect(await ids(moved, userScope())).toEqual(['m1', 'm1', 'm1']);
      expect(await ids(moved, projectScope('/Users/jeff/project-a'))).toEqual([]);
    });

    it('a keyed event decides a session over an earlier unkeyed one', async () => {
      // Recorded across the upgrade: the unkeyed event's cwd is P's, the key the user scope's.
      const upgraded = [
        makeEvent('/Users/jeff/project-a', 'x1'),
        await scopedEvent('/Users/jeff/project-a', 'x1', '/home/jeff/.teamai'),
      ];
      expect(await ids(upgraded, projectScope('/Users/jeff/project-a'))).toEqual([]);
      expect(await ids(upgraded, userScope())).toEqual(['x1', 'x1']);
    });

    it('a project keeps what it recorded under its in-repo .teamai before moving to a partition', async () => {
      const legacy = [await scopedEvent(undefined, 'l1', '/Users/jeff/project-a/.teamai')];
      expect(await ids(legacy, projectScope('/Users/jeff/project-a'))).toEqual(['l1']);
      expect(await ids(legacy, userScope())).toEqual([]);
    });

    it('a project rooted at HOME does not take the user scope\'s events', async () => {
      const home = os.homedir();
      const evts = [await scopedEvent(undefined, 'u1', path.join(home, '.teamai'))];
      expect(await ids(evts, projectScope(home))).toEqual([]);
    });

    it('matches a data home reached through a symlink', async () => {
      const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-scope-key-')));
      try {
        fs.mkdirSync(path.join(tmp, 'real', '.teamai'), { recursive: true });
        fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'link'), 'dir');
        const evts = [await scopedEvent(undefined, 'k1', path.join(tmp, 'link', '.teamai'))];
        const config = projectScope(path.join(tmp, 'real'), path.join(tmp, 'real', '.teamai'));
        expect(await ids(evts, config)).toEqual(['k1']);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('keeps what a project recorded in its in-repo .teamai after migration removed it', async () => {
      const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-scope-gone-')));
      try {
        fs.mkdirSync(path.join(tmp, 'real', '.teamai'), { recursive: true });
        fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'link'), 'dir');
        const evts = [await scopedEvent(undefined, 'g1', path.join(tmp, 'link', '.teamai'))];
        fs.rmSync(path.join(tmp, 'real', '.teamai'), { recursive: true });
        expect(await ids(evts, projectScope(path.join(tmp, 'link')))).toEqual(['g1']);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('a Windows data home matches whatever its case or separators', async () => {
      const win = await Promise.all([scopedEvent(undefined, 'w1', 'C:\\Users\\Jeff\\.teamai'), scopedEvent(undefined, 'w2', 'C:\\Users\\jeff\\.teamai\\projects\\p')]);
      expect(await ids(win, userScope('c:/users/jeff/.teamai'))).toEqual(['w1']);
    });
  });

  it('an event whose key is not a string counts as written before keys existed', async () => {
    // A hand-edited or corrupted line in the shared log.
    const corrupt: DashboardEvent[] = JSON.parse(JSON.stringify([
      { ...makeEvent('/Users/jeff/project-a', 'c1'), dataHomeKey: null },
      { ...makeEvent('/Users/jeff/other-work', 'c2'), dataHomeKey: 42 },
    ]));
    expect(await ids(corrupt, projectScope('/Users/jeff/project-a'))).toEqual(['c1']);
    expect(await ids(corrupt, userScope())).toEqual([]);
  });

  it('matches an older event\'s real cwd to a project whose root was set through a symlink', async () => {
    // A non-git project's root is the directory as given, not realpath'd.
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-scope-root-')));
    try {
      fs.mkdirSync(path.join(tmp, 'real'));
      fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'link'), 'dir');
      const evts = [makeEvent(path.join(tmp, 'real'), 'r1')];
      expect(await ids(evts, projectScope(path.join(tmp, 'link')))).toEqual(['r1']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the user scope never keeps events without a data home', async () => {
    expect(await ids(events, userScope())).toEqual([]);
  });

  // Events without a data home go to the project whose root holds their cwd.
  it('filters to projectRoot (exact match and subdirectories)', async () => {
    expect(await ids(events, projectScope('/Users/jeff/project-a'))).toEqual(['s1', 's2']);
  });

  it('projectRoot with trailing slash works the same', async () => {
    expect(await ids(events, projectScope('/Users/jeff/project-a/'))).toEqual(['s1', 's2']);
  });

  it('events with undefined cwd are excluded by projectRoot', async () => {
    expect(await ids(events, projectScope('/Users/jeff/project-a'))).not.toContain('s5');
  });

  it('does not match partial directory name prefixes', async () => {
    const evts = [
      makeEvent('/Users/jeff/project-ab', 'x1'),
      makeEvent('/Users/jeff/project-a', 'x2'),
    ];
    expect(await ids(evts, projectScope('/Users/jeff/project-a'))).toEqual(['x2']);
  });

  // Windows paths are plain strings here, so these run on the ubuntu CI too.
  // Both sides of the comparison are native paths in production: projectRoot is
  // path.resolve(cwd) from init, and cwd is whatever the tool's hook payload
  // carried.
  describe('Windows paths', () => {
    const winEvents: DashboardEvent[] = [
      makeEvent('C:\\Users\\jeff\\project-a', 'w1'),
      makeEvent('C:\\Users\\jeff\\project-a\\src', 'w2'),
      makeEvent('C:\\Users\\jeff\\project-ab', 'w3'),
      makeEvent('C:\\Users\\jeff\\other-work', 'w4'),
    ];

    it('filters to projectRoot including subdirectories', async () => {
      expect(await ids(winEvents, projectScope('C:\\Users\\jeff\\project-a'))).toEqual(['w1', 'w2']);
    });

    it('matches a root and a cwd that disagree on separator style', async () => {
      expect(await ids(winEvents, projectScope('C:/Users/jeff/project-a'))).toEqual(['w1', 'w2']);
    });

    it('trailing backslash on the root works the same', async () => {
      expect(await ids(winEvents, projectScope('C:\\Users\\jeff\\project-a\\'))).toEqual(['w1', 'w2']);
    });

    it('ignores drive-letter and directory casing', async () => {
      expect(await ids(winEvents, projectScope('c:\\users\\JEFF\\Project-A'))).toEqual(['w1', 'w2']);
    });

    it('matches a UNC root whatever its case or separators', async () => {
      const uncEvents: DashboardEvent[] = [
        makeEvent('\\\\Server\\Share\\Proj', 'u1'),
        makeEvent('\\\\server\\share\\proj\\src', 'u2'),
        makeEvent('\\\\server\\share\\other', 'u3'),
      ];
      expect(await ids(uncEvents, projectScope('\\\\SERVER\\SHARE\\proj'))).toEqual(['u1', 'u2']);
    });
  });

  // A POSIX path is case-sensitive, and `\` is a legal character in a POSIX
  // filename, so neither folding may be applied to one.
  describe('POSIX paths keep their own rules', () => {
    it('does not fold case', async () => {
      expect(await ids(events, projectScope('/users/jeff/PROJECT-A'))).toEqual([]);
    });

    it('treats a backslash in a filename as part of the name', async () => {
      const evts = [makeEvent('/work/a\\b', 'p1'), makeEvent('/work/a/b', 'p2')];
      expect(await ids(evts, projectScope('/work/a/b'))).toEqual(['p2']);
      expect(await ids(evts, projectScope('/work/a\\b'))).toEqual(['p1']);
    });
  });
});
