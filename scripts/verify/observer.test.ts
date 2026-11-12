import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { journal } from '../../packages/runtime-sandbox/src/journal.js';
import { sandboxJournalRoot } from '../../packages/runtime-sandbox/src/journal-root.js';
import { bwrapSteps, startObserver } from './observer.js';
import type { World } from './world.js';

const roots: string[] = [];

afterEach(() => {
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

/** An engine that lists one teamai container of `world`'s journal and fails every `docker exec` into it. */
function dockerFailingExec(world: World) {
  const owner = journal(sandboxJournalRoot(world.home)).owner;

  return (argv: readonly string[]): Promise<string | undefined> => {
    const [command = '', verb = ''] = argv;

    if (command === 'docker' && verb === 'info') return Promise.resolve('29.0.0\n');

    if (command === 'docker' && verb === 'ps') return Promise.resolve(`c0ffee\tteamai-r1-a1\t${owner}\n`);

    return Promise.resolve(undefined);
  };
}

describe('the sandbox observer', () => {
  it('says a sandbox of the world it found but could not read was not observed', async () => {
    const world = worldIn();
    const observer = startObserver(world, { pass: new Map(), label: 'teamai workflow start', listed: dockerFailingExec(world) });

    expect(await observer.stop()).toContain('[verify] observed docker:teamai-r1-a1: NOT OBSERVED, no environment could be read');
  });

  it.runIf(process.platform !== 'linux')("says a container member's bwrap steps go unread off Linux, where it reads no /proc", async () => {
    const world = worldIn([{ machine: 'container', container: 'teamai-verify-x-carol', name: 'carol', home: '/w/carol/home', project: '/w/carol/project', tmp: '/tmp/carol', writers: '/w/carol/writers.json', env: {}, baseline: { files: {} } }]);
    const observer = startObserver(world, { pass: new Map(), label: 'teamai workflow start', listed: () => Promise.resolve(undefined) });

    expect(await observer.stop()).toContain("[verify] NOT OBSERVED: bwrap steps in @carol's container, the observer reads their environment from /proc on Linux only");
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
