import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { outerHandleOf, registerAgent } from './outer.js';

let dir: string;
let server: net.Server | undefined;

beforeEach(() => {
  // A unix socket path binds at most ~104 bytes: the test temp directory can be past that.
  dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'outer-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A socket at `dir/sock/attempt.sock` that answers each line with what `answer` gives, as the sandbox runtime's does. */
async function socketAnswering(answer: (line: string) => string[]): Promise<{ socket: string; lines: string[] }> {
  const socketDir = path.join(dir, 'sock');
  fs.mkdirSync(socketDir, { mode: 0o700 });
  const socket = path.join(socketDir, 'attempt.sock');
  const lines: string[] = [];

  server = net.createServer((client) => {
    readline.createInterface({ input: client }).on('line', (line) => {
      lines.push(line);
      for (const reply of answer(line)) client.write(`${reply}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(socket, () => resolve());
  });

  return { socket, lines };
}

describe('the outer runtime a place runs through', () => {
  it('reads the attempt socket from a sandbox handle, and nothing from another runtime\'s handle', () => {
    expect(outerHandleOf(JSON.stringify({ place: 'p-1', socket: '/s/attempt.sock' }))).toEqual({ place: 'p-1', socket: '/s/attempt.sock' });
    expect(outerHandleOf('worktree/r0123abcd/a0123abcd')).toBeUndefined();
  });

  it('registers the agent, and resolves once the sandbox says that agent\'s wrapper connected, not another\'s', async () => {
    const { socket, lines } = await socketAnswering(() => [JSON.stringify({ connected: { agent: 'helper' } }), JSON.stringify({ connected: { agent: 'step' } })]);
    const registration = registerAgent(socket, 'step');

    expect(await registration.connected).toEqual({ ok: true });
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ register: { agent: 'step' } }]);
    registration.close();
  });

  it('says why when the socket closes before the wrapper connects', async () => {
    const { socket } = await socketAnswering(() => []);
    server?.on('connection', (client) => client.destroy());
    const registration = registerAgent(socket, 'step');

    expect(await registration.connected).toMatchObject({ ok: false, why: expect.stringContaining(socket) });
  });

  it('never registers on a socket whose directory others may open, since whoever made it would say what ran', async () => {
    const { socket, lines } = await socketAnswering(() => [JSON.stringify({ connected: { agent: 'step' } })]);
    fs.chmodSync(path.dirname(socket), 0o755);
    const registration = registerAgent(socket, 'step');

    expect(await registration.connected).toMatchObject({ ok: false, why: expect.stringContaining('0700') });
    expect(lines).toEqual([]);
  });
});
