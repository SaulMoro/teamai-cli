import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { journal } from '../../packages/runtime-sandbox/src/journal.js';
import { sandboxJournalRoot } from '../../packages/runtime-sandbox/src/journal-root.js';
import { bwrapSteps, startObserver } from './observer.js';
import type { World } from './world.js';

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();

  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function worldIn(members: World['members'] = []): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-'));
  roots.push(dir);
  const at = (name: string): string => path.join(dir, name);

  return {
    runId: '20261112T120000-aaaaaa', dir, project: at('project'), team: at('team.git'), home: at('home'), tmp: at('tmp'), logs: at('logs'), bin: at('bin'),
    build: { commit: 'c', dirty: false, version: '0', tarball: 't', sha256: 's', node: 'v24' },
    createdAt: '2026-11-12T12:00:00.000Z', baseline: { teamRefs: {}, checkoutStatus: [] }, env: { VERIFY_WORLD_CANARY: 'c4n4ry0123456789' }, members,
  };
}

const failed = { kind: 'failed', why: 'exit 1', timedOut: false } as const;
const missing = { kind: 'missing' } as const;
const printed = (stdout: string) => ({ kind: 'ran', stdout }) as const;

/** An engine that lists one teamai container of `world`'s journal and fails every `docker exec` into it. */
function dockerFailingExec(world: World) {
  const owner = journal(sandboxJournalRoot(world.home)).owner;

  return (argv: readonly string[]) => {
    const [command = '', verb = ''] = argv;

    if (command === 'docker' && verb === 'info') return Promise.resolve(printed('29.0.0\n'));

    if (command === 'docker' && verb === 'ps') return Promise.resolve(printed(`c0ffee\tteamai-r1-a1\t${owner}\n`));

    return Promise.resolve(command === 'docker' ? failed : missing);
  };
}

