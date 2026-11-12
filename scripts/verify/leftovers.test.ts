import { describe, expect, it } from 'vitest';
import { attributeLeftover, cleanupPlan, linesOf, worldTier, type WorldTies } from './leftovers.js';

const SELF: WorldTies = { runId: '20261112T120000-aaaaaa', paths: ['/w/20261112T120000-aaaaaa', '/private/tmp/teamai-verify-20261112T120000-aaaaaa'], journals: ['0123456789abcdef'], runs: ['r00000000000000aa'] };
const OTHER: WorldTies = { runId: '20261112T110000-bbbbbb', paths: ['/w/20261112T110000-bbbbbb'], journals: ['fedcba9876543210'], runs: ['r00000000000000bb'] };

describe('whose leftover it is', () => {
  it("is this world's when it names a path inside it, its TMPDIR included, or a journal or run of its own", () => {
    expect(attributeLeftover({ paths: ['/w/20261112T120000-aaaaaa/home/x'], journals: [], runs: [], marked: false }, SELF, [OTHER]).kind).toBe('own');
    expect(attributeLeftover({ paths: ['/private/tmp/teamai-verify-20261112T120000-aaaaaa'], journals: [], runs: [], marked: false }, SELF, [OTHER]).kind).toBe('own');
    expect(attributeLeftover({ paths: [], journals: ['0123456789abcdef'], runs: [], marked: true }, SELF, [OTHER]).kind).toBe('own');
    expect(attributeLeftover({ paths: [], journals: [], runs: ['r00000000000000aa'], marked: true }, SELF, [OTHER]).kind).toBe('own');
  });

  it("is another world's when it is tied to that one only, and never this world's leak", () => {
    expect(attributeLeftover({ paths: ['/w/20261112T110000-bbbbbb/project'], journals: [], runs: [], marked: false }, SELF, [OTHER])).toEqual({ kind: 'other_world', runId: OTHER.runId });
    expect(attributeLeftover({ paths: [], journals: ['fedcba9876543210'], runs: [], marked: true }, SELF, [OTHER])).toEqual({ kind: 'other_world', runId: OTHER.runId });
  });

  it('does not take a path that only starts like a world path for one inside it', () => {
    expect(attributeLeftover({ paths: ['/w/20261112T120000-aaaaaa-copy/x'], journals: [], runs: [], marked: false }, SELF, []).kind).toBe('unrelated');
  });

  it("is ambiguous when it carries teamai's mark but no world's tie, and unrelated when it carries neither", () => {
    expect(attributeLeftover({ paths: ['/Users/me/repo'], journals: ['1111111111111111'], runs: [], marked: true }, SELF, [OTHER]).kind).toBe('ambiguous');
    expect(attributeLeftover({ paths: ['/Users/me/repo'], journals: [], runs: [], marked: false }, SELF, [OTHER])).toEqual({ kind: 'unrelated' });
  });
});

describe("a world's tier", () => {
  it('is basic when no step runtime left a record, middle when only teamai\'s own process ran steps, and driver once a runtime outside it, a sandbox journal or a container member exists', () => {
    expect(worldTier({ inProcessRecords: 0, externalRecords: 0, runtimeJournals: 0, containerMembers: 0 })).toBe('basic');
    expect(worldTier({ inProcessRecords: 2, externalRecords: 0, runtimeJournals: 0, containerMembers: 0 })).toBe('middle');
    expect(worldTier({ inProcessRecords: 2, externalRecords: 1, runtimeJournals: 0, containerMembers: 0 })).toBe('driver');
    expect(worldTier({ inProcessRecords: 0, externalRecords: 0, runtimeJournals: 1, containerMembers: 0 })).toBe('driver');
    expect(worldTier({ inProcessRecords: 0, externalRecords: 0, runtimeJournals: 0, containerMembers: 1 })).toBe('driver');
    // After uninstall took the records away, a world a runtime outside teamai's process ran in keeps every check.
    expect(worldTier({ inProcessRecords: 0, externalRecords: 0, runtimeJournals: 0, containerMembers: 0, driverSeen: true })).toBe('driver');
  });
});

