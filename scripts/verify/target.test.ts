import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { containerCommand, watchSandboxes } from './target.js';
import { parseMachine } from './members.js';

describe('a command for a member in a container', () => {
  it('goes through docker exec with each variable by name only, the container PATH aside, in the member project', () => {
    const ran = containerCommand({
      container: 'teamai-verify-20261112T120000-aaaaaa-carol',
      env: { HOME: '/w/members/carol/home', PATH: '/opt/teamai/node_modules/.bin:/usr/bin:/bin', VERIFY_WORLD_CANARY: 'c4n4ry' },
      pass: new Map([['GATEWAY_TOKEN', 'tok-secret']]),
      cwd: '/w/members/carol/project',
      argv: ['teamai', 'pull'],
      harnessEnv: { PATH: '/usr/local/bin:/usr/bin', HOME: '/Users/me' },
    });

    expect(ran.command).toBe('docker');
    expect(ran.args).toEqual(['exec', '-i', '-w', '/w/members/carol/project', '-e', 'PATH=/opt/teamai/node_modules/.bin:/usr/bin:/bin', '-e', 'HOME', '-e', 'VERIFY_WORLD_CANARY', '-e', 'GATEWAY_TOKEN', 'teamai-verify-20261112T120000-aaaaaa-carol', 'teamai', 'pull']);
    expect(ran.args.join(' ')).not.toMatch(/c4n4ry|tok-secret/);
    expect(ran.env).toMatchObject({ HOME: '/w/members/carol/home', VERIFY_WORLD_CANARY: 'c4n4ry', GATEWAY_TOKEN: 'tok-secret', PATH: '/usr/local/bin:/usr/bin', DOCKER_CONFIG: '/Users/me/.docker' });
  });
});

describe('--machine', () => {
  it('is host unless it names container, and nothing else', () => {
    expect(parseMachine([])).toBe('host');
    expect(parseMachine(['--machine', 'container'])).toBe('container');
    expect(parseMachine(['--machine=host'])).toBe('host');
    expect(() => parseMachine(['--machine', 'vm'])).toThrow(/host or container/);
  });
});

describe('the watch for sandboxes over one command', () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  /** A HOME where earlier commands left a sandbox place record and T3's state, as they stay until uninstall. */
  function usedHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
    homes.push(home);
    fs.mkdirSync(path.join(home, '.teamai', 'runtime-state', 'sandbox', 'places'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'runtime-state', 'sandbox', 'places', 'earlier.json'), '{}');
    fs.mkdirSync(path.join(home, '.teamai', 'runtime-state', 't3'), { recursive: true });

    return home;
  }

  const counting = () => {
    const started = { count: 0 };

    return { started, start: () => { started.count += 1; return Promise.resolve({ stop: () => Promise.resolve([]) }); } };
  };

  it('starts no observer for a command that opens no sandbox, whatever earlier commands left', async () => {
    const { started, start } = counting();
    const watching = watchSandboxes({ home: usedHome(), members: [] }, { start });

    await watching.stop();
    expect(started.count).toBe(0);
  });

  it('starts the observer once a sandbox place opens during the command', async () => {
    const home = usedHome();
    const { started, start } = counting();
    const watching = watchSandboxes({ home, members: [] }, { start });

    fs.writeFileSync(path.join(home, '.teamai', 'runtime-state', 'sandbox', 'places', 'now.json'), '{}');
    await watching.stop();
    expect(started.count).toBe(1);
  });
});
