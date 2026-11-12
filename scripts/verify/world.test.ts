import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { socketPathOf } from '../../packages/runtime-sandbox/src/attempt-socket.js';
import { worldCommandNames, worldTmpDir } from './world.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the commands a world puts on PATH', () => {
  it('are git, every tool, every sandbox provider teamai runs on this machine, and the T3 and Paseo commands', () => {
    // docs/glossary.md, Sandbox provider: docker, podman, sbx, seatbelt (macOS's /usr/bin/sandbox-exec), bwrap; vercel runs elsewhere.
    expect(worldCommandNames()).toEqual(expect.arrayContaining(['git', 'claude', 'codex', 'codebuddy', 'opencode', 'docker', 'podman', 'sbx', '/usr/bin/sandbox-exec', 'bwrap', 't3', 'paseo']));
  });
});

describe("a world's TMPDIR", () => {
  // A unix socket path holds at most 103 bytes on macOS (sun_path is 104 with its NUL), 107 on Linux.
  it.each([
    ['the world', undefined],
    ['a member with the longest name', 'abcdefghijkl'],
  ])('leaves room for the deepest attempt socket teamai makes there, for %s', (_who, member) => {
    const tmp = worldTmpDir({ root: '/private/tmp', runId: '20261112T113044-479be0', member });
    vi.stubEnv('TMPDIR', tmp);
    // A result path past what a socket binds sends the socket to the temp directory, its deepest place.
    const socket = socketPathOf({ result: path.join('/private/var/folders/xx', 'y'.repeat(120), 'result'), place: 'teamai-r0123456789abcdef-a01234567' });

    expect(socket.startsWith(`${tmp}/`)).toBe(true);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
  });

  it('is one of its own per world and per member, named after the run so it is found again', () => {
    const runId = '20261112T113044-479be0';

    expect(new Set([worldTmpDir({ root: '/tmp', runId }), worldTmpDir({ root: '/tmp', runId, member: 'bob' }), worldTmpDir({ root: '/tmp', runId: '20261112T113044-000000' })]).size).toBe(3);
    expect(worldTmpDir({ root: '/tmp', runId })).toContain(runId);
  });
});