describe('the sandbox observer', () => {
  it('says a sandbox of the world it found but could not read was not observed', async () => {
    const world = worldIn();
    const observer = startObserver(world, { pass: new Map(), label: 'teamai workflow start', listed: dockerFailingExec(world) });

    expect(await observer.stop()).toContain("[verify] observed docker:teamai-r1-a1: NOT OBSERVED, no step's environment could be read");
  });

  it.runIf(process.platform !== 'linux')("says a container member's bwrap steps go unread off Linux, where it reads no /proc", async () => {
    const world = worldIn([{ machine: 'container', container: 'teamai-verify-x-carol', name: 'carol', home: '/w/carol/home', project: '/w/carol/project', tmp: '/tmp/carol', writers: '/w/carol/writers.json', env: {}, baseline: { files: {} } }]);
    const observer = startObserver(world, { pass: new Map(), label: 'teamai workflow start', listed: () => Promise.resolve(missing) });

    expect(await observer.stop()).toContain("[verify] NOT OBSERVED: bwrap steps in @carol's container, the observer reads their environment from /proc on Linux only");
  });

  it("reads a step's environment in a container, never the idle process the container waits in or the observer's own", async () => {
    const world = worldIn();
    const owner = journal(sandboxJournalRoot(world.home)).owner;
    const proc = path.join(world.dir, 'fake-proc');
    /** A process in the fake /proc: its parent and its environment. */
    const process_ = (pid: number, ppid: number, env: string): void => {
      fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
      fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (sh) S ${ppid} ${pid} ${pid} 0 -1\n`);
      fs.writeFileSync(path.join(proc, String(pid), 'environ'), `${env}\0`);
    };
    // The container's idle loop and its sleep, as teamai starts every container.
    process_(1, 0, 'HOME=/tmp/teamai-home');
    process_(7, 1, 'HOME=/tmp/teamai-home');
    const observe = async (): Promise<string[]> => startObserver(world, {
      pass: new Map(),
      label: 'teamai workflow start',
      listed: async ([command = '', verb = '', ...rest]) => {
        if (command !== 'docker') return missing;

        if (verb === 'info') return printed('29.0.0\n');

        if (verb === 'ps') return printed(`c0ffee\tteamai-r0123abcd-a0123abcd\t${owner}\n`);

        const script = (rest.at(-1) ?? '').replaceAll('/proc/', `${proc}/`);

        return printed(spawnSync('sh', ['-c', script], { encoding: 'utf8' }).stdout);
      },
    }).stop();

    expect(await observe()).toEqual(["[verify] observed docker:teamai-r0123abcd-a0123abcd: NOT OBSERVED, no step's environment could be read"]);

    // A step `docker exec` started, which the container's namespace shows with no parent.
    process_(42, 0, `HOME=/tmp/teamai-home\0VERIFY_WORLD_CANARY=${world.env?.VERIFY_WORLD_CANARY ?? ''}`);

    expect(await observe()).toEqual(['[verify] observed docker:teamai-r0123abcd-a0123abcd: ENV LEAK VERIFY_WORLD_CANARY']);
  });

  it('says it could not list the sbx sandboxes when `sbx ls` fails, and nothing when sbx is not installed', async () => {
    const world = worldIn();
    const sbxFails = startObserver(world, { pass: new Map(), label: 'teamai workflow start', listed: ([command]) => Promise.resolve(command === 'sbx' ? { kind: 'failed', why: 'sbx: not signed in', timedOut: false } as const : missing) });
    const noSbx = startObserver(world, { pass: new Map(), label: 'teamai workflow start', listed: () => Promise.resolve(missing) });

    expect(await sbxFails.stop()).toEqual(['[verify] NOT OBSERVED: sbx sandboxes, `sbx ls` failed (sbx: not signed in)']);

    const sbxBanner = startObserver(world, { pass: new Map(), label: 'teamai workflow start', listed: ([command]) => Promise.resolve(command === 'sbx' ? printed('A new sbx is out: run sbx upgrade\n[]') : missing) });

    expect(await sbxBanner.stop()).toEqual(['[verify] NOT OBSERVED: sbx sandboxes, `sbx ls --json` printed a list this harness cannot read']);
    expect(await noSbx.stop()).toEqual([]);
  });

  it('asks no more, and says so, an engine whose `info` took past its time', async () => {
    vi.useFakeTimers();
    const world = worldIn();
    let infos = 0;
    const observer = startObserver(world, {
      pass: new Map(),
      label: 'teamai workflow start',
      listed: ([command = '', verb = '']) => {
        if (command !== 'docker') return Promise.resolve(missing);
        infos += verb === 'info' ? 1 : 0;

        return Promise.resolve({ kind: 'failed', why: 'it took over 10 s', timedOut: true } as const);
      },
    });

    await vi.advanceTimersByTimeAsync(500);

    expect(await observer.stop()).toEqual(['[verify] NOT OBSERVED: docker containers, `docker info` took over 10 s']);
    expect(infos).toBe(1);
  });

  it('asks again on the next look for an engine that was down at the first, and reads the container it then lists', async () => {
    vi.useFakeTimers();
    const world = worldIn();
    const owner = journal(sandboxJournalRoot(world.home)).owner;
    let infos = 0;
    const observer = startObserver(world, {
      pass: new Map(),
      label: 'teamai workflow start',
      listed: ([command = '', verb = '']) => {
        if (command !== 'docker') return Promise.resolve(missing);

        if (verb === 'info') return Promise.resolve((infos += 1) === 1 ? failed : printed('29.0.0\n'));

        return Promise.resolve(verb === 'ps' ? printed(`c0ffee\tteamai-r0123abcd-a0123abcd\t${owner}\n`) : printed('PATH=/usr/bin\0\0'));
      },
    });

    await vi.advanceTimersByTimeAsync(500);

    expect(await observer.stop()).toEqual(['[verify] observed docker:teamai-r0123abcd-a0123abcd: env ok']);
  });

  // bwrap with --unshare-pid runs a second bwrap as the namespace's first process, with the same arguments.
  it('reads one step from a bwrap that runs a bwrap inside it, the first process below both', () => {
    const args = ['/usr/bin/bwrap', '--unshare-pid', '--bind', '/w/x/project', '/w/x/project', 'sh', '-c', 'step'];

    expect(bwrapSteps([
      { pid: '50', ppid: '1', args: ['node', '/w/x/install/teamai'] },
      { pid: '100', ppid: '50', args },
      { pid: '101', ppid: '100', args },
      { pid: '102', ppid: '101', args: ['sh', '-c', 'step'] },
      { pid: '200', ppid: '50', args: ['/usr/bin/bwrap', '--bind', '/elsewhere', '/elsewhere', 'sh'] },
      { pid: '201', ppid: '200', args: ['sh'] },
    ], ['/w/x'])).toEqual([{ bwrap: '100', steps: ['102'] }]);
  });

  it('names a bwrap by the attempt place it binds, so section (f) can tell its attempt was read', () => {
    const args = ['/usr/bin/bwrap', '--bind', '/w/x/home/.teamai/runtime-state/sandbox/teamai-r0123abcd-a0123abcd/home', '/w/x/home/.teamai/runtime-state/sandbox/teamai-r0123abcd-a0123abcd/home', 'sh'];

    expect(bwrapSteps([{ pid: '100', ppid: '50', args }, { pid: '102', ppid: '100', args: ['sh'] }], ['/w/x'])).toEqual([{ bwrap: 'teamai-r0123abcd-a0123abcd', steps: ['102'] }]);
  });

  it("reads no second step from a bwrap the step's own tool runs further down", () => {
    const args = ['/usr/bin/bwrap', '--bind', '/w/x/project', '/w/x/project', 'sh', '-c', 'step'];

    expect(bwrapSteps([
      { pid: '100', ppid: '50', args },
      { pid: '102', ppid: '100', args: ['node', 'tool.js'] },
      { pid: '103', ppid: '102', args: ['/usr/bin/bwrap', '--ro-bind', '/w/x/project', '/w/x/project', 'sh'] },
      { pid: '104', ppid: '103', args: ['sh'] },
    ], ['/w/x'])).toEqual([{ bwrap: '100', steps: ['102'] }]);
  });
});
