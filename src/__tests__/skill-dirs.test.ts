import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { settleSkillDirs, type SkillDirRelease, type SkillDirs } from '../resources/skill-dirs.js';

type Case = {
  readonly name: string;
  readonly previous: SkillDirs | undefined;
  readonly previousFormer?: SkillDirs;
  readonly current: SkillDirs;
  readonly incomplete?: readonly string[];
  readonly followSession?: readonly string[];
  readonly real?: Readonly<Record<string, string>>;
  readonly record: SkillDirs;
  readonly former?: SkillDirs;
  readonly release: readonly SkillDirRelease[];
};

const CASES: readonly Case[] = [
  {
    name: 'releases nothing when no tool moved',
    previous: { hermes: ['/a'] }, current: { hermes: ['/a'] },
    record: { hermes: ['/a'] }, release: [],
  },
  {
    name: 'releases nothing without a previous record',
    previous: undefined, current: { hermes: ['/b'] },
    record: { hermes: ['/b'] }, release: [],
  },
  {
    name: 'releases the old directory of a tool that moved and took everything',
    previous: { hermes: ['/a'] }, current: { hermes: ['/b'] },
    record: { hermes: ['/b'] }, release: [{ dir: '/a', tool: 'hermes', currentDir: '/b' }],
  },
  {
    name: 'keeps both directories on record for a tool that moved and missed something',
    previous: { hermes: ['/a'] }, current: { hermes: ['/b'] }, incomplete: ['hermes'],
    record: { hermes: ['/a', '/b'] }, release: [],
  },
  {
    name: 'releases both directories a held move kept once the tool takes everything elsewhere',
    previous: { hermes: ['/a', '/b'] }, current: { hermes: ['/c'] },
    record: { hermes: ['/c'] }, release: [{ dir: '/a', tool: 'hermes', currentDir: '/c' }, { dir: '/b', tool: 'hermes', currentDir: '/c' }],
  },
  {
    name: 'keeps a directory another tool still writes',
    previous: { hermes: ['/a'], pi: ['/a'] }, current: { hermes: ['/b'], pi: ['/a'] },
    record: { hermes: ['/b'], pi: ['/a'] }, release: [],
  },
  {
    name: 'keeps a shared directory a held tool keeps, when the other tool moves in the same pull',
    previous: { hermes: ['/a'], pi: ['/a'] }, current: { hermes: ['/b'], pi: ['/c'] }, incomplete: ['hermes'],
    record: { hermes: ['/a', '/b'], pi: ['/c'] }, release: [],
  },
  {
    name: 'keeps a shared directory a held tool keeps, when the other tool moves in a later pull',
    previous: { hermes: ['/a', '/b'], pi: ['/a'] }, current: { hermes: ['/b'], pi: ['/c'] }, incomplete: ['hermes'],
    record: { hermes: ['/a', '/b'], pi: ['/c'] }, release: [],
  },
  {
    name: 'releases a directory two tools moved off once',
    previous: { hermes: ['/a'], pi: ['/a'] }, current: { hermes: ['/b'], pi: ['/c'] },
    record: { hermes: ['/b'], pi: ['/c'] }, release: [{ dir: '/a', tool: 'hermes', currentDir: '/b' }],
  },
  {
    name: 'keeps a directory a session-following tool writes now, and leaves that tool off the record',
    previous: { hermes: ['/a'] }, current: { hermes: ['/b'], openclaw: ['/a'] }, followSession: ['openclaw'],
    record: { hermes: ['/b'] }, release: [],
  },
  {
    name: 'never releases the old directory of a session-following tool',
    previous: { openclaw: ['/a'] }, current: { openclaw: ['/b'] }, followSession: ['openclaw'],
    record: {}, release: [],
  },
  {
    name: 'keeps a tool that takes skills nowhere now as former, and releases nothing of it',
    previous: { hermes: ['/a'] }, current: {},
    record: {}, former: { hermes: ['/a'] }, release: [],
  },
  {
    name: 'keeps as former the directories of a held tool that takes skills nowhere now',
    previous: { hermes: ['/a'], pi: ['/a'] }, current: { pi: ['/c'] }, incomplete: ['hermes'],
    record: { pi: ['/c'] }, former: { hermes: ['/a'] }, release: [],
  },
  {
    name: 'keeps a former tool as former while it still takes skills nowhere',
    previous: {}, previousFormer: { hermes: ['/a'] }, current: {},
    record: {}, former: { hermes: ['/a'] }, release: [],
  },
  {
    name: 'releases the former directory of a tool once it takes skills elsewhere',
    previous: {}, previousFormer: { hermes: ['/a'] }, current: { hermes: ['/b'] },
    record: { hermes: ['/b'] }, release: [{ dir: '/a', tool: 'hermes', currentDir: '/b' }],
  },
  {
    name: 'records, and releases nothing of, a tool that takes skills from its former directory again',
    previous: {}, previousFormer: { hermes: ['/a'] }, current: { hermes: ['/a'] },
    record: { hermes: ['/a'] }, release: [],
  },
  {
    name: 'keeps the former directory on record when the tool that takes skills elsewhere missed something',
    previous: {}, previousFormer: { hermes: ['/a'] }, current: { hermes: ['/b'] }, incomplete: ['hermes'],
    record: { hermes: ['/a', '/b'] }, release: [],
  },
  {
    name: 'releases only the directory of a tool with two that moved',
    previous: { codex: ['/home/.codex/skills', '/home/.agents/skills'] }, current: { codex: ['/x/skills', '/home/.agents/skills'] },
    record: { codex: ['/x/skills', '/home/.agents/skills'] }, release: [{ dir: '/home/.codex/skills', tool: 'codex', currentDir: '/x/skills' }],
  },
  {
    name: 'releases nothing when the tool takes skills from its old directory through a link',
    previous: { hermes: ['/real'] }, current: { hermes: ['/link'] }, real: { '/real': '/real', '/link': '/real' },
    record: { hermes: ['/link'] }, release: [],
  },
];

describe('settleSkillDirs', () => {
  it.each(CASES)('$name', ({ previous, previousFormer, current, incomplete = [], followSession = [], real = {}, record, former = {}, release }) => {
    const settled = settleSkillDirs({
      previous, former: previousFormer, current, incomplete: new Set(incomplete), realDirs: new Map(Object.entries(real)), followsSession: (tool) => followSession.includes(tool),
      host: { platform: 'linux', path: path.posix },
    });

    expect(settled).toEqual({ record, former, release });
  });

  it('compares directories in the host\'s path flavor', () => {
    const settled = settleSkillDirs({
      previous: { hermes: ['C:\\Users\\M\\hermes\\skills'] }, former: undefined, current: { hermes: ['c:\\users\\m\\hermes\\skills\\'] },
      incomplete: new Set(), realDirs: new Map(), followsSession: () => false, host: { platform: 'win32', path: path.win32 },
    });

    expect(settled.release).toEqual([]);
  });
});
