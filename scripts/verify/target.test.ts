import { describe, expect, it } from 'vitest';
import { containerCommand } from './target.js';
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