describe('what each row reads from what an engine or the process table printed', () => {
  it("takes a process's working directory and the absolute paths its arguments name, and skips the harness's own chain", async () => {
    const { lineageOf, parseLsofCwd, parseProcLines, parsePs, pathsNamed } = await import('./leftovers/processes.js');
    const procs = parsePs('    1     0 /sbin/launchd\n  500     1 node /w/x/bin/teamai workflow serve\n  600   500 /bin/sh -c sleep 1000 --dir=/w/20261112T120000-aaaaaa/home\n');

    expect(procs.map((proc) => proc.pid)).toEqual([1, 500, 600]);
    expect(pathsNamed(procs[2]?.command ?? '')).toEqual(['/bin/sh', '/w/20261112T120000-aaaaaa/home']);
    expect(parseLsofCwd('p500\nfcwd\nn/w/20261112T120000-aaaaaa/project\np600\nfcwd\nn/\n')).toEqual(new Map([[500, '/w/20261112T120000-aaaaaa/project'], [600, '/']]));
    expect([...lineageOf(600, procs)]).toEqual([600, 500]);
    expect(parseProcLines('42\t1\t/w/20261112T120000-aaaaaa/project\tnode /x a b\nnot a line\n')).toEqual([{ pid: 42, ppid: 1, cwd: '/w/20261112T120000-aaaaaa/project', command: 'node /x a b' }]);
  });

  it('says it could not see every working directory on macOS when lsof ends without success or with a note, whatever it listed before', async () => {
    const { readDarwinTable } = await import('./leftovers/processes.js');
    const ps = '  500     1 node /w/x/bin/teamai\n  600     1 sleep 900\n';
    const listed = (lsof: { code: number | null; stdout: string; why: string }) => readDarwinTable({ label: 'this machine', ps, lsof });

    expect(listed({ code: 0, stdout: 'p500\nfcwd\nn/w\np600\nfcwd\nn/\n', why: '' }).unseen).toEqual([]);
    expect(listed({ code: 1, stdout: 'p500\nfcwd\nn/w\n', why: 'lsof: WARNING: can\'t stat() a file system' }).unseen).toEqual([
      { kind: 'not_observed', what: 'working directories on this machine', why: "lsof ended with 1 after listing 1 (lsof: WARNING: can't stat() a file system), so a process it missed may be the world's" },
    ]);
    expect(listed({ code: null, stdout: 'p500\nfcwd\nn/w\n', why: 'spawnSync lsof ETIMEDOUT' }).unseen).toEqual([
      { kind: 'not_observed', what: 'working directories on this machine', why: "lsof ended with no exit code after listing 1 (spawnSync lsof ETIMEDOUT), so a process it missed may be the world's" },
    ]);
    expect(listed({ code: 0, stdout: 'p500\nfcwd\nn/w\n', why: 'lsof: no pwd entry for UID 501' }).unseen).toEqual([
      { kind: 'not_observed', what: 'working directories on this machine', why: "lsof listed 1 but said lsof: no pwd entry for UID 501, so a process it missed may be the world's" },
    ]);
    expect(listed({ code: 0, stdout: '', why: '' }).unseen).toEqual([{ kind: 'not_observed', what: 'working directories on this machine', why: 'lsof listed none ()' }]);
    expect(listed({ code: 0, stdout: 'p500\nfcwd\nn/w\n', why: '' }).procs.map((proc) => proc.cwd)).toEqual(['/w', undefined]);
  });

  it('reads containers with their owner, run and mounts, and sbx names with the journal teamai gave them', async () => {
    const { parseContainers, parseMounts } = await import('./leftovers/containers.js');
    const { journalOfSbxName } = await import('./leftovers/sbx.js');

    expect(parseContainers('abc123\tteamai-r1-a1\t0123456789abcdef\tr1\trunning\n')).toEqual([{ id: 'abc123', name: 'teamai-r1-a1', owner: '0123456789abcdef', run: 'r1', state: 'running' }]);
    expect(parseMounts('abc123abc123ffff\t/w/20261112T120000-aaaaaa/project\t/tmp/x\n')).toEqual(new Map([['abc123abc123', ['/w/20261112T120000-aaaaaa/project', '/tmp/x']]]));
    expect(journalOfSbxName('teamai-0123456789abcdef-r1-a1')).toBe('0123456789abcdef');
    expect(journalOfSbxName('teamai-0123456789abcdef-warm-42-x')).toBe('0123456789abcdef');
    expect(journalOfSbxName('my-sandbox')).toBeUndefined();
  });
});

