import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerThrough } from './outer.js';

let dir: string;
let server: net.Server;
let lines: string[];
let ended: Promise<void>;

beforeEach(async () => {
  // A unix socket's path must stay short: macOS's own temporary folder is too deep for one.
  dir = fs.mkdtempSync('/tmp/teamai-kit-outer-');
  lines = [];
  let end = (): void => {};
  ended = new Promise((resolve) => { end = resolve; });
  server = net.createServer((client) => {
    client.setEncoding('utf8').on('data', (data: string) => lines.push(...data.split('\n').filter(Boolean)));
    client.on('end', end);
  });
  await new Promise<void>((resolve) => server.listen(path.join(dir, 'attempt.sock'), resolve));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a registration on an outer runtime\'s attempt socket', () => {
  it('registers the step\'s tool on the socket the outer handle names, and ends once closed', async () => {
    const registered = await registerThrough({ outer: JSON.stringify({ place: 'sandbox-1', socket: path.join(dir, 'attempt.sock') }), agent: null });

    expect(registered.ok).toBe(true);
    await expect.poll(() => lines).toEqual(['{"register":{"agent":null}}']);
    if (registered.ok) registered.close();
    await ended;
  });

  it('registers nothing for an outer handle that names no attempt socket, saying so', async () => {
    expect(await registerThrough({ outer: 'sandbox-1', agent: null })).toEqual({ ok: false, why: 'its handle names no attempt socket' });
  });

  it('says why when nothing answers on the socket', async () => {
    const registered = await registerThrough({ outer: JSON.stringify({ place: 'sandbox-1', socket: path.join(dir, 'gone.sock') }), agent: null });

    expect(registered).toEqual({ ok: false, why: expect.stringContaining('ENOENT') });
  });
});
