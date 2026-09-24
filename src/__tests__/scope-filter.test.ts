import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptBareKeys, filterEventsByScope } from '../team-push.js';
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

/** The session of each event a scope keeps: its run ID without the run's start. */
async function ids(events: DashboardEvent[], config?: LocalConfig): Promise<string[]> {
  return (await filterEventsByScope(events, config)).map((e) => e.sessionId.slice(0, e.sessionId.lastIndexOf('@')));
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

    it('a session ID reused after its session ended is decided anew', async () => {
      // A PID-fallback ID: the user-scope run ended, a later run in P reuses the ID.
      for (const end of ['session_end', 'process_exit'] as const) {
        const reused = [
          await scopedEvent(undefined, 'pid-1', '/home/jeff/.teamai'),
          { ...(await scopedEvent(undefined, 'pid-1', '/home/jeff/.teamai')), type: end },
          await scopedEvent(undefined, 'pid-1', '/home/jeff/.teamai/projects/p'),
        ];
        const project = await filterEventsByScope(reused, projectScope('/Users/jeff/project-a'));
        const user = await filterEventsByScope(reused, userScope());
        // Each run is its own session, under the ID plus its first event's timestamp.
        const first = `pid-1@${reused[0].timestamp}`;
        expect(project).toEqual([{ ...reused[2], sessionId: `pid-1@${reused[2].timestamp}` }]);
        expect(user).toEqual([{ ...reused[0], sessionId: first }, { ...reused[1], sessionId: first }]);
      }
    });

    it('a run keeps its ID after compaction drops the earlier runs of its ID', async () => {
      const ended = [
        await scopedEvent(undefined, 'pid-1', '/home/jeff/.teamai/projects/p'),
        { ...(await scopedEvent(undefined, 'pid-1', '/home/jeff/.teamai/projects/p')), type: 'session_end' as const },
      ];
      const later = { ...(await scopedEvent(undefined, 'pid-1', '/home/jeff/.teamai/projects/p')), timestamp: '2099-01-01T00:00:00.000Z' };
      const before = await filterEventsByScope([...ended, later], projectScope('/Users/jeff/project-a'));
      const after = await filterEventsByScope([later], projectScope('/Users/jeff/project-a'));
      expect(after.map((e) => e.sessionId)).toEqual(['pid-1@2099-01-01T00:00:00.000Z']);
      expect(before[2].sessionId).toBe(after[0].sessionId);
    });

    it('an event that records its data home as a path, before keys were hashed, is keyed by it', async () => {
      const unhashed: DashboardEvent[] = [
        { ...makeEvent(undefined, 'c1'), tool: 'copilot', dataHome: '/home/jeff/.teamai/projects/p' },
        { ...makeEvent('/Users/jeff/project-a', 'u1'), dataHome: '/home/jeff/.teamai' },
      ];
      expect(await ids(unhashed, projectScope('/Users/jeff/project-a'))).toEqual(['c1']);
      expect(await ids(unhashed, userScope())).toEqual(['u1']);
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
    // A hand-edited or corrupted line in the shared log: a later keyed event decides the session.
    const corrupt: DashboardEvent[] = JSON.parse(JSON.stringify([
      { ...makeEvent('/Users/jeff/project-a', 'c1'), dataHomeKey: null },
      { ...makeEvent('/Users/jeff/project-a', 'c2'), dataHomeKey: 42 },
    ]));
    const decided = [
      corrupt[0], await scopedEvent(undefined, 'c1', '/home/jeff/.teamai/projects/p'),
      corrupt[1], await scopedEvent(undefined, 'c2', '/home/jeff/.teamai/projects/p'),
    ];
    expect(await ids(decided, projectScope('/Users/jeff/project-a'))).toEqual(['c1', 'c1', 'c2', 'c2']);
    expect(await ids(decided, userScope())).toEqual([]);
  });
});

describe('adoptBareKeys', () => {
  it('gives a snapshot entry keyed by the bare session ID to the first run of that ID', () => {
    const reported = { 'pid-1': 3, 's2@t0': 1 };
    const adopted = adoptBareKeys(reported, ['pid-1@t1', 'pid-1@t2', 's2@t0', 's3@t3']);
    expect(adopted['pid-1@t1']).toBe(3);
    expect(adopted['pid-1@t2']).toBeUndefined();
    expect(adopted['s3@t3']).toBeUndefined();
  });

  it('never overrides a run\'s own entry', () => {
    expect(adoptBareKeys({ 'pid-1': 3, 'pid-1@t1': 5 }, ['pid-1@t1'])['pid-1@t1']).toBe(5);
  });
});