describe("a row's lines in section (f)", () => {
  const same = (text: string): string => text;

  it('says the row found none left even beside a note of its own, and never when part of it was not looked at', () => {
    expect(linesOf('open attempt place', [{ kind: 'observed', findings: [], notes: ['run r1 attempt a1 ran on seatbelt'] }], same)).toEqual({ leaks: [], notes: ['no open attempt place left', 'run r1 attempt a1 ran on seatbelt'] });
    expect(linesOf('teamai container', [{ kind: 'observed', findings: [], notes: [] }, { kind: 'observed', findings: [], notes: ['podman: not installed here'] }], same)).toEqual({ leaks: [], notes: ['no teamai container left', 'podman: not installed here'] });
    expect(linesOf('teamai container', [{ kind: 'observed', findings: [], notes: [] }, { kind: 'not_observed', what: 'podman containers', why: 'podman info failed' }], same)).toEqual({ leaks: [], notes: ['NOT OBSERVED: podman containers, podman info failed'] });
    expect(linesOf('teamai container', [{ kind: 'observed', findings: [{ what: 'docker container c', attribution: { kind: 'ambiguous', why: 'tied to no world' } }], notes: [] }], same)).toEqual({ leaks: [], notes: ['docker container c: tied to no world, so not counted here'] });
  });
});

describe('what cleanup does with what the rows found', () => {
  const own = { kind: 'own', why: 'names the world' } as const;
  const theirs = { kind: 'other_world', runId: OTHER.runId } as const;

  it('refuses while a process of the world lives, naming each, and removes nothing', () => {
    const plan = cleanupPlan([
      { onCleanup: 'refuse', observed: [{ kind: 'observed', findings: [{ what: 'process 42 on this machine (sleep 900)', attribution: own }, { what: 'process 43 on this machine (x)', attribution: theirs }], notes: [] }] },
      { onCleanup: 'remove', observed: [{ kind: 'observed', findings: [{ what: 'docker container c', attribution: own, remove: ['docker', 'rm', '-f', 'c'] }], notes: [] }] },
    ]);

    expect(plan).toEqual({ kind: 'refuse', processes: ['process 42 on this machine (sleep 900)'], unseen: [] });
  });

  it('refuses when it could not look at the processes, since one of the world may still run there', () => {
    const plan = cleanupPlan([
      { onCleanup: 'refuse', observed: [{ kind: 'observed', findings: [], notes: [] }, { kind: 'not_observed', what: 'working directories on this machine', why: 'lsof listed none' }] },
      { onCleanup: 'remove', observed: [{ kind: 'observed', findings: [{ what: 'docker container c', attribution: own, remove: ['docker', 'rm', '-f', 'c'] }], notes: [] }] },
    ]);

    expect(plan).toEqual({ kind: 'refuse', processes: [], unseen: ['working directories on this machine, lsof listed none'] });
  });

  it("removes only the world's own removable leftovers, keeps what a row keeps, and says what it could not look at", () => {
    const plan = cleanupPlan([
      { onCleanup: 'refuse', observed: [{ kind: 'observed', findings: [], notes: [] }] },
      { onCleanup: 'keep', observed: [{ kind: 'observed', findings: [{ what: 'run r attempt a place', attribution: own }], notes: [] }] },
      { onCleanup: 'remove', observed: [
        { kind: 'observed', findings: [{ what: 'docker container mine', attribution: own, remove: ['docker', 'rm', '-f', 'mine'] }, { what: 'docker container theirs', attribution: theirs, remove: ['docker', 'rm', '-f', 'theirs'] }], notes: [] },
        { kind: 'not_observed', what: 'podman containers', why: 'podman info failed' },
      ] },
    ]);

    expect(plan).toEqual({ kind: 'remove', removals: [{ what: 'docker container mine', command: ['docker', 'rm', '-f', 'mine'] }], unobserved: ['podman containers, podman info failed'] });
  });
});
